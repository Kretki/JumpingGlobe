"""Decode GeoPackage geometry blobs (GeoPackageBinary header + ISO WKB) into GeoJSON geometries."""

from __future__ import annotations

import struct
from typing import Any

# GPKG binary header envelope sizes in bytes, indexed by the envelope-contents indicator.
_ENVELOPE_SIZES = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
_GPKG_HEADER_BYTES = 8

# WKB base geometry types (2D) that the land layers contain.
_WKB_LINESTRING = 2
_WKB_POLYGON = 3
_WKB_MULTIPOLYGON = 6

# Decimal places kept in API output: 1e-6° ≈ 0.11 m, far below the finest LOD
# tolerance, and it roughly halves the JSON payload vs full float repr.
COORD_DECIMALS = 6

RingCoords = list[list[float]]


def _read_uint32(wkb_bytes: bytes, byte_offset: int, little_endian: bool) -> tuple[int, int]:
    """Read one unsigned 32-bit integer.

    Usage:
        Low-level WKB reader for counts and geometry type codes.

    Args:
        wkb_bytes: Buffer to read from.
        byte_offset: Position of the integer in the buffer.
        little_endian: True for NDR byte order, False for XDR.

    Returns:
        Tuple of (value, offset just past the integer).
    """
    value_format = "<I" if little_endian else ">I"
    return struct.unpack_from(value_format, wkb_bytes, byte_offset)[0], byte_offset + 4


def _read_ring(wkb_bytes: bytes, byte_offset: int, little_endian: bool) -> tuple[RingCoords, int]:
    """Read one WKB point sequence (ring or line string) as rounded [lon, lat] pairs.

    Usage:
        Called for every ring of a polygon and for line strings.

    Args:
        wkb_bytes: Buffer to read from.
        byte_offset: Position of the point count.
        little_endian: True for NDR byte order, False for XDR.

    Returns:
        Tuple of (list of [lon, lat] rounded to COORD_DECIMALS, offset past the ring).
    """
    point_count, byte_offset = _read_uint32(wkb_bytes, byte_offset, little_endian)
    byte_order = "<" if little_endian else ">"
    flat_values = struct.unpack_from(f"{byte_order}{2 * point_count}d", wkb_bytes, byte_offset)
    byte_offset += 16 * point_count
    coordinates = [
        [round(flat_values[value_idx], COORD_DECIMALS), round(flat_values[value_idx + 1], COORD_DECIMALS)]
        for value_idx in range(0, 2 * point_count, 2)
    ]
    return coordinates, byte_offset


def _read_polygon(wkb_bytes: bytes, byte_offset: int, little_endian: bool) -> tuple[list[RingCoords], int]:
    """Read the rings of one WKB polygon body, dropping rings with fewer than 3 points.

    Usage:
        Called for a Polygon and for every member of a MultiPolygon.

    Args:
        wkb_bytes: Buffer to read from.
        byte_offset: Position of the ring count.
        little_endian: True for NDR byte order, False for XDR.

    Returns:
        Tuple of (list of rings, offset past the polygon).
    """
    ring_count, byte_offset = _read_uint32(wkb_bytes, byte_offset, little_endian)
    polygon_rings: list[RingCoords] = []
    for _ in range(ring_count):
        ring_points, byte_offset = _read_ring(wkb_bytes, byte_offset, little_endian)
        if len(ring_points) >= 3:
            polygon_rings.append(ring_points)
    return polygon_rings, byte_offset


def _read_multipolygon(wkb_bytes: bytes, byte_offset: int, little_endian: bool) -> list[list[RingCoords]]:
    """Read the member polygons of a WKB MultiPolygon body.

    Usage:
        Called by wkb_to_geojson for MultiPolygon geometries. Stops at the first
        member that is not a polygon (best effort on malformed data).

    Args:
        wkb_bytes: Buffer to read from.
        byte_offset: Position of the member count.
        little_endian: True for NDR byte order, False for XDR.

    Returns:
        List of polygons (each a list of rings); empty polygons are skipped.
    """
    member_count, byte_offset = _read_uint32(wkb_bytes, byte_offset, little_endian)
    polygon_list: list[list[RingCoords]] = []
    for _ in range(member_count):
        if byte_offset >= len(wkb_bytes):
            break
        nested_little_endian = wkb_bytes[byte_offset] == 1
        nested_type, byte_offset = _read_uint32(wkb_bytes, byte_offset + 1, nested_little_endian)
        if nested_type & 0xFF != _WKB_POLYGON:
            break
        polygon_rings, byte_offset = _read_polygon(wkb_bytes, byte_offset, nested_little_endian)
        if polygon_rings:
            polygon_list.append(polygon_rings)
    return polygon_list


def wkb_to_geojson(wkb_bytes: bytes) -> dict[str, Any] | None:
    """Decode ISO WKB into a GeoJSON geometry (lon/lat).

    Usage:
        Pass the WKB part of a GeoPackage blob (after its header).

    Args:
        wkb_bytes: ISO WKB bytes; Z/M flags in the high bits are ignored.

    Returns:
        A GeoJSON geometry dict (Polygon, MultiPolygon or LineString), or None for
        empty, unsupported or too-short input. A MultiPolygon with one member is
        returned as a Polygon.
    """
    if len(wkb_bytes) < 5:
        return None
    little_endian = wkb_bytes[0] == 1
    geometry_type, byte_offset = _read_uint32(wkb_bytes, 1, little_endian)
    base_type = geometry_type & 0xFF

    if base_type == _WKB_POLYGON:
        polygon_rings, _ = _read_polygon(wkb_bytes, byte_offset, little_endian)
        return {"type": "Polygon", "coordinates": polygon_rings} if polygon_rings else None

    if base_type == _WKB_MULTIPOLYGON:
        polygon_list = _read_multipolygon(wkb_bytes, byte_offset, little_endian)
        if not polygon_list:
            return None
        if len(polygon_list) == 1:
            return {"type": "Polygon", "coordinates": polygon_list[0]}
        return {"type": "MultiPolygon", "coordinates": polygon_list}

    if base_type == _WKB_LINESTRING:
        line_points, _ = _read_ring(wkb_bytes, byte_offset, little_endian)
        return {"type": "LineString", "coordinates": line_points}

    return None


def gpkg_blob_to_geojson(geometry_blob: bytes) -> dict[str, Any] | None:
    """Parse a GeoPackageBinary geometry blob into a GeoJSON geometry.

    Usage:
        Called for every ``geom`` column value read from a land layer.

    Args:
        geometry_blob: Raw blob starting with the ``GP`` magic bytes.

    Returns:
        GeoJSON geometry dict, or None when the blob is invalid, flagged empty or
        holds an unsupported geometry type.
    """
    if len(geometry_blob) < _GPKG_HEADER_BYTES or geometry_blob[0:2] != b"GP":
        return None
    header_flags = geometry_blob[3]
    if (header_flags >> 4) & 1:
        return None
    envelope_kind = (header_flags >> 1) & 0x07
    header_length = _GPKG_HEADER_BYTES + _ENVELOPE_SIZES.get(envelope_kind, 0)
    if len(geometry_blob) <= header_length:
        return None
    return wkb_to_geojson(geometry_blob[header_length:])
