"""True-polar-wander settings: the ``tpwWorkbook`` entry of lod.json ``paleoMagnetics``.

The workbook (Vaes et al. 2023 GAPWAP supplement) holds the TPW paths (spin-axis
positions in several mantle reference frames) on one sheet and polar-wander rates on
another. Column names are configured, so another workbook with the same layout works.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_SETTING_PREFIX = "lod.json paleoMagnetics.tpwWorkbook"
_FRAME_KEY_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")
_MAX_FRAME_KEY_LENGTH = 32


@dataclass(frozen=True)
class TpwFrameColumns:
    """One TPW path of the workbook.

    Attributes:
        frame_key: Short id sent to the client, e.g. ``M22``.
        frame_label: Text shown in the frame dropdown.
        longitude_column: Column with the pole longitude (degrees east).
        latitude_column: Column with the pole latitude (degrees north).
    """

    frame_key: str
    frame_label: str
    longitude_column: str
    latitude_column: str


@dataclass(frozen=True)
class TpwWorkbookConfig:
    """Where the TPW paths and rates are in the workbook.

    Attributes:
        workbook_path: The .xlsx file (inside the source directory).
        path_sheet: Sheet with the TPW paths.
        age_column: Age column of both sheets (Ma).
        confidence_column: 95 % confidence radius of the path poles (degrees), or "".
        path_frames: Paths in dropdown order (the first is the default).
        rate_sheet: Sheet with polar-wander rates, or "".
        rate_column: Rate column (degrees per Myr).
        rate_low_column: Lower bound column, or "".
        rate_high_column: Upper bound column, or "".
    """

    workbook_path: Path
    path_sheet: str
    age_column: str
    confidence_column: str
    path_frames: tuple[TpwFrameColumns, ...]
    rate_sheet: str = ""
    rate_column: str = ""
    rate_low_column: str = ""
    rate_high_column: str = ""


def required_text(setting_section: Mapping[str, Any], setting_name: str) -> str:
    """Read a non-empty text setting.

    Usage:
        Sheet and column names.

    Args:
        setting_section: Mapping holding the setting.
        setting_name: Its key.

    Returns:
        The stripped text.

    Raises:
        ValueError: If it is missing or empty.
    """
    setting_text = str(setting_section.get(setting_name) or "").strip()
    if not setting_text:
        raise ValueError(f"{_SETTING_PREFIX}.{setting_name} must be set")
    return setting_text


def read_frame_columns(frame_entry: Any) -> TpwFrameColumns:
    """Read one ``frames`` entry.

    Usage:
        read_tpw_workbook.

    Args:
        frame_entry: ``{"key", "label", "lonColumn", "latColumn"}``.

    Returns:
        The frame columns.

    Raises:
        ValueError: If the entry is not an object or its key is not ``[A-Za-z0-9_]{1,32}``.
    """
    if not isinstance(frame_entry, Mapping):
        raise ValueError(f"{_SETTING_PREFIX}.frames: every entry must be an object")
    frame_key = required_text(frame_entry, "key")
    if len(frame_key) > _MAX_FRAME_KEY_LENGTH or not set(frame_key) <= _FRAME_KEY_CHARS:
        raise ValueError(f"{_SETTING_PREFIX}.frames.key must match [A-Za-z0-9_]{{1,32}}, got {frame_key!r}")
    return TpwFrameColumns(
        frame_key=frame_key,
        frame_label=str(frame_entry.get("label") or frame_key),
        longitude_column=required_text(frame_entry, "lonColumn"),
        latitude_column=required_text(frame_entry, "latColumn"),
    )


def read_tpw_workbook(workbook_section: Mapping[str, Any], workbook_path: Path) -> TpwWorkbookConfig:
    """Build the workbook settings.

    Usage:
        read_paleomag_config, with the already validated workbook path.

    Args:
        workbook_section: The ``tpwWorkbook`` mapping.
        workbook_path: Resolved workbook path inside the source directory.

    Returns:
        The validated settings.

    Raises:
        ValueError: If a sheet, a column or the frame list is missing or invalid.
    """
    path_frames = tuple(read_frame_columns(frame_entry) for frame_entry in workbook_section.get("frames") or [])
    if not path_frames:
        raise ValueError(f"{_SETTING_PREFIX}.frames must list at least one TPW path")
    return TpwWorkbookConfig(
        workbook_path=workbook_path,
        path_sheet=required_text(workbook_section, "pathSheet"),
        age_column=required_text(workbook_section, "ageColumn"),
        confidence_column=str(workbook_section.get("confidenceColumn") or ""),
        path_frames=path_frames,
        rate_sheet=str(workbook_section.get("rateSheet") or ""),
        rate_column=str(workbook_section.get("rateColumn") or ""),
        rate_low_column=str(workbook_section.get("rateLowColumn") or ""),
        rate_high_column=str(workbook_section.get("rateHighColumn") or ""),
    )
