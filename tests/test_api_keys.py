"""Tests for the bearer API-key store."""

import importlib
import os
import sys


def load_api_keys(tmp_path):
    os.environ["SNAGARR_API_DIR"] = str(tmp_path / "api")
    sys.modules.pop("src.primary.api_keys", None)
    import src.primary.api_keys as ak
    importlib.reload(ak)
    return ak


def test_create_verify_roundtrip(tmp_path):
    ak = load_api_keys(tmp_path)
    key = ak.create_key("ci", "write")
    assert key.startswith("snag_")
    rec = ak.verify_key(key)
    assert rec is not None and rec["scope"] == "write"
    assert "hash" not in rec  # never leak the hash
    assert ak.verify_key("snag_wrong") is None
    assert ak.verify_key("") is None


def test_scope_ordering(tmp_path):
    ak = load_api_keys(tmp_path)
    assert ak.scope_satisfies("admin", "read") is True
    assert ak.scope_satisfies("write", "write") is True
    assert ak.scope_satisfies("read", "write") is False
    assert ak.scope_satisfies("write", "admin") is False


def test_list_and_revoke(tmp_path):
    ak = load_api_keys(tmp_path)
    k = ak.create_key("temp", "read")
    listed = ak.list_keys()
    assert len(listed) == 1 and listed[0]["label"] == "temp"
    assert all("hash" not in row for row in listed)
    kid = listed[0]["id"]
    assert ak.revoke_key(kid) is True
    assert ak.verify_key(k) is None
    assert ak.revoke_key(kid) is False  # already gone


def test_invalid_scope_rejected(tmp_path):
    ak = load_api_keys(tmp_path)
    try:
        ak.create_key("bad", "superuser")
        assert False, "should have raised"
    except ValueError:
        pass
