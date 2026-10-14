"""Serves the exported topology model file, cached per file version."""

from __future__ import annotations

from collections.abc import Callable
from functools import lru_cache
from pathlib import Path

FileVersion = tuple[str, int]
"""(path, ``st_mtime_ns``) of the topology file (cache key)."""


class TopologyFileService:
    """Reads the topology JSON written by TopologyLayerBuilder."""

    def __init__(self, current_path: Callable[[], Path | None]) -> None:
        """Create the service.

        Usage:
            ``TopologyFileService(topology_builder.topology_path)``.

        Args:
            current_path: Returns the up-to-date topology file, or None while it is not ready.
                The path never comes from a client request.

        Returns:
            None.
        """
        self._current_path = current_path
        self._bytes_by_version = lru_cache(maxsize=1)(self._read_file)

    @staticmethod
    def _read_file(file_version: FileVersion) -> bytes:
        """Read the file of one version.

        Usage:
            Cache-miss path of topology_json.

        Args:
            file_version: (path, mtime); the mtime only keys the cache.

        Returns:
            The file content (UTF-8 JSON).
        """
        return Path(file_version[0]).read_bytes()

    def topology_json(self) -> bytes | None:
        """Return the topology model JSON.

        Usage:
            Body of /api/plates/topologies.

        Returns:
            UTF-8 JSON bytes, or None while the file is missing or stale.

        Raises:
            OSError: If the file cannot be read.
        """
        topology_path = self._current_path()
        if topology_path is None:
            return None
        return self._bytes_by_version((str(topology_path), topology_path.stat().st_mtime_ns))
