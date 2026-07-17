#!/usr/bin/env python3
"""
Stateful manager.

Stores the set of processed media IDs per app+instance so that items are not
re-hunted every cycle. The store auto-expires after ``stateful_management_hours``:
once the window passes, every processed ID is cleared and still-missing items
become eligible to be searched again.

Persistence hardening in this module:
- All JSON writes are atomic (temp file + os.replace) so a crash mid-write can
  never truncate a file and silently wipe dedup state.
- Per-instance filenames carry a short hash of the raw instance name so two
  instances whose names differ only in punctuation cannot collide on one file.
- A single reentrant lock guards every read/write/reset so a reset cannot race a
  concurrent add across the hunt threads.
"""

import os
import json
import time
import hashlib
import pathlib
import datetime
import logging
import tempfile
import threading
from typing import Dict, Any, Set

# Create logger for stateful_manager
stateful_logger = logging.getLogger("stateful_manager")

# Constants
STATEFUL_DIR = pathlib.Path(os.getenv("STATEFUL_DIR") or os.path.join(os.getenv("SNAGARR_CONFIG_DIR", "/config"), "stateful"))
LOCK_FILE = STATEFUL_DIR / "lock.json"
DEFAULT_HOURS = 168  # Default 7 days (168 hours)

# One reentrant lock serializes all state mutations across the Waitress and hunt
# threads. Reentrant so a public helper can call another while already holding it.
_LOCK = threading.RLock()

# Ensure the stateful directory exists
try:
    STATEFUL_DIR.mkdir(parents=True, exist_ok=True)
    stateful_logger.info(f"Stateful directory created/confirmed at {STATEFUL_DIR}")
except Exception as e:
    stateful_logger.error(f"Error creating stateful directory: {e}")

# Create app directories
APP_TYPES = ["sonarr", "radarr", "lidarr", "readarr", "whisparr", "eros"]
for app_type in APP_TYPES:
    (STATEFUL_DIR / app_type).mkdir(exist_ok=True)

# Add import for get_advanced_setting
from src.primary.settings_manager import get_advanced_setting


def _atomic_write_json(path: pathlib.Path, obj: Any, fsync: bool = True) -> None:
    """Write JSON to ``path`` atomically (temp file in the same dir + os.replace).

    os.replace is atomic on the same filesystem, so readers always see either the
    old complete file or the new complete file, never a truncated one.

    ``fsync`` forces the bytes to disk before the rename. It is worth the cost for
    the small, infrequent lock file, but is skipped for the per-instance ID caches:
    those are written once per processed item in tight loops, and blocking every
    hunt thread on an fsync (which can stall on a network mount) is not worth it.
    Losing the last few IDs on a hard crash only re-hunts a few items, which is
    self-healing.
    """
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
            f.flush()
            if fsync:
                os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _sanitize(instance_name: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in instance_name) or "default"


def _instance_filename(instance_name: str) -> str:
    """Collision-resistant per-instance filename.

    Appends a short hash of the raw name so "My Server", "My-Server" and
    "My.Server" get distinct files instead of all mapping to "My_Server.json".
    """
    digest = hashlib.sha1(instance_name.encode("utf-8")).hexdigest()[:8]
    return f"{_sanitize(instance_name)}_{digest}.json"


def _instance_path(app_type: str, instance_name: str) -> pathlib.Path:
    """Resolve the per-instance state file, migrating a legacy (hash-less) file once.

    Older builds stored ``{sanitized}.json``. If that legacy file exists and the
    new hashed file does not, rename it in place so existing processed state
    carries forward across the upgrade instead of forcing a full re-hunt.
    """
    new_path = STATEFUL_DIR / app_type / _instance_filename(instance_name)
    if not new_path.exists():
        legacy = STATEFUL_DIR / app_type / f"{_sanitize(instance_name)}.json"
        if legacy.exists() and legacy != new_path:
            try:
                os.replace(legacy, new_path)
                # If two old instances sanitized to this same legacy name, only the
                # first resolved here claims it; the other starts empty and re-hunts.
                stateful_logger.info(f"Migrated legacy stateful file {legacy.name} -> {new_path.name} "
                                     f"(if instance names collided pre-upgrade, run one manual reset).")
            except Exception as e:
                stateful_logger.error(f"Failed migrating legacy stateful file {legacy}: {e}")
    return new_path


def _read_ids(file_path: pathlib.Path) -> Set[str]:
    """Read the processed-ID set from a resolved file path. Missing/corrupt -> empty set."""
    if not file_path.exists():
        return set()
    try:
        with open(file_path, "r") as f:
            data = json.load(f)
        return set(str(x) for x in data.get("processed_ids", []))
    except Exception as e:
        stateful_logger.error(f"Error reading processed IDs from {file_path}: {e}")
        return set()


def initialize_lock_file() -> None:
    """Create the lock file with a fresh window if it does not already exist.

    A no-op when the file exists, so process restarts preserve the running window.
    """
    try:
        STATEFUL_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        stateful_logger.error(f"Error creating stateful directory: {e}")

    with _LOCK:
        if not LOCK_FILE.exists():
            try:
                current_time = int(time.time())
                expiration_hours = get_advanced_setting("stateful_management_hours", DEFAULT_HOURS)
                _atomic_write_json(LOCK_FILE, {
                    "created_at": current_time,
                    "expires_at": current_time + (expiration_hours * 3600),
                })
                stateful_logger.info(f"Initialized lock file at {LOCK_FILE} with expiration in {expiration_hours} hours")
            except Exception as e:
                stateful_logger.error(f"Error initializing lock file: {e}")


def get_lock_info() -> Dict[str, Any]:
    """Return the current lock info, self-healing missing fields."""
    initialize_lock_file()
    with _LOCK:
        try:
            with open(LOCK_FILE, "r") as f:
                lock_info = json.load(f)

            if not isinstance(lock_info, dict):
                raise ValueError("Lock info is not a dictionary")

            if "created_at" not in lock_info:
                lock_info["created_at"] = int(time.time())

            if "expires_at" not in lock_info or lock_info["expires_at"] is None:
                expiration_hours = get_advanced_setting("stateful_management_hours", DEFAULT_HOURS)
                lock_info["expires_at"] = lock_info["created_at"] + (expiration_hours * 3600)
                _atomic_write_json(LOCK_FILE, lock_info)

            return lock_info
        except Exception as e:
            stateful_logger.error(f"Error reading lock file: {e}")
            current_time = int(time.time())
            expiration_hours = get_advanced_setting("stateful_management_hours", DEFAULT_HOURS)
            return {
                "created_at": current_time,
                "expires_at": current_time + (expiration_hours * 3600),
            }


def update_lock_expiration(hours: int = None) -> bool:
    """(Re)anchor the retention window to now.

    Called when the operator changes ``stateful_management_hours``. Anchors BOTH
    created_at and expires_at to the current time so the new window always lands
    in the future. (The previous behavior recomputed expires_at from the original
    created_at, which put expiry in the past whenever the interval was lowered.)
    """
    expiration_hours = hours if hours is not None else get_advanced_setting("stateful_management_hours", DEFAULT_HOURS)
    with _LOCK:
        now = int(time.time())
        expires_at = now + (expiration_hours * 3600)
        try:
            _atomic_write_json(LOCK_FILE, {"created_at": now, "expires_at": expires_at})
            stateful_logger.info(f"Updated stateful window: expires {datetime.datetime.fromtimestamp(expires_at)}")
            return True
        except Exception as e:
            stateful_logger.error(f"Error updating lock expiration: {e}")
            return False


def reset_stateful_management() -> bool:
    """Clear all processed IDs and start a fresh retention window.

    Writes a new lock file (created_at/expires_at = now + interval) and deletes
    every per-instance state file under each app directory.
    """
    with _LOCK:
        try:
            expiration_hours = get_advanced_setting("stateful_management_hours", DEFAULT_HOURS)
            current_time = int(time.time())
            expires_at = current_time + (expiration_hours * 3600)

            _atomic_write_json(LOCK_FILE, {"created_at": current_time, "expires_at": expires_at})

            for app_type in APP_TYPES:
                app_dir = STATEFUL_DIR / app_type
                if app_dir.exists():
                    for json_file in app_dir.glob("*.json"):
                        try:
                            json_file.unlink()
                            stateful_logger.debug(f"Deleted {json_file}")
                        except Exception as e:
                            stateful_logger.error(f"Error deleting {json_file}: {e}")

            stateful_logger.info(f"Reset stateful management. New expiration: {datetime.datetime.fromtimestamp(expires_at)}")
            return True
        except Exception as e:
            stateful_logger.error(f"Error resetting stateful management: {e}")
            return False


def check_expiration() -> bool:
    """If the retention window has passed, reset the store. Returns True if it reset.

    This is the auto-expiry driver. It MUST be called on the periodic hunt path
    (see background.app_specific_loop) or the store would only ever clear on a
    manual reset, and still-missing items would never be re-searched.
    """
    with _LOCK:
        try:
            lock_info = get_lock_info()
            expires_at = lock_info.get("expires_at")

            if expires_at is None:
                update_lock_expiration()
                expires_at = get_lock_info().get("expires_at")

            expires_at = int(expires_at)
        except (TypeError, ValueError) as e:
            # Corrupt / hand-edited lock.json. Do not let this kill the hunt
            # thread (it would restart-loop and silently stop hunting). Re-anchor
            # a fresh window and skip the reset this cycle.
            stateful_logger.warning(f"Unreadable stateful expiry ({e}); re-anchoring window, no reset this cycle.")
            update_lock_expiration()
            return False

        if int(time.time()) >= expires_at:
            stateful_logger.info("Stateful window expired; clearing processed IDs and starting a new window.")
            reset_stateful_management()
            return True

    return False


def get_processed_ids(app_type: str, instance_name: str) -> Set[str]:
    """Return the set of processed media IDs for an app+instance."""
    if app_type not in APP_TYPES:
        stateful_logger.warning(f"Unknown app type: {app_type}")
        return set()
    with _LOCK:
        return _read_ids(_instance_path(app_type, instance_name))


def add_processed_id(app_type: str, instance_name: str, media_id: str) -> bool:
    """Record a media ID as processed for an app+instance (read-modify-write under lock)."""
    if app_type not in APP_TYPES:
        stateful_logger.warning(f"Unknown app type: {app_type}")
        return False

    media_id = str(media_id)
    with _LOCK:
        file_path = _instance_path(app_type, instance_name)
        ids = _read_ids(file_path)
        if media_id in ids:
            return True
        ids.add(media_id)
        try:
            # Cache data written per-item in tight loops: skip fsync (see helper).
            _atomic_write_json(file_path, {
                "processed_ids": sorted(ids),
                "last_updated": int(time.time()),
            }, fsync=False)
            return True
        except Exception as e:
            stateful_logger.error(f"Error adding media ID {media_id} to {file_path}: {e}")
            return False


def is_processed(app_type: str, instance_name: str, media_id: str) -> bool:
    """Return True if a media ID has already been processed for an app+instance."""
    if app_type not in APP_TYPES:
        return False
    with _LOCK:
        ids = _read_ids(_instance_path(app_type, instance_name))
    result = str(media_id) in ids
    stateful_logger.debug(f"is_processed {app_type}/{instance_name} id={media_id} -> {result} (total {len(ids)})")
    return result


def get_stateful_management_info() -> Dict[str, Any]:
    """Return created/expiry timestamps and the configured interval for the UI/API."""
    lock_info = get_lock_info()
    return {
        "created_at_ts": lock_info.get("created_at"),
        "expires_at_ts": lock_info.get("expires_at"),
        "interval_hours": get_advanced_setting("stateful_management_hours", DEFAULT_HOURS),
    }


def initialize_stateful_system():
    """Initialize directories and the lock file on startup.

    Deliberately does NOT re-anchor the window on every start: it only creates the
    lock file if absent, so restarts preserve the running retention window. The
    window is (re)anchored only on first init or when the operator changes the
    interval (via update_lock_expiration).
    """
    stateful_logger.info("Initializing stateful management system")

    try:
        STATEFUL_DIR.mkdir(parents=True, exist_ok=True)
        for app_type in APP_TYPES:
            (STATEFUL_DIR / app_type).mkdir(exist_ok=True)
        stateful_logger.info(f"Stateful directory structure created at {STATEFUL_DIR}")
    except Exception as e:
        stateful_logger.error(f"Failed to create stateful directories: {e}")

    try:
        initialize_lock_file()
        # Startup grace: if the on-disk window is ALREADY expired (a stale lock
        # from an older build, or downtime longer than the interval), re-anchor it
        # to a fresh window at startup instead of letting the first hunt cycle
        # immediately reset and wipe the (just-migrated) processed IDs. Re-hunts
        # then happen on the intended cadence, not in a burst on every restart.
        # A still-valid window is left untouched, so a normal restart preserves it.
        with _LOCK:
            info = get_lock_info()
            expires_at = info.get("expires_at")
            try:
                already_expired = expires_at is None or int(time.time()) >= int(expires_at)
            except (TypeError, ValueError):
                already_expired = True
            if already_expired:
                stateful_logger.info("Stateful window was expired at startup; re-anchoring a fresh window (processed IDs preserved).")
                update_lock_expiration()
        info = get_stateful_management_info()
        stateful_logger.info(f"Stateful window active: interval {info['interval_hours']}h, expires_at {info['expires_at_ts']}")
    except Exception as e:
        stateful_logger.error(f"Failed to initialize lock file: {e}")

    try:
        total_files = 0
        for app_type in APP_TYPES:
            app_dir = STATEFUL_DIR / app_type
            if app_dir.exists():
                total_files += len(list(app_dir.glob("*.json")))
        stateful_logger.info(f"Found {total_files} existing processed-ID files" if total_files else "No existing processed-ID files found")
    except Exception as e:
        stateful_logger.error(f"Failed to check for existing processed IDs: {e}")

    stateful_logger.info("Stateful management system initialization complete")


# Initialize the stateful system on module import
initialize_stateful_system()
