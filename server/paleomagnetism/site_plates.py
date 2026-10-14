"""Assign paleomagnetic sites to plates of the rotation model with the static polygons.

A site moves with the plate under it, so its virtual geomagnetic pole can be shown at
any age. The static polygons (``plate_id``, ``from_age``, ``to_age`` in present-day
coordinates) come from the derived static-polygon GeoPackage of the plate model.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from server.land_data.geometry_decoder import gpkg_blob_to_geojson

RingCoords = list[list[float]]
STATIC_TABLE = "land_polygons"
_STATIC_QUERY = "SELECT plate_id, from_age, to_age, geom FROM land_polygons"


@dataclass(frozen=True)
class StaticPolygon:
    """One static polygon of the plate model.

    Attributes:
        plate_id: Plate of the rotation model.
        from_age: Age (Ma) the polygon appears.
        to_age: Age (Ma) it disappears (0 = present).
        envelope: (west, south, east, north) of its exterior rings, degrees.
        polygon_rings: Polygons, each an exterior ring followed by holes, as [lon, lat] lists.
    """

    plate_id: int
    from_age: float
    to_age: float
    envelope: tuple[float, float, float, float]
    polygon_rings: tuple[tuple[RingCoords, ...], ...]


def has_feature_table(database: sqlite3.Connection) -> bool:
    """Whether the GeoPackage holds the static-polygon table written by the prep script.

    Usage:
        read_static_polygons.

    Args:
        database: Open GeoPackage.

    Returns:
        True when gpkg_contents lists STATIC_TABLE as a feature table.
    """
    table_row = database.execute(
        "SELECT 1 FROM gpkg_contents WHERE table_name = ? AND data_type = ?", (STATIC_TABLE, "features")
    ).fetchone()
    return table_row is not None


def exterior_envelope(polygon_rings: Sequence[Sequence[RingCoords]]) -> tuple[float, float, float, float]:
    """Bounding box of the exterior rings.

    Usage:
        Quick rejection before the ring test.

    Args:
        polygon_rings: Polygons (exterior first).

    Returns:
        (west, south, east, north) in degrees.
    """
    exterior_points = [ring_point for polygon in polygon_rings for ring_point in polygon[0]]
    longitudes = [ring_point[0] for ring_point in exterior_points]
    latitudes = [ring_point[1] for ring_point in exterior_points]
    return min(longitudes), min(latitudes), max(longitudes), max(latitudes)


def read_static_polygons(gpkg_path: Path) -> list[StaticPolygon]:
    """Read every static polygon.

    Usage:
        Once per version of the static-polygon file.

    Args:
        gpkg_path: Static-polygon GeoPackage (a derived file, never from a request).

    Returns:
        Polygons with a plate id and a polygon geometry.

    Raises:
        sqlite3.Error: If the file is not a readable GeoPackage.
        ValueError: If it has no STATIC_TABLE feature table.
    """
    database = sqlite3.connect(f"file:{gpkg_path}?mode=ro", uri=True)
    try:
        if not has_feature_table(database):
            raise ValueError(f"static-polygon GeoPackage has no {STATIC_TABLE} table")
        table_rows = database.execute(_STATIC_QUERY).fetchall()
    finally:
        database.close()
    static_polygons: list[StaticPolygon] = []
    for plate_id, from_age, to_age, geometry_blob in table_rows:
        geometry = gpkg_blob_to_geojson(geometry_blob) if geometry_blob else None
        if plate_id is None or geometry is None or geometry["type"] not in ("Polygon", "MultiPolygon"):
            continue
        polygon_list = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        polygon_rings = tuple(tuple(ring for ring in polygon) for polygon in polygon_list if polygon)
        static_polygons.append(
            StaticPolygon(
                plate_id=int(plate_id),
                from_age=float(from_age) if from_age is not None else 1e6,
                to_age=float(to_age) if to_age is not None else 0.0,
                envelope=exterior_envelope(polygon_rings),
                polygon_rings=polygon_rings,
            )
        )
    return static_polygons


def ring_contains(ring_coords: RingCoords, longitude: float, latitude: float) -> bool:
    """Even-odd test of a point against a lon/lat ring (planar, as the client's plate picking).

    Usage:
        polygon_contains.

    Args:
        ring_coords: Closed or open ring of [lon, lat] points.
        longitude: Point longitude.
        latitude: Point latitude.

    Returns:
        True when the point is inside.
    """
    is_inside = False
    previous_point = ring_coords[-1]
    for ring_point in ring_coords:
        crosses = (ring_point[1] > latitude) != (previous_point[1] > latitude)
        if crosses:
            crossing_lon = previous_point[0] + (latitude - previous_point[1]) * (ring_point[0] - previous_point[0]) / (
                ring_point[1] - previous_point[1]
            )
            if longitude < crossing_lon:
                is_inside = not is_inside
        previous_point = ring_point
    return is_inside


def polygon_contains(static_polygon: StaticPolygon, longitude: float, latitude: float) -> bool:
    """Whether a static polygon covers a point.

    Usage:
        plate_for_site.

    Args:
        static_polygon: Polygon.
        longitude: Point longitude, -180..180.
        latitude: Point latitude.

    Returns:
        True when inside an exterior ring and outside its holes.
    """
    west_edge, south_edge, east_edge, north_edge = static_polygon.envelope
    if not (west_edge <= longitude <= east_edge and south_edge <= latitude <= north_edge):
        return False
    return any(
        ring_contains(polygon[0], longitude, latitude)
        and not any(ring_contains(hole_ring, longitude, latitude) for hole_ring in polygon[1:])
        for polygon in static_polygon.polygon_rings
    )


def plate_for_site(
    static_polygons: Sequence[StaticPolygon], longitude: float, latitude: float, age_ma: float
) -> int | None:
    """Plate under a site, preferring polygons that existed at the site's age.

    Usage:
        assign_site_plates.

    Args:
        static_polygons: Polygons sorted oldest-appearing first.
        longitude: Site longitude (present day).
        latitude: Site latitude.
        age_ma: Site age.

    Returns:
        Plate id, or None when no polygon covers the site.
    """
    covering = [
        static_polygon for static_polygon in static_polygons if polygon_contains(static_polygon, longitude, latitude)
    ]
    alive_then = [
        static_polygon for static_polygon in covering if static_polygon.to_age <= age_ma <= static_polygon.from_age
    ]
    chosen = (alive_then or covering)[:1]
    return chosen[0].plate_id if chosen else None


def assign_site_plates(
    static_polygons: Sequence[StaticPolygon],
    longitudes: Sequence[float],
    latitudes: Sequence[float],
    ages_ma: Sequence[float],
) -> list[int | None]:
    """Plate of every site.

    Usage:
        PaleoMagService, once per version of the PINT and static-polygon files.

    Args:
        static_polygons: Polygons of the plate model.
        longitudes: Site longitudes.
        latitudes: Site latitudes.
        ages_ma: Site ages.

    Returns:
        Plate id per site (None where no polygon covers it).
    """
    ordered_polygons = sorted(static_polygons, key=lambda static_polygon: -static_polygon.from_age)
    plate_cache: dict[tuple[float, float, float], int | None] = {}
    site_plates: list[int | None] = []
    for longitude, latitude, age_ma in zip(longitudes, latitudes, ages_ma, strict=True):
        cache_key = (longitude, latitude, age_ma)
        if cache_key not in plate_cache:
            plate_cache[cache_key] = plate_for_site(ordered_polygons, longitude, latitude, age_ma)
        site_plates.append(plate_cache[cache_key])
    return site_plates
