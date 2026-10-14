"""Paleomagnetic and true-polar-wander settings from the ``paleoMagnetics`` section of lod.json.

The paleomagnetic pole tables (CSV), the TPW workbook (.xlsx, see server/tpw_config.py)
and the TPW net-angle table (CSV) live under ``paleoMagnetics.sourceDir``. Every
configured file is a path relative to that directory and must stay inside it.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from server.lod_config import LOD_CONFIG, PROJECT_ROOT
from server.tpw_config import TpwWorkbookConfig, read_tpw_workbook

_SETTING_PREFIX = "lod.json paleoMagnetics"
_DEFAULT_MIN_WINDOW_MYR = 2.0


@dataclass(frozen=True)
class CsvSource:
    """One configured CSV table.

    Attributes:
        file_path: Absolute path of the table (inside the source directory).
        default_block: Block name used when the table has no block column ("" when it has one).
    """

    file_path: Path
    default_block: str = ""


@dataclass(frozen=True)
class PaleoMagConfig:
    """Validated paleomagnetic data settings.

    Attributes:
        source_directory: Directory with the CSV tables.
        pole_sources: Paleomagnetic pole tables.
        tpw_workbook: TPW paths and polar-wander rates, or None.
        net_angle_source: TPW rate and net rotation angle table (``age, PW_rate, net_angle``), or None.
        block_plate_ids: Block name -> plate id of the rotation model.
        named_ages_ma: Geological age name -> (young, old) age in Ma.
        min_window_myr: Narrowest age window a pole is shown for, in Myr (> 0).
    """

    source_directory: Path
    pole_sources: tuple[CsvSource, ...] = ()
    tpw_workbook: TpwWorkbookConfig | None = None
    net_angle_source: CsvSource | None = None
    block_plate_ids: Mapping[str, int] = field(default_factory=dict)
    named_ages_ma: Mapping[str, tuple[float, float]] = field(default_factory=dict)
    min_window_myr: float = _DEFAULT_MIN_WINDOW_MYR

    def source_files(self) -> tuple[Path, ...]:
        """List every configured table.

        Usage:
            Cache key of the paleomagnetic service (file versions).

        Returns:
            Paths of the pole tables, the TPW workbook and the net-angle table.
        """
        workbook_files = (self.tpw_workbook.workbook_path,) if self.tpw_workbook else ()
        angle_files = (self.net_angle_source.file_path,) if self.net_angle_source else ()
        return tuple(pole_source.file_path for pole_source in self.pole_sources) + workbook_files + angle_files


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


def read_sources(source_directory: Path, entry_list: Any, setting_name: str) -> tuple[CsvSource, ...]:
    """Read a list of ``{"file", "block"?}`` table entries.

    Usage:
        poleFiles and tpwRotationFiles.

    Args:
        source_directory: Resolved source directory.
        entry_list: The configured list (missing = empty).
        setting_name: Setting name for error messages.

    Returns:
        The table sources in configured order.

    Raises:
        ValueError: If an entry is not an object or its file is invalid.
    """
    table_sources: list[CsvSource] = []
    for table_entry in entry_list or []:
        if not isinstance(table_entry, Mapping):
            raise ValueError(f"{_SETTING_PREFIX}.{setting_name}: every entry must be an object with a file")
        table_path = contained_file(source_directory, table_entry.get("file"), setting_name)
        table_sources.append(CsvSource(table_path, str(table_entry.get("block") or "").strip()))
    return tuple(table_sources)


def read_named_ages(named_section: Any) -> dict[str, tuple[float, float]]:
    """Read the age-name table.

    Usage:
        namedAgesMa (poles dated by period instead of numbers).

    Args:
        named_section: Mapping of name -> [young, old] in Ma.

    Returns:
        Name -> (young, old) with young <= old.

    Raises:
        ValueError: If an entry is not a pair of non-negative numbers.
    """
    named_ages: dict[str, tuple[float, float]] = {}
    for age_name, age_pair in (named_section or {}).items():
        if not isinstance(age_pair, list) or len(age_pair) != 2:
            raise ValueError(f"{_SETTING_PREFIX}.namedAgesMa.{age_name}: expected [youngMa, oldMa]")
        youngest_age, oldest_age = sorted(float(age_value) for age_value in age_pair)
        if youngest_age < 0:
            raise ValueError(f"{_SETTING_PREFIX}.namedAgesMa.{age_name}: ages must not be negative")
        named_ages[str(age_name).strip()] = (youngest_age, oldest_age)
    return named_ages


def read_paleomag_config(paleo_section: Mapping[str, Any], project_root: Path) -> PaleoMagConfig:
    """Build a PaleoMagConfig from the ``paleoMagnetics`` section of lod.json.

    Usage:
        Called once at import time (PALEO_MAGNETICS below); tests may call it with a dict.

    Args:
        paleo_section: The section (sourceDir, poleFiles, tpwWorkbook, tpwNetAngleFile,
            blockPlateIds, namedAgesMa, minAgeWindowMyr). An empty mapping disables the layers.
        project_root: Directory sourceDir is resolved against.

    Returns:
        The validated configuration.

    Raises:
        ValueError: If a path, plate id, age name, workbook setting or the minimum window is invalid.
    """
    source_directory = (project_root / str(paleo_section.get("sourceDir") or "")).resolve()
    workbook_section = paleo_section.get("tpwWorkbook") or {}
    angle_file = paleo_section.get("tpwNetAngleFile")
    min_window_myr = float(paleo_section.get("minAgeWindowMyr") or _DEFAULT_MIN_WINDOW_MYR)
    if min_window_myr <= 0:
        raise ValueError(f"{_SETTING_PREFIX}.minAgeWindowMyr must be positive")
    return PaleoMagConfig(
        source_directory=source_directory,
        pole_sources=read_sources(source_directory, paleo_section.get("poleFiles"), "poleFiles"),
        tpw_workbook=(
            read_tpw_workbook(
                workbook_section, contained_file(source_directory, workbook_section.get("file"), "tpwWorkbook.file")
            )
            if workbook_section
            else None
        ),
        net_angle_source=CsvSource(contained_file(source_directory, angle_file, "tpwNetAngleFile"))
        if angle_file
        else None,
        block_plate_ids={
            str(block_name).strip(): int(plate_number)
            for block_name, plate_number in (paleo_section.get("blockPlateIds") or {}).items()
        },
        named_ages_ma=read_named_ages(paleo_section.get("namedAgesMa")),
        min_window_myr=min_window_myr,
    )


PALEO_MAGNETICS: PaleoMagConfig = read_paleomag_config(LOD_CONFIG.get("paleoMagnetics") or {}, PROJECT_ROOT)
