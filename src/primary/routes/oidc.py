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

from flask import Blueprint, redirect, url_for, session, request
from authlib.integrations.flask_client import OAuth

from src.primary.auth import create_session, SESSION_COOKIE_NAME
from src.primary.utils.logger import get_logger

logger = get_logger("oidc")

oauth = OAuth()
oidc_bp = Blueprint("oidc", __name__)

_registered = False


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
    try:
        from src.primary.settings_manager import load_settings
        return load_settings("general") or {}
    except Exception:
        return {}


def _config():
    """Assemble the OIDC config from secret files / env / settings (in that order)."""
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
        "allowed_groups": set(allowed),
        "admin_groups": set(admin),
    }


def oidc_configured() -> bool:
    """True when tenant + client id + client secret are all available."""
    c = _config()
    return bool(c["tenant"] and c["client_id"] and c["client_secret"])


def init_oidc(app):
    """Bind Authlib to the app. Client registration is lazy (see _client)."""
    oauth.init_app(app)


def _client():
    """Register (once) and return the Entra OAuth client, or None if unconfigured."""
    global _registered
    if not oidc_configured():
        return None
    if not _registered:
        c = _config()
        oauth.register(
            name="entra",
            client_id=c["client_id"],
            client_secret=c["client_secret"],
            server_metadata_url=(
                f"https://login.microsoftonline.com/{c['tenant']}/v2.0/.well-known/openid-configuration"
            ),
            client_kwargs={"scope": "openid profile email", "code_challenge_method": "S256"},
        )
        _registered = True
        logger.info("Registered Entra OIDC client.")
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


@oidc_bp.route("/auth/login")
def oidc_login():
    client = _client()
    if client is None:
        logger.warning("OIDC login requested but OIDC is not configured; sending to local login.")
        return redirect(url_for("common.login_page") if _has_endpoint("common.login_page") else "/login")
    redirect_uri = url_for("oidc.oidc_callback", _external=True)
    return client.authorize_redirect(redirect_uri)


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
