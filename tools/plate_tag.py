#!/usr/bin/env python3
"""
Cut land polygons by plate static polygons and tag each piece with its plate.

  plate_tag.py <land.gpkg> <static_polygons.gpkg> <out.gpkg> [--jobs N]

Input land layer `land_polygons` (EPSG:4326). Output layer `land_polygons` with:

  plate_id      reconstruction plate id of the static polygon the piece lies in
  from_age      Ma when that static polygon (and thus this piece) appears
  to_age        Ma when it disappears (0 = still exists)
  src_env_area  envelope area (deg²) of the ORIGINAL land polygon, so the API's
                min_area filter keeps all pieces of a continent together

Only static polygons that exist today (to_age == 0) are used. Land not covered by
any static polygon (gaps between them) goes to the nearest one. Overlapping static
polygons never duplicate land: each piece is subtracted once assigned.

Requires GDAL Python bindings (`from osgeo import ogr`), e.g. system python3.
"""

from __future__ import annotations

import argparse
import math
import multiprocessing as mp
import os
import shutil
import sys
import tempfile
import time

from osgeo import ogr, osr

ogr.UseExceptions()

LAYER = "land_polygons"
CELL_DEG = 5.0
MIN_PIECE_DEG2 = 1e-12

_static: list[tuple[int, float, float, ogr.Geometry, tuple[float, float, float, float]]] = []
_grid: dict[tuple[int, int], list[int]] = {}


def _polygonal(g: ogr.Geometry | None) -> ogr.Geometry | None:
    """Polygon/MultiPolygon part of a geometry (drops lines/points from collections)."""
    if g is None or g.IsEmpty():
        return None
    t = ogr.GT_Flatten(g.GetGeometryType())
    if t == ogr.wkbPolygon:
        return ogr.ForceToMultiPolygon(g)
    if t == ogr.wkbMultiPolygon:
        return g
    if t == ogr.wkbGeometryCollection:
        out = ogr.Geometry(ogr.wkbMultiPolygon)
        for i in range(g.GetGeometryCount()):
            sub = _polygonal(g.GetGeometryRef(i))
            if sub is not None:
                for j in range(sub.GetGeometryCount()):
                    out.AddGeometry(sub.GetGeometryRef(j))
        return out if out.GetGeometryCount() else None
    return None


def _cells(env: tuple[float, float, float, float]):
    x0, x1, y0, y1 = env
    for cx in range(math.floor(x0 / CELL_DEG), math.floor(x1 / CELL_DEG) + 1):
        for cy in range(math.floor(y0 / CELL_DEG), math.floor(y1 / CELL_DEG) + 1):
            yield cx, cy


def _load_static(path: str) -> None:
    ds = ogr.Open(path)
    layer = ds.GetLayer(0)
    for f in layer:
        if float(f.GetField("to_age") or 0) > 0:
            continue  # not present today: cannot own present-day land
        g = _polygonal(f.GetGeometryRef().Clone())
        if g is None:
            continue
        env = g.GetEnvelope()
        idx = len(_static)
        _static.append((int(f.GetField("plate_id")), float(f.GetField("from_age")), 0.0, g, env))
        for c in _cells(env):
            _grid.setdefault(c, []).append(idx)


def _candidates(env: tuple[float, float, float, float]) -> list[int]:
    seen: set[int] = set()
    x0, x1, y0, y1 = env
    for c in _cells(env):
        for i in _grid.get(c, ()):
            if i in seen:
                continue
            e = _static[i][4]
            if e[0] <= x1 and e[1] >= x0 and e[2] <= y1 and e[3] >= y0:
                seen.add(i)
    # Big/old polygons first so overlaps resolve to the long-lived owner.
    return sorted(seen, key=lambda i: -_static[i][1])


def _nearest(g: ogr.Geometry) -> int:
    env = g.GetEnvelope()
    pad = CELL_DEG
    while pad <= 360:
        cand = _candidates((env[0] - pad, env[1] + pad, env[2] - pad, env[3] + pad))
        if cand:
            return min(cand, key=lambda i: g.Distance(_static[i][3]))
        pad *= 2
    return 0


def _assign(land: ogr.Geometry) -> list[tuple[int, ogr.Geometry]]:
    """[(static index, piece)] covering `land` exactly once."""
    env = land.GetEnvelope()
    cand = _candidates(env)
    for i in cand:
        e = _static[i][4]
        if e[0] <= env[0] and e[1] >= env[1] and e[2] <= env[2] and e[3] >= env[3]:
            if _static[i][3].Contains(land):
                return [(i, land)]
    out: list[tuple[int, ogr.Geometry]] = []
    remaining: ogr.Geometry | None = land
    for i in cand:
        if remaining is None:
            break
        sg = _static[i][3]
        if not sg.Intersects(remaining):
            continue
        piece = _polygonal(remaining.Intersection(sg))
        if piece is None or piece.GetArea() <= MIN_PIECE_DEG2:
            continue
        out.append((i, piece))
        remaining = _polygonal(remaining.Difference(sg))
        if remaining is not None and remaining.GetArea() <= MIN_PIECE_DEG2:
            remaining = None
    if remaining is not None:
        out.append((_nearest(remaining) if _static else 0, remaining))
    return out


def _worker(args: tuple[str, str, int, int, str]) -> tuple[int, int]:
    land_path, static_path, fid_lo, fid_hi, out_path = args
    if not _static:
        _load_static(static_path)
    src = ogr.Open(land_path)
    layer = src.GetLayer(LAYER)
    layer.SetAttributeFilter(f"fid >= {fid_lo} AND fid < {fid_hi}")

    drv = ogr.GetDriverByName("GPKG")
    dst = drv.CreateDataSource(out_path)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    out = dst.CreateLayer(LAYER, srs, ogr.wkbMultiPolygon, options=["SPATIAL_INDEX=NO"])
    out.CreateField(ogr.FieldDefn("plate_id", ogr.OFTInteger))
    out.CreateField(ogr.FieldDefn("from_age", ogr.OFTReal))
    out.CreateField(ogr.FieldDefn("to_age", ogr.OFTReal))
    out.CreateField(ogr.FieldDefn("src_env_area", ogr.OFTReal))
    defn = out.GetLayerDefn()

    # Re-tagging an already tagged file keeps the original polygon's envelope area.
    has_src_area = layer.GetLayerDefn().GetFieldIndex("src_env_area") >= 0

    n_in = n_out = 0
    dst.StartTransaction()
    for f in layer:
        g = _polygonal(f.GetGeometryRef())
        if g is None:
            continue
        n_in += 1
        if has_src_area and f.GetField("src_env_area") is not None:
            env_area = float(f.GetField("src_env_area"))
        else:
            e = g.GetEnvelope()
            env_area = (e[1] - e[0]) * (e[3] - e[2])
        for i, piece in _assign(g):
            plate_id, from_age, to_age = (_static[i][0], _static[i][1], _static[i][2]) if _static else (0, 1e6, 0.0)
            of = ogr.Feature(defn)
            of.SetGeometry(ogr.ForceToMultiPolygon(piece))
            of.SetField("plate_id", plate_id)
            of.SetField("from_age", from_age)
            of.SetField("to_age", to_age)
            of.SetField("src_env_area", env_area)
            out.CreateFeature(of)
            n_out += 1
    dst.CommitTransaction()
    dst = None
    return n_in, n_out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("land")
    ap.add_argument("static")
    ap.add_argument("out")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    a = ap.parse_args()

    src = ogr.Open(a.land)
    layer = src.GetLayer(LAYER)
    fids = [f.GetFID() for f in layer]
    src = None
    if not fids:
        sys.exit(f"{a.land}: no features in {LAYER}")
    chunks = max(a.jobs * 8, 1)
    step = max(1, math.ceil(len(fids) / chunks))
    bounds = [(fids[i], fids[min(i + step, len(fids)) - 1] + 1) for i in range(0, len(fids), step)]

    tmp = tempfile.mkdtemp(prefix="plate_tag_", dir=os.path.dirname(os.path.abspath(a.out)))
    try:
        tasks = [(a.land, a.static, lo, hi, os.path.join(tmp, f"part{k:04d}.gpkg")) for k, (lo, hi) in enumerate(bounds)]
        t0 = time.time()
        done = n_in = n_out = 0
        with mp.Pool(a.jobs) as pool:
            for i_n, o_n in pool.imap_unordered(_worker, tasks):
                done += 1
                n_in += i_n
                n_out += o_n
                print(f"\r  {done}/{len(tasks)} chunks · {n_in} land → {n_out} plate pieces · {time.time() - t0:.0f}s", end="", flush=True)
        print()

        drv = ogr.GetDriverByName("GPKG")
        if os.path.exists(a.out):
            drv.DeleteDataSource(a.out)
        dst = drv.CreateDataSource(a.out)
        srs = osr.SpatialReference()
        srs.ImportFromEPSG(4326)
        out = dst.CreateLayer(LAYER, srs, ogr.wkbMultiPolygon, options=["SPATIAL_INDEX=YES"])
        for name, t in (("plate_id", ogr.OFTInteger), ("from_age", ogr.OFTReal), ("to_age", ogr.OFTReal), ("src_env_area", ogr.OFTReal)):
            out.CreateField(ogr.FieldDefn(name, t))
        dst.StartTransaction()
        for _, _, _, _, part in tasks:
            pds = ogr.Open(part)
            for f in pds.GetLayer(0):
                f.SetFID(-1)
                out.CreateFeature(f)
            pds = None
        dst.CommitTransaction()
        dst.ExecuteSQL(f"CREATE INDEX IF NOT EXISTS idx_{LAYER}_src_env_area ON {LAYER}(src_env_area)")
        dst = None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
