"""
Unit tests for the admin hub blueprint (src/primary/routes/admin_routes.py).

Stubs:
  - settings_manager, auth, oidc_config, api_keys, logger
  - Flask test client with a minimal app that mounts only admin_bp

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
import types

import pytest

# ---- stubs (must run before importing the blueprint) ----------------------

os.environ.setdefault("SNAGARR_USER_DIR", tempfile.mkdtemp())
os.environ.setdefault("SNAGARR_API_DIR", tempfile.mkdtemp())

_logmod = types.ModuleType("src.primary.utils.logger")
_logmod.logger = logging.getLogger("test-admin")
sys.modules["src.primary.utils.logger"] = _logmod

# Track which provider/key operations were called.
_PROVIDERS = []
_KEYS = []
_GENERAL = {"auth_mode": "login", "proxy_auth_bypass": False, "local_access_bypass": False}

_sm = types.ModuleType("src.primary.settings_manager")
_sm.load_settings = lambda app, **kw: dict(_GENERAL) if app == "general" else {}
_sm.save_settings = lambda app, data: True
_sm.get_setting = lambda app, key, default=None: _GENERAL.get(key, default)
sys.modules["src.primary.settings_manager"] = _sm

_oc = types.ModuleType("src.primary.oidc_config")
_oc.load_providers = lambda: list(_PROVIDERS)
_oc.save_providers = lambda lst: (_PROVIDERS.__setitem__(slice(None), lst) or True)
_oc.get_provider = lambda name: next((p for p in _PROVIDERS if p.get("name") == name), None)
_oc.mask_provider = lambda p: {k: v for k, v in p.items() if k != "client_secret"}
_oc.merge_provider_secret = lambda incoming, stored: dict(incoming)
_oc.SECRET_SENTINEL = "***"
sys.modules["src.primary.oidc_config"] = _oc

_ak = types.ModuleType("src.primary.api_keys")
_ak.list_keys = lambda: list(_KEYS)
_ak.create_key = lambda label, scope="read": "testkey-" + label
_ak.revoke_key = lambda key_id: any(k for k in _KEYS if k.get("id") == key_id and _KEYS.remove(k) is None)
sys.modules["src.primary.api_keys"] = _ak

# Sessions: map token -> (username, role)
_SESSIONS = {
    "admin-token": ("admin", "admin"),
    "member-token": ("user", "member"),
}

_auth = types.ModuleType("src.primary.auth")
_auth.SESSION_COOKIE_NAME = "snagarr_session"
_auth.verify_session = lambda tok: tok in _SESSIONS
_auth.get_role_from_session = lambda tok: _SESSIONS.get(tok, (None, None))[1]
_auth.get_username_from_session = lambda tok: _SESSIONS.get(tok, (None, None))[0]
sys.modules["src.primary.auth"] = _auth

from flask import Flask  # noqa: E402
from src.primary.routes.admin_routes import admin_bp  # noqa: E402


@pytest.fixture
def client():
    _PROVIDERS.clear()
    _KEYS.clear()
    app = Flask(__name__, template_folder=None)
    app.config["TESTING"] = True
    app.secret_key = "test-secret"
    # Disable template rendering for pure-API tests; the /admin GET tests are
    # separate because they require a real template folder.
    app.register_blueprint(admin_bp)
    return app.test_client()


def _admin_env(c):
    """Set the admin session cookie on the test client."""
    return c.environ_base.update({"HTTP_COOKIE": "snagarr_session=admin-token"}) or c


def _member_env(c):
    return c.environ_base.update({"HTTP_COOKIE": "snagarr_session=member-token"}) or c


# ---- helpers ---------------------------------------------------------------

def _get(client, path, token=None):
    headers = {}
    if token:
        headers["Cookie"] = "snagarr_session=" + token
    return client.get(path, headers=headers)


def _post(client, path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Cookie"] = "snagarr_session=" + token
    return client.post(path, data=json.dumps(body or {}), headers=headers)


def _delete(client, path, token=None):
    headers = {}
    if token:
        headers["Cookie"] = "snagarr_session=" + token
    return client.delete(path, headers=headers)


# ---- /api/admin/summary ---------------------------------------------------

def test_summary_unauthenticated(client):
    r = _get(client, "/api/admin/summary")
    assert r.status_code == 401


def test_summary_member_forbidden(client):
    r = _get(client, "/api/admin/summary", token="member-token")
    assert r.status_code == 403


def test_summary_admin_ok(client):
    r = _get(client, "/api/admin/summary", token="admin-token")
    assert r.status_code == 200
    d = r.get_json()
    assert "version" in d
    assert "sso_provider_count" in d
    assert "api_key_count" in d


# ---- /api/admin/sso-providers --------------------------------------------

def test_sso_list_unauthenticated(client):
    r = _get(client, "/api/admin/sso-providers")
    assert r.status_code == 401


def test_sso_list_member_forbidden(client):
    r = _get(client, "/api/admin/sso-providers", token="member-token")
    assert r.status_code == 403


def test_sso_list_admin_empty(client):
    r = _get(client, "/api/admin/sso-providers", token="admin-token")
    assert r.status_code == 200
    assert r.get_json() == {"providers": []}


def test_sso_upsert_missing_name(client):
    r = _post(client, "/api/admin/sso-providers", {"client_id": "abc"}, token="admin-token")
    assert r.status_code == 400


def test_sso_upsert_ok(client):
    r = _post(client, "/api/admin/sso-providers",
              {"name": "entra", "client_id": "cid", "provider_type": "entra"},
              token="admin-token")
    assert r.status_code == 200
    assert r.get_json()["success"] is True
    assert any(p["name"] == "entra" for p in _PROVIDERS)


def test_sso_delete_not_found(client):
    r = _delete(client, "/api/admin/sso-providers/nonexistent", token="admin-token")
    assert r.status_code == 404


def test_sso_delete_ok(client):
    _PROVIDERS.append({"name": "entra", "client_id": "cid"})
    r = _delete(client, "/api/admin/sso-providers/entra", token="admin-token")
    assert r.status_code == 200
    assert r.get_json()["success"] is True
    assert not any(p["name"] == "entra" for p in _PROVIDERS)


def test_sso_member_cannot_upsert(client):
    r = _post(client, "/api/admin/sso-providers",
              {"name": "entra", "client_id": "x"},
              token="member-token")
    assert r.status_code == 403


# ---- /api/admin/keys -------------------------------------------------------

def test_keys_list_unauthenticated(client):
    r = _get(client, "/api/admin/keys")
    assert r.status_code == 401


def test_keys_list_admin_empty(client):
    r = _get(client, "/api/admin/keys", token="admin-token")
    assert r.status_code == 200
    assert r.get_json() == {"keys": []}


def test_keys_create_missing_label(client):
    r = _post(client, "/api/admin/keys", {"scope": "read"}, token="admin-token")
    assert r.status_code == 400


def test_keys_create_bad_scope(client):
    r = _post(client, "/api/admin/keys", {"label": "mykey", "scope": "admin"}, token="admin-token")
    assert r.status_code == 400


def test_keys_create_ok(client):
    r = _post(client, "/api/admin/keys", {"label": "hermes", "scope": "read"}, token="admin-token")
    assert r.status_code == 200
    d = r.get_json()
    assert d["success"] is True
    assert d["key"].startswith("testkey-")


def test_keys_revoke_not_found(client):
    r = _delete(client, "/api/admin/keys/does-not-exist", token="admin-token")
    # revoke_key returns False -> 404
    assert r.status_code == 404


def test_keys_member_cannot_create(client):
    r = _post(client, "/api/admin/keys", {"label": "x", "scope": "read"}, token="member-token")
    assert r.status_code == 403
