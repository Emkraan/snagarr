"""
Smoke tests for the OIDC blueprint: it imports cleanly and its config
resolution reflects env/secret-file presence. The full sign-in flow is verified
against a live Entra tenant at deploy, not here.
"""

import importlib
import logging
import os
import sys
import types


def load_oidc(tmp_path):
    os.environ["SNAGARR_USER_DIR"] = str(tmp_path / "user")
    for k in ("OIDC_TENANT_ID", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET",
              "OIDC_TENANT_ID_FILE", "OIDC_CLIENT_ID_FILE", "OIDC_CLIENT_SECRET_FILE"):
        os.environ.pop(k, None)

    fake_logger_mod = types.ModuleType("src.primary.utils.logger")
    fake_logger_mod.logger = logging.getLogger("test-oidc")
    fake_logger_mod.get_logger = lambda name="": logging.getLogger(f"test-{name}")
    sys.modules["src.primary.utils.logger"] = fake_logger_mod

    sys.modules.pop("src.primary.auth", None)
    sys.modules.pop("src.primary.routes.oidc", None)
    import src.primary.routes.oidc as oidc
    importlib.reload(oidc)
    return oidc


def test_oidc_imports_and_unconfigured_by_default(tmp_path):
    oidc = load_oidc(tmp_path)
    assert oidc.oidc_bp is not None
    assert oidc.oidc_configured() is False


def test_oidc_configured_from_env(tmp_path):
    oidc = load_oidc(tmp_path)
    os.environ["OIDC_TENANT_ID"] = "11111111-1111-1111-1111-111111111111"
    os.environ["OIDC_CLIENT_ID"] = "22222222-2222-2222-2222-222222222222"
    os.environ["OIDC_CLIENT_SECRET"] = "shh-not-a-real-secret"
    try:
        assert oidc.oidc_configured() is True
    finally:
        for k in ("OIDC_TENANT_ID", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"):
            os.environ.pop(k, None)


def test_oidc_secret_file_resolution(tmp_path):
    oidc = load_oidc(tmp_path)
    secret_file = tmp_path / "client_secret"
    secret_file.write_text("file-sourced-secret\n")
    os.environ["OIDC_CLIENT_SECRET_FILE"] = str(secret_file)
    try:
        assert oidc._read_secret("OIDC_CLIENT_SECRET") == "file-sourced-secret"
    finally:
        os.environ.pop("OIDC_CLIENT_SECRET_FILE", None)
