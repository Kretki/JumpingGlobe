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
GPML is XML (GDAL has no GPML driver); it is parsed with defusedxml so entity
expansion and external-entity attacks are rejected.
"""

from __future__ import annotations

import gzip
import json
import sys
from typing import Any
# Element is imported for type hints only; all parsing goes through defusedxml.
from xml.etree.ElementTree import Element  # nosec B405

from defusedxml.ElementTree import iterparse

GML_NAMESPACE = "{http://www.opengis.net/gml}"
GPML_NAMESPACE = "{http://www.gplates.org/gplates}"
DISTANT_PAST_MA = 1e6

RingCoords = list[list[float]]
PolygonRings = list[RingCoords]


def parse_time_position(time_element: Element | None, default_age: float) -> float:
    """Read a gml:timePosition below an element as an age in Ma.

    Usage:
        Decode the begin/end of a feature's gml:validTime.

    Args:
        time_element: gml:begin or gml:end element, or None.
        default_age: Age returned when the element or its value is missing/invalid.

    Returns:
        Age in Ma; ``distantPast`` -> 1e6 and ``distantFuture`` -> 0.
    """
    if time_element is None:
        return default_age
    position_element = time_element.find(f".//{GML_NAMESPACE}timePosition")
    if position_element is None or position_element.text is None:
        return default_age
    position_text = position_element.text.strip()
    if position_text.endswith("distantPast"):
        return DISTANT_PAST_MA
    if position_text.endswith("distantFuture"):
        return 0.0
    try:
        return float(position_text)
    except ValueError:
        return default_age


def parse_ring(linear_ring: Element) -> RingCoords | None:
    """Convert a gml:LinearRing into a closed GeoJSON ring.

    Usage:
        Called for exterior and interior rings.

    Args:
        linear_ring: gml:LinearRing element whose gml:posList is ``lat lon lat lon ...``.

    Returns:
        Closed ring of [lon, lat] pairs with at least 4 points, or None.
    """
    position_list = linear_ring.find(f"{GML_NAMESPACE}posList")
    if position_list is None or not position_list.text:
        return None
    coordinate_values = [float(value_text) for value_text in position_list.text.split()]
    ring_points = [
        [coordinate_values[value_idx + 1], coordinate_values[value_idx]]
        for value_idx in range(0, len(coordinate_values) - 1, 2)
    ]
    if len(ring_points) < 3:
        return None
    if ring_points[0] != ring_points[-1]:
        ring_points.append(ring_points[0])
    return ring_points if len(ring_points) >= 4 else None


def parse_polygons(feature_element: Element) -> list[PolygonRings]:
    """Collect every gml:Polygon of a feature.

    Usage:
        Geometry of one GPML feature.

    Args:
        feature_element: GPML feature element.

    Returns:
        List of polygons, each ``[exterior, *holes]``; polygons without a valid
        exterior are skipped.
    """
    polygon_list: list[PolygonRings] = []
    for polygon_element in feature_element.iter(f"{GML_NAMESPACE}Polygon"):
        exterior_ring = polygon_element.find(f"{GML_NAMESPACE}exterior/{GML_NAMESPACE}LinearRing")
        if exterior_ring is None:
            continue
        outer_ring = parse_ring(exterior_ring)
        if outer_ring is None:
            continue
        polygon_rings = [outer_ring]
        for interior_ring in polygon_element.findall(f"{GML_NAMESPACE}interior/{GML_NAMESPACE}LinearRing"):
            hole_ring = parse_ring(interior_ring)
            if hole_ring is not None:
                polygon_rings.append(hole_ring)
        polygon_list.append(polygon_rings)
    return polygon_list


def parse_properties(feature_element: Element) -> dict[str, Any]:
    """Read plate id, lifetime and name of a GPML feature.

    Usage:
        Attributes of one output GeoJSON feature.

    Args:
        feature_element: GPML feature element.

    Returns:
        ``{"plate_id", "from_age", "to_age", "name"}``.
    """
    plate_element = feature_element.find(f"{GPML_NAMESPACE}reconstructionPlateId//{GPML_NAMESPACE}value")
    plate_id = int(float(plate_element.text)) if plate_element is not None and plate_element.text else 0
    valid_period = feature_element.find(f"{GML_NAMESPACE}validTime/{GML_NAMESPACE}TimePeriod")
    begin_element = valid_period.find(f"{GML_NAMESPACE}begin") if valid_period is not None else None
    end_element = valid_period.find(f"{GML_NAMESPACE}end") if valid_period is not None else None
    name_element = feature_element.find(f"{GML_NAMESPACE}name")
    return {
        "plate_id": plate_id,
        "from_age": parse_time_position(begin_element, DISTANT_PAST_MA),
        "to_age": parse_time_position(end_element, 0.0),
        "name": (name_element.text or "").strip() if name_element is not None else "",
    }


def polygon_geometry(polygon_list: list[PolygonRings]) -> dict[str, Any]:
    """Build a GeoJSON geometry from one or more polygons.

    Usage:
        Geometry of one output feature.

    Args:
        polygon_list: Non-empty list of polygons.

    Returns:
        A Polygon for one polygon, otherwise a MultiPolygon.
    """
    if len(polygon_list) == 1:
        return {"type": "Polygon", "coordinates": polygon_list[0]}
    return {"type": "MultiPolygon", "coordinates": polygon_list}


def read_features(source_path: str) -> list[dict[str, Any]]:
    """Stream a GPML/GPMLZ file and return its polygon features.

    Usage:
        Core of convert(); memory stays bounded because each featureMember is
        cleared after it was read.

    Args:
        source_path: Input path; a name ending in ``z`` is read as gzip.

    Returns:
        List of GeoJSON features.
    """
    open_function = gzip.open if source_path.endswith("z") else open
    feature_list: list[dict[str, Any]] = []
    with open_function(source_path, "rb") as source_stream:
        for _, xml_element in iterparse(source_stream, events=("end",)):
            if xml_element.tag != f"{GML_NAMESPACE}featureMember":
                continue
            feature_element = next(iter(xml_element), None)
            if feature_element is None:
                continue
            feature_props = parse_properties(feature_element)
            polygon_list = parse_polygons(feature_element)
            xml_element.clear()
            if polygon_list:
                feature_list.append(
                    {"type": "Feature", "properties": feature_props, "geometry": polygon_geometry(polygon_list)}
                )
    return feature_list


def convert_gpml(source_path: str, output_path: str) -> int:
    """Convert a GPML/GPMLZ file into a GeoJSON FeatureCollection file.

    Usage:
        ``convert("static.gpml", "static.geojson")``.

    Args:
        source_path: Input GPML or gzip-compressed GPMLZ file.
        output_path: GeoJSON file to write (overwritten).

    Returns:
        Number of polygon features written.
    """
    feature_list = read_features(source_path)
    with open(output_path, "w", encoding="utf-8") as output_stream:
        json.dump({"type": "FeatureCollection", "features": feature_list}, output_stream)
    return len(feature_list)


def cli_main(argument_list: list[str]) -> int:
    """Command-line entry point.

    Usage:
        ``gpml_to_geojson.py <in.gpml|in.gpmlz> <out.geojson>``.

    Args:
        argument_list: ``sys.argv``.

    Returns:
        Process exit status (0 on success).
    """
    if len(argument_list) != 3:
        sys.exit(__doc__)
    feature_count = convert_gpml(argument_list[1], argument_list[2])
    print(f"{argument_list[1]}: {feature_count} polygon features -> {argument_list[2]}")
    return 0


if __name__ == "__main__":
    sys.exit(cli_main(sys.argv))
