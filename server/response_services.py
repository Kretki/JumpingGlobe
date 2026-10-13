"""Cached, JSON-encoded responses for land queries and the rotation model."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from server.gpkg_store import GeoPackageStore
from server.land_queries import LandQueryEngine
from server.rotation_parser import parse_rotation_file
from server.rotation_tree import RotationTree
from server.spherical_geometry import BoundingBox

LAND_CACHE_SIZE = 32
PAST_CACHE_SIZE = 16


def encode_compact_json(json_payload: Any) -> bytes:
    """Serialise a json_payload as compact UTF-8 JSON.

    Usage:
        Encode every API body once so cached responses skip re-encoding.

    Args:
        json_payload: JSON-serialisable object.

    Returns:
        UTF-8 bytes without insignificant whitespace.
    """
    return json.dumps(json_payload, separators=(",", ":")).encode("utf-8")


class RotationService:
    """Loads the .rot file and caches its JSON encoding and RotationTree per file version."""

    def __init__(self, rotation_path: Path) -> None:
        """Create the service.

        Usage:
            ``RotationService(ROTATION_FILE)``.

        Args:
            rotation_path: Path of the GPlates .rot file.

        Returns:
            None.
        """
        self._rotation_path = rotation_path
        self._json_by_mtime = lru_cache(maxsize=1)(self._encode_rotations)
        self._tree_by_mtime = lru_cache(maxsize=1)(self._build_tree)

    def is_available(self) -> bool:
        """Tell whether the rotation file exists.

        Usage:
            Routes answer 404 when it is missing.

        Returns:
            True when the file is present.
        """
        return self._rotation_path.is_file()

    def file_name(self) -> str:
        """Return the rotation file's base name.

        Usage:
            Error messages that must not reveal server paths.

        Returns:
            File name without directories.
        """
        return self._rotation_path.name

    def _modified_ns(self) -> int:
        """Return the rotation file's modification time.

        Usage:
            Cache key, so caches refresh when the file changes.

        Returns:
            ``st_mtime_ns`` of the rotation file.
        """
        return self._rotation_path.stat().st_mtime_ns

    def _encode_rotations(self, _modified_ns: int) -> bytes:
        """Parse and encode the rotation model (anchor plate 0).

        Usage:
            Cache-miss path of rotations_json.

        Args:
            _modified_ns: File version; only used as the cache key.

        Returns:
            Encoded ``{"maxAge", "plates", "anchorPlate"}``.
        """
        rotation_model = parse_rotation_file(self._rotation_path)
        rotation_model["anchorPlate"] = 0
        return encode_compact_json(rotation_model)

    def _build_tree(self, _modified_ns: int) -> RotationTree:
        """Parse the rotation file into a RotationTree.

        Usage:
            Cache-miss path of rotation_tree.

        Args:
            _modified_ns: File version; only used as the cache key.

        Returns:
            The rotation tree.
        """
        return RotationTree(parse_rotation_file(self._rotation_path))

    def rotations_json(self) -> bytes:
        """Return the encoded rotation model for the current file version.

        Usage:
            Body of /api/rotations.

        Returns:
            UTF-8 JSON bytes.

        Raises:
            OSError: If the file cannot be read.
        """
        return self._json_by_mtime(self._modified_ns())

    def rotation_tree(self) -> RotationTree:
        """Return the RotationTree for the current file version.

        Usage:
            Rotation source for past-age land queries.

        Returns:
            The cached tree.

        Raises:
            OSError: If the file cannot be read.
        """
        return self._tree_by_mtime(self._modified_ns())


class LandService:
    """Runs land queries and caches their encoded responses."""

    def __init__(self, gpkg_store: GeoPackageStore, query_engine: LandQueryEngine, rotations: RotationService) -> None:
        """Create the service.

        Usage:
            ``LandService(store, LandQueryEngine(store), RotationService(path))``.

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
