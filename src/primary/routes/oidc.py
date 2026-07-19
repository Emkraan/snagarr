#!/usr/bin/env python3
"""
Provider-agnostic single sign-on (OIDC + OAuth2).

Adds SSO as a first-class login option alongside the local username/password
flow, for ANY number of configured providers. Each provider is one of:

  * an OIDC preset (microsoft / google / okta / keycloak / authentik) whose
    endpoints derive from a tenant/issuer,
  * a generic OIDC provider (admin supplies a discovery URL),
  * a plain OAuth2 provider (github, or a fully custom authorize/token/userinfo
    triple) that has no id_token and needs a manual userinfo fetch.

All flows terminate in the SAME in-memory session the local login uses, so every
downstream route is unchanged. Configuration is UI-managed and lives in the
dedicated 0600 store (oidc_config); a one-time seed migrates a legacy env/file
OIDC deployment into the store so removing the env never breaks login. A single
callback route (/auth/callback) serves every provider — the active provider name
is stashed in the session at login, so no per-provider redirect URI is needed.
"""

import os

from flask import Blueprint, redirect, url_for, session, request, jsonify
from authlib.integrations.flask_client import OAuth

from src.primary.auth import create_session, SESSION_COOKIE_NAME
from src.primary import oidc_config
from src.primary.utils.logger import get_logger

logger = get_logger("oidc")

oauth = OAuth()
oidc_bp = Blueprint("oidc", __name__)

# name -> config_hash of the Authlib client currently registered. A mismatch
# against the freshly-assembled config triggers a live re-registration.
_versions = {}


# --- config assembly / presets --------------------------------------------

def _read_secret(env_name: str):
    """Resolve a value from a *_FILE pointer, a plain env var, or None."""
    file_ptr = os.environ.get(f"{env_name}_FILE")
    if file_ptr:
        try:
            with open(file_ptr, "r") as f:
                return f.read().strip()
        except Exception as e:
            logger.error(f"Could not read {env_name}_FILE ({file_ptr}): {e}")
    return os.environ.get(env_name)


def _preset(cfg: dict) -> dict:
    """Default endpoints/scopes/claims for a provider type (admin values win).

    Profile claims (name/email/picture) are OIDC-standard for the id_token /
    userinfo. Admins can override any of these per provider in the SSO editor;
    role assignment is by admin_groups (see _is_admin)."""
    pt = cfg.get("provider_type")
    tenant = (cfg.get("tenant") or "").strip()
    issuer = (cfg.get("issuer") or "").strip().rstrip("/")
    # OIDC-standard profile claim names, applied unless a provider overrides them.
    std = {"name_claim": "name", "email_claim": "email", "picture_claim": "picture"}
    if pt == "microsoft":
        return {"flow": "oidc",
                "discovery_url": f"https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" if tenant else "",
                # User.Read (a default delegated Graph permission) yields a Graph
                # access token so _fetch_graph_photo can pull the user's photo.
                "scopes": ["openid", "profile", "email", "User.Read"],
                "username_claim": "preferred_username", "groups_claim": "groups", **std}
    if pt == "google":
        return {"flow": "oidc",
                "discovery_url": "https://accounts.google.com/.well-known/openid-configuration",
                "scopes": ["openid", "email", "profile"], "username_claim": "email", "groups_claim": "", **std}
    if pt == "github":
        return {"flow": "oauth2",
                "authorize_url": "https://github.com/login/oauth/authorize",
                "token_url": "https://github.com/login/oauth/access_token",
                "userinfo_url": "https://api.github.com/user",
                "scopes": ["read:user", "user:email"], "username_claim": "login", "groups_claim": "",
                "name_claim": "name", "email_claim": "email", "picture_claim": "avatar_url"}
    if pt in ("keycloak", "authentik", "okta"):
        return {"flow": "oidc",
                "discovery_url": (issuer + "/.well-known/openid-configuration") if issuer else "",
                "scopes": ["openid", "profile", "email"],
                "username_claim": "preferred_username", "groups_claim": "groups", **std}
    if pt == "oauth2":
        return {"flow": "oauth2", "username_claim": "preferred_username", "groups_claim": "groups", **std}
    # generic oidc
    return {"flow": "oidc", "scopes": ["openid", "profile", "email"],
            "username_claim": "preferred_username", "groups_claim": "groups", **std}


def resolve(cfg: dict) -> dict:
    """Merge preset defaults UNDER the admin's explicit values."""
    m = dict(cfg)
    p = _preset(cfg)
    m["_flow"] = "oauth2" if cfg.get("provider_type") in ("oauth2", "github") else p.get("flow", "oidc")
    for k, v in p.items():
        if k == "flow":
            continue
        if not m.get(k):
            m[k] = v
    return m


# --- Authlib registration ---------------------------------------------------

def init_oidc(app):
    """Bind Authlib to the app and seed the store from a legacy env deployment."""
    oauth.init_app(app)
    try:
        seed_from_env()
    except Exception as e:
        logger.error(f"OIDC env seed failed (non-fatal): {e}")


def seed_from_env():
    """One-time: if no providers are configured yet but env/file OIDC creds are
    present (the legacy deployment shape), persist them into the store as a
    microsoft provider. Lets an env-based deploy drop the env and keep login."""
    if oidc_config.load_providers():
        return
    tenant = _read_secret("OIDC_TENANT_ID")
    client_id = _read_secret("OIDC_CLIENT_ID")
    client_secret = _read_secret("OIDC_CLIENT_SECRET")
    if not (tenant and client_id and client_secret):
        return
    allowed = [g.strip() for g in (os.environ.get("OIDC_ALLOWED_GROUPS") or "").split(",") if g.strip()]
    admin = [g.strip() for g in (os.environ.get("OIDC_ADMIN_GROUPS") or "").split(",") if g.strip()]
    oidc_config.save_providers([{
        "name": "microsoft", "display_name": "Microsoft Entra ID", "provider_type": "microsoft",
        "enabled": True, "show_on_login": True, "is_default": True,
        "tenant": tenant, "client_id": client_id, "client_secret": client_secret,
        "allowed_groups": allowed, "admin_groups": admin,
    }])
    logger.info("Seeded SSO provider store from env OIDC config (Entra).")


def invalidate():
    """Force re-registration of every provider's Authlib client on next use."""
    _versions.clear()


def _evict(name):
    for reg in (getattr(oauth, "_clients", None), getattr(oauth, "_registry", None)):
        if isinstance(reg, dict):
            reg.pop(name, None)


def _register(m: dict):
    name = m["name"]
    common = dict(name=name, client_id=m.get("client_id"), client_secret=m.get("client_secret"))
    if m["_flow"] == "oidc":
        return oauth.register(
            server_metadata_url=m.get("discovery_url") or None,
            client_kwargs={"scope": " ".join(m.get("scopes") or ["openid", "profile", "email"]),
                           "code_challenge_method": "S256"},
            **common)
    return oauth.register(
        authorize_url=m.get("authorize_url"),
        access_token_url=m.get("token_url"),
        client_kwargs={"scope": " ".join(m.get("scopes") or []),
                       "token_endpoint_auth_method": m.get("token_endpoint_auth_method", "client_secret_post"),
                       "headers": {"Accept": "application/json"}},
        **common)


def get_client(name):
    """Register/refresh and return (client, provider) or (None, None)."""
    if not name:
        return None, None
    p = oidc_config.get_provider(name)
    if not p or not p.get("enabled", True):
        return None, None
    if not (p.get("client_id") and p.get("client_secret")):
        return None, None
    cur = oidc_config.config_hash(p)
    if _versions.get(name) != cur:
        _evict(name)
        _register(resolve(p))
        _versions[name] = cur
        logger.info(f"Registered/updated SSO client '{name}' (config changed).")
    return oauth.create_client(name), p


# --- authorization / claim mapping -----------------------------------------

def _dig(d, dotted):
    cur = d
    for part in (dotted or "").split("."):
        if not part:
            continue
        cur = cur.get(part) if isinstance(cur, dict) else None
    return cur or []


def _groups(claims, m):
    g = _dig(claims, m.get("groups_claim") or "groups")
    if isinstance(g, str):
        g = [g]
    roles = claims.get("roles")
    if isinstance(roles, list):
        g = list(g) + roles
    return set(g)


def _authorized(claims, m) -> bool:
    allowed = set(m.get("allowed_groups") or []) | set(m.get("admin_groups") or [])
    if not allowed:
        return True
    return bool(_groups(claims, m) & allowed)


def _is_admin(claims, m) -> bool:
    # Fail closed: an unconfigured admin_groups grants nobody admin via SSO
    # (the local username/password account is unaffected - see create_session).
    # An operator who wants every authenticated user to be admin must say so
    # explicitly by listing the group(s) rather than leaving the field empty.
    admin = set(m.get("admin_groups") or [])
    if not admin:
        return False
    return bool(_groups(claims, m) & admin)


def _fetch_userinfo_oauth2(client, token, m) -> dict:
    """Plain OAuth2 has no id_token/userinfo — fetch the resource URL manually."""
    profile = {}
    try:
        profile = client.get(m.get("userinfo_url"), token=token).json() or {}
    except Exception as e:
        logger.warning(f"OAuth2 userinfo fetch failed for '{m.get('name')}': {e}")
    if m.get("provider_type") == "github" and not profile.get("email"):
        try:
            emails = client.get("https://api.github.com/user/emails", token=token).json() or []
            primary = next((e for e in emails if e.get("primary") and e.get("verified")), None)
            if primary:
                profile["email"] = primary.get("email")
        except Exception:
            pass
    return profile


def _display_name(claims, m) -> str:
    """The user's full name from the configured name claim, falling back to
    given_name + family_name. Empty string if the IdP sent none."""
    name = claims.get(m.get("name_claim") or "name")
    if not name:
        parts = [claims.get("given_name"), claims.get("family_name")]
        name = " ".join(p for p in parts if p).strip()
    return (name or "").strip()


def _fetch_graph_photo(client, token) -> str:
    """Microsoft Entra puts no photo in the id_token; fetch it from Graph as a
    data: URI. Requires the access token to carry a Graph scope (e.g. User.Read);
    fails soft to '' so the UI falls back to an initials avatar. Provider-agnostic:
    only attempted for the microsoft provider type."""
    try:
        r = client.get("https://graph.microsoft.com/v1.0/me/photo/$value", token=token)
        if getattr(r, "status_code", 0) == 200 and r.content and len(r.content) <= 400_000:
            import base64
            ct = r.headers.get("Content-Type", "image/jpeg")
            return f"data:{ct};base64," + base64.b64encode(r.content).decode()
    except Exception as e:
        logger.info(f"Graph photo unavailable (fine; using initials avatar): {e}")
    return ""


def _callback_url() -> str:
    """The single https callback (matches every provider's registered redirect)."""
    override = os.environ.get("OIDC_REDIRECT_URI")
    if override:
        return override
    uri = url_for("oidc.oidc_callback", _external=True)
    host = (request.host or "").split(":")[0]
    if uri.startswith("http://") and host not in ("localhost", "127.0.0.1"):
        uri = "https://" + uri[len("http://"):]
    return uri


# --- routes -----------------------------------------------------------------

def _start(name):
    client, p = get_client(name)
    if client is None:
        logger.warning(f"SSO login requested for '{name}' but it is not configured; to local login.")
        return redirect("/login")
    session["oidc_provider"] = name
    try:
        return client.authorize_redirect(_callback_url())
    except Exception as e:
        logger.error(f"SSO authorize_redirect failed for '{name}' ({e}); to local login.")
        return redirect("/login")


@oidc_bp.route("/auth/login")
def oidc_login():
    """Kick off the DEFAULT provider (used by a single-provider deployment)."""
    p = oidc_config.default_provider()
    if not p:
        return redirect("/login")
    return _start(p["name"])


@oidc_bp.route("/auth/login/<name>")
def oidc_login_named(name):
    """Kick off a specific provider (the login-page buttons target this)."""
    return _start(name)


@oidc_bp.route("/auth/callback")
def oidc_callback():
    name = session.get("oidc_provider")
    client, p = get_client(name) if name else (None, None)
    if client is None:
        return redirect("/login")
    try:
        token = client.authorize_access_token()  # validates state, nonce, signature
    except Exception as e:
        logger.warning(f"SSO callback token exchange failed for '{name}': {e}")
        return "Sign-in failed.", 403
    m = resolve(p)
    if m["_flow"] == "oidc":
        claims = token.get("userinfo") or {}
    else:
        claims = _fetch_userinfo_oauth2(client, token, m)
    if not claims:
        logger.warning(f"SSO '{name}': no user claims returned.")
        return "Sign-in failed: no user profile.", 403
    if m.get("required_verified_email", True) and claims.get("email_verified") is False:
        return "Access denied: your email is not verified.", 403
    if not _authorized(claims, m):
        who = claims.get(m.get("username_claim") or "preferred_username") or claims.get("email")
        logger.warning(f"SSO '{name}' user denied by group gate: {who}")
        return "Access denied: your account is not in an allowed group.", 403
    username = (claims.get(m.get("username_claim") or "preferred_username")
                or claims.get("email") or claims.get("login") or claims.get("sub"))
    display_name = _display_name(claims, m)
    email = claims.get(m.get("email_claim") or "email") or ""
    picture = claims.get(m.get("picture_claim") or "picture") or ""
    if not picture and m.get("provider_type") == "microsoft":
        picture = _fetch_graph_photo(client, token)
    role = "admin" if _is_admin(claims, m) else "member"
    profile = {"name": display_name, "email": email, "picture": picture, "provider": name}
    session_token = create_session(username, role=role, profile=profile)
    session[SESSION_COOKIE_NAME] = session_token
    resp = redirect("/")
    resp.set_cookie(SESSION_COOKIE_NAME, session_token, httponly=True, samesite="Lax", path="/", secure=request.is_secure)
    logger.info(f"SSO sign-in for '{username}' ({display_name or 'no-name'}) via '{name}' role={role}.")
    return resp


@oidc_bp.route("/auth/logout")
def oidc_logout():
    from src.primary.auth import logout as _logout
    token = request.cookies.get(SESSION_COOKIE_NAME) or session.get(SESSION_COOKIE_NAME)
    if token:
        _logout(token)
    session.pop(SESSION_COOKIE_NAME, None)
    session.pop("oidc_provider", None)
    resp = redirect("/")
    resp.delete_cookie(SESSION_COOKIE_NAME, path="/", samesite="Lax")
    return resp


# --- status / verify (for the settings UI; auth-exempt, secret-free) --------

def oidc_configured() -> bool:
    """True when at least one enabled provider has id + secret (any source)."""
    for p in oidc_config.load_providers():
        if p.get("enabled", True) and p.get("client_id") and p.get("client_secret"):
            return True
    return False


def oidc_env_configured() -> bool:
    """True only when OIDC creds come from ENV/FILE (legacy deployment).
    Kept for back-compat; the auth path no longer routes on it."""
    return bool(_read_secret("OIDC_TENANT_ID") and _read_secret("OIDC_CLIENT_ID")
                and _read_secret("OIDC_CLIENT_SECRET"))


def _probe_discovery(m) -> dict:
    """Fetch the OIDC discovery doc to confirm reachability. Never raises."""
    disc = m.get("discovery_url")
    if m["_flow"] != "oidc" or not disc:
        return {"discovery_reachable": None}
    try:
        import requests
        try:
            from src.primary.settings_manager import get_ssl_verify_setting
            verify = get_ssl_verify_setting()
        except Exception:
            verify = True
        r = requests.get(disc, timeout=6, verify=verify)
        if r.status_code == 200 and "token_endpoint" in (r.json() or {}):
            return {"discovery_reachable": True}
        return {"discovery_reachable": False, "error": f"HTTP {r.status_code} from discovery endpoint."}
    except Exception as e:
        return {"discovery_reachable": False, "error": str(e)}


@oidc_bp.route("/auth/status")
def auth_status():
    """Secret-free SSO status for the settings UI. ?verify=<name> probes one."""
    provs = []
    for p in oidc_config.load_providers():
        provs.append({
            "name": p.get("name"), "display_name": p.get("display_name") or p.get("name"),
            "provider_type": p.get("provider_type"), "enabled": bool(p.get("enabled", True)),
            "show_on_login": bool(p.get("show_on_login", True)), "is_default": bool(p.get("is_default")),
            "configured": bool(p.get("client_id") and p.get("client_secret")),
            "secret_set": bool(p.get("client_secret")),
        })
    status = {"providers": provs, "redirect_uri": _safe_callback(), "any_configured": oidc_configured()}
    name = request.args.get("verify")
    if name:
        p = oidc_config.get_provider(name)
        if not p:
            status["verify"] = {"ok": False, "error": "Unknown provider."}
        else:
            m = resolve(p)
            checks = {"config_complete": bool(p.get("client_id") and p.get("client_secret"))}
            checks.update(_probe_discovery(m))
            checks["ok"] = bool(checks.get("config_complete")) and (checks.get("discovery_reachable") in (True, None))
            status["verify"] = checks
    return jsonify(status)


# --- provider CRUD (admin; gated by authenticate_request via the /api/ path) ---

@oidc_bp.route("/api/sso/providers", methods=["GET"])
def sso_list():
    return jsonify({"providers": [oidc_config.mask_provider(p) for p in oidc_config.load_providers()],
                    "redirect_uri": _safe_callback()})


@oidc_bp.route("/api/sso/providers", methods=["POST"])
def sso_upsert():
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not body.get("name") or not body.get("provider_type"):
        return jsonify({"error": "name and provider_type are required"}), 422
    if body["provider_type"] not in oidc_config.PROVIDER_TYPES:
        return jsonify({"error": f"provider_type must be one of {list(oidc_config.PROVIDER_TYPES)}"}), 422
    name = body["name"]
    providers = oidc_config.load_providers()
    stored = next((p for p in providers if p.get("name") == name), None)
    merged = oidc_config.merge_provider_secret(body, stored)
    merged.pop("client_secret_set", None)
    for k in ("allowed_groups", "admin_groups", "scopes"):
        v = merged.get(k)
        if isinstance(v, str):
            merged[k] = [x.strip() for x in v.split(",") if x.strip()]
    if merged.get("is_default"):
        for p in providers:
            p["is_default"] = False
    providers = [p for p in providers if p.get("name") != name] + [merged]
    if not oidc_config.save_providers(providers):
        return jsonify({"error": "Could not save provider."}), 500
    invalidate()
    return jsonify({"ok": True, "provider": oidc_config.mask_provider(merged)})


@oidc_bp.route("/api/sso/providers/<name>", methods=["DELETE"])
def sso_delete(name):
    providers = [p for p in oidc_config.load_providers() if p.get("name") != name]
    if not oidc_config.save_providers(providers):
        return jsonify({"error": "Could not save."}), 500
    invalidate()
    return jsonify({"ok": True})


def _safe_callback() -> str:
    try:
        return _callback_url()
    except Exception:
        return ""


def _has_endpoint(name: str) -> bool:
    from flask import current_app
    return name in current_app.view_functions
