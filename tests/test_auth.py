"""
Tests for the Phase 4 auth hardening:
- passwords are hashed with bcrypt,
- legacy SHA-256 hashes still verify and are transparently upgraded on login,
- the Flask secret key is generated once and persisted.

auth.py hardcodes /config/user (now SNAGARR_USER_DIR-overridable) and imports the
logger at module load, so the logger is stubbed and the user dir is redirected
to a tmp path before import.
"""

import hashlib
import importlib
import json
import logging
import os
import secrets
import sys
import types


def load_auth(tmp_path):
    os.environ["SNAGARR_USER_DIR"] = str(tmp_path / "user")
    os.environ.pop("SECRET_KEY", None)  # exercise the persist path, not the env override

    # Stub the logger so importing auth does not create /config/logs.
    fake_logger_mod = types.ModuleType("src.primary.utils.logger")
    fake_logger_mod.logger = logging.getLogger("test-auth")
    sys.modules["src.primary.utils.logger"] = fake_logger_mod

    sys.modules.pop("src.primary.auth", None)
    from src.primary import auth
    importlib.reload(auth)
    return auth


def _legacy_hash(password):
    salt = secrets.token_hex(16)
    return f"{salt}:{hashlib.sha256((password + salt).encode()).hexdigest()}"


def test_hash_password_is_bcrypt(tmp_path):
    auth = load_auth(tmp_path)
    h = auth.hash_password("s3cret-pw")
    assert h.startswith("$2"), "password hash must be bcrypt"
    assert auth.verify_password(h, "s3cret-pw") is True
    assert auth.verify_password(h, "wrong") is False


def test_legacy_hash_detection_and_verify(tmp_path):
    auth = load_auth(tmp_path)
    legacy = _legacy_hash("old-pw")
    assert auth.is_legacy_password_hash(legacy) is True
    assert auth.is_legacy_password_hash(auth.hash_password("x")) is False
    assert auth.verify_password(legacy, "old-pw") is True
    assert auth.verify_password(legacy, "nope") is False


def test_create_and_verify_user(tmp_path):
    auth = load_auth(tmp_path)
    assert auth.create_user("alice", "correct horse") is True
    ok, needs_2fa = auth.verify_user("alice", "correct horse")
    assert ok is True and needs_2fa is False
    ok, _ = auth.verify_user("alice", "bad")
    assert ok is False


def test_legacy_password_upgraded_to_bcrypt_on_login(tmp_path):
    auth = load_auth(tmp_path)
    # Seed a credentials file with a legacy SHA-256 password hash.
    creds = {
        "username": auth.hash_username("bob"),
        "password": _legacy_hash("hunter2"),
        "created_at": 0,
        "2fa_enabled": False,
        "2fa_secret": None,
    }
    auth.USER_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(auth.USER_FILE, "w") as f:
        json.dump(creds, f)

    ok, _ = auth.verify_user("bob", "hunter2")
    assert ok is True
    # The stored hash must now be bcrypt, and still verify.
    with open(auth.USER_FILE) as f:
        stored = json.load(f)["password"]
    assert stored.startswith("$2"), "legacy hash should have been upgraded to bcrypt"
    assert auth.is_legacy_password_hash(stored) is False


def test_secret_key_is_persisted(tmp_path):
    auth = load_auth(tmp_path)
    k1 = auth.get_or_create_secret_key()
    k2 = auth.get_or_create_secret_key()
    assert k1 == k2 and len(k1) >= 32
    assert auth.SECRET_KEY_FILE.exists()
