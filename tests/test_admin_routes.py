"""
Unit tests for the admin hub blueprint (src/primary/routes/admin_routes.py).

Authentication is exercised via the REAL auth module: test tokens are inserted
directly into auth.active_sessions so verify_session / get_role_from_session
return the correct values without needing monkeypatching.

Deps (oidc_config, api_keys, settings_manager) are replaced on the admin_routes
module object so the routes work without hitting the filesystem.

RBAC contract under test:
  - Unauthenticated sessions -> 401
  - Member sessions -> 403
  - Admin sessions -> 200 / expected payload
"""

import json
import logging
import os
import sys
import tempfile
import time
import types
from unittest.mock import MagicMock

import pytest

# ---- env vars must be set before any snagarr imports ----------------------

os.environ.setdefault("SNAGARR_CONFIG_DIR", tempfile.mkdtemp())
os.environ.setdefault("SNAGARR_USER_DIR", tempfile.mkdtemp())
os.environ.setdefault("SNAGARR_API_DIR", tempfile.mkdtemp())

# ---- stub logger so importing auth/oidc_config doesn't create /config/logs -

_fake_logger = logging.getLogger("test-admin")
_logmod = types.ModuleType("src.primary.utils.logger")
_logmod.logger = _fake_logger  # type: ignore[attr-defined]
_logmod.get_logger = lambda _app_type="": _fake_logger  # type: ignore[attr-defined]
_logmod.debug_log = lambda *_a, **_kw: None  # type: ignore[attr-defined]
sys.modules.setdefault("src.primary.utils.logger", _logmod)

# ---- imports (after env + logger stubs are in place) ----------------------

from flask import Flask  # noqa: E402

import src.primary.auth as _auth  # noqa: E402
from src.primary.routes.admin_routes import admin_bp  # noqa: E402
import src.primary.routes.admin_routes as _ar  # noqa: E402

# ---- shared test constants -------------------------------------------------

ADMIN_TOKEN = "test-admin-session-token"
MEMBER_TOKEN = "test-member-session-token"
COOKIE_NAME = _auth.SESSION_COOKIE_NAME  # "snagarr_session"

_PROVIDERS = []
_KEYS = []


# ---- fixtures -------------------------------------------------------------

@pytest.fixture(autouse=True)
def _setup_sessions():
    """Insert real sessions so verify_session / get_role_from_session work."""
    _auth.active_sessions[ADMIN_TOKEN] = {
        "user": "admin@test.com",
        "role": "admin",
        "expires_at": time.time() + 3600,
    }
    _auth.active_sessions[MEMBER_TOKEN] = {
        "user": "member@test.com",
        "role": "member",
        "expires_at": time.time() + 3600,
    }
    yield
    _auth.active_sessions.pop(ADMIN_TOKEN, None)
    _auth.active_sessions.pop(MEMBER_TOKEN, None)


@pytest.fixture(autouse=True)
def _patch_deps(monkeypatch):
    """Replace oidc_config / api_keys / settings_manager on admin_routes."""

    def _load_providers():
        return list(_PROVIDERS)

    def _save_providers(lst):
        _PROVIDERS[:] = lst
        return True

    def _get_provider(name):
        return next((p for p in _PROVIDERS if p.get("name") == name), None)

    def _mask_provider(p):
        return {k: v for k, v in p.items() if k != "client_secret"}

    def _merge_secret(incoming, stored):
        return dict(incoming)

    def _list_keys():
        return list(_KEYS)

    def _create_key(label, scope="read"):
        return "testkey-" + label

    def _revoke_key(key_id):
        for k in list(_KEYS):
            if k.get("id") == key_id:
                _KEYS.remove(k)
                return True
        return False

    def _load_settings(app, **_):
        if app == "general":
            return {"proxy_auth_bypass": False, "local_access_bypass": False}
        return {}

    oc = MagicMock()
    oc.load_providers = _load_providers
    oc.save_providers = _save_providers
    oc.get_provider = _get_provider
    oc.mask_provider = _mask_provider
    oc.merge_provider_secret = _merge_secret

    ak = MagicMock()
    ak.list_keys = _list_keys
    ak.create_key = _create_key
    ak.revoke_key = _revoke_key

    sm = MagicMock()
    sm.load_settings = _load_settings

    monkeypatch.setattr(_ar, "oidc_config", oc)
    monkeypatch.setattr(_ar, "api_keys", ak)
    monkeypatch.setattr(_ar, "settings_manager", sm)


@pytest.fixture(autouse=True)
def _reset_stores():
    _PROVIDERS.clear()
    _KEYS.clear()
    yield


@pytest.fixture
def client():
    app = Flask(__name__, template_folder=None)
    app.config["TESTING"] = True
    app.secret_key = "test-secret"
    app.register_blueprint(admin_bp)
    return app.test_client()


# ---- helpers ---------------------------------------------------------------

def _get(client, path, token=None):
    headers = {}
    if token:
        headers["Cookie"] = f"{COOKIE_NAME}={token}"
    return client.get(path, headers=headers)


def _post(client, path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Cookie"] = f"{COOKIE_NAME}={token}"
    return client.post(path, data=json.dumps(body or {}), headers=headers)


def _delete(client, path, token=None):
    headers = {}
    if token:
        headers["Cookie"] = f"{COOKIE_NAME}={token}"
    return client.delete(path, headers=headers)


# ---- /api/admin/summary ----------------------------------------------------

def test_summary_unauthenticated(client):
    r = _get(client, "/api/admin/summary")
    assert r.status_code == 401


def test_summary_member_forbidden(client):
    r = _get(client, "/api/admin/summary", token=MEMBER_TOKEN)
    assert r.status_code == 403


def test_summary_admin_ok(client):
    r = _get(client, "/api/admin/summary", token=ADMIN_TOKEN)
    assert r.status_code == 200
    d = r.get_json()
    assert "version" in d
    assert "sso_provider_count" in d
    assert "api_key_count" in d


# ---- /api/admin/sso-providers ----------------------------------------------

def test_sso_list_unauthenticated(client):
    assert _get(client, "/api/admin/sso-providers").status_code == 401


def test_sso_list_member_forbidden(client):
    assert _get(client, "/api/admin/sso-providers", token=MEMBER_TOKEN).status_code == 403


def test_sso_list_admin_empty(client):
    r = _get(client, "/api/admin/sso-providers", token=ADMIN_TOKEN)
    assert r.status_code == 200
    assert r.get_json() == {"providers": []}


def test_sso_upsert_missing_name(client):
    r = _post(client, "/api/admin/sso-providers", {"client_id": "abc"}, token=ADMIN_TOKEN)
    assert r.status_code == 400


def test_sso_upsert_ok(client):
    r = _post(
        client,
        "/api/admin/sso-providers",
        {"name": "entra", "client_id": "cid", "provider_type": "entra"},
        token=ADMIN_TOKEN,
    )
    assert r.status_code == 200
    assert r.get_json()["success"] is True
    assert any(p["name"] == "entra" for p in _PROVIDERS)


def test_sso_delete_not_found(client):
    assert _delete(client, "/api/admin/sso-providers/nonexistent", token=ADMIN_TOKEN).status_code == 404


def test_sso_delete_ok(client):
    _PROVIDERS.append({"name": "entra", "client_id": "cid"})
    r = _delete(client, "/api/admin/sso-providers/entra", token=ADMIN_TOKEN)
    assert r.status_code == 200
    assert r.get_json()["success"] is True
    assert not any(p["name"] == "entra" for p in _PROVIDERS)


def test_sso_member_cannot_upsert(client):
    r = _post(client, "/api/admin/sso-providers", {"name": "e", "client_id": "x"}, token=MEMBER_TOKEN)
    assert r.status_code == 403


# ---- /api/admin/keys -------------------------------------------------------

def test_keys_list_unauthenticated(client):
    assert _get(client, "/api/admin/keys").status_code == 401


def test_keys_list_admin_empty(client):
    r = _get(client, "/api/admin/keys", token=ADMIN_TOKEN)
    assert r.status_code == 200
    assert r.get_json() == {"keys": []}


def test_keys_create_missing_label(client):
    assert _post(client, "/api/admin/keys", {"scope": "read"}, token=ADMIN_TOKEN).status_code == 400


def test_keys_create_bad_scope(client):
    assert _post(client, "/api/admin/keys", {"label": "x", "scope": "admin"}, token=ADMIN_TOKEN).status_code == 400


def test_keys_create_ok(client):
    r = _post(client, "/api/admin/keys", {"label": "hermes", "scope": "read"}, token=ADMIN_TOKEN)
    assert r.status_code == 200
    d = r.get_json()
    assert d["success"] is True
    assert d["key"].startswith("testkey-")


def test_keys_revoke_not_found(client):
    assert _delete(client, "/api/admin/keys/does-not-exist", token=ADMIN_TOKEN).status_code == 404


def test_keys_member_cannot_create(client):
    r = _post(client, "/api/admin/keys", {"label": "x", "scope": "read"}, token=MEMBER_TOKEN)
    assert r.status_code == 403
