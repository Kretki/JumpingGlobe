"""Shared LOD paths from lod.json (same file the TypeScript client imports)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
_CFG_PATH = ROOT / "lod.json"
_CFG: dict[str, Any] = json.loads(_CFG_PATH.read_text(encoding="utf-8"))

DATA_DIR = (ROOT / str(_CFG["dataDir"])).resolve()
WORLD_FILE = str(_CFG["worldFile"])
FULL_RESOLUTION_FILE = str(_CFG.get("fullResolutionFile") or "land_polygons.gpkg")
BANDS: list[dict[str, Any]] = list(_CFG.get("bands") or [])

# Plate reconstruction (Merdith et al. 2021): rotation file, plus derived files in
# dataDir built by public/data/merdith_prep.sh (see server/plate_data.py).
ROTATION_FILE = (ROOT / str(_CFG.get("rotationFile") or "public/data/meredith_rot/meredith.rot")).resolve()
MERDITH_DIR = ROTATION_FILE.parent
STATIC_POLYGONS_FILE = str(_CFG.get("staticPolygonsFile") or "merdith_static.gpkg")
BAND_FILES: list[str] = [str(b["file"]) for b in sorted(BANDS, key=lambda b: b.get("orderNum", 0))]


def plates_file(lod_file: str) -> str:
    """Plate-tagged twin of a land LOD file."""
    return lod_file[: -len(".gpkg")] + "_plates.gpkg" if lod_file.endswith(".gpkg") else lod_file + "_plates"
