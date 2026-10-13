"""
Land polygon GeoPackage API.

Serves EPSG:4326 features from LOD GPKGs via bbox queries so the browser
never loads the full multi-hundred-MB (or 1.5 GiB) datasets.

  GET /api/health
  GET /api/land/stats
  GET /api/land?file=<worldFile from lod.json>&bbox=west,south,east,north&limit=25000&min_area=0

Run:
  uvicorn server.app:app --reload --port 8765
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from functools import lru_cache

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

try:
    from server.gpkg_reader import LandGpkgStore
    from server.lod_config import (
        DATA_DIR,
        FULL_RESOLUTION_FILE,
        ROOT,
        ROTATION_FILE,
        WORLD_FILE,
    )
    from server.plate_data import PlateData
    from server.rotation import RotationTree, parse_rot
except ImportError:  # running as `python app.py` inside server/
    from gpkg_reader import LandGpkgStore
    from lod_config import (
        DATA_DIR,
        FULL_RESOLUTION_FILE,
        ROOT,
        ROTATION_FILE,
        WORLD_FILE,
    )
    from plate_data import PlateData
    from rotation import RotationTree, parse_rot

store = LandGpkgStore(DATA_DIR)

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Build the plate layers in the background on first start (non-blocking).
    plate_data.ensure()
    yield


app = FastAPI(title="Land GPKG API", version="1.0.0", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)


@lru_cache(maxsize=32)
def _land_json(
    file: str, west: float, south: float, east: float, north: float, limit: int, min_area: float
) -> bytes:
    """Serialized FeatureCollection; repeated queries (always the world view) skip SQLite + encoding."""
    fc = store.query_bbox(file, west, south, east, north, limit=limit, min_area=min_area)
    return json.dumps(fc, separators=(",", ":")).encode("utf-8")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "data_dir": str(DATA_DIR), "lods": store.available_lods()}


@lru_cache(maxsize=1)
def _rotations_json(mtime_ns: int) -> bytes:
    model = parse_rot(ROTATION_FILE)
    model["anchorPlate"] = 0
    return json.dumps(model, separators=(",", ":")).encode("utf-8")


def _plate_data_rebuilt() -> None:
    _land_json.cache_clear()
    _past_json.cache_clear()


plate_data = PlateData(on_rebuilt=_plate_data_rebuilt)


@app.get("/api/rotations")
def rotations() -> Response:
    """Merdith et al. 2021 rotation model: total poles per moving plate (file order)."""
    if not ROTATION_FILE.is_file():
        raise HTTPException(status_code=404, detail=f"Rotation file not found: {ROTATION_FILE.name}")
    body = _rotations_json(ROTATION_FILE.stat().st_mtime_ns)
    return Response(content=body, media_type="application/json")


@lru_cache(maxsize=1)
def _rotation_tree(mtime_ns: int) -> RotationTree:
    return RotationTree(parse_rot(ROTATION_FILE))


@app.get("/api/plates/status")
def plates_status() -> dict:
    """Readiness of the plate layers; the client polls this while they are built."""
    plate_data.ensure()
    return {
        "status": plate_data.status,
        "detail": plate_data.detail,
        # LOD file -> plate-tagged twin, only for twins that are already built
        "plateFiles": plate_data.ready_plate_files(),
        "staticFile": plate_data.static_file(),
    }


@lru_cache(maxsize=16)
def _past_json(
    file: str, age: float, lon: float, lat: float, radius: float, limit: int, min_area: float, mtime_ns: int
) -> bytes:
    tree = _rotation_tree(ROTATION_FILE.stat().st_mtime_ns)
    fc = store.query_past(file, tree, age, lon, lat, radius, limit=limit, min_area=min_area)
    return json.dumps(fc, separators=(",", ":")).encode("utf-8")


@app.get("/api/land/past")
def land_past(
    file: str = Query(..., description="Plate-tagged GPKG (see /api/plates/status plateFiles)"),
    age: float = Query(..., ge=0.0, description="Reconstruction age in Ma"),
    lon: float = Query(..., ge=-180.0, le=180.0, description="View centre at `age` (degrees)"),
    lat: float = Query(..., ge=-90.0, le=90.0),
    radius: float = Query(..., gt=0.0, le=90.0, description="View cap radius in degrees"),
    limit: int = Query(25000, ge=1, le=100000),
    min_area: float = Query(0.0, ge=0.0),
) -> Response:
    """Detail land around a view centre as it was at `age` (pieces still in present-day coordinates)."""
    if not ROTATION_FILE.is_file():
        raise HTTPException(status_code=404, detail="Rotation file not found")
    try:
        mtime = store.resolve_file(file).stat().st_mtime_ns
        body = _past_json(file, age, lon, lat, radius, limit, min_area, mtime)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(content=body, media_type="application/json")


@app.get("/api/land/stats")
def land_stats() -> dict:
    lods = {}
    for name in store.available_lods():
        try:
            lods[name] = store.stats(name)
        except OSError as exc:
            lods[name] = {"error": str(exc)}
    full = DATA_DIR / FULL_RESOLUTION_FILE
    return {
        "lods": lods,
        "full_resolution": {
            "path": full.name if full.is_file() else None,
            "size_bytes": full.stat().st_size if full.is_file() else 0,
            "note": "Too large for browser bulk load; use LOD gpkg files via /api/land",
        },
        "srs": "EPSG:4326",
    }


@app.get("/api/land")
def land(
    file: str = Query(WORLD_FILE, description="GPKG filename under lod.json dataDir"),
    bbox: str = Query(
        ...,
        description="west,south,east,north in EPSG:4326 degrees (west>east = antimeridian wrap)",
        examples=["-10,35,40,60"],
    ),
    limit: int = Query(25000, ge=1, le=100000),
    min_area: float = Query(
        0.0,
        ge=0.0,
        description="Minimum envelope area in deg² (drop tiny islands when zoomed out)",
    ),
) -> Response:
    try:
        parts = [float(x.strip()) for x in bbox.split(",")]
        if len(parts) != 4:
            raise ValueError("bbox must have 4 comma-separated numbers")
        west, south, east, north = parts
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid bbox: {exc}") from exc

    if not (-90.0 <= south <= north <= 90.0):
        raise HTTPException(status_code=400, detail="Invalid latitude range")
    if not (-180.0 <= west <= 180.0 and -180.0 <= east <= 180.0):
        raise HTTPException(status_code=400, detail="Longitude must be in [-180, 180]")

    try:
        body = _land_json(file, west, south, east, north, limit, min_area)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=body,
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# Allow `python -m server.app` and `python server/app.py`
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.app:app", host="0.0.0.0", port=8765, reload=True, app_dir=str(ROOT))
