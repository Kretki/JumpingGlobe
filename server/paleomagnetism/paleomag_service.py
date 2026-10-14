"""Serves the PINT sites (with poles and plates) and the true-polar-wander data as one JSON document."""

from __future__ import annotations

from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Any

import polars as pl

from server.configuration.paleomag_config import PaleoMagConfig
from server.paleomagnetism.pint_sites import read_pint_sites
from server.paleomagnetism.site_plates import assign_site_plates, read_static_polygons
from server.paleomagnetism.tpw_tables import read_net_angles, read_tpw_paths, read_tpw_rates
from server.shared_utils.json_encoding import encode_compact_json

FORMAT_VERSION = 3
_DECIMALS = 3

FileVersion = tuple[str, int]
"""(path, ``st_mtime_ns``) of one file (cache key)."""

_SITE_COLUMNS = {
    "site_name": "siteName",
    "site_lat": "siteLat",
    "site_lon": "siteLon",
    "age_ma": "ageMa",
    "age_error": "ageError",
    "moment_e22": "momentE22",
    "vgp_lat": "vgpLat",
    "vgp_lon": "vgpLon",
    "plate_id": "plateId",
}


def file_version(data_path: Path) -> FileVersion:
    """Cache key of one file.

    Usage:
        paleomag_json.

    Args:
        data_path: Existing file.

    Returns:
        (path, modification time in ns).
    """
    return str(data_path), data_path.stat().st_mtime_ns


def site_columns(site_frame: pl.DataFrame) -> dict[str, Any]:
    """Encode the site table column-wise (compact for ~5000 sites).

    Usage:
        PaleoMagService._encode_files.

    Args:
        site_frame: Sites with ``plate_id`` added.

    Returns:
        Column name -> list of values; ``polarity`` is one string with a letter per site.
    """
    rounded_frame = site_frame.with_columns(pl.col(pl.Float64).round(_DECIMALS))
    encoded_columns: dict[str, Any] = {
        json_name: rounded_frame[column_name].to_list() for column_name, json_name in _SITE_COLUMNS.items()
    }
    encoded_columns["polarity"] = "".join(rounded_frame["polarity"].to_list())
    return encoded_columns


class PaleoMagService:
    """Reads the configured files and encodes them for the client."""

    def __init__(self, paleo_config: PaleoMagConfig, static_path: Callable[[], Path | None]) -> None:
        """Create the service.

        Usage:
            ``PaleoMagService(PALEO_MAGNETICS, plate_builder.static_path)`` in the application factory.

        Args:
            paleo_config: Paleomagnetic settings (file paths never come from a request).
            static_path: Returns the up-to-date static-polygon GeoPackage, or None while it is built.

        Returns:
            None.
        """
        self._config = paleo_config
        self._static_path = static_path
        self._json_by_version = lru_cache(maxsize=1)(self._encode_files)

    def is_available(self) -> bool:
        """Tell whether any file is configured and every configured file exists.

        Usage:
            /api/paleomag returns 404 otherwise.

        Returns:
            True when the data can be served.
        """
        source_files = self._config.source_files()
        return bool(source_files) and all(source_file.is_file() for source_file in source_files)

    def _site_payload(self, static_version: FileVersion | None) -> dict[str, Any] | None:
        """Read the PINT sites and assign their plates.

        Usage:
            _encode_files.

        Args:
            static_version: Static-polygon file version, or None while it is not built.

        Returns:
            Encoded site columns, or None without a PINT file.
        """
        if self._config.pint_file is None:
            return None
        site_frame = read_pint_sites(self._config.pint_file)
        site_plates: list[int | None] = [None] * site_frame.height
        if static_version is not None:
            site_plates = assign_site_plates(
                read_static_polygons(Path(static_version[0])),
                site_frame["site_lon"].to_list(),
                site_frame["site_lat"].to_list(),
                site_frame["age_ma"].to_list(),
            )
        return site_columns(site_frame.with_columns(pl.Series("plate_id", site_plates, dtype=pl.Int64)))

    def _encode_files(self, data_versions: tuple[FileVersion, ...], static_version: FileVersion | None) -> bytes:
        """Read and encode the files of one version.

        Usage:
            Cache-miss path of paleomag_json.

        Args:
            data_versions: Data file versions; they only key the cache.
            static_version: Static-polygon file version (its path is read), or None.

        Returns:
            UTF-8 JSON ``{"version", "sites", "platesReady", "tpwPaths", "tpwRates", "tpwNetAngles"}``.

        Raises:
            OSError: If a file cannot be read.
            ValueError: If the TPW workbook cannot be read.
            polars.exceptions.PolarsError: If a CSV cannot be parsed.
        """
        del data_versions
        tpw_workbook = self._config.tpw_workbook
        return encode_compact_json(
            {
                "version": FORMAT_VERSION,
                "sites": self._site_payload(static_version),
                "platesReady": static_version is not None,
                "tpwPaths": read_tpw_paths(tpw_workbook) if tpw_workbook else [],
                "tpwRates": read_tpw_rates(tpw_workbook) if tpw_workbook else [],
                "tpwNetAngles": read_net_angles(self._config.net_angle_file),
            }
        )

    def paleomag_json(self) -> bytes:
        """Return the encoded paleomagnetic data.

        Usage:
            Body of /api/paleomag (call is_available first). Re-encoded when a data file or
            the static-polygon file changes; ``platesReady`` is false until the latter exists.

        Returns:
            UTF-8 JSON bytes.

        Raises:
            OSError: If a file cannot be read.
            ValueError: If the TPW workbook cannot be read.
        """
        static_path = self._static_path()
        static_version = file_version(static_path) if static_path is not None and static_path.is_file() else None
        data_versions = tuple(file_version(source_file) for source_file in self._config.source_files())
        return self._json_by_version(data_versions, static_version)
