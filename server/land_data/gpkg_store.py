"""Thread-safe, read-only access to the land LOD GeoPackages in the data directory."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any

_PLATE_COLUMNS = frozenset({"plate_id", "from_age", "to_age", "src_env_area"})
_TABLE_INFO_SQL = "PRAGMA table_info(land_polygons)"
_COUNT_SQL = "SELECT COUNT(*) FROM land_polygons"


class GeoPackageStore:
    """Validates GeoPackage names and hands out per-thread read-only SQLite connections."""

    def __init__(self, data_directory: Path, excluded_file: str = "") -> None:
        """Create a store rooted at a data directory.

        Usage:
            ``GeoPackageStore(DATA_DIR, FULL_RESOLUTION_FILE)``.

        Args:
            data_directory: Directory holding the .gpkg files; requests can never
                leave it.
            excluded_file: File name hidden from available_lods() (the
                full-resolution source, too large for the browser).

        Returns:
            None.
        """
        self.data_directory = Path(data_directory)
        self._excluded_file = Path(excluded_file).name if excluded_file else ""
        self._thread_local = threading.local()

    def resolve_file(self, file_name: str) -> Path:
        """Map a client-supplied file name to a GeoPackage inside the data directory.

        Usage:
            Every request goes through this check before touching the filesystem.

        Args:
            file_name: Bare file name such as ``land_lod3.gpkg``.

        Returns:
            Absolute resolved path of the file.

        Raises:
            ValueError: If the name is empty, absolute, contains ``..``, is not a
                ``.gpkg`` or resolves outside the data directory (path traversal).
            FileNotFoundError: If the file does not exist.
        """
        if not file_name or Path(file_name).is_absolute() or ".." in Path(file_name).parts:
            raise ValueError("invalid file name")
        if not file_name.endswith(".gpkg"):
            raise ValueError("file must be a .gpkg")
        root_directory = self.data_directory.resolve()
        resolved_path = (self.data_directory / file_name).resolve()
        try:
            resolved_path.relative_to(root_directory)
        except ValueError as exception:
            raise ValueError("invalid file name") from exception
        if not resolved_path.is_file():
            raise FileNotFoundError(f"LOD file not found: {file_name}")
        return resolved_path

    def available_lods(self) -> list[str]:
        """List the GeoPackages the API can serve.

        Usage:
            Reported by /api/health and /api/land/stats.

        Returns:
            Sorted file names of every .gpkg in the data directory except the
            excluded full-resolution file; empty when the directory is missing.
        """
        if not self.data_directory.is_dir():
            return []
        return sorted(
            gpkg_path.name
            for gpkg_path in self.data_directory.glob("*.gpkg")
            if gpkg_path.is_file() and gpkg_path.name != self._excluded_file
        )

    def connection(self, file_name: str) -> sqlite3.Connection:
        """Return this thread's read-only connection to a GeoPackage.

        Usage:
            Called by query code; connections are cached per thread and reopened
            when the file is replaced (e.g. plate layers rebuilt).

        Args:
            file_name: Bare file name, validated with resolve_file.

        Returns:
            An open sqlite3 connection in read-only URI mode.

        Raises:
            ValueError: If the name is invalid (see resolve_file).
            FileNotFoundError: If the file does not exist.
        """
        if not hasattr(self._thread_local, "connections"):
            self._thread_local.connections = {}
        connection_cache: dict[str, tuple[int, sqlite3.Connection]] = self._thread_local.connections
        resolved_path = self.resolve_file(file_name)
        modified_ns = resolved_path.stat().st_mtime_ns
        cached_entry = connection_cache.get(file_name)
        if cached_entry is None or cached_entry[0] != modified_ns:
            if cached_entry is not None:
                cached_entry[1].close()
            database = sqlite3.connect(f"file:{resolved_path}?mode=ro", uri=True, check_same_thread=False)
            database.row_factory = sqlite3.Row
            connection_cache[file_name] = (modified_ns, database)
        return connection_cache[file_name][1]

    def modified_ns(self, file_name: str) -> int:
        """Return the modification time of a GeoPackage in nanoseconds.

        Usage:
            Part of cache keys, so caches invalidate when a file is rebuilt.

        Args:
            file_name: Bare file name, validated with resolve_file.

        Returns:
            ``st_mtime_ns`` of the file.
        """
        return self.resolve_file(file_name).stat().st_mtime_ns

    @staticmethod
    def column_names(database: sqlite3.Connection) -> set[str]:
        """Return the column names of the ``land_polygons`` table.

        Usage:
            Detect plate-tagged files and optional columns.

        Args:
            database: Open GeoPackage connection.

        Returns:
            Set of column names.
        """
        return {table_row[1] for table_row in database.execute(_TABLE_INFO_SQL)}

    def has_plate_columns(self, database: sqlite3.Connection) -> bool:
        """Tell whether a GeoPackage was plate-tagged by tools/plate_tag.py.

        Usage:
            Choose between the plain and the plate-aware queries.

        Args:
            database: Open GeoPackage connection.

        Returns:
            True when plate_id, from_age, to_age and src_env_area all exist.
        """
        return _PLATE_COLUMNS <= self.column_names(database)

    def file_stats(self, file_name: str) -> dict[str, Any]:
        """Feature count and size of one GeoPackage.

        Usage:
            Served per file by /api/land/stats.

        Args:
            file_name: Bare file name, validated with resolve_file.

        Returns:
            ``{"file", "path", "features", "srs", "size_bytes"}``.
        """
        database = self.connection(file_name)
        feature_count = database.execute(_COUNT_SQL).fetchone()[0]
        resolved_path = self.resolve_file(file_name)
        return {
            "file": file_name,
            "path": str(resolved_path.name),
            "features": feature_count,
            "srs": "EPSG:4326",
            "size_bytes": resolved_path.stat().st_size if resolved_path.is_file() else 0,
        }
