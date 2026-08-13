"""
Centralized blueprint imports
This module provides a single location to import all app blueprints
to avoid circular import issues
"""

# Import blueprints from the renamed route files
from src.primary.apps.eros_routes import eros_bp
from src.primary.apps.lidarr_routes import lidarr_bp
from src.primary.apps.radarr_routes import radarr_bp
from src.primary.apps.readarr_routes import readarr_bp
from src.primary.apps.sonarr_routes import sonarr_bp
from src.primary.apps.swaparr_routes import swaparr_bp
from src.primary.apps.whisparr_routes import whisparr_bp

__all__ = [
    "eros_bp",
    "lidarr_bp",
    "radarr_bp",
    "readarr_bp",
    "sonarr_bp",
    "swaparr_bp",
    "whisparr_bp"
]