"""Paleomagnetic and true-polar-wander settings from the ``paleoMagnetics`` section of lod.json.

The PINT paleointensity database (CSV), the TPW workbook (.xlsx, see tpw_config.py) and
the TPW net-angle table (CSV) live under ``paleoMagnetics.sourceDir``. Every configured
file is a path relative to that directory and must stay inside it.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from server.configuration.lod_config import LOD_CONFIG, PROJECT_ROOT
from server.configuration.tpw_config import TpwWorkbookConfig, read_tpw_workbook

_SETTING_PREFIX = "lod.json paleoMagnetics"


@dataclass(frozen=True)
class PaleoMagConfig:
    """Validated paleomagnetic data settings.

    Attributes:
        source_directory: Directory with the data files.
        pint_file: PINT database CSV (site directions and dipole moments), or None.
        tpw_workbook: TPW paths and polar-wander rates, or None.
        net_angle_file: TPW rate and net rotation angle table (``age, PW_rate, net_angle``), or None.
    """

    source_directory: Path
    pint_file: Path | None = None
    tpw_workbook: TpwWorkbookConfig | None = None
    net_angle_file: Path | None = None

    def source_files(self) -> tuple[Path, ...]:
        """List every configured file.

        Usage:
            Availability check and cache key of the paleomagnetic service.

        Returns:
            Paths of the PINT table, the TPW workbook and the net-angle table that are configured.
        """
        workbook_path = self.tpw_workbook.workbook_path if self.tpw_workbook else None
        return tuple(data_path for data_path in (self.pint_file, workbook_path, self.net_angle_file) if data_path)


def contained_file(source_directory: Path, config_value: Any, setting_name: str) -> Path:
    """Resolve a configured relative file path that must stay inside the source directory.

    Usage:
        Every file entry of the paleoMagnetics section.

    Args:
        source_directory: Resolved source directory.
        config_value: Relative path read from lod.json, e.g. ``tpw/rates.csv``.
        setting_name: Setting name for the error message.

    Returns:
        The resolved absolute path.

    Raises:
        ValueError: If the value is empty, absolute, contains ``..`` or leaves the directory.
    """
    relative_text = str(config_value or "")
    relative_path = Path(relative_text)
    if not relative_text or relative_path.is_absolute() or ".." in relative_path.parts:
        raise ValueError(
            f"{_SETTING_PREFIX}.{setting_name}: expected a relative path inside sourceDir, got {relative_text!r}"
        )
    resolved_path = (source_directory / relative_path).resolve()
    if not resolved_path.is_relative_to(source_directory):
        raise ValueError(f"{_SETTING_PREFIX}.{setting_name}: {relative_text!r} leaves sourceDir")
    return resolved_path


def optional_file(source_directory: Path, config_value: Any, setting_name: str) -> Path | None:
    """Resolve an optional file setting.

    Usage:
        pintFile and tpwNetAngleFile.

    Args:
        source_directory: Resolved source directory.
        config_value: Relative path, or empty/missing.
        setting_name: Setting name for error messages.

    Returns:
        The resolved path, or None when not configured.

    Raises:
        ValueError: If a configured path is invalid (see contained_file).
    """
    return contained_file(source_directory, config_value, setting_name) if config_value else None


def read_paleomag_config(paleo_section: Mapping[str, Any], project_root: Path) -> PaleoMagConfig:
    """Build a PaleoMagConfig from the ``paleoMagnetics`` section of lod.json.

    Usage:
        Called once at import time (PALEO_MAGNETICS below); tests may call it with a dict.

    Args:
        paleo_section: The section (sourceDir, pintFile, tpwWorkbook, tpwNetAngleFile). An
            empty mapping disables the layers.
        project_root: Directory sourceDir is resolved against.

    Returns:
        The validated configuration.

    Raises:
        ValueError: If a path or a workbook setting is invalid.
    """
    source_directory = (project_root / str(paleo_section.get("sourceDir") or "")).resolve()
    workbook_section = paleo_section.get("tpwWorkbook") or {}
    workbook_path = optional_file(source_directory, workbook_section.get("file"), "tpwWorkbook.file")
    return PaleoMagConfig(
        source_directory=source_directory,
        pint_file=optional_file(source_directory, paleo_section.get("pintFile"), "pintFile"),
        tpw_workbook=read_tpw_workbook(workbook_section, workbook_path) if workbook_path else None,
        net_angle_file=optional_file(source_directory, paleo_section.get("tpwNetAngleFile"), "tpwNetAngleFile"),
    )


PALEO_MAGNETICS: PaleoMagConfig = read_paleomag_config(LOD_CONFIG.get("paleoMagnetics") or {}, PROJECT_ROOT)
