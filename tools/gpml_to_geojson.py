#!/usr/bin/env python3
"""
Convert GPlates GPML / GPMLZ polygon features to GeoJSON (EPSG:4326, lon/lat).

Only polygon geometry is kept (static polygons, continental polygons). Each feature
gets the attributes the globe needs:

  plate_id  reconstruction plate id (gpml:reconstructionPlateId)
  from_age  begin of gml:validTime in Ma (feature appears)   distantPast  -> 1e6
  to_age    end   of gml:validTime in Ma (feature disappears) distantFuture -> 0
  name      gml:name (informational)

Usage: gpml_to_geojson.py <in.gpml|in.gpmlz> <out.geojson>
Stdlib only (GPML is XML; GDAL has no GPML driver).
"""

from __future__ import annotations

import gzip
import json
import sys
import xml.etree.ElementTree as ET

GML = "{http://www.opengis.net/gml}"
GPML = "{http://www.gplates.org/gplates}"
DISTANT_PAST_MA = 1e6


def _time(el: ET.Element | None, default: float) -> float:
    if el is None:
        return default
    tp = el.find(f".//{GML}timePosition")
    if tp is None or tp.text is None:
        return default
    text = tp.text.strip()
    if text.endswith("distantPast"):
        return DISTANT_PAST_MA
    if text.endswith("distantFuture"):
        return 0.0
    try:
        return float(text)
    except ValueError:
        return default


def _ring(lr: ET.Element) -> list[list[float]] | None:
    pos = lr.find(f"{GML}posList")
    if pos is None or not pos.text:
        return None
    vals = [float(v) for v in pos.text.split()]
    # GPML posList is "lat lon lat lon ..."
    ring = [[vals[i + 1], vals[i]] for i in range(0, len(vals) - 1, 2)]
    if len(ring) < 3:
        return None
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring if len(ring) >= 4 else None


def _polygons(feature: ET.Element) -> list[list[list[list[float]]]]:
    polys = []
    for poly in feature.iter(f"{GML}Polygon"):
        ext = poly.find(f"{GML}exterior/{GML}LinearRing")
        if ext is None:
            continue
        outer = _ring(ext)
        if outer is None:
            continue
        rings = [outer]
        for inner in poly.findall(f"{GML}interior/{GML}LinearRing"):
            r = _ring(inner)
            if r is not None:
                rings.append(r)
        polys.append(rings)
    return polys


def convert(src: str, dst: str) -> int:
    opener = gzip.open if src.endswith("z") else open
    features = []
    with opener(src, "rb") as fh:
        for _, el in ET.iterparse(fh, events=("end",)):
            if el.tag != f"{GML}featureMember":
                continue
            feat = next(iter(el), None)
            if feat is None:
                continue
            pid_el = feat.find(f"{GPML}reconstructionPlateId//{GPML}value")
            plate_id = int(float(pid_el.text)) if pid_el is not None and pid_el.text else 0
            vt = feat.find(f"{GML}validTime/{GML}TimePeriod")
            from_age = _time(vt.find(f"{GML}begin") if vt is not None else None, DISTANT_PAST_MA)
            to_age = _time(vt.find(f"{GML}end") if vt is not None else None, 0.0)
            name_el = feat.find(f"{GML}name")
            name = (name_el.text or "").strip() if name_el is not None else ""
            polys = _polygons(feat)
            el.clear()
            if not polys:
                continue
            geometry = (
                {"type": "Polygon", "coordinates": polys[0]}
                if len(polys) == 1
                else {"type": "MultiPolygon", "coordinates": polys}
            )
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "plate_id": plate_id,
                        "from_age": from_age,
                        "to_age": to_age,
                        "name": name,
                    },
                    "geometry": geometry,
                }
            )
    with open(dst, "w", encoding="utf-8") as out:
        json.dump({"type": "FeatureCollection", "features": features}, out)
    return len(features)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    n = convert(sys.argv[1], sys.argv[2])
    print(f"{sys.argv[1]}: {n} polygon features -> {sys.argv[2]}")
