"""Land feature queries against the GeoPackages: present-day bbox queries and past-age view-cap queries."""

from __future__ import annotations

import sqlite3
from typing import Any, Protocol

from server.geometry_decoder import gpkg_blob_to_geojson
from server.gpkg_store import GeoPackageStore
from server.quaternion_math import Quaternion, lonlat_to_unit, quat_conjugate, quat_rotate, unit_to_lonlat
from server.spherical_geometry import BoundingBox, boxes_intersect, cap_bbox, split_antimeridian

MAX_FEATURE_LIMIT = 100_000
DISTANT_PAST_MA = 1e6

# All SQL below is static; every value is bound as a parameter.
# Plate pieces are filtered/sorted by their ORIGINAL land polygon's envelope so a
# continent cut into plates is kept or dropped as a whole.
_PLATE_BBOX_SQL = """
    SELECT p.fid, p.geom, p.plate_id, p.from_age, p.to_age, {name_column}
    FROM rtree_land_polygons_geom r
    JOIN land_polygons p ON p.fid = r.id
    WHERE r.maxx >= ? AND r.minx <= ?
      AND r.maxy >= ? AND r.miny <= ?
      AND p.src_env_area >= ?
    ORDER BY p.src_env_area DESC
    LIMIT ?
"""
_PLATE_BBOX_SQL_WITH_NAME = _PLATE_BBOX_SQL.replace("{name_column}", "p.name")
_PLATE_BBOX_SQL_WITHOUT_NAME = _PLATE_BBOX_SQL.replace("{name_column}", "NULL")

# Prefer larger envelopes when capped so continents stay visible when zoomed out.
_PLAIN_BBOX_SQL = """
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

_PLATE_EXTENTS_SQL = """
    SELECT p.plate_id, MIN(r.minx), MIN(r.miny), MAX(r.maxx), MAX(r.maxy)
    FROM rtree_land_polygons_geom r JOIN land_polygons p ON p.fid = r.id
    GROUP BY p.plate_id
"""

_PAST_PLATE_SQL = """
    SELECT p.fid, p.geom, p.from_age, p.to_age
    FROM rtree_land_polygons_geom r JOIN land_polygons p ON p.fid = r.id
    WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?
      AND p.plate_id = ? AND p.from_age >= ? AND p.to_age <= ?
      AND p.src_env_area >= ?
    ORDER BY p.src_env_area DESC
    LIMIT ?
"""

BoxResultRow = tuple[int, bytes, dict[str, Any]]


class RotationSource(Protocol):
    """Anything that can give a plate's total rotation at an age (see server.rotation_tree.RotationTree)."""

    def total_rotation(
        self, plate_id: int, age_in_ma: float, rotation_memo: dict[int, Quaternion | None] | None = None
    ) -> Quaternion | None:
        """Return the plate's rotation relative to the anchor, or None where undefined."""
        ...


def clamp_limit(feature_limit: int) -> int:
    """Clamp a requested feature limit to [1, MAX_FEATURE_LIMIT].

    Usage:
        Sanitise limits before they reach SQL.

    Args:
        feature_limit: Requested maximum number of features.

    Returns:
        The clamped integer limit.
    """
    return max(1, min(int(feature_limit), MAX_FEATURE_LIMIT))


def _plate_row(table_row: sqlite3.Row) -> BoxResultRow:
    """Convert a plate-aware bbox query row to (fid, blob, properties).

    Usage:
        Row mapper for _PLATE_BBOX_SQL_*.

    Args:
        table_row: Row (fid, geom, plate_id, from_age, to_age, name).

    Returns:
        Tuple (fid, geometry blob, properties with plate_id/from_age/to_age[/name]).
    """
    plate_props: dict[str, Any] = {
        "plate_id": int(table_row[2] or 0),
        "from_age": float(table_row[3] if table_row[3] is not None else DISTANT_PAST_MA),
        "to_age": float(table_row[4] or 0.0),
    }
    if table_row[5]:
        plate_props["name"] = table_row[5]
    return int(table_row[0]), bytes(table_row[1]), plate_props


class LandQueryEngine:
    """Runs land queries on a GeoPackageStore and returns GeoJSON FeatureCollections."""

    def __init__(self, gpkg_store: GeoPackageStore) -> None:
        """Create the engine.

        Usage:
            ``LandQueryEngine(GeoPackageStore(DATA_DIR))``.

        Args:
            gpkg_store: Store that validates names and provides connections.

        Returns:
            None.
        """
        self._gpkg_store = gpkg_store
        self._extent_cache: dict[tuple[str, int], dict[int, BoundingBox]] = {}

    def query_bbox(
        self,
        file_name: str,
        bounding_box: BoundingBox,
        *,
        feature_limit: int = 25000,
        min_area: float = 0.0,
    ) -> dict[str, Any]:
        """Land polygons intersecting a lon/lat box.

        Usage:
            Backs /api/land. Coordinates are EPSG:4326 (lon, lat).

        Args:
            file_name: GeoPackage file name in the data directory.
            bounding_box: (west, south, east, north); west > east wraps the antimeridian.
            feature_limit: Maximum number of features (clamped to 1..100000).
            min_area: Minimum envelope area in deg² (plate files: of the original polygon).

        Returns:
            FeatureCollection with ``crs``, ``file``, ``bbox``, ``count`` and ``features``;
            features are ordered by envelope area, largest first.

        Raises:
            ValueError: If the file name is invalid.
            FileNotFoundError: If the file does not exist.
        """
        feature_limit = clamp_limit(feature_limit)
        database = self._gpkg_store.connection(file_name)
        feature_list: list[dict[str, Any]] = []
        seen_fids: set[int] = set()
        for query_box in split_antimeridian(bounding_box):
            if len(feature_list) >= feature_limit:
                break
            box_rows = self._query_box(database, query_box, feature_limit - len(feature_list), min_area)
            for feature_id, geometry_blob, feature_props in box_rows:
                if feature_id in seen_fids:
                    continue
                seen_fids.add(feature_id)
                geometry = gpkg_blob_to_geojson(geometry_blob)
                if geometry is None:
                    continue
                feature_list.append(
                    {
                        "type": "Feature",
                        "id": feature_id,
                        "properties": {"fid": feature_id, "file": file_name, **feature_props},
                        "geometry": geometry,
                    }
                )
                if len(feature_list) >= feature_limit:
                    break
        return {
            "type": "FeatureCollection",
            "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
            "file": file_name,
            "count": len(feature_list),
            "bbox": list(bounding_box),
            "features": feature_list,
        }

    def _query_box(
        self, database: sqlite3.Connection, query_box: BoundingBox, row_limit: int, min_area: float
    ) -> list[BoxResultRow]:
        """Run the R-tree range query for one non-wrapping box.

        Usage:
            Called by query_bbox for each half of a split box.

        Args:
            database: Open GeoPackage connection.
            query_box: (west, south, east, north) with west <= east.
            row_limit: Maximum rows to return.
            min_area: Minimum envelope area in deg².

        Returns:
            List of (fid, geometry blob, extra properties).
        """
        west_edge, south_edge, east_edge, north_edge = query_box
        sql_params = (west_edge, east_edge, south_edge, north_edge, min_area, row_limit)
        if self._gpkg_store.has_plate_columns(database):
            has_name = "name" in GeoPackageStore.column_names(database)
            plate_sql = _PLATE_BBOX_SQL_WITH_NAME if has_name else _PLATE_BBOX_SQL_WITHOUT_NAME
            return [_plate_row(table_row) for table_row in database.execute(plate_sql, sql_params)]
        return [
            (int(table_row[0]), bytes(table_row[1]), {}) for table_row in database.execute(_PLAIN_BBOX_SQL, sql_params)
        ]

    def _plate_extents(self, file_name: str, database: sqlite3.Connection) -> dict[int, BoundingBox]:
        """Present-day lon/lat envelope of each plate's pieces, cached per file version.

        Usage:
            Lets query_past skip plates whose land cannot intersect the view.

        Args:
            file_name: Plate-tagged GeoPackage file name.
            database: Its open connection.

        Returns:
            Mapping plate id -> (minx, miny, maxx, maxy).
        """
        cache_key = (file_name, self._gpkg_store.modified_ns(file_name))
        if cache_key not in self._extent_cache:
            extent_rows = database.execute(_PLATE_EXTENTS_SQL).fetchall()
            self._extent_cache[cache_key] = {
                int(table_row[0]): (table_row[1], table_row[2], table_row[3], table_row[4]) for table_row in extent_rows
            }
        return self._extent_cache[cache_key]

    def query_past(
        self,
        file_name: str,
        rotation_source: RotationSource,
        age_in_ma: float,
        view_center: tuple[float, float],
        radius_deg: float,
        *,
        feature_limit: int = 25000,
        min_area: float = 0.0,
    ) -> dict[str, Any]:
        """Land of a plate-tagged file lying within a view cap as it was at an age.

        Usage:
            Backs /api/land/past. Each plate has moved differently, so the view cap
            is rotated back to present-day coordinates per plate (inverse of the
            plate's total rotation) and that plate's pieces are queried there.
            Every feature carries ``clip`` = the present-day box used for its plate,
            so the client can clip it before reconstructing it to the age.

        Args:
            file_name: Plate-tagged GeoPackage file name.
            rotation_source: Provides total plate rotations.
            age_in_ma: Reconstruction age in Ma.
            view_center: (longitude, latitude) of the view centre at that age.
            radius_deg: View cap radius in degrees.
            feature_limit: Maximum number of features (clamped to 1..100000).
            min_area: Minimum original-polygon envelope area in deg².

        Returns:
            FeatureCollection with ``file``, ``age``, ``center``, ``radius``,
            ``plates`` (plates that contributed), ``count`` and ``features``.

        Raises:
            ValueError: If the file is invalid or not plate-tagged.
            FileNotFoundError: If the file does not exist.
        """
        database = self._gpkg_store.connection(file_name)
        if not self._gpkg_store.has_plate_columns(database):
            raise ValueError(f"{file_name} is not plate-tagged")
        feature_limit = clamp_limit(feature_limit)
        center_unit = lonlat_to_unit(*view_center)
        rotation_memo: dict[int, Quaternion | None] = {}
        feature_list: list[dict[str, Any]] = []
        plates_used = 0
        for plate_id, plate_extent in self._plate_extents(file_name, database).items():
            if len(feature_list) >= feature_limit:
                break
            plate_quat = rotation_source.total_rotation(plate_id, age_in_ma, rotation_memo)
            if plate_quat is None:
                continue
            present_center = unit_to_lonlat(quat_rotate(quat_conjugate(plate_quat), center_unit))
            clip_box = cap_bbox(present_center[0], present_center[1], radius_deg)
            plate_features = self._past_plate_features(
                database, plate_id, plate_extent, clip_box, age_in_ma, min_area, feature_limit - len(feature_list)
            )
            plates_used += bool(plate_features)
            feature_list.extend(plate_features)
        return {
            "type": "FeatureCollection",
            "file": file_name,
            "age": age_in_ma,
            "center": list(view_center),
            "radius": radius_deg,
            "plates": plates_used,
            "count": len(feature_list),
            "features": feature_list,
        }

    @staticmethod
    def _past_plate_features(
        database: sqlite3.Connection,
        plate_id: int,
        plate_extent: BoundingBox,
        clip_box: BoundingBox,
        age_in_ma: float,
        min_area: float,
        row_limit: int,
    ) -> list[dict[str, Any]]:
        """Features of one plate inside its present-day clip box that exist at an age.

        Usage:
            Inner step of query_past.

        Args:
            database: Open plate-tagged GeoPackage connection.
            plate_id: Plate to query.
            plate_extent: Envelope of all the plate's pieces (pre-filter).
            clip_box: Present-day box of the rotated-back view cap.
            age_in_ma: Age in Ma; pieces must satisfy from_age >= age >= to_age.
            min_area: Minimum original-polygon envelope area in deg².
            row_limit: Remaining feature budget for this plate (shared by both
                halves of a wrapping clip box).

        Returns:
            GeoJSON features carrying plate_id, from_age, to_age and clip.
        """
        feature_list: list[dict[str, Any]] = []
        for query_box in split_antimeridian(clip_box):
            if not boxes_intersect(plate_extent, query_box):
                continue
            west_edge, south_edge, east_edge, north_edge = query_box
            remaining = row_limit - len(feature_list)
            sql_params = (
                west_edge, east_edge, south_edge, north_edge, plate_id, age_in_ma, age_in_ma, min_area, remaining
            )
            plate_rows = database.execute(_PAST_PLATE_SQL, sql_params).fetchall()
            for feature_id, geometry_blob, from_age_ma, to_age_ma in plate_rows:
                geometry = gpkg_blob_to_geojson(bytes(geometry_blob))
                if geometry is None:
                    continue
                feature_list.append(
                    {
                        "type": "Feature",
                        "id": int(feature_id),
                        "properties": {
                            "plate_id": plate_id,
                            "from_age": float(from_age_ma),
                            "to_age": float(to_age_ma or 0.0),
                            "clip": list(clip_box),
                        },
                        "geometry": geometry,
                    }
                )
        return feature_list
