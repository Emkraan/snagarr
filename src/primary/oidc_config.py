#!/usr/bin/env python3
"""
Dedicated at-rest store for OIDC (Entra ID) configuration.

The OIDC client secret must never sit in the broadly-read, 0644 general.json.
This module keeps the sensitive OIDC values in their own file inside the
established secret directory (USER_DIR, the same place the Flask secret key and
local credentials live), written atomically and locked down to 0600.

Only the OIDC values that are secret or config-shaping live here:
tenant id, client id, client secret, allowed groups, admin groups, plus a
derived config_version used to trigger live re-registration of the Authlib
client without a restart. The oidc_enabled toggle stays in general.json because
the hot auth path reads it on every unauthenticated request.
"""

import hashlib
import json
import os
import tempfile

from src.primary.auth import USER_DIR
from src.primary.utils.logger import get_logger

logger = get_logger("oidc_config")

# Placeholder returned in place of a stored secret on every GET, and accepted on
# save to mean "keep the stored secret unchanged". It is not derived from the
# real secret in any way, so it leaks nothing.
SECRET_SENTINEL = "__SNAGARR_OIDC_SECRET_SET__"

OIDC_FILE = USER_DIR / "oidc.json"

# The OIDC value keys this store owns (mirrors what is peeled out of general.json).
OIDC_KEYS = (
    "oidc_tenant_id",
    "oidc_client_id",
    "oidc_client_secret",
    "oidc_allowed_groups",
    "oidc_admin_groups",
)


def load_oidc_config() -> dict:
    """Return the stored OIDC config, or {} if absent/unreadable. Never raises."""
    try:
        if not os.path.exists(OIDC_FILE):
            return {}
        with open(OIDC_FILE, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.error(f"Could not read OIDC config ({OIDC_FILE}): {e}")
        return {}


def save_oidc_config(data: dict) -> bool:
    """Persist the OIDC config atomically, then lock the file to 0600.

    Writes to a temp file in the same directory and os.replace()s it into place
    so a concurrent reader never observes a torn file.
    """
    try:
        USER_DIR.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix=".oidc.", suffix=".tmp", dir=str(USER_DIR))
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            try:
                os.chmod(tmp_path, 0o600)
            except Exception as e:
                logger.warning(f"Could not chmod OIDC temp file: {e}")
            os.replace(tmp_path, OIDC_FILE)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
        try:
            os.chmod(OIDC_FILE, 0o600)
        except Exception as e:
            logger.warning(f"Could not chmod OIDC config file: {e}")
        return True
    except Exception as e:
        logger.error(f"Could not save OIDC config ({OIDC_FILE}): {e}")
        return False


def config_hash(assembled: dict) -> str:
    """sha256 over the identity-bearing fields of an assembled OIDC config.

    A change in tenant, client id, client secret, or metadata URL yields a new
    hash, which the OIDC blueprint uses to re-register the Authlib client live.
    """
    tenant = assembled.get("tenant") or ""
    client_id = assembled.get("client_id") or ""
    client_secret = assembled.get("client_secret") or ""
    metadata_url = assembled.get("metadata_url") or ""
    material = "|".join([tenant, client_id, client_secret, metadata_url])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()
