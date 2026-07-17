#!/usr/bin/env python3
"""
In-app OpenID Connect (Entra ID) sign-in.

Adds OIDC as a first-class login option alongside the local username/password
flow. It terminates in the SAME in-memory session the local login uses, so every
downstream route is unchanged: an OIDC session is indistinguishable from a
password session once established.

Configuration is read from mounted secret files first (the Key Vault -> kv-sync
pattern: OIDC_*_FILE env pointers to read-only files), then plain env vars, then
the general settings JSON. Secrets should never live in the settings JSON on a
shared host, so the *_FILE path is preferred.
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

# Version (config hash) of the Authlib "entra" client currently registered.
# None means "not registered yet"; a mismatch against the freshly-assembled
# config on any request triggers a live re-registration (no restart needed).
_registered_version = None


def _metadata_url(tenant: str) -> str:
    return f"https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration"


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


def _settings():
    """The stored OIDC values (from the dedicated 0600 oidc.json store)."""
    try:
        return oidc_config.load_oidc_config() or {}
    except Exception:
        return {}


def _config():
    """Assemble the OIDC config from secret files / env / stored settings.

    Precedence for tenant/client id/client secret is file -> env -> stored
    settings, so an env/file mount always overrides the UI-managed values.
    """
    s = _settings()
    tenant = _read_secret("OIDC_TENANT_ID") or s.get("oidc_tenant_id") or ""
    client_id = _read_secret("OIDC_CLIENT_ID") or s.get("oidc_client_id") or ""
    client_secret = _read_secret("OIDC_CLIENT_SECRET") or s.get("oidc_client_secret") or ""
    allowed = s.get("oidc_allowed_groups") or []
    admin = s.get("oidc_admin_groups") or []
    env_allowed = os.environ.get("OIDC_ALLOWED_GROUPS")
    if env_allowed:
        allowed = [g.strip() for g in env_allowed.split(",") if g.strip()]
    return {
        "tenant": tenant,
        "client_id": client_id,
        "client_secret": client_secret,
        "metadata_url": _metadata_url(tenant) if tenant else "",
        "allowed_groups": set(allowed),
        "admin_groups": set(admin),
    }


def invalidate():
    """Force re-registration of the Authlib client on the next _client() call.

    Called right after a UI save so the saving worker picks up the change
    immediately, even before the config hash would otherwise diverge.
    """
    global _registered_version
    _registered_version = None


def oidc_configured() -> bool:
    """True when tenant + client id + client secret are all available (any source)."""
    c = _config()
    return bool(c["tenant"] and c["client_id"] and c["client_secret"])


def oidc_env_configured() -> bool:
    """True only when OIDC creds are provided by ENV/FILE (deployment-managed).

    The auth path uses this so an env-based deployment auto-enables OIDC without
    the UI toggle, while UI-stored config requires an explicit oidc_enabled
    toggle. That prevents merely SAVING credentials in the UI from forcing OIDC
    (and locking out local login before the config is verified).
    """
    return bool(_read_secret("OIDC_TENANT_ID") and _read_secret("OIDC_CLIENT_ID")
                and _read_secret("OIDC_CLIENT_SECRET"))


def init_oidc(app):
    """Bind Authlib to the app. Client registration is lazy (see _client)."""
    oauth.init_app(app)


def _client():
    """Register/refresh and return the Entra OAuth client, or None if unconfigured.

    Registration is keyed on the live config hash: whenever tenant/client
    id/secret/metadata change (a UI save, an env change, or another worker's
    write picked up on read), the previously registered Authlib client is
    dropped and re-registered with the new values. No restart is required and
    the mechanism is safe across multiple workers because the hash is derived
    from the freshly-assembled config on every call.
    """
    global _registered_version
    if not oidc_configured():
        return None
    c = _config()
    current = oidc_config.config_hash(c)
    if _registered_version != current:
        # Drop any prior registration of this name; Authlib rejects a duplicate
        # register() of the same name. The pops are guarded so a first-time
        # registration is a safe no-op.
        registry = getattr(oauth, "_registry", None)
        if isinstance(registry, dict):
            registry.pop("entra", None)
        clients = getattr(oauth, "_clients", None)
        if isinstance(clients, dict):
            clients.pop("entra", None)
        oauth.register(
            name="entra",
            client_id=c["client_id"],
            client_secret=c["client_secret"],
            server_metadata_url=_metadata_url(c["tenant"]),
            client_kwargs={"scope": "openid profile email", "code_challenge_method": "S256"},
        )
        _registered_version = current
        logger.info("Registered/updated Entra OIDC client (config version changed).")
    return oauth.entra


def _authorized(claims) -> bool:
    """Group gate. Empty allowlist => any authenticated tenant user is allowed."""
    c = _config()
    allowed = c["allowed_groups"] | c["admin_groups"]
    if not allowed:
        return True
    principal = set(claims.get("groups", [])) | set(claims.get("roles", []))
    return bool(principal & allowed)


def _is_admin(claims) -> bool:
    c = _config()
    if not c["admin_groups"]:
        return True  # single-operator default
    principal = set(claims.get("groups", [])) | set(claims.get("roles", []))
    return bool(principal & c["admin_groups"])


def _callback_url() -> str:
    """Build the OIDC callback URL, forcing https behind a TLS-terminating proxy.

    Order: an explicit OIDC_REDIRECT_URI env (most reliable), else url_for. The
    internal proxy hop is plain HTTP, so url_for often yields http://; Entra
    requires the redirect_uri to match the registered https URL exactly, so we
    upgrade the scheme for any non-localhost host.
    """
    override = os.environ.get("OIDC_REDIRECT_URI")
    if override:
        return override
    uri = url_for("oidc.oidc_callback", _external=True)
    host = (request.host or "").split(":")[0]
    if uri.startswith("http://") and host not in ("localhost", "127.0.0.1"):
        uri = "https://" + uri[len("http://"):]
    return uri


@oidc_bp.route("/auth/login")
def oidc_login():
    client = _client()
    if client is None:
        logger.warning("OIDC login requested but OIDC is not configured; sending to local login.")
        return redirect(url_for("common.login_page") if _has_endpoint("common.login_page") else "/login")
    redirect_uri = _callback_url()
    try:
        return client.authorize_redirect(redirect_uri)
    except Exception as e:
        # Misconfigured / unreachable tenant must never lock out local login.
        logger.error(f"OIDC authorize_redirect failed ({e}); falling back to local login.")
        return redirect(url_for("common.login_page") if _has_endpoint("common.login_page") else "/login")


@oidc_bp.route("/auth/callback")
def oidc_callback():
    client = _client()
    if client is None:
        return redirect("/login")
    try:
        token = client.authorize_access_token()  # validates state, nonce, signature
    except Exception as e:
        logger.warning(f"OIDC callback failed token exchange: {e}")
        return "Sign-in failed.", 403
    claims = token.get("userinfo") or {}
    if not _authorized(claims):
        logger.warning(f"OIDC user denied by group gate: {claims.get('preferred_username') or claims.get('email')}")
        return "Access denied: your account is not in an allowed group.", 403

    username = claims.get("preferred_username") or claims.get("email") or claims.get("sub")
    session_token = create_session(username)
    session[SESSION_COOKIE_NAME] = session_token
    resp = redirect("/")
    resp.set_cookie(SESSION_COOKIE_NAME, session_token, httponly=True, samesite="Lax", path="/")
    logger.info(f"OIDC sign-in for '{username}' (admin={_is_admin(claims)}).")
    return resp


def _oidc_enabled() -> bool:
    """Read the oidc_enabled toggle from general settings (stays in general.json)."""
    try:
        from src.primary.settings_manager import load_settings
        return bool((load_settings("general") or {}).get("oidc_enabled", False))
    except Exception:
        return False


def _config_source() -> str:
    """Where the effective OIDC identity is sourced from: env, settings, or none."""
    if _read_secret("OIDC_TENANT_ID") or _read_secret("OIDC_CLIENT_ID") or _read_secret("OIDC_CLIENT_SECRET"):
        return "env"
    s = _settings()
    if s.get("oidc_tenant_id") or s.get("oidc_client_id") or s.get("oidc_client_secret"):
        return "settings"
    return "none"


@oidc_bp.route("/auth/status")
def auth_status():
    """Read-only, secret-free OIDC status for the settings UI. Auth-exempt.

    ?probe=1 additionally fetches the tenant OIDC metadata document to confirm
    the tenant/network path is reachable.
    """
    c = _config()
    try:
        redirect_uri = _callback_url()
    except Exception:
        redirect_uri = ""
    status = {
        "enabled": _oidc_enabled(),
        "configured": oidc_configured(),
        "source": _config_source(),
        "redirect_uri": redirect_uri,
        "tenant_set": bool(c["tenant"]),
        "client_id_set": bool(c["client_id"]),
        "secret_set": bool(c["client_secret"]),
        "admin_groups_set": bool(c["admin_groups"]),
    }
    if request.args.get("probe"):
        status.update(_probe_metadata(c))
    return jsonify(status)


def _probe_metadata(c) -> dict:
    """Fetch the tenant OIDC metadata to verify reachability. Never raises."""
    tenant = c.get("tenant") or ""
    if not tenant:
        return {"metadata_reachable": False, "error": "No tenant id configured."}
    try:
        import requests
        try:
            from src.primary.settings_manager import get_ssl_verify_setting
            verify = get_ssl_verify_setting()
        except Exception:
            verify = True
        resp = requests.get(_metadata_url(tenant), timeout=5, verify=verify)
        if resp.status_code == 200:
            return {"metadata_reachable": True}
        return {"metadata_reachable": False, "error": f"HTTP {resp.status_code} from metadata endpoint."}
    except Exception as e:
        return {"metadata_reachable": False, "error": str(e)}


@oidc_bp.route("/auth/logout")
def oidc_logout():
    """Clear the local session; optionally RP-initiated logout at Entra."""
    from src.primary.auth import logout as _logout
    token = request.cookies.get(SESSION_COOKIE_NAME) or session.get(SESSION_COOKIE_NAME)
    if token:
        _logout(token)
    session.pop(SESSION_COOKIE_NAME, None)
    resp = redirect("/")
    resp.delete_cookie(SESSION_COOKIE_NAME, path="/", samesite="Lax")
    return resp


def _has_endpoint(name: str) -> bool:
    from flask import current_app
    return name in current_app.view_functions
