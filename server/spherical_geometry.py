"""Lon/lat box helpers: antimeridian splitting and boxes enclosing spherical caps."""

from __future__ import annotations

import math

BoundingBox = tuple[float, float, float, float]
"""(west, south, east, north) in degrees; west > east means the box wraps the antimeridian."""


def normalize_longitude(longitude: float) -> float:
    """Wrap a longitude into [-180, 180).

    Usage:
        Normalise longitudes computed by adding offsets to a centre longitude.

    Args:
        longitude: Longitude in degrees, any value.

    Returns:
        Equivalent longitude in [-180, 180).
    """
    return ((longitude + 180.0) % 360.0) - 180.0


def split_antimeridian(bounding_box: BoundingBox) -> list[BoundingBox]:
    """Split a box that wraps the antimeridian into two non-wrapping boxes.

    Usage:
        Turn a client bbox into boxes that an R-tree range query can handle.

    Args:
        bounding_box: (west, south, east, north) in degrees.

    Returns:
        ``[bounding_box]`` when west <= east, otherwise the east-of-west part
        (west..180) followed by the west-of-east part (-180..east).
    """
    west_edge, south_edge, east_edge, north_edge = bounding_box
    if west_edge <= east_edge:
        return [bounding_box]
    return [(west_edge, south_edge, 180.0, north_edge), (-180.0, south_edge, east_edge, north_edge)]


def boxes_intersect(first_box: BoundingBox, second_box: BoundingBox) -> bool:
    """Test whether two non-wrapping boxes overlap (edges touching counts as overlap).

    Usage:
        Cheap envelope pre-check before an R-tree query.

    Args:
        first_box: (west, south, east, north), west <= east.
        second_box: (west, south, east, north), west <= east.

    Returns:
        True when the boxes share at least one point.
    """
    return not (
        first_box[0] > second_box[2]
        or first_box[2] < second_box[0]
        or first_box[1] > second_box[3]
        or first_box[3] < second_box[1]
    )


def cap_bbox(longitude: float, latitude: float, radius_deg: float) -> BoundingBox:
    """Return the lon/lat box enclosing a spherical cap.

    Usage:
        Convert a view cap (centre + angular radius) into a box for range queries.

    Args:
        longitude: Cap centre longitude in degrees.
        latitude: Cap centre latitude in degrees.
        radius_deg: Cap angular radius in degrees (values above 90 are clamped).

    Returns:
        (west, south, east, north); west > east wraps the antimeridian, and caps
        touching a pole span every longitude.
    """
    south_edge = max(-90.0, latitude - radius_deg)
    north_edge = min(90.0, latitude + radius_deg)
    cos_latitude = math.cos(math.radians(latitude))
    sin_radius = math.sin(math.radians(min(radius_deg, 90.0)))
    if north_edge >= 89.999 or south_edge <= -89.999 or sin_radius >= cos_latitude:
        return (-180.0, south_edge, 180.0, north_edge)
    half_width = math.degrees(math.asin(sin_radius / cos_latitude))
    if half_width >= 179.9:
        return (-180.0, south_edge, 180.0, north_edge)
    west_edge = normalize_longitude(longitude - half_width)
    east_edge = normalize_longitude(longitude + half_width)
    return (west_edge, south_edge, east_edge, north_edge)
