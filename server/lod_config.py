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

# Plate reconstruction (Merdith et al. 2021): rotation file and the plate-tagged
# continental-crust layer that sits in dataDir next to the land LODs.
ROTATION_FILE = (ROOT / str(_CFG.get("rotationFile") or "public/data/meredith_rot/meredith.rot")).resolve()
CONTINENTS_FILE = str(_CFG.get("continentsFile") or "merdith_continents.gpkg")
# Plate-tagged copy of the world LOD (built by merdith_prep.sh; moves on the timeline).
PLATE_WORLD_FILE = str(_CFG.get("plateWorldFile") or WORLD_FILE.replace(".gpkg", "_plates.gpkg"))
MERDITH_DIR = ROTATION_FILE.parent
