"""
Unit tests for trusted-proxy header authentication (src/primary/auth.py).

Snagarr can run behind a reverse proxy (e.g. an Authentik forward-auth on
Traefik) that has already authenticated the user and forwards their identity as
headers. When proxy_trust_auth is enabled AND the operator confirms a trusted
proxy is in front (TRUST_PROXY_HOPS > 0), authenticate_request trusts those
headers and logs the user in with the matching RBAC role.

Contract under test:
  (a) header present + TRUST_PROXY_HOPS>0 + admin group -> admin, allowed
  (b) header present + non-admin group -> member (a POST is blocked by RBAC)
  (c) proxy_trust_auth on but TRUST_PROXY_HOPS=0 -> NOT authenticated (fail-closed)
  (d) proxy_trust_auth on, TRUST_PROXY_HOPS>0, header MISSING -> NOT authenticated

The REAL auth module is exercised; settings are supplied via a load_settings
mock (mirroring tests/test_admin_routes.py), and user_exists is forced True so
the flow reaches the proxy branch instead of the /setup redirect.
"""

import logging
import os
import sys
import tempfile
import types

import pytest

# ---- env vars must be set before any snagarr imports ----------------------

os.environ.setdefault("SNAGARR_CONFIG_DIR", tempfile.mkdtemp())
os.environ.setdefault("SNAGARR_USER_DIR", tempfile.mkdtemp())
os.environ.setdefault("SNAGARR_API_DIR", tempfile.mkdtemp())

# ---- stub logger so importing auth doesn't create /config/logs ------------

_fake_logger = logging.getLogger("test-proxy-trust")
_logmod = types.ModuleType("src.primary.utils.logger")
_logmod.logger = _fake_logger  # type: ignore[attr-defined]
_logmod.get_logger = lambda _app_type="": _fake_logger  # type: ignore[attr-defined]
_logmod.debug_log = lambda *_a, **_kw: None  # type: ignore[attr-defined]
sys.modules.setdefault("src.primary.utils.logger", _logmod)

# ---- imports (after env + logger stubs are in place) ----------------------

from flask import Flask, g, jsonify

import src.primary.auth as _auth

COOKIE_NAME = _auth.SESSION_COOKIE_NAME  # "snagarr_session"

# Default general settings the auth path sees; individual tests override keys.
_SETTINGS = {
    "proxy_auth_bypass": False,
    "local_access_bypass": False,
    "proxy_trust_auth": True,
    "proxy_username_header": "X-authentik-username",
    "proxy_groups_header": "X-authentik-groups",
    "proxy_groups_separator": "|",
    "proxy_admin_groups": ["snagarr-admins"],
}


@pytest.fixture(autouse=True)
def _patch_env(monkeypatch):
    """Force user_exists True, supply settings, reset the bypass cache."""
    monkeypatch.setattr(_auth, "user_exists", lambda: True)

    def _load_settings(app, **_):
        if app == "general":
            return dict(_SETTINGS)
        return {}

    # authenticate_request imports load_settings from sys.modules at call time;
    # another test module may have installed a stub settings_manager there, so
    # patch whichever module object is currently live.
    sm_mod = sys.modules.get("src.primary.settings_manager")
    if sm_mod is None:
        import src.primary.settings_manager as sm_mod
    monkeypatch.setattr(sm_mod, "load_settings", _load_settings, raising=False)
    # The proxy-bypass decision is cached module-side; reset it per test.
    _auth._proxy_bypass_cache["value"] = None
    _auth._proxy_bypass_cache["expires"] = 0
    _auth.active_sessions.clear()
    yield
    _auth.active_sessions.clear()


@pytest.fixture
def client():
    app = Flask(__name__, template_folder=None)
    app.config["TESTING"] = True
    app.secret_key = "test-secret"
    app.before_request(_auth.authenticate_request)
    app.before_request(_auth.enforce_rbac)

    @app.after_request
    def _set_cookie(resp):
        # Mirror web_server._proxy_trust_set_cookie so the end-to-end cookie
        # persistence is covered here too.
        try:
            token = g.get("snagarr_proxy_token")
        except Exception:
            token = None
        if token:
            resp.set_cookie(COOKIE_NAME, token, httponly=True, samesite="Lax", path="/")
        return resp

    @app.route("/")
    def home():
        return jsonify({"ok": True, "role": _auth.session_role()})

    @app.route("/write", methods=["POST"])
    def write():
        return jsonify({"ok": True, "role": _auth.session_role()})

    return app.test_client()


# ---- (a) admin group -> admin ---------------------------------------------

def test_admin_group_authenticated_as_admin(client, monkeypatch):
    monkeypatch.setattr(_auth, "TRUST_PROXY_HOPS", 1)
    r = client.get("/", headers={
        "X-authentik-username": "richard",
        "X-authentik-groups": "everyone|snagarr-admins",
    })
    assert r.status_code == 200
    body = r.get_json()
    assert body["role"] == "admin"
    # A raw session cookie should have been minted for subsequent requests.
    assert COOKIE_NAME in r.headers.get("Set-Cookie", "")


# ---- (b) non-admin group -> member, write blocked --------------------------

def test_non_admin_group_is_member(client, monkeypatch):
    monkeypatch.setattr(_auth, "TRUST_PROXY_HOPS", 1)
    r = client.get("/", headers={
        "X-authentik-username": "bob",
        "X-authentik-groups": "everyone|readers",
    })
    assert r.status_code == 200
    assert r.get_json()["role"] == "member"


def test_member_write_blocked_by_rbac(client, monkeypatch):
    monkeypatch.setattr(_auth, "TRUST_PROXY_HOPS", 1)
    r = client.post("/write", headers={
        "X-authentik-username": "bob",
        "X-authentik-groups": "readers",
    })
    assert r.status_code == 403


def test_admin_write_allowed(client, monkeypatch):
    monkeypatch.setattr(_auth, "TRUST_PROXY_HOPS", 1)
    r = client.post("/write", headers={
        "X-authentik-username": "richard",
        "X-authentik-groups": "snagarr-admins",
    })
    assert r.status_code == 200
    assert r.get_json()["role"] == "admin"


# ---- (c) fail-closed when TRUST_PROXY_HOPS == 0 ----------------------------

def test_not_authenticated_without_trust_proxy_hops(client, monkeypatch):
    monkeypatch.setattr(_auth, "TRUST_PROXY_HOPS", 0)
    r = client.get("/", headers={
        "X-authentik-username": "richard",
        "X-authentik-groups": "snagarr-admins",
    })
    # Redirected to the local login page; header trust is disabled.
    assert r.status_code == 302
    assert "/login" in r.headers.get("Location", "")


# ---- (d) fail-closed when the username header is missing -------------------

def test_not_authenticated_without_username_header(client, monkeypatch):
    monkeypatch.setattr(_auth, "TRUST_PROXY_HOPS", 1)
    r = client.get("/", headers={
        "X-authentik-groups": "snagarr-admins",
    })
    assert r.status_code == 302
    assert "/login" in r.headers.get("Location", "")


# ---- fail-closed when proxy_trust_auth itself is off -----------------------

def test_not_authenticated_when_mode_disabled(client, monkeypatch):
    monkeypatch.setattr(_auth, "TRUST_PROXY_HOPS", 1)
    monkeypatch.setitem(_SETTINGS, "proxy_trust_auth", False)
    try:
        r = client.get("/", headers={
            "X-authentik-username": "richard",
            "X-authentik-groups": "snagarr-admins",
        })
        assert r.status_code == 302
        assert "/login" in r.headers.get("Location", "")
    finally:
        _SETTINGS["proxy_trust_auth"] = True


# ---- empty admin_groups fails closed (everyone is a member) ----------------

def test_empty_admin_groups_grants_no_admin(client, monkeypatch):
    monkeypatch.setattr(_auth, "TRUST_PROXY_HOPS", 1)
    monkeypatch.setitem(_SETTINGS, "proxy_admin_groups", [])
    try:
        r = client.get("/", headers={
            "X-authentik-username": "richard",
            "X-authentik-groups": "snagarr-admins",
        })
        assert r.status_code == 200
        assert r.get_json()["role"] == "member"
    finally:
        _SETTINGS["proxy_admin_groups"] = ["snagarr-admins"]
