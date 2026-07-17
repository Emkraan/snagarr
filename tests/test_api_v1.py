"""
Integration tests for the /api/v1 surface via a Flask test client.

settings_manager and the logger are stubbed once (before importing the app
modules) so the blueprint mounts without touching /config. The api_keys store is
pointed at a per-test tmp dir, and the stubbed settings live in a mutable dict
reset per test. No module reloading, so the module the decorator closes over and
the one the test mints keys with are always the same object.
"""

import logging
import os
import sys
import tempfile
import types

import pytest

# --- one-time stubs, before importing the app modules ----------------------
os.environ.setdefault("SNAGARR_USER_DIR", tempfile.mkdtemp())
os.environ.setdefault("SNAGARR_API_DIR", tempfile.mkdtemp())

_logmod = types.ModuleType("src.primary.utils.logger")
_logmod.logger = logging.getLogger("t")
_logmod.get_logger = lambda name="": logging.getLogger("t")
sys.modules["src.primary.utils.logger"] = _logmod

_STORE = {}
_sm = types.ModuleType("src.primary.settings_manager")
_sm.KNOWN_APP_TYPES = ["sonarr", "radarr", "general", "swaparr"]
_sm.load_settings = lambda app, use_cache=True: dict(_STORE.get(app, {}))
_sm.save_settings = lambda app, data: (_STORE.__setitem__(app, data) or True)
_sm.get_all_settings = lambda: {k: dict(v) for k, v in _STORE.items()}
_sm.get_configured_apps = lambda: [a for a in _STORE if _STORE[a].get("instances")]
_sm.load_default_app_settings = lambda app: {"_default": True, "app": app}
sys.modules["src.primary.settings_manager"] = _sm

from flask import Flask  # noqa: E402
from src.primary.routes import api_v1 as api_v1_mod  # noqa: E402
from src.primary import api_keys as ak  # noqa: E402


@pytest.fixture
def client(tmp_path):
    # Fresh, isolated key store per test.
    ak.API_DIR = tmp_path / "api"
    ak.KEYS_FILE = ak.API_DIR / "keys.json"
    # Reset the in-memory settings store per test.
    _STORE.clear()
    _STORE.update({
        "sonarr": {"instances": [{"name": "Main", "api_url": "http://x", "api_key": "SECRETKEY123", "enabled": True}],
                   "hunt_missing_items": 3},
        "general": {"proxy_auth_bypass": False, "oidc_client_secret": "topsecretvalue"},
        "swaparr": {"enabled": True, "max_strikes": 96},
    })
    app = Flask(__name__)
    app.secret_key = "test"
    app.register_blueprint(api_v1_mod.api_v1)
    c = app.test_client()
    c._ak = ak
    return c


def test_health_is_public(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True and body["data"]["status"] == "ok"


def test_config_requires_auth(client):
    r = client.get("/api/v1/config")
    assert r.status_code == 401
    assert r.get_json()["error"]["code"] == "unauthorized"


def test_read_key_can_get_but_not_write(client):
    read_key = client._ak.create_key("ro", "read")
    hdr = {"Authorization": f"Bearer {read_key}"}

    r = client.get("/api/v1/config/sonarr", headers=hdr)
    assert r.status_code == 200
    data = r.get_json()["data"]
    assert data["instances"][0]["api_key"].endswith("Y123")
    assert "SECRETKEY" not in data["instances"][0]["api_key"]

    r = client.put("/api/v1/config/sonarr", headers=hdr, json={"hunt_missing_items": 5})
    assert r.status_code == 403


def test_write_key_can_patch(client):
    wkey = client._ak.create_key("rw", "write")
    hdr = {"Authorization": f"Bearer {wkey}"}
    r = client.patch("/api/v1/config/sonarr", headers=hdr, json={"hunt_missing_items": 7})
    assert r.status_code == 200
    assert _STORE["sonarr"]["hunt_missing_items"] == 7


def test_unknown_app_404(client):
    key = client._ak.create_key("ro", "read")
    r = client.get("/api/v1/config/bogus", headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 404


def test_general_secret_masked(client):
    key = client._ak.create_key("ro", "read")
    r = client.get("/api/v1/config/general", headers={"Authorization": f"Bearer {key}"})
    assert "topsecret" not in r.get_json()["data"]["oidc_client_secret"]


def test_key_management_needs_admin(client):
    wkey = client._ak.create_key("rw", "write")
    r = client.get("/api/v1/keys", headers={"Authorization": f"Bearer {wkey}"})
    assert r.status_code == 403
    akey = client._ak.create_key("adm", "admin")
    r = client.post("/api/v1/keys", headers={"Authorization": f"Bearer {akey}"}, json={"label": "new", "scope": "read"})
    assert r.status_code == 201
    assert r.get_json()["data"]["key"].startswith("snag_")
