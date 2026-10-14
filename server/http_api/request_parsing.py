"""Validation of query-string values that FastAPI cannot check on its own."""

from __future__ import annotations

from server.shared_utils.spherical_geometry import BoundingBox

_BBOX_PARTS = 4


def parse_bbox(bbox_text: str) -> BoundingBox:
    """Parse and validate a ``west,south,east,north`` query value.

    Usage:
        Called by /api/land before any query runs.

    Args:
        bbox_text: Comma-separated degrees; west > east means antimeridian wrap.

    Returns:
        Tuple (west, south, east, north).

    Raises:
        ValueError: With a client-facing message when the value is not four
            numbers, latitudes are out of order or outside [-90, 90], or
            longitudes are outside [-180, 180].
    """
    try:
        bbox_parts = [float(text_part.strip()) for text_part in bbox_text.split(",")]
        if len(bbox_parts) != _BBOX_PARTS:
            raise ValueError("bbox must have 4 comma-separated numbers")
    except ValueError as exception:
        raise ValueError(f"Invalid bbox: {exception}") from exception
    west_edge, south_edge, east_edge, north_edge = bbox_parts
    if not (-90.0 <= south_edge <= north_edge <= 90.0):
        raise ValueError("Invalid latitude range")
    if not (-180.0 <= west_edge <= 180.0 and -180.0 <= east_edge <= 180.0):
        raise ValueError("Longitude must be in [-180, 180]")
    return (west_edge, south_edge, east_edge, north_edge)
