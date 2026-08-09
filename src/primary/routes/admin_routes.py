#!/usr/bin/env python3
"""
Admin hub blueprint.

Provides a dedicated management surface for administrative operations:
  GET  /admin                       - admin hub page (admin role required)
  GET  /api/admin/summary           - system + connection summary (JSON)
  GET  /api/admin/sso-providers     - list OIDC providers (masked secrets)
  POST /api/admin/sso-providers     - upsert an OIDC provider
  DELETE /api/admin/sso-providers/<name>  - remove a provider

All endpoints require an authenticated admin session. Members receive 403.
"""

import pathlib
from flask import Blueprint, jsonify, render_template, request
from ..auth import SESSION_COOKIE_NAME, get_role_from_session, verify_session
from ..utils.logger import logger
from .. import oidc_config, api_keys, settings_manager

admin_bp = Blueprint("admin", __name__)

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent


def _require_admin():
    """Return (session_token, None) or (None, 403-response)."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not verify_session(token):
        return None, (jsonify({"error": "Not authenticated"}), 401)
    if get_role_from_session(token) != "admin":
        return None, (jsonify({"error": "Admin access required"}), 403)
    return token, None


# ---------------------------------------------------------------------------
# Admin hub page
# ---------------------------------------------------------------------------

@admin_bp.route("/admin")
def admin_hub():
    """Admin hub - rendered for admin sessions only; members get 403."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not verify_session(token):
        from flask import redirect, url_for
        return redirect(url_for("common.login_route"))
    if get_role_from_session(token) != "admin":
        return render_template("403.html"), 403
    return render_template("admin.html")


# ---------------------------------------------------------------------------
# System summary
# ---------------------------------------------------------------------------

@admin_bp.route("/api/admin/summary")
def admin_summary():
    _, err = _require_admin()
    if err:
        return err

    version = "unknown"
    build = "unknown"
    try:
        vf = _REPO_ROOT / "VERSION"
        if vf.exists():
            version = vf.read_text().strip()
        bf = _REPO_ROOT / "BUILD"
        if bf.exists():
            build = bf.read_text().strip()
    except Exception:
        pass

    # Configured connections summary.
    apps_configured = {}
    for app_name in ("sonarr", "radarr", "lidarr", "readarr", "whisparr", "swaparr", "eros"):
        try:
            s = settings_manager.load_settings(app_name)
            instances = s.get("instances") or s.get(f"{app_name}_instances") or []
            apps_configured[app_name] = len(instances)
        except Exception:
            apps_configured[app_name] = 0

    provider_count = len(oidc_config.load_providers())
    key_count = len(api_keys.list_keys())

    general = settings_manager.load_settings("general")
    auth_mode = "login"
    if general.get("proxy_auth_bypass"):
        auth_mode = "no_login"
    elif general.get("local_access_bypass"):
        auth_mode = "local_bypass"

    return jsonify({
        "version": version,
        "build": build,
        "auth_mode": auth_mode,
        "sso_provider_count": provider_count,
        "api_key_count": key_count,
        "apps_configured": apps_configured,
    })


# ---------------------------------------------------------------------------
# SSO provider management
# ---------------------------------------------------------------------------

@admin_bp.route("/api/admin/sso-providers", methods=["GET"])
def list_sso_providers():
    _, err = _require_admin()
    if err:
        return err
    providers = [oidc_config.mask_provider(p) for p in oidc_config.load_providers()]
    return jsonify({"providers": providers})


@admin_bp.route("/api/admin/sso-providers", methods=["POST"])
def upsert_sso_provider():
    _, err = _require_admin()
    if err:
        return err

    data = request.get_json(force=True) or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"success": False, "error": "Provider name is required"}), 400

    existing_providers = oidc_config.load_providers()
    stored = oidc_config.get_provider(name)
    merged = oidc_config.merge_provider_secret(data, stored)

    updated = [p if p.get("name") != name else merged for p in existing_providers]
    if not any(p.get("name") == name for p in existing_providers):
        updated.append(merged)

    if oidc_config.save_providers(updated):
        logger.info(f"Admin upserted SSO provider: {name}")
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "Failed to save provider"}), 500


@admin_bp.route("/api/admin/sso-providers/<name>", methods=["DELETE"])
def delete_sso_provider(name):
    _, err = _require_admin()
    if err:
        return err

    providers = oidc_config.load_providers()
    updated = [p for p in providers if p.get("name") != name]
    if len(updated) == len(providers):
        return jsonify({"success": False, "error": "Provider not found"}), 404

    if oidc_config.save_providers(updated):
        logger.info(f"Admin deleted SSO provider: {name}")
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "Failed to delete provider"}), 500


# ---------------------------------------------------------------------------
# API key management
# ---------------------------------------------------------------------------

@admin_bp.route("/api/admin/keys", methods=["GET"])
def list_api_keys():
    _, err = _require_admin()
    if err:
        return err
    return jsonify({"keys": api_keys.list_keys()})


@admin_bp.route("/api/admin/keys", methods=["POST"])
def create_api_key():
    _, err = _require_admin()
    if err:
        return err

    data = request.get_json(force=True) or {}
    label = data.get("label", "").strip()
    scope = data.get("scope", "read")
    if not label:
        return jsonify({"success": False, "error": "Label is required"}), 400
    if scope not in ("read", "write"):
        return jsonify({"success": False, "error": "scope must be 'read' or 'write'"}), 400

    key = api_keys.create_key(label, scope)
    logger.info(f"Admin created API key: {label} ({scope})")
    return jsonify({"success": True, "key": key})


@admin_bp.route("/api/admin/keys/<key_id>", methods=["DELETE"])
def revoke_api_key(key_id):
    _, err = _require_admin()
    if err:
        return err

    if api_keys.revoke_key(key_id):
        logger.info(f"Admin revoked API key: {key_id}")
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "Key not found"}), 404
