"""Shared LOD and plate-model paths read from lod.json (the same file the TypeScript client imports)."""

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


_LOD_CONFIG: dict[str, Any] = load_lod_config(CONFIG_PATH)

DATA_DIR = (PROJECT_ROOT / str(_LOD_CONFIG["dataDir"])).resolve()
WORLD_FILE = str(_LOD_CONFIG["worldFile"])
FULL_RESOLUTION_FILE = str(_LOD_CONFIG.get("fullResolutionFile") or "land_polygons.gpkg")
LOD_BANDS: list[dict[str, Any]] = list(_LOD_CONFIG.get("bands") or [])

# Plate reconstruction (Merdith et al. 2021): rotation file, plus derived files in
# dataDir built by public/data/merdith_prep.sh (see server/plate_layers.py).
ROTATION_FILE = (
    PROJECT_ROOT / str(_LOD_CONFIG.get("rotationFile") or "public/data/meredith_rot/meredith.rot")
).resolve()
MERDITH_DIR = ROTATION_FILE.parent
STATIC_POLYGONS_FILE = str(_LOD_CONFIG.get("staticPolygonsFile") or "merdith_static.gpkg")
BAND_FILES: list[str] = [
    str(band_entry["file"]) for band_entry in sorted(LOD_BANDS, key=lambda band_entry: band_entry.get("orderNum", 0))
]


def plate_twin_name(lod_file_name: str) -> str:
    """Return the file name of the plate-tagged twin of a land LOD file.

    Usage:
        Map a LOD GeoPackage name (from lod.json) to the derived file that
        merdith_prep.sh writes next to it.

    Args:
        lod_file_name: LOD file name, e.g. ``land_lod2.gpkg``.

    Returns:
        The twin file name, e.g. ``land_lod2_plates.gpkg`` (``<name>_plates`` when
        the input has no ``.gpkg`` suffix).
    """
    if lod_file_name.endswith(".gpkg"):
        return lod_file_name[: -len(".gpkg")] + "_plates.gpkg"
    return lod_file_name + "_plates"
