"""Cached, JSON-encoded land query responses (the rotation model is served by plate_model/rotation_service.py)."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from server.land_data.gpkg_store import GeoPackageStore
from server.shared_utils.json_encoding import encode_compact_json
from server.land_data.land_queries import LandQueryEngine
from server.contracts.service_contracts import RotationTreeSource
from server.shared_utils.spherical_geometry import BoundingBox

LAND_CACHE_SIZE = 32
PAST_CACHE_SIZE = 16


class LandService:
    """Runs land queries and caches their encoded responses."""

    def __init__(
        self, gpkg_store: GeoPackageStore, query_engine: LandQueryEngine, rotations: RotationTreeSource
    ) -> None:
        """Create the service.

        Usage:
            ``LandService(store, LandQueryEngine(store), RotationService(paths, max_age))``.

        Args:
            gpkg_store: GeoPackage store (file validation, stats).
            query_engine: Executes the queries.
            rotations: Supplies the rotation tree for past queries.

        Returns:
            None.
        """
        self._gpkg_store = gpkg_store
        self._query_engine = query_engine
        self._rotations = rotations
        # Repeated queries (always the world view) skip SQLite and encoding.
        self._land_cache = lru_cache(maxsize=LAND_CACHE_SIZE)(self._encode_land)
        self._past_cache = lru_cache(maxsize=PAST_CACHE_SIZE)(self._encode_past)

    def clear_caches(self) -> None:
        """Drop all cached responses.

        Usage:
            Called after the plate layers were rebuilt.

        Returns:
            None.
        """
        self._land_cache.cache_clear()
        self._past_cache.cache_clear()

    def available_lods(self) -> list[str]:
        """Return the servable GeoPackage file names.

        Usage:
            /api/health and /api/land/stats.

        Returns:
            Sorted file names (see GeoPackageStore.available_lods).
        """
        return self._gpkg_store.available_lods()

    def file_stats(self, file_name: str) -> dict[str, Any]:
        """Return feature count and size of one GeoPackage.

        Usage:
            /api/land/stats, once per file.

        Args:
            file_name: GeoPackage file name.

        Returns:
            Stats dictionary (see GeoPackageStore.file_stats).
        """
        return self._gpkg_store.file_stats(file_name)

    def _encode_land(
        self, file_name: str, bounding_box: BoundingBox, feature_limit: int, min_area: float
    ) -> bytes:
        """Run and encode a present-day bbox query.

        Usage:
            Cache-miss path of land_json.

        Args:
            file_name: GeoPackage file name.
            bounding_box: (west, south, east, north) in degrees.
            feature_limit: Maximum number of features.
            min_area: Minimum envelope area in deg².

        Returns:
            UTF-8 JSON bytes.
        """
        feature_collection = self._query_engine.query_bbox(
            file_name, bounding_box, feature_limit=feature_limit, min_area=min_area
        )
        return encode_compact_json(feature_collection)

    def land_json(self, file_name: str, bounding_box: BoundingBox, feature_limit: int, min_area: float) -> bytes:
        """Return the encoded FeatureCollection for a present-day bbox query.

        Usage:
            Body of /api/land.

        Args:
            file_name: GeoPackage file name.
            bounding_box: (west, south, east, north) in degrees.
            feature_limit: Maximum number of features.
            min_area: Minimum envelope area in deg².

        Returns:
            UTF-8 JSON bytes.

        Raises:
            ValueError: If the file name is invalid.
            FileNotFoundError: If the file does not exist.
        """
        return self._land_cache(file_name, bounding_box, feature_limit, min_area)

    def _encode_past(
        self,
        file_name: str,
        age_in_ma: float,
        view_center: tuple[float, float],
        radius_deg: float,
        feature_limit: int,
        min_area: float,
        _modified_ns: int,
    ) -> bytes:
        """Run and encode a past-age query.

        Usage:
            Cache-miss path of past_json.

        Args:
            file_name: Plate-tagged GeoPackage file name.
            age_in_ma: Reconstruction age in Ma.
            view_center: (longitude, latitude) of the view centre at that age.
            radius_deg: View cap radius in degrees.
            feature_limit: Maximum number of features.
            min_area: Minimum original-polygon envelope area in deg².
            _modified_ns: File version; only used as the cache key.

        Returns:
            UTF-8 JSON bytes.
        """
        feature_collection = self._query_engine.query_past(
            file_name,
            self._rotations.rotation_tree(),
            age_in_ma,
            view_center,
            radius_deg,
            feature_limit=feature_limit,
            min_area=min_area,
        )
        return encode_compact_json(feature_collection)

    def past_json(
        self,
        file_name: str,
        age_in_ma: float,
        view_center: tuple[float, float],
        radius_deg: float,
        feature_limit: int,
        min_area: float,
    ) -> bytes:
        """Return the encoded FeatureCollection for a past-age view-cap query.

        Usage:
            Body of /api/land/past; cached per file version.

        Args:
            file_name: Plate-tagged GeoPackage file name.
            age_in_ma: Reconstruction age in Ma.
            view_center: (longitude, latitude) of the view centre at that age.
            radius_deg: View cap radius in degrees.
            feature_limit: Maximum number of features.
            min_area: Minimum original-polygon envelope area in deg².

        Returns:
            UTF-8 JSON bytes.

        Raises:
            ValueError: If the file is invalid or not plate-tagged.
            FileNotFoundError: If the file does not exist.
        """
        modified_ns = self._gpkg_store.modified_ns(file_name)
        return self._past_cache(file_name, age_in_ma, view_center, radius_deg, feature_limit, min_area, modified_ns)
