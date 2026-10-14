"""Shared LOD paths read from lod.json (the same file the TypeScript client imports).

The plate-model section of lod.json is read by server/plate_model_config.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / "lod.json"


def load_lod_config(config_path: Path) -> dict[str, Any]:
    """Read and parse the LOD configuration file.

    Usage:
        Called once at import time to populate the module constants below.

    Args:
        config_path: Path of the lod.json file.

    Returns:
        The parsed JSON object as a dictionary.

    Raises:
        OSError: If the file cannot be read.
        json.JSONDecodeError: If the file is not valid JSON.
    """
    return json.loads(config_path.read_text(encoding="utf-8"))


LOD_CONFIG: dict[str, Any] = load_lod_config(CONFIG_PATH)

DATA_DIR = (PROJECT_ROOT / str(LOD_CONFIG["dataDir"])).resolve()
WORLD_FILE = str(LOD_CONFIG["worldFile"])
FULL_RESOLUTION_FILE = str(LOD_CONFIG.get("fullResolutionFile") or "land_polygons.gpkg")
LOD_BANDS: list[dict[str, Any]] = list(LOD_CONFIG.get("bands") or [])

BAND_FILES: list[str] = [
    str(band_entry["file"]) for band_entry in sorted(LOD_BANDS, key=lambda band_entry: band_entry.get("orderNum", 0))
]

