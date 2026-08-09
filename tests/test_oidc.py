"""
Smoke + unit tests for the provider-agnostic SSO subsystem: the blueprint
imports cleanly, the provider store round-trips (with secret preserve-unless-
changed), presets resolve to the right flow/endpoints, a legacy flat Entra
config migrates, and an env deployment seeds the store. The full sign-in flow is
verified against a live tenant at deploy, not here.
"""

import importlib
import logging
import os
import sys
import types


def load_oidc(tmp_path):
    os.environ["SNAGARR_USER_DIR"] = str(tmp_path / "user")
    for k in ("OIDC_TENANT_ID", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET",
              "OIDC_TENANT_ID_FILE", "OIDC_CLIENT_ID_FILE", "OIDC_CLIENT_SECRET_FILE",
              "OIDC_ISSUER", "OIDC_ISSUER_FILE"):
        os.environ.pop(k, None)

    fake_logger_mod = types.ModuleType("src.primary.utils.logger")
    fake_logger_mod.logger = logging.getLogger("test-oidc")
    fake_logger_mod.get_logger = lambda name="": logging.getLogger(f"test-{name}")
    sys.modules["src.primary.utils.logger"] = fake_logger_mod

    # Re-import auth (for a fresh USER_DIR), the store, and the blueprint.
    # Also clear the submodule attributes on the parent package so Python does
    # not reuse the stale module object via `from src.primary import oidc_config`
    # (Python checks pkg.__dict__ before sys.modules for submodule lookups).
    import src.primary as _pkg  # noqa: PLC0415 -- ensure package is loaded
    for _attr in ("auth", "oidc_config"):
        if hasattr(_pkg, _attr):
            delattr(_pkg, _attr)
    sys.modules.pop("src.primary.auth", None)
    sys.modules.pop("src.primary.oidc_config", None)
    sys.modules.pop("src.primary.routes.oidc", None)
    import src.primary.routes.oidc as oidc
    importlib.reload(oidc)
    return oidc


def test_oidc_imports_and_unconfigured_by_default(tmp_path):
    oidc = load_oidc(tmp_path)
    assert oidc.oidc_bp is not None
    assert oidc.oidc_configured() is False


def test_env_seed_creates_microsoft_provider(tmp_path):
    oidc = load_oidc(tmp_path)
    from src.primary import oidc_config
    os.environ["OIDC_TENANT_ID"] = "11111111-1111-1111-1111-111111111111"
    os.environ["OIDC_CLIENT_ID"] = "22222222-2222-2222-2222-222222222222"
    os.environ["OIDC_CLIENT_SECRET"] = "shh-not-a-real-secret"
    try:
        assert oidc.oidc_env_configured() is True
        oidc.seed_from_env()
        provs = oidc_config.load_providers()
        assert len(provs) == 1
        assert provs[0]["provider_type"] == "microsoft"
        assert provs[0]["tenant"] == "11111111-1111-1111-1111-111111111111"
        assert oidc.oidc_configured() is True
        # the secret is stored underneath but masked on the read-model
        assert oidc_config.mask_provider(provs[0])["client_secret"] == oidc_config.SECRET_SENTINEL
        # seeding is one-time: it must not clobber an existing store
        oidc.seed_from_env()
        assert len(oidc_config.load_providers()) == 1
    finally:
        for k in ("OIDC_TENANT_ID", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"):
            os.environ.pop(k, None)


def test_env_seed_creates_authentik_provider(tmp_path):
    oidc = load_oidc(tmp_path)
    from src.primary import oidc_config
    os.environ["OIDC_ISSUER"] = "https://auth.example.com/application/o/snagarr/"
    os.environ["OIDC_CLIENT_ID"] = "33333333-3333-3333-3333-333333333333"
    os.environ["OIDC_CLIENT_SECRET"] = "shh-authentik-secret"
    try:
        assert oidc.oidc_env_configured() is True
        oidc.seed_from_env()
        provs = oidc_config.load_providers()
        assert len(provs) == 1
        assert provs[0]["provider_type"] == "authentik"
        assert provs[0]["issuer"] == "https://auth.example.com/application/o/snagarr/"
        assert provs[0]["is_default"] is True
        assert oidc.oidc_configured() is True
        # the secret is stored but masked on the read-model
        assert oidc_config.mask_provider(provs[0])["client_secret"] == oidc_config.SECRET_SENTINEL
        # seeding is one-time
        oidc.seed_from_env()
        assert len(oidc_config.load_providers()) == 1
    finally:
        for k in ("OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"):
            os.environ.pop(k, None)


def test_provider_store_crud_and_secret_preserve(tmp_path):
    load_oidc(tmp_path)
    from src.primary import oidc_config
    oidc_config.save_providers([{
        "name": "okta", "provider_type": "okta", "enabled": True,
        "client_id": "cid", "client_secret": "sek", "issuer": "https://x.okta.com",
    }])
    p = oidc_config.get_provider("okta")
    assert p and p["client_secret"] == "sek"
    # sentinel / empty preserves the stored secret; anything else replaces it
    assert oidc_config.merge_provider_secret(
        {"client_secret": oidc_config.SECRET_SENTINEL}, p)["client_secret"] == "sek"
    assert oidc_config.merge_provider_secret({"client_secret": ""}, p)["client_secret"] == "sek"
    assert oidc_config.merge_provider_secret({"client_secret": "new"}, p)["client_secret"] == "new"


def test_resolve_microsoft_and_github_flows(tmp_path):
    oidc = load_oidc(tmp_path)
    ms = oidc.resolve({"name": "microsoft", "provider_type": "microsoft",
                       "tenant": "TENANT", "client_id": "c", "client_secret": "s"})
    assert ms["_flow"] == "oidc"
    assert "login.microsoftonline.com/TENANT/v2.0/.well-known/openid-configuration" in ms["discovery_url"]

    gh = oidc.resolve({"name": "github", "provider_type": "github", "client_id": "c", "client_secret": "s"})
    assert gh["_flow"] == "oauth2"
    assert gh["userinfo_url"] == "https://api.github.com/user"


def test_legacy_flat_config_migrates(tmp_path):
    load_oidc(tmp_path)
    from src.primary import oidc_config
    oidc_config.save_oidc_config({"oidc_tenant_id": "t", "oidc_client_id": "c", "oidc_client_secret": "s"})
    provs = oidc_config.load_providers()
    assert len(provs) == 1
    assert provs[0]["provider_type"] == "microsoft"
    assert provs[0]["tenant"] == "t"


def test_oidc_secret_file_resolution(tmp_path):
    oidc = load_oidc(tmp_path)
    secret_file = tmp_path / "client_secret"
    secret_file.write_text("file-sourced-secret\n")
    os.environ["OIDC_CLIENT_SECRET_FILE"] = str(secret_file)
    try:
        assert oidc._read_secret("OIDC_CLIENT_SECRET") == "file-sourced-secret"
    finally:
        os.environ.pop("OIDC_CLIENT_SECRET_FILE", None)


def test_callback_url_env_override(tmp_path):
    oidc = load_oidc(tmp_path)
    os.environ["OIDC_REDIRECT_URI"] = "https://snagarr.example.com/auth/callback"
    try:
        assert oidc._callback_url() == "https://snagarr.example.com/auth/callback"
    finally:
        os.environ.pop("OIDC_REDIRECT_URI", None)
