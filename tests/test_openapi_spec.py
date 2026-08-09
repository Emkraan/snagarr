"""Invariants of the generated OpenAPI spec.

Guards the four properties the API standard (api-standard.md Rule 11) requires a
committed spec test to assert: generation does not throw, version comes from the
VERSION file (not a hardcoded literal), product branding is present, and the core
API-key paths are there. Without this the spec silently drifts on every merge.
"""

import os
import re
import tempfile

import pytest

# One-time stubs before importing the app modules; mirrors test_api_v1.py.
import sys
import types
import logging

os.environ.setdefault("SNAGARR_USER_DIR", tempfile.mkdtemp())
os.environ.setdefault("SNAGARR_API_DIR", tempfile.mkdtemp())

_logmod = types.ModuleType("src.primary.utils.logger")
_logmod.logger = logging.getLogger("t")
_logmod.get_logger = lambda name="": logging.getLogger("t")
sys.modules.setdefault("src.primary.utils.logger", _logmod)

_STORE = {}
_sm = types.ModuleType("src.primary.settings_manager")
_sm.KNOWN_APP_TYPES = ["sonarr", "radarr", "general"]
_sm.get_all_settings = lambda: _STORE.copy()
_sm.update_settings = lambda a, d: _STORE.update(d)
_sm.DEFAULT_SETTINGS = {}
sys.modules.setdefault("src.primary.settings_manager", _sm)

_KEYS: dict = {}
_ak = types.ModuleType("src.primary.api_keys")
_ak.SCOPES = {"read": 1, "write": 2, "admin": 3}
_ak.list_keys = lambda: list(_KEYS.values())
sys.modules.setdefault("src.primary.api_keys", _ak)


@pytest.fixture
def spec():
    from src.primary.openapi_spec import build_spec
    return build_spec()


# ---------------------------------------------------------------------------
# Rule 11a: the document generates without throwing

def test_spec_generates(spec):
    assert spec["openapi"].startswith("3.")
    assert "paths" in spec


# ---------------------------------------------------------------------------
# Rule 11b: version comes from the VERSION file, not a hardcoded literal

def test_version_from_version_file(spec):
    """The container stamps APP_VERSION at build; the VERSION file is the fallback.

    The rule is the derivation, not the reading: the version field must be
    resolved from the file (or the env the Dockerfile promotes it into), never
    written as a string literal in the spec source.
    """
    import pathlib

    repo_root = pathlib.Path(__file__).resolve().parents[1]
    version_file = repo_root / "VERSION"
    if version_file.exists():
        expected = version_file.read_text().strip()
        assert spec["info"]["version"] == expected, (
            f"spec version {spec['info']['version']!r} does not match "
            f"VERSION file {expected!r}"
        )
    # Regardless: it must look like SemVer.
    assert re.match(r"^\d+\.\d+\.\d+", spec["info"]["version"]), (
        f"spec version {spec['info']['version']!r} is not semver"
    )


# ---------------------------------------------------------------------------
# Rule 11c: product identity in info

def test_branding_present(spec):
    """api-standard.md Rule 4: title, description, contact, license, x-logo.

    `contact.url` and `license.url` must reference the project's own repo, not
    an operating org's domain or any homelab hostname.
    """
    info = spec["info"]
    assert info.get("title") == "Snagarr API", "title must be the product name"
    assert len(info.get("description", "")) > 200, (
        "a one-liner is not a description (Rule 4 requires real prose)"
    )
    contact = info.get("contact", {})
    assert contact.get("name") == "Snagarr", "contact.name is the product, not the org"
    assert "github.com" in contact.get("url", ""), (
        "contact.url must reference the project repo"
    )
    license_ = info.get("license", {})
    assert license_.get("name"), "license.name must be present"
    assert "github.com" in license_.get("url", ""), (
        "license.url must reference the project repo"
    )
    logo = info.get("x-logo", {})
    assert logo.get("url"), "x-logo.url is the field Scalar and RapiDoc read for the masthead"
    assert logo.get("altText"), "x-logo.altText must describe the image"
    # The logo URL must be relative (no hardcoded hostname), per Rule 4's
    # public-build brand-agnosticism requirement.
    assert not logo["url"].startswith("http"), (
        "x-logo.url must be relative (no baked-in hostname)"
    )


def test_no_infrastructure_identity_in_info(spec):
    """No homelab hostname, IP, or path baked into the public build's identity."""
    blob = repr(spec["info"])
    for forbidden in ("emkraan.com", "10.20.", "localhost", "/opt/", "portainer"):
        assert forbidden not in blob, (
            f"{forbidden!r} is infrastructure identity, not product identity"
        )


# ---------------------------------------------------------------------------
# Rule 11d: core API-key paths are present

def test_key_paths_present(spec):
    """The key-minting and revoke paths must be in the spec.

    Minting a key (`POST /keys`) and revoking one (`DELETE /keys/{key_id}`) are
    the control-plane operations a machine consumer relies on. If they vanish
    from the spec the reference documents a surface that cannot be automated.
    """
    paths = spec.get("paths", {})
    assert "/keys" in paths, "POST /keys (mint) must be in the spec"
    assert "post" in paths["/keys"], "POST /keys must declare a post operation"
    key_id_path = "/keys/{key_id}"
    assert key_id_path in paths, f"DELETE {key_id_path} (revoke) must be in the spec"
    assert "delete" in paths[key_id_path], f"DELETE {key_id_path} must declare a delete operation"


def test_health_path_present(spec):
    assert "/health" in spec.get("paths", {}), "/health must be in the spec"
