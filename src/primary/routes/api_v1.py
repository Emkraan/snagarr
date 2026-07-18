#!/usr/bin/env python3
"""
Versioned programmatic configuration API (/api/v1).

A stable, consistently-shaped surface for reading and writing every setting,
triggering resets, and checking status. Wraps the existing settings_manager
primitives rather than replacing the legacy browser-oriented routes.

Auth: a Bearer API key (scoped read < write < admin), a valid operator session
cookie (treated as admin), or a proxy-trusted deployment. Responses use a fixed
envelope: {"ok": bool, "data": ..., "error": {"code","message"} | null}.
"""

import os
from functools import wraps

from flask import Blueprint, request, jsonify, session, g

from src.primary import settings_manager, api_keys, oidc_config
from src.primary.auth import verify_session, SESSION_COOKIE_NAME
from src.primary.utils.logger import get_logger

logger = get_logger("api_v1")

api_v1 = Blueprint("api_v1", __name__, url_prefix="/api/v1")

# Keys masked with a last-4 hint in GET responses (identifying, not clobberable
# in practice because these paths are not round-tripped through the UI form).
_MASK_KEYS = {"api_key", "password"}
# Keys replaced wholesale with a non-reversible sentinel: any part of a client
# secret is still secret material, and a last-4 mask can be round-tripped into a
# clobber. These honor preserve-unless-changed on write instead.
_SECRET_SENTINEL_KEYS = {"oidc_client_secret", "client_secret"}


def _ok(data=None, status=200):
    return jsonify({"ok": True, "data": data, "error": None}), status


def _err(code, message, status):
    return jsonify({"ok": False, "data": None, "error": {"code": code, "message": message}}), status


def _mask(value):
    """Recursively mask secret-like values. Client secrets are replaced with a
    non-reversible sentinel; other secret-like keys keep a last-4 hint."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in _SECRET_SENTINEL_KEYS:
                out[k] = oidc_config.SECRET_SENTINEL if v else ""
            elif k in _MASK_KEYS:
                out[k] = _mask_scalar(v)
            else:
                out[k] = _mask(v)
        return out
    if isinstance(value, list):
        return [_mask(v) for v in value]
    return value


def _mask_scalar(v):
    if not v or not isinstance(v, str):
        return v
    return ("*" * max(0, len(v) - 4)) + v[-4:] if len(v) > 4 else "****"


def _preserve_secrets(app_name, body):
    """Preserve-unless-changed for secret fields on write: an incoming secret
    that is empty or the sentinel keeps the stored value; anything else is a new
    secret. Mutates and returns body."""
    if not isinstance(body, dict):
        return body
    if any(k in body for k in _SECRET_SENTINEL_KEYS):
        try:
            current = settings_manager.load_settings(app_name) or {}
        except Exception:
            current = {}
        for k in _SECRET_SENTINEL_KEYS:
            if k in body and body[k] in ("", oidc_config.SECRET_SENTINEL):
                stored = current.get(k, "")
                if stored:
                    body[k] = stored
                else:
                    body.pop(k, None)
    return body


def require_api_key(scope="read"):
    """Gate a route on a scoped Bearer key, an operator session, or proxy trust."""
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            authz = request.headers.get("Authorization", "")
            if authz.startswith("Bearer "):
                rec = api_keys.verify_key(authz[len("Bearer "):])
                if rec and api_keys.scope_satisfies(rec.get("scope", ""), scope):
                    g.api_scope = rec["scope"]
                    return fn(*args, **kwargs)
                return _err("forbidden", "Invalid API key or insufficient scope.", 403)

            sid = session.get(SESSION_COOKIE_NAME) or request.cookies.get(SESSION_COOKIE_NAME)
            if sid and verify_session(sid):
                # A logged-in operator maps to their RBAC role: admin -> admin
                # scope, member -> read-only.
                from src.primary.auth import get_role_from_session
                g.api_scope = "admin" if get_role_from_session(sid) == "admin" else "read"
                if api_keys.scope_satisfies(g.api_scope, scope):
                    return fn(*args, **kwargs)
                return _err("forbidden", "This session is read-only.", 403)

            try:
                if settings_manager.load_settings("general").get("proxy_auth_bypass", False):
                    g.api_scope = "admin"
                    return fn(*args, **kwargs)
            except Exception:
                pass

            return _err("unauthorized", "Authentication required: Bearer API key or session.", 401)
        return wrapper
    return decorator


def _app_or_error(app_name):
    if app_name not in settings_manager.KNOWN_APP_TYPES:
        return None, _err("not_found", f"Unknown app '{app_name}'. Known: {settings_manager.KNOWN_APP_TYPES}", 404)
    return app_name, None


def _normalize_urls(settings_data):
    """Strip trailing slashes on any api_url (top-level and per-instance)."""
    if not isinstance(settings_data, dict):
        return settings_data
    if isinstance(settings_data.get("api_url"), str):
        settings_data["api_url"] = settings_data["api_url"].rstrip("/")
    for inst in settings_data.get("instances", []) or []:
        if isinstance(inst, dict) and isinstance(inst.get("api_url"), str):
            inst["api_url"] = inst["api_url"].rstrip("/")
    return settings_data


def _version():
    # This module lives at src/primary/routes/, so walk up FOUR levels to the
    # repo root that holds VERSION (routes -> primary -> src -> root).
    try:
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        with open(os.path.join(root, "VERSION")) as f:
            return f.read().strip()
    except Exception:
        return "0.0.0"


# --- meta / health ---------------------------------------------------------

@api_v1.route("/openapi.json", methods=["GET"])
def openapi_json():
    """The OpenAPI 3.0 spec for this API. Public (schema only) so the docs page
    can load it before sign-in; it is under the /api/v1/ allow-listed prefix."""
    from src.primary.openapi_spec import build_spec
    return jsonify(build_spec())


@api_v1.route("/health", methods=["GET"])
def health():
    return _ok({"status": "ok", "version": _version()})


@api_v1.route("/meta", methods=["GET"])
@require_api_key("read")
def meta():
    return _ok({"version": _version(), "app_types": settings_manager.KNOWN_APP_TYPES, "api_version": "v1"})


# --- config ----------------------------------------------------------------

def _masked_oidc_block():
    """SSO providers for a GET: from the dedicated 0600 store, each client secret
    sentinelized so it never leaves the server. Provider CRUD is at /api/sso/*."""
    return {"sso_providers": [oidc_config.mask_provider(p) for p in oidc_config.load_providers()]}


def _merge_general_oidc(settings_dict):
    """Splice the masked SSO provider list into a general-settings dict for a GET."""
    if isinstance(settings_dict, dict):
        settings_dict.update(_masked_oidc_block())
    return settings_dict


@api_v1.route("/config", methods=["GET"])
@require_api_key("read")
def get_all_config():
    data = _mask(settings_manager.get_all_settings())
    if isinstance(data, dict) and isinstance(data.get("general"), dict):
        _merge_general_oidc(data["general"])
    return _ok(data)


@api_v1.route("/config/<app_name>", methods=["GET"])
@require_api_key("read")
def get_config(app_name):
    app, err = _app_or_error(app_name)
    if err:
        return err
    data = _mask(settings_manager.load_settings(app))
    if app == "general":
        _merge_general_oidc(data)
    return _ok(data)


@api_v1.route("/config/<app_name>", methods=["PUT"])
@require_api_key("write")
def put_config(app_name):
    app, err = _app_or_error(app_name)
    if err:
        return err
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _err("unprocessable", "Body must be a JSON object.", 422)
    body = _preserve_secrets(app, body)
    if settings_manager.save_settings(app, _normalize_urls(body)):
        data = _mask(settings_manager.load_settings(app))
        if app == "general":
            _merge_general_oidc(data)
        return _ok(data)
    return _err("save_failed", "Could not save settings.", 500)


@api_v1.route("/config/<app_name>", methods=["PATCH"])
@require_api_key("write")
def patch_config(app_name):
    app, err = _app_or_error(app_name)
    if err:
        return err
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _err("unprocessable", "Body must be a JSON object.", 422)
    body = _preserve_secrets(app, body)
    merged = settings_manager.load_settings(app)
    merged.update(body)  # shallow merge is the right granularity for these flat configs
    if settings_manager.save_settings(app, _normalize_urls(merged)):
        data = _mask(settings_manager.load_settings(app))
        if app == "general":
            _merge_general_oidc(data)
        return _ok(data)
    return _err("save_failed", "Could not save settings.", 500)


@api_v1.route("/config/<app_name>/defaults", methods=["GET"])
@require_api_key("read")
def get_defaults(app_name):
    app, err = _app_or_error(app_name)
    if err:
        return err
    return _ok(_mask(settings_manager.load_default_app_settings(app)))


@api_v1.route("/config/<app_name>/reset", methods=["POST"])
@require_api_key("write")
def reset_config(app_name):
    app, err = _app_or_error(app_name)
    if err:
        return err
    defaults = settings_manager.load_default_app_settings(app)
    if settings_manager.save_settings(app, defaults):
        return _ok(_mask(settings_manager.load_settings(app)))
    return _err("save_failed", "Could not reset settings.", 500)


# --- status ----------------------------------------------------------------

@api_v1.route("/status", methods=["GET"])
@require_api_key("read")
def status():
    configured = settings_manager.get_configured_apps()
    apps = [a for a in settings_manager.KNOWN_APP_TYPES if a not in ("general", "swaparr")]
    return _ok({a: {"configured": a in configured} for a in apps})


# --- swaparr ---------------------------------------------------------------

@api_v1.route("/swaparr", methods=["GET"])
@require_api_key("read")
def get_swaparr():
    return _ok(_mask(settings_manager.load_settings("swaparr")))


@api_v1.route("/swaparr", methods=["PATCH"])
@require_api_key("write")
def patch_swaparr():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _err("unprocessable", "Body must be a JSON object.", 422)
    merged = settings_manager.load_settings("swaparr")
    merged.update(body)
    if settings_manager.save_settings("swaparr", merged):
        return _ok(settings_manager.load_settings("swaparr"))
    return _err("save_failed", "Could not save swaparr settings.", 500)


# --- stateful --------------------------------------------------------------

@api_v1.route("/stateful", methods=["GET"])
@require_api_key("read")
def get_stateful():
    from src.primary.stateful_manager import get_stateful_management_info
    return _ok(get_stateful_management_info())


@api_v1.route("/stateful/reset", methods=["POST"])
@require_api_key("admin")
def reset_stateful():
    from src.primary.stateful_manager import reset_stateful_management
    return _ok({"reset": bool(reset_stateful_management())})


# --- cycle control ---------------------------------------------------------

@api_v1.route("/cycles/<app_name>/reset", methods=["POST"])
@require_api_key("write")
def reset_cycle(app_name):
    app, err = _app_or_error(app_name)
    if err:
        return err
    try:
        import pathlib
        import time
        reset_dir = pathlib.Path(os.getenv("SNAGARR_RESET_DIR", "/config/reset"))
        reset_dir.mkdir(parents=True, exist_ok=True)
        (reset_dir / f"{app}.reset").write_text(str(int(time.time())))
        return _ok({"app": app, "cycle_reset_requested": True})
    except Exception as e:
        return _err("reset_failed", str(e), 500)


# --- API key management (admin) --------------------------------------------

@api_v1.route("/keys", methods=["GET"])
@require_api_key("admin")
def list_api_keys():
    return _ok(api_keys.list_keys())


@api_v1.route("/keys", methods=["POST"])
@require_api_key("admin")
def create_api_key():
    body = request.get_json(silent=True) or {}
    label = body.get("label", "unnamed")
    scope = body.get("scope", "read")
    if scope not in api_keys.SCOPES:
        return _err("unprocessable", f"scope must be one of {list(api_keys.SCOPES)}", 422)
    key = api_keys.create_key(label, scope)
    # The plaintext key is returned ONCE and never retrievable again.
    return _ok({"label": label, "scope": scope, "key": key, "note": "Store this now; it cannot be shown again."}, 201)


@api_v1.route("/keys/<key_id>", methods=["DELETE"])
@require_api_key("admin")
def delete_api_key(key_id):
    return _ok({"revoked": bool(api_keys.revoke_key(key_id))})
