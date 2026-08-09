"""
Unit tests for the admin hub blueprint (src/primary/routes/admin_routes.py).

Uses unittest.mock.patch to stub auth/oidc_config/api_keys without fighting
Python's import caching. Each test patches what admin_routes.py actually calls
at call-site, ensuring correct isolation regardless of import order.

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
from unittest.mock import MagicMock, patch

import pytest

# ---- pre-import stubs for modules with filesystem side-effects -----------

os.environ.setdefault("SNAGARR_USER_DIR", tempfile.mkdtemp())
os.environ.setdefault("SNAGARR_API_DIR", tempfile.mkdtemp())

_logmod = types.ModuleType("src.primary.utils.logger")
_logmod.logger = logging.getLogger("test-admin")
sys.modules.setdefault("src.primary.utils.logger", _logmod)

# ---- import the blueprint (may drag in real auth/oidc but that's fine) ---
# We'll patch via unittest.mock.patch at the call-site.

from flask import Flask  # noqa: E402
from src.primary.routes.admin_routes import admin_bp  # noqa: E402

# The module object - we patch its names directly in each test.
import src.primary.routes.admin_routes as _ar  # noqa: E402

# ---- shared test state ---------------------------------------------------

_PROVIDERS = []
_KEYS = []

ADMIN_TOKEN = "admin-tok"
MEMBER_TOKEN = "member-tok"
COOKIE_NAME = "snagarr_session"


def _verify_session(tok):
    return tok in (ADMIN_TOKEN, MEMBER_TOKEN)


def _get_role(tok):
    if tok == ADMIN_TOKEN:
        return "admin"
    if tok == MEMBER_TOKEN:
        return "member"
    return None


# ---- fixtures ------------------------------------------------------------

@pytest.fixture(autouse=True)
def _patch_auth(monkeypatch):
    """Patch the bound names inside admin_routes for the duration of each test."""
    monkeypatch.setattr(_ar, "SESSION_COOKIE_NAME", COOKIE_NAME)
    monkeypatch.setattr(_ar, "verify_session", _verify_session)
    monkeypatch.setattr(_ar, "get_role_from_session", _get_role)


@pytest.fixture(autouse=True)
def _patch_deps(monkeypatch):
    """Patch oidc_config, api_keys, settings_manager used by admin_routes."""

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


# ---- helpers -------------------------------------------------------------

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


# ---- /api/admin/summary --------------------------------------------------

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


# ---- /api/admin/sso-providers --------------------------------------------

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


# ---- /api/admin/keys -----------------------------------------------------

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
