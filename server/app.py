"""
Land polygon GeoPackage API.

Serves EPSG:4326 features from LOD GPKGs via bbox queries so the browser
never loads the full multi-hundred-MB (or 1.5 GiB) datasets.

  GET /api/health
  GET /api/land/stats
  GET /api/land?lod=0&bbox=west,south,east,north&limit=25000&min_area=0

Run:
  uvicorn server.app:app --reload --port 8765
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

try:
    from server.gpkg_reader import LandGpkgStore
except ImportError:  # running as `python app.py` inside server/
    from gpkg_reader import LandGpkgStore

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "public" / "data"

store = LandGpkgStore(DATA_DIR)

app = FastAPI(title="Land GPKG API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "data_dir": str(DATA_DIR), "lods": store.available_lods()}


@app.get("/api/land/stats")
def land_stats() -> dict:
    lods = {}
    for lod in store.available_lods():
        try:
            lods[lod] = store.stats(lod)
        except OSError as exc:
            lods[lod] = {"error": str(exc)}
    full = DATA_DIR / "land_polygons.gpkg"
    return {
        "lods": lods,
        "full_resolution": {
            "path": full.name if full.is_file() else None,
            "size_bytes": full.stat().st_size if full.is_file() else 0,
            "note": "Too large for browser bulk load; use lod 0–2 via /api/land",
        },
        "srs": "EPSG:4326",
    }


@app.get("/api/land")
def land(
    lod: int = Query(0, ge=0, le=2, description="Detail level: 0=coarse … 2=fine"),
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
) -> dict:
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
        return store.query_bbox(
            lod, west, south, east, north, limit=limit, min_area=min_area
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# Allow `python -m server.app` and `python server/app.py`
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.app:app", host="0.0.0.0", port=8765, reload=True, app_dir=str(ROOT))
