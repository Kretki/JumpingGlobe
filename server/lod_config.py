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
