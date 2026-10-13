"""Cut one land polygon along static-polygon boundaries, assigning every piece to exactly one plate."""

from __future__ import annotations

from osgeo import ogr

from plate_tagging.geometry_filters import MIN_PIECE_DEG2, polygonal_part
from plate_tagging.static_index import StaticPolygonIndex, envelope_contains

AssignedPiece = tuple[int, ogr.Geometry]
"""(static entry index, land piece)."""


def is_negligible(geometry: ogr.Geometry | None) -> bool:
    """Tell whether a piece is missing or too small to keep.

    Usage:
        Drop slivers produced by overlay operations.

    Args:
        geometry: Piece geometry or None.

    Returns:
        True for None or area <= MIN_PIECE_DEG2.
    """
    return geometry is None or geometry.GetArea() <= MIN_PIECE_DEG2


def assign_pieces(land_geometry: ogr.Geometry, static_index: StaticPolygonIndex) -> list[AssignedPiece]:
    """Split a land polygon into pieces covering it exactly once.

    Usage:
        Called for every land feature by the chunk worker.

    Args:
        land_geometry: Land MultiPolygon.
        static_index: Present-day static polygons.

    Returns:
        List of (static entry index, piece). A polygon fully inside one static
        polygon is returned whole; overlapping static polygons never duplicate
        land (each piece is subtracted once assigned); leftovers in gaps go to
        the nearest static polygon.
    """
    land_envelope = land_geometry.GetEnvelope()
    candidate_list = static_index.candidates(land_envelope)
    for entry_idx in candidate_list:
        static_entry = static_index.static_entries[entry_idx]
        if envelope_contains(static_entry.envelope, land_envelope) and static_entry.geometry.Contains(land_geometry):
            return [(entry_idx, land_geometry)]
    assigned: list[AssignedPiece] = []
    remaining: ogr.Geometry | None = land_geometry
    for entry_idx in candidate_list:
        if remaining is None:
            break
        static_geometry = static_index.static_entries[entry_idx].geometry
        if not static_geometry.Intersects(remaining):
            continue
        land_piece = polygonal_part(remaining.Intersection(static_geometry))
        if is_negligible(land_piece):
            continue
        assigned.append((entry_idx, land_piece))
        remaining = polygonal_part(remaining.Difference(static_geometry))
        if remaining is not None and is_negligible(remaining):
            remaining = None
    if remaining is not None:
        owner_idx = static_index.nearest_entry(remaining) if static_index.static_entries else 0
        assigned.append((owner_idx, remaining))
    return assigned
