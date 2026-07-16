"""
Adversarial tests for the stateful manager fixes.

Each of these would FAIL against the upstream fork and PASS against the fixed
module, so they lock in the behavior we forked to get:

- BUG-1  check_expiration actually clears processed IDs when the window passes.
- BUG-2  update_lock_expiration anchors the window to now (never lands in the past).
- L2     writes are atomic; a corrupt file degrades to "empty", never crashes.
- L3     instances whose names differ only in punctuation get distinct files.
- L6     a restart preserves the running window instead of re-anchoring it.
- legacy per-instance state migrates forward instead of being orphaned.

The real settings_manager hardcodes /config and runs side effects at import, so
it is stubbed before importing the module under test.
"""

import json
import os
import sys
import time
import types


def load_sm(tmp_path, hours=24):
    """Import a fresh stateful_manager bound to an isolated STATEFUL_DIR."""
    os.environ["STATEFUL_DIR"] = str(tmp_path / "stateful")

    state = {"hours": hours}
    fake = types.ModuleType("src.primary.settings_manager")

    def get_advanced_setting(name, default=None):
        return state["hours"] if name == "stateful_management_hours" else default

    fake.get_advanced_setting = get_advanced_setting
    sys.modules["src.primary.settings_manager"] = fake

    # Force a clean module load so STATEFUL_DIR + the import-time init re-run.
    sys.modules.pop("src.primary.stateful_manager", None)
    import src.primary.stateful_manager as sm

    sm._set_test_hours = lambda h: state.__setitem__("hours", h)
    return sm


def test_add_and_is_processed_roundtrip(tmp_path):
    sm = load_sm(tmp_path)
    assert sm.is_processed("sonarr", "Main", "98_2") is False
    assert sm.add_processed_id("sonarr", "Main", "98_2") is True
    assert sm.is_processed("sonarr", "Main", "98_2") is True
    # ints and strings must be treated identically
    assert sm.is_processed("sonarr", "Main", 98) is False
    assert sm.add_processed_id("sonarr", "Main", 98) is True
    assert sm.is_processed("sonarr", "Main", "98") is True
    # unknown app type is rejected, not crashed
    assert sm.add_processed_id("bogus", "Main", "1") is False


def test_instance_filename_collision_resistance(tmp_path):
    # L3: these three sanitize to the same "My_Server" and MUST NOT share a file.
    sm = load_sm(tmp_path)
    sm.add_processed_id("radarr", "My Server", "a")
    sm.add_processed_id("radarr", "My-Server", "b")
    sm.add_processed_id("radarr", "My.Server", "c")

    assert sm.is_processed("radarr", "My Server", "a") is True
    assert sm.is_processed("radarr", "My Server", "b") is False
    assert sm.is_processed("radarr", "My-Server", "b") is True
    assert sm.is_processed("radarr", "My.Server", "c") is True

    files = list((sm.STATEFUL_DIR / "radarr").glob("*.json"))
    assert len(files) == 3, f"expected 3 distinct files, got {[f.name for f in files]}"


def test_update_lock_expiration_anchors_to_now(tmp_path):
    # BUG-2: simulate a lock created 10h ago, then lower the interval to 1h.
    sm = load_sm(tmp_path, hours=100)
    now = int(time.time())
    with open(sm.LOCK_FILE, "w") as f:
        json.dump({"created_at": now - 10 * 3600, "expires_at": now - 9 * 3600}, f)

    assert sm.update_lock_expiration(1) is True
    info = sm.get_lock_info()
    # Buggy behavior would put expires_at ~9h in the PAST; the fix keeps it in the future.
    assert info["expires_at"] > now
    assert info["created_at"] >= now - 2


def test_check_expiration_resets_when_window_passed(tmp_path):
    # BUG-1: expired window must clear processed IDs and open a fresh window.
    sm = load_sm(tmp_path, hours=24)
    sm.add_processed_id("sonarr", "Main", "42")
    assert sm.is_processed("sonarr", "Main", "42") is True

    now = int(time.time())
    with open(sm.LOCK_FILE, "w") as f:
        json.dump({"created_at": now - 48 * 3600, "expires_at": now - 3600}, f)

    assert sm.check_expiration() is True
    assert sm.is_processed("sonarr", "Main", "42") is False
    assert sm.get_lock_info()["expires_at"] > now


def test_check_expiration_noop_while_active(tmp_path):
    sm = load_sm(tmp_path, hours=24)
    sm.add_processed_id("sonarr", "Main", "42")
    assert sm.check_expiration() is False
    assert sm.is_processed("sonarr", "Main", "42") is True


def test_restart_preserves_window(tmp_path):
    # L6: re-running init (the restart path) must NOT re-anchor the window.
    sm = load_sm(tmp_path, hours=24)
    before = sm.get_lock_info()
    time.sleep(1)
    sm.initialize_stateful_system()
    after = sm.get_lock_info()
    assert after["created_at"] == before["created_at"]
    assert after["expires_at"] == before["expires_at"]


def test_corrupt_file_degrades_to_empty(tmp_path):
    # L2: a truncated/garbage instance file returns empty, never raises.
    sm = load_sm(tmp_path)
    path = sm._instance_path("sonarr", "Main")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        f.write('{"processed_ids": [1,2,3')  # truncated JSON
    assert sm.get_processed_ids("sonarr", "Main") == set()
    # a subsequent add repairs the file
    assert sm.add_processed_id("sonarr", "Main", "7") is True
    with open(sm._instance_path("sonarr", "Main")) as f:
        assert json.load(f)["processed_ids"] == ["7"]


def test_legacy_instance_file_migrates(tmp_path):
    # Legacy hash-less "{sanitized}.json" state must carry forward, not be orphaned.
    sm = load_sm(tmp_path)
    legacy = sm.STATEFUL_DIR / "sonarr" / "Main.json"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    with open(legacy, "w") as f:
        json.dump({"processed_ids": ["100", "200"], "last_updated": 1}, f)

    assert sm.get_processed_ids("sonarr", "Main") == {"100", "200"}
    assert not legacy.exists(), "legacy file should have been renamed to the hashed name"
