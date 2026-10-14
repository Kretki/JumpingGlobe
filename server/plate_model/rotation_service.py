"""Loads the plate model's .rot files and caches the encoded model and its RotationTree per file version."""

from __future__ import annotations

from collections.abc import Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any

from server.shared_utils.json_encoding import encode_compact_json
from server.plate_model.rotation_parser import parse_rotation_files
from server.plate_model.rotation_tree import RotationTree

FileVersions = tuple[int, ...]
"""``st_mtime_ns`` of every rotation file, in load order (cache key)."""


class RotationService:
    """Serves a rotation model that may be split over several .rot files (e.g. Cao et al. 2024)."""

    def __init__(self, rotation_paths: Sequence[Path], max_age_ma: float) -> None:
        """Create the service.

        Usage:
            ``RotationService(PLATE_MODEL.rotation_files, PLATE_MODEL.max_age_ma)``.

        Args:
            rotation_paths: GPlates .rot files in load order (earlier files win where ages overlap).
            max_age_ma: Oldest age reported to the client in Ma; poles beyond it stay in
                the model (they keep interpolation at the limit exact) but the timeline stops here.

        Returns:
            None.
        """
        self._rotation_paths = tuple(rotation_paths)
        self._max_age_ma = float(max_age_ma)
        self._json_by_version = lru_cache(maxsize=1)(self._encode_rotations)
        self._tree_by_version = lru_cache(maxsize=1)(self._build_tree)

    def is_available(self) -> bool:
        """Tell whether every rotation file exists.

        Usage:
            Routes answer 404 when one is missing.

        Returns:
            True when all files are present.
        """
        return all(rotation_path.is_file() for rotation_path in self._rotation_paths)

    def file_name(self) -> str:
        """Return the rotation files' base names.

        Usage:
            Error messages that must not reveal server paths.

        Returns:
            Comma-separated file names without directories.
        """
        return ", ".join(rotation_path.name for rotation_path in self._rotation_paths)

    def _file_versions(self) -> FileVersions:
        """Return the modification times of all rotation files.

        Usage:
            Cache key, so caches refresh when any file changes.

        Returns:
            Tuple of ``st_mtime_ns`` values in load order.

        Raises:
            OSError: If a file is missing.
        """
        return tuple(rotation_path.stat().st_mtime_ns for rotation_path in self._rotation_paths)

    def _parse_model(self) -> dict[str, Any]:
        """Parse all rotation files and cap ``maxAge`` at the configured limit.

        Usage:
            Shared by the two cache-miss paths below.

        Returns:
            ``{"maxAge", "plates"}`` (see rotation_parser.parse_rotation_files).
        """
        rotation_model = parse_rotation_files(self._rotation_paths)
        rotation_model["maxAge"] = min(float(rotation_model["maxAge"]), self._max_age_ma)
        return rotation_model

    def _encode_rotations(self, _file_versions: FileVersions) -> bytes:
        """Parse and encode the rotation model (anchor plate 0).

        Usage:
            Cache-miss path of rotations_json.

        Args:
            _file_versions: File versions; only used as the cache key.

        Returns:
            Encoded ``{"maxAge", "plates", "anchorPlate"}``.
        """
        rotation_model = self._parse_model()
        rotation_model["anchorPlate"] = 0
        return encode_compact_json(rotation_model)

    def _build_tree(self, _file_versions: FileVersions) -> RotationTree:
        """Parse the rotation files into a RotationTree.

        Usage:
            Cache-miss path of rotation_tree.

        Args:
            _file_versions: File versions; only used as the cache key.

        Returns:
            The rotation tree.
        """
        return RotationTree(self._parse_model())

    def rotations_json(self) -> bytes:
        """Return the encoded rotation model for the current file versions.

        Usage:
            Body of /api/rotations.

        Returns:
            UTF-8 JSON bytes.

        Raises:
            OSError: If a file cannot be read.
        """
        return self._json_by_version(self._file_versions())

    def rotation_tree(self) -> RotationTree:
        """Return the RotationTree for the current file versions.

        Usage:
            Rotation source for past-age land queries.

        Returns:
            The cached tree.

        Raises:
            OSError: If a file cannot be read.
        """
        return self._tree_by_version(self._file_versions())
