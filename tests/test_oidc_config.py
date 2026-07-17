"""
Unit tests for the dedicated OIDC config store and the secret-handling rules
that guard it: sentinel masking, preserve-unless-changed on write, and the
config-hash change that drives live Authlib re-registration.

Follows the existing stub style: the logger and settings_manager are stubbed in
sys.modules before importing the app modules, and the OIDC store is redirected
to a per-test tmp dir so nothing touches /config.
"""

import json
import logging
import os
import stat
import sys
import tempfile
import types

import pytest

# --- one-time stubs, before importing the app modules ----------------------
os.environ.setdefault("SNAGARR_USER_DIR", tempfile.mkdtemp())
os.environ.setdefault("SNAGARR_CONFIG_DIR", tempfile.mkdtemp())

_logmod = types.ModuleType("src.primary.utils.logger")
_logmod.logger = logging.getLogger("t")
_logmod.get_logger = lambda name="": logging.getLogger("t")
sys.modules.setdefault("src.primary.utils.logger", _logmod)

_STORE = {}
_sm = sys.modules.get("src.primary.settings_manager")
if _sm is None:
    _sm = types.ModuleType("src.primary.settings_manager")
    _sm.KNOWN_APP_TYPES = ["sonarr", "radarr", "general", "swaparr"]
    _sm.load_settings = lambda app, use_cache=True: dict(_STORE.get(app, {}))
    _sm.save_settings = lambda app, data: (_STORE.__setitem__(app, data) or True)
    _sm.get_all_settings = lambda: {k: dict(v) for k, v in _STORE.items()}
    _sm.get_configured_apps = lambda: []
    _sm.load_default_app_settings = lambda app: {}
    sys.modules["src.primary.settings_manager"] = _sm

from src.primary import oidc_config  # noqa: E402
from src.primary.routes import api_v1 as api_v1_mod  # noqa: E402


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Redirect the OIDC store to a per-test tmp file."""
    monkeypatch.setattr(oidc_config, "USER_DIR", tmp_path)
    monkeypatch.setattr(oidc_config, "OIDC_FILE", tmp_path / "oidc.json")
    return tmp_path


# --- store round-trip + permissions ---------------------------------------

def test_sentinel_is_not_derived_from_a_secret():
    # The sentinel must be a fixed placeholder, never any part of a real secret.
    assert oidc_config.SECRET_SENTINEL == "__SNAGARR_OIDC_SECRET_SET__"


def test_load_missing_returns_empty(store):
    assert oidc_config.load_oidc_config() == {}


def test_save_then_load_round_trip(store):
    payload = {
        "oidc_tenant_id": "t-123",
        "oidc_client_id": "c-456",
        "oidc_client_secret": "sekret",
        "oidc_allowed_groups": ["g1"],
        "oidc_admin_groups": [],
    }
    assert oidc_config.save_oidc_config(payload) is True
    assert oidc_config.load_oidc_config() == payload


def test_saved_file_is_0600(store):
    oidc_config.save_oidc_config({"oidc_client_secret": "x"})
    mode = stat.S_IMODE(os.stat(oidc_config.OIDC_FILE).st_mode)
    assert mode == 0o600


def test_load_bad_json_returns_empty(store):
    oidc_config.OIDC_FILE.write_text("{ not json")
    assert oidc_config.load_oidc_config() == {}


# --- config_hash change ----------------------------------------------------

def test_config_hash_stable_for_same_input():
    a = {"tenant": "t", "client_id": "c", "client_secret": "s", "metadata_url": "m"}
    assert oidc_config.config_hash(a) == oidc_config.config_hash(dict(a))


def test_config_hash_changes_when_secret_changes():
    base = {"tenant": "t", "client_id": "c", "client_secret": "s1", "metadata_url": "m"}
    changed = {**base, "client_secret": "s2"}
    assert oidc_config.config_hash(base) != oidc_config.config_hash(changed)


def test_config_hash_changes_when_tenant_changes():
    base = {"tenant": "t1", "client_id": "c", "client_secret": "s", "metadata_url": "m1"}
    changed = {"tenant": "t2", "client_id": "c", "client_secret": "s", "metadata_url": "m2"}
    assert oidc_config.config_hash(base) != oidc_config.config_hash(changed)


# --- sentinel masking (api_v1._mask) ---------------------------------------

def test_mask_replaces_client_secret_with_sentinel():
    masked = api_v1_mod._mask({"oidc_client_secret": "topsecretvalue"})
    assert masked["oidc_client_secret"] == oidc_config.SECRET_SENTINEL
    assert "topsecret" not in masked["oidc_client_secret"]


def test_mask_empty_secret_stays_empty():
    masked = api_v1_mod._mask({"client_secret": ""})
    assert masked["client_secret"] == ""


def test_mask_api_key_keeps_last4():
    masked = api_v1_mod._mask({"api_key": "SECRETKEY123"})
    assert masked["api_key"].endswith("Y123")
    assert "SECRETKEY" not in masked["api_key"]


# --- preserve-unless-changed (api_v1._preserve_secrets) --------------------

def test_preserve_sentinel_keeps_stored_secret(monkeypatch):
    monkeypatch.setattr(api_v1_mod.settings_manager, "load_settings",
                        lambda app, use_cache=True: {"oidc_client_secret": "stored-real"})
    body = api_v1_mod._preserve_secrets("general", {"oidc_client_secret": oidc_config.SECRET_SENTINEL})
    assert body["oidc_client_secret"] == "stored-real"


def test_preserve_empty_keeps_stored_secret(monkeypatch):
    monkeypatch.setattr(api_v1_mod.settings_manager, "load_settings",
                        lambda app, use_cache=True: {"oidc_client_secret": "stored-real"})
    body = api_v1_mod._preserve_secrets("general", {"oidc_client_secret": ""})
    assert body["oidc_client_secret"] == "stored-real"


def test_preserve_new_value_overwrites(monkeypatch):
    monkeypatch.setattr(api_v1_mod.settings_manager, "load_settings",
                        lambda app, use_cache=True: {"oidc_client_secret": "stored-real"})
    body = api_v1_mod._preserve_secrets("general", {"oidc_client_secret": "brand-new"})
    assert body["oidc_client_secret"] == "brand-new"


def test_preserve_sentinel_with_no_stored_drops_key(monkeypatch):
    monkeypatch.setattr(api_v1_mod.settings_manager, "load_settings",
                        lambda app, use_cache=True: {})
    body = api_v1_mod._preserve_secrets("general", {"oidc_client_secret": oidc_config.SECRET_SENTINEL})
    assert "oidc_client_secret" not in body
