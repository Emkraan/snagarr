"""
Snagarr - Find Missing & Upgrade Media Items
A unified tool for Sonarr, Radarr, Lidarr, Readarr, and more.
"""

import os as _os


def _read_version() -> str:
    try:
        _root = _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
        with open(_os.path.join(_root, "VERSION")) as _f:
            return _f.read().strip()
    except Exception:
        return "0.0.0"

__version__ = _read_version()