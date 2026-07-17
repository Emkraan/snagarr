#!/usr/bin/env python3
"""
Dedicated at-rest store for provider-agnostic SSO configuration.

Holds a LIST of SSO provider configs (OIDC presets, generic OIDC, or custom
OAuth2). Client secrets must never sit in the broadly-read 0644 general.json, so
they live here inside the established secret directory (USER_DIR, the same place
the Flask secret key and local credentials live), written atomically and locked
to 0600.

Shape on disk:  {"providers": [ {name, provider_type, client_id, client_secret,
                 ...}, ... ]}

A per-provider config hash drives live re-registration of the Authlib client
without a restart. The oidc_enabled toggle stays in general.json because the hot
auth path reads it on every unauthenticated request.

A legacy single-Entra config (flat oidc_tenant_id/oidc_client_id/... keys, the
v0.1 shape) is transparently migrated in-memory into a one-element provider list
so existing deployments keep working with no operator action.
"""

import hashlib
import json
import os
import tempfile

from src.primary.auth import USER_DIR
from src.primary.utils.logger import get_logger

logger = get_logger("oidc_config")

# Placeholder returned in place of a stored secret on every GET, and accepted on
# save to mean "keep the stored secret unchanged". Not derived from the real
# secret, so it leaks nothing.
SECRET_SENTINEL = "__SNAGARR_OIDC_SECRET_SET__"

OIDC_FILE = USER_DIR / "oidc.json"

# Provider types we understand. `oidc` = generic discovery; `oauth2` = fully
# manual endpoints; the rest are presets that fill defaults under admin values.
PROVIDER_TYPES = ("oidc", "oauth2", "microsoft", "google", "github", "authentik", "keycloak", "okta")

# Fields that identify a provider for the live-re-registration hash. Any change
# here re-registers that provider's Authlib client on the next request.
_HASH_FIELDS = (
    "provider_type", "client_id", "client_secret", "tenant", "issuer",
    "discovery_url", "authorize_url", "token_url", "userinfo_url", "scopes",
)

# Legacy flat keys (v0.1 single-Entra store) recognized for in-memory migration.
_LEGACY_KEYS = ("oidc_tenant_id", "oidc_client_id", "oidc_client_secret",
                "oidc_allowed_groups", "oidc_admin_groups")


def _read() -> dict:
    """Raw stored doc, or {} if absent/unreadable. Never raises."""
    try:
        if not os.path.exists(OIDC_FILE):
            return {}
        with open(OIDC_FILE, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.error(f"Could not read OIDC config ({OIDC_FILE}): {e}")
        return {}


def _write(data: dict) -> bool:
    """Persist atomically, then lock to 0600. Temp file in the same dir + replace
    so a concurrent reader never observes a torn file."""
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


# Back-compat aliases (older callers used these names directly).
def load_oidc_config() -> dict:
    """The full stored doc: {"providers": [...]} (plus any legacy flat keys)."""
    return _read()


def save_oidc_config(data: dict) -> bool:
    return _write(data)


def _legacy_to_provider(d: dict) -> dict | None:
    """Wrap a legacy flat single-Entra config into one microsoft provider."""
    if d.get("oidc_tenant_id") or d.get("oidc_client_id") or d.get("oidc_client_secret"):
        return {
            "name": "microsoft",
            "display_name": "Microsoft Entra ID",
            "provider_type": "microsoft",
            "enabled": True,
            "show_on_login": True,
            "is_default": True,
            "tenant": d.get("oidc_tenant_id", ""),
            "client_id": d.get("oidc_client_id", ""),
            "client_secret": d.get("oidc_client_secret", ""),
            "allowed_groups": d.get("oidc_allowed_groups", []) or [],
            "admin_groups": d.get("oidc_admin_groups", []) or [],
        }
    return None


def load_providers() -> list:
    """The configured provider list. Migrates a legacy flat config in memory."""
    d = _read()
    provs = d.get("providers")
    if isinstance(provs, list):
        return [p for p in provs if isinstance(p, dict) and p.get("name")]
    legacy = _legacy_to_provider(d)
    return [legacy] if legacy else []


def save_providers(providers: list) -> bool:
    """Persist the provider list, dropping any legacy flat keys."""
    d = _read()
    for k in _LEGACY_KEYS:
        d.pop(k, None)
    d["providers"] = [p for p in (providers or []) if isinstance(p, dict) and p.get("name")]
    return _write(d)


def get_provider(name: str) -> dict | None:
    for p in load_providers():
        if p.get("name") == name:
            return p
    return None


def default_provider() -> dict | None:
    """The is_default provider if flagged, else the first enabled one."""
    enabled = [p for p in load_providers() if p.get("enabled", True)]
    for p in enabled:
        if p.get("is_default"):
            return p
    return enabled[0] if enabled else None


def login_providers() -> list:
    """Enabled providers that opted into a login-page button."""
    return [p for p in load_providers() if p.get("enabled", True) and p.get("show_on_login", True)]


def config_hash(provider: dict) -> str:
    """sha256 over the identity-bearing fields of a provider config. A change in
    any of them re-registers the Authlib client live (no restart)."""
    parts = []
    for k in _HASH_FIELDS:
        v = provider.get(k)
        parts.append(",".join(v) if isinstance(v, list) else str(v or ""))
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def mask_provider(p: dict) -> dict:
    """A provider dict safe for a GET: client_secret sentinelized, plus a flag."""
    out = dict(p)
    has = bool(p.get("client_secret"))
    out["client_secret"] = SECRET_SENTINEL if has else ""
    out["client_secret_set"] = has
    return out


def merge_provider_secret(incoming: dict, stored: dict | None) -> dict:
    """Preserve-unless-changed for the client secret: an incoming secret that is
    empty or the sentinel keeps the stored value; anything else is a new secret.
    Returns a new dict (does not mutate `incoming`)."""
    out = dict(incoming)
    sec = incoming.get("client_secret")
    if sec in ("", None, SECRET_SENTINEL):
        out["client_secret"] = (stored or {}).get("client_secret", "") if stored else ""
    return out
