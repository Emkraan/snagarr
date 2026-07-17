#!/usr/bin/env python3
"""
Bearer API keys for the programmatic /api/v1 surface.

Keys are high-entropy random tokens shown once at creation; only a SHA-256 hash
is stored (no brute-force risk given the entropy, so no bcrypt needed). Each key
carries a scope: read < write < admin.
"""

import os
import json
import time
import secrets
import hashlib
import tempfile
import pathlib
import threading
from typing import Optional, Dict, Any, List

API_DIR = pathlib.Path(os.getenv("SNAGARR_API_DIR") or os.path.join(os.getenv("SNAGARR_CONFIG_DIR", "/config"), "api"))
KEYS_FILE = API_DIR / "keys.json"
KEY_PREFIX = "snag_"
SCOPES = {"read": 1, "write": 2, "admin": 3}

_LOCK = threading.RLock()


def _atomic_write(path: pathlib.Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _load() -> List[Dict[str, Any]]:
    if not KEYS_FILE.exists():
        return []
    try:
        with open(KEYS_FILE) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def scope_satisfies(have: str, need: str) -> bool:
    return SCOPES.get(have, 0) >= SCOPES.get(need, 99)


def create_key(label: str, scope: str = "read") -> str:
    """Create a key and return the plaintext ONCE (only its hash is stored)."""
    if scope not in SCOPES:
        raise ValueError(f"invalid scope: {scope}")
    key = KEY_PREFIX + secrets.token_urlsafe(32)
    record = {
        "id": secrets.token_hex(8),
        "label": label or "unnamed",
        "scope": scope,
        "hash": _hash(key),
        "created_at": int(time.time()),
    }
    with _LOCK:
        keys = _load()
        keys.append(record)
        _atomic_write(KEYS_FILE, keys)
    return key


def list_keys() -> List[Dict[str, Any]]:
    """Return key metadata (never the hash or plaintext)."""
    with _LOCK:
        return [{k: v for k, v in rec.items() if k != "hash"} for rec in _load()]


def revoke_key(key_id: str) -> bool:
    with _LOCK:
        keys = _load()
        remaining = [k for k in keys if k.get("id") != key_id]
        if len(remaining) == len(keys):
            return False
        _atomic_write(KEYS_FILE, remaining)
        return True


def verify_key(presented: str) -> Optional[Dict[str, Any]]:
    """Return the key record (incl. scope) if the presented token matches, else None."""
    if not presented:
        return None
    h = _hash(presented.strip())
    with _LOCK:
        for rec in _load():
            if secrets.compare_digest(rec.get("hash", ""), h):
                return {k: v for k, v in rec.items() if k != "hash"}
    return None
