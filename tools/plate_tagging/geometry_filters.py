"""OGR geometry helpers shared by the plate-tagging steps."""

from __future__ import annotations

from osgeo import ogr

ogr.UseExceptions()

LAYER_NAME = "land_polygons"
MIN_PIECE_DEG2 = 1e-12
DISTANT_PAST_MA = 1e6

Envelope = tuple[float, float, float, float]
"""OGR envelope order: (min x, max x, min y, max y)."""


def polygonal_part(geometry: ogr.Geometry | None) -> ogr.Geometry | None:
    """Return the Polygon/MultiPolygon part of a geometry.

    Usage:
        Normalise results of OGR overlay operations, which may return
        collections mixing polygons with lines or points.

    Args:
        geometry: Any OGR geometry, or None.

    Returns:
        A MultiPolygon (polygons are promoted), or None when nothing polygonal is left.
    """
    if geometry is None or geometry.IsEmpty():
        return None
    flat_type = ogr.GT_Flatten(geometry.GetGeometryType())
    if flat_type == ogr.wkbPolygon:
        return ogr.ForceToMultiPolygon(geometry)
    if flat_type == ogr.wkbMultiPolygon:
        return geometry
    if flat_type == ogr.wkbGeometryCollection:
        collected = ogr.Geometry(ogr.wkbMultiPolygon)
        for member_idx in range(geometry.GetGeometryCount()):
            member_part = polygonal_part(geometry.GetGeometryRef(member_idx))
            if member_part is not None:
                for polygon_idx in range(member_part.GetGeometryCount()):
                    collected.AddGeometry(member_part.GetGeometryRef(polygon_idx))
        return collected if collected.GetGeometryCount() else None
    return None


def envelope_area(envelope: Envelope) -> float:
    """Area of an OGR envelope in deg².

    Usage:
        ``src_env_area`` of a land polygon.

    Args:
        envelope: (min x, max x, min y, max y).

    Returns:
        (max x - min x) * (max y - min y).
    """
    return (envelope[1] - envelope[0]) * (envelope[3] - envelope[2])
