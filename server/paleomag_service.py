"""Serves the paleomagnetic poles and true-polar-wander paths and rates as one JSON document (cached per version)."""

from __future__ import annotations

from functools import lru_cache

from server.json_encoding import encode_compact_json
from server.paleomag_config import PaleoMagConfig
from server.paleomag_tables import read_all_tables
from server.tpw_tables import read_net_angles, read_tpw_paths, read_tpw_rates

FORMAT_VERSION = 2

FileVersions = tuple[tuple[str, int], ...]
"""(path, ``st_mtime_ns``) of every table (cache key)."""


class PaleoMagService:
    """Reads the configured CSV tables and encodes them for the client."""

    def __init__(self, paleo_config: PaleoMagConfig) -> None:
        """Create the service.

        Usage:
            ``PaleoMagService(PALEO_MAGNETICS)`` in the application factory.

        Args:
            paleo_config: Paleomagnetic settings (table paths never come from a request).

        Returns:
            None.
        """
        self._config = paleo_config
        self._json_by_version = lru_cache(maxsize=1)(self._encode_tables)

    def is_available(self) -> bool:
        """Tell whether any table is configured and every configured table exists.

        Usage:
            /api/paleomag returns 404 otherwise.

        Returns:
            True when the data can be served.
        """
        source_files = self._config.source_files()
        return bool(source_files) and all(source_file.is_file() for source_file in source_files)

    def _encode_tables(self, file_versions: FileVersions) -> bytes:
        """Read and encode the tables of one version.

        Usage:
            Cache-miss path of paleomag_json.

        Args:
            file_versions: Table versions; they only key the cache.

        Returns:
            UTF-8 JSON ``{"version", "poles", "tpwPaths", "tpwRates", "tpwNetAngles", "skippedRows"}``.

        Raises:
            OSError: If a table cannot be read.
            ValueError: If the TPW workbook or one of its sheets cannot be read.
        """
        del file_versions
        table_records = read_all_tables(self._config)
        tpw_workbook = self._config.tpw_workbook
        return encode_compact_json(
            {
                "version": FORMAT_VERSION,
                "poles": table_records.pole_records,
                "tpwPaths": read_tpw_paths(tpw_workbook) if tpw_workbook else [],
                "tpwRates": read_tpw_rates(tpw_workbook) if tpw_workbook else [],
                "tpwNetAngles": read_net_angles(self._config.net_angle_source),
                "skippedRows": table_records.skipped_rows,
            }
        )

    def paleomag_json(self) -> bytes:
        """Return the encoded paleomagnetic data.

        Usage:
            Body of /api/paleomag (call is_available first).

        Returns:
            UTF-8 JSON bytes.

        Raises:
            OSError: If a table cannot be read.
        """
        file_versions = tuple(
            (str(source_file), source_file.stat().st_mtime_ns) for source_file in self._config.source_files()
        )
        return self._json_by_version(file_versions)
