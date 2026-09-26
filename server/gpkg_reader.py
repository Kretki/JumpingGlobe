"""GeoPackage land polygon reader with R-tree bbox queries (EPSG:4326)."""

from __future__ import annotations

import struct
import threading
from pathlib import Path
from typing import Any, Iterator

import sqlite3

# GPKG binary header envelope sizes (bytes after flags+srs_id)
_ENVELOPE_SIZES = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}

# WKB geometry types (2D)
_WKB_POINT = 1
_WKB_LINESTRING = 2
_WKB_POLYGON = 3
_WKB_MULTIPOINT = 4
_WKB_MULTILINESTRING = 5
_WKB_MULTIPOLYGON = 6
_WKB_GEOMETRYCOLLECTION = 7


def _u32(data: bytes, off: int, le: bool) -> tuple[int, int]:
    fmt = "<I" if le else ">I"
    return struct.unpack_from(fmt, data, off)[0], off + 4


def _f64(data: bytes, off: int, le: bool) -> tuple[float, int]:
    fmt = "<d" if le else ">d"
    return struct.unpack_from(fmt, data, off)[0], off + 8


def _read_point(data: bytes, off: int, le: bool) -> tuple[list[float], int]:
    x, off = _f64(data, off, le)
    y, off = _f64(data, off, le)
    return [x, y], off


def _read_ring(data: bytes, off: int, le: bool) -> tuple[list[list[float]], int]:
    n, off = _u32(data, off, le)
    coords: list[list[float]] = []
    for _ in range(n):
        pt, off = _read_point(data, off, le)
        coords.append(pt)
    return coords, off


def _read_polygon(data: bytes, off: int, le: bool) -> tuple[list[list[list[float]]], int]:
    n_rings, off = _u32(data, off, le)
    rings: list[list[list[float]]] = []
    for _ in range(n_rings):
        ring, off = _read_ring(data, off, le)
        if len(ring) >= 3:
            rings.append(ring)
    return rings, off


def wkb_to_geojson(wkb: bytes) -> dict[str, Any] | None:
    """Decode ISO WKB (after GPKG header) to a GeoJSON geometry (lon/lat)."""
    if len(wkb) < 5:
        return None
    le = wkb[0] == 1
    gtype, off = _u32(wkb, 1, le)
    # Strip optional Z/M flags (EWKB high bits) — keep base type
    base = gtype & 0xFF

    if base == _WKB_POLYGON:
        rings, _ = _read_polygon(wkb, off, le)
        if not rings:
            return None
        return {"type": "Polygon", "coordinates": rings}

    if base == _WKB_MULTIPOLYGON:
        n, off = _u32(wkb, off, le)
        polys: list[list[list[list[float]]]] = []
        for _ in range(n):
            if off >= len(wkb):
                break
            # nested WKB geometry
            nested_le = wkb[off] == 1
            off += 1
            nested_type, off = _u32(wkb, off, nested_le)
            nested_base = nested_type & 0xFF
            if nested_base != _WKB_POLYGON:
                # skip unknown nested type best-effort
                break
            rings, off = _read_polygon(wkb, off, nested_le)
            if rings:
                polys.append(rings)
        if not polys:
            return None
        if len(polys) == 1:
            return {"type": "Polygon", "coordinates": polys[0]}
        return {"type": "MultiPolygon", "coordinates": polys}

    if base == _WKB_LINESTRING:
        ring, _ = _read_ring(wkb, off, le)
        return {"type": "LineString", "coordinates": ring}

    return None


def gpkg_blob_to_geojson(blob: bytes) -> dict[str, Any] | None:
    """Parse GeoPackageBinary → GeoJSON geometry."""
    if len(blob) < 8 or blob[0:2] != b"GP":
        return None
    flags = blob[3]
    empty = (flags >> 4) & 1
    if empty:
        return None
    envelope_type = (flags >> 1) & 0x07
    header_len = 8 + _ENVELOPE_SIZES.get(envelope_type, 0)
    if len(blob) <= header_len:
        return None
    return wkb_to_geojson(blob[header_len:])


def gpkg_blob_envelope(blob: bytes) -> tuple[float, float, float, float] | None:
    """Return (minx, miny, maxx, maxy) from GPKG envelope if present."""
    if len(blob) < 8 or blob[0:2] != b"GP":
        return None
    flags = blob[3]
    envelope_type = (flags >> 1) & 0x07
    if envelope_type == 0:
        return None
    le = (flags & 1) == 1
    fmt = "<4d" if le else ">4d"
    if envelope_type == 1:
        minx, maxx, miny, maxy = struct.unpack_from(fmt, blob, 8)
        return minx, miny, maxx, maxy
    # types 2/3/4 include Z or M — still first 4 doubles are XY
    minx, maxx, miny, maxy = struct.unpack_from(fmt, blob, 8)
    return minx, miny, maxx, maxy


class LandGpkgStore:
    """Thread-safe read-only access to land LOD GeoPackages."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir)
        self._local = threading.local()

    def resolve_file(self, name: str) -> Path:
        if not name or Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("invalid file name")
        if not name.endswith(".gpkg"):
            raise ValueError("file must be a .gpkg")
        root = self.data_dir.resolve()
        path = (self.data_dir / name).resolve()
        try:
            path.relative_to(root)
        except ValueError as exc:
            raise ValueError("invalid file name") from exc
        if not path.is_file():
            raise FileNotFoundError(f"LOD file not found: {name}")
        return path

    def available_lods(self) -> list[str]:
        if not self.data_dir.is_dir():
            return []
        try:
            from server.lod_config import FULL_RESOLUTION_FILE
        except ImportError:
            from lod_config import FULL_RESOLUTION_FILE
        skip = Path(FULL_RESOLUTION_FILE).name
        return sorted(
            p.name
            for p in self.data_dir.glob("*.gpkg")
            if p.is_file() and p.name != skip
        )

    def _conn(self, name: str) -> sqlite3.Connection:
        if not hasattr(self._local, "conns"):
            self._local.conns = {}
        conns: dict[str, sqlite3.Connection] = self._local.conns
        if name not in conns:
            path = self.resolve_file(name)
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conns[name] = conn
        return conns[name]

    def query_bbox(
        self,
        file: str,
        west: float,
        south: float,
        east: float,
        north: float,
        *,
        limit: int = 25000,
        min_area: float = 0.0,
    ) -> dict[str, Any]:
        """
        Return GeoJSON FeatureCollection of land polygons intersecting bbox.
        Coordinates are EPSG:4326 (lon, lat). Handles antimeridian wrap (west > east).
        """
        limit = max(1, min(int(limit), 100_000))

        # Split bbox if it crosses the antimeridian
        boxes: list[tuple[float, float, float, float]] = []
        if west <= east:
            boxes.append((west, south, east, north))
        else:
            boxes.append((west, south, 180.0, north))
            boxes.append((-180.0, south, east, north))

        features: list[dict[str, Any]] = []
        seen: set[int] = set()
        conn = self._conn(file)

        for w, s, e, n in boxes:
            if len(features) >= limit:
                break
            remaining = limit - len(features)
            rows = self._query_box(conn, w, s, e, n, remaining, min_area)
            for fid, geom_blob in rows:
                if fid in seen:
                    continue
                seen.add(fid)
                geometry = gpkg_blob_to_geojson(geom_blob)
                if geometry is None:
                    continue
                features.append(
                    {
                        "type": "Feature",
                        "id": fid,
                        "properties": {"fid": fid, "file": file},
                        "geometry": geometry,
                    }
                )
                if len(features) >= limit:
                    break

        return {
            "type": "FeatureCollection",
            "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
            "file": file,
            "count": len(features),
            "bbox": [west, south, east, north],
            "features": features,
        }

    def _query_box(
        self,
        conn: sqlite3.Connection,
        west: float,
        south: float,
        east: float,
        north: float,
        limit: int,
        min_area: float,
    ) -> list[tuple[int, bytes]]:
        # Prefer larger envelopes when capped so continents stay visible when zoomed out
        sql = """
            SELECT p.fid, p.geom,
                   (r.maxx - r.minx) * (r.maxy - r.miny) AS area
            FROM rtree_land_polygons_geom r
            JOIN land_polygons p ON p.fid = r.id
            WHERE r.maxx >= ? AND r.minx <= ?
              AND r.maxy >= ? AND r.miny <= ?
              AND (r.maxx - r.minx) * (r.maxy - r.miny) >= ?
            ORDER BY area DESC
            LIMIT ?
        """
        cur = conn.execute(sql, (west, east, south, north, min_area, limit))
        return [(int(row[0]), bytes(row[1])) for row in cur]

    def stats(self, name: str) -> dict[str, Any]:
        conn = self._conn(name)
        count = conn.execute("SELECT COUNT(*) FROM land_polygons").fetchone()[0]
        path = self.resolve_file(name)
        return {
            "file": name,
            "path": str(path.name),
            "features": count,
            "srs": "EPSG:4326",
            "size_bytes": path.stat().st_size if path.is_file() else 0,
        }
