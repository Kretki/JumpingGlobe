"""Read the true-polar-wander data into JSON-ready records.

* TPW paths: per configured frame, the spin-axis pole (lon, lat) and its 95 % confidence
  radius at each age of the path sheet; ages where the frame has no pole are left out.
* Polar-wander rates of the rate sheet (with lower and upper bounds).
* Net TPW angles: a CSV with ``age``, ``PW_rate`` and ``net_angle`` (empty cells allowed), read with polars.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import polars as pl

from server.configuration.tpw_config import TpwFrameColumns, TpwWorkbookConfig
from server.paleomagnetism.xlsx_sheets import CellValue, read_sheet_rows


def number_or_none(cell_value: CellValue) -> float | None:
    """Read a workbook cell as a number.

    Usage:
        Every numeric cell of the workbook.

    Args:
        cell_value: Float, text or None.

    Returns:
        The number, or None when empty or not numeric.
    """
    if isinstance(cell_value, float):
        return cell_value
    try:
        return float(str(cell_value).strip().replace("−", "-")) if cell_value is not None else None
    except ValueError:
        return None


def wrapped_longitude(longitude_deg: float) -> float:
    """Wrap a longitude to -180..180.

    Usage:
        Path pole longitudes.

    Args:
        longitude_deg: Longitude in degrees.

    Returns:
        The equivalent longitude in -180..180.
    """
    return (longitude_deg + 180.0) % 360.0 - 180.0


def path_point(
    sheet_row: Mapping[str, CellValue], workbook_config: TpwWorkbookConfig, path_frame: TpwFrameColumns
) -> dict[str, Any] | None:
    """One pole of a TPW path.

    Usage:
        read_tpw_paths.

    Args:
        sheet_row: Row of the path sheet.
        workbook_config: Column names.
        path_frame: Frame whose columns are read.

    Returns:
        ``{"ageMa", "longitudeDeg", "latitudeDeg", "confidenceDeg"}``, or None when the frame has
        no pole at this age.
    """
    age_ma = number_or_none(sheet_row.get(workbook_config.age_column))
    longitude_deg = number_or_none(sheet_row.get(path_frame.longitude_column))
    latitude_deg = number_or_none(sheet_row.get(path_frame.latitude_column))
    if age_ma is None or age_ma < 0 or longitude_deg is None or latitude_deg is None or abs(latitude_deg) > 90:
        return None
    confidence_deg = (
        number_or_none(sheet_row.get(workbook_config.confidence_column)) if workbook_config.confidence_column else None
    )
    return {
        "ageMa": age_ma,
        "longitudeDeg": wrapped_longitude(longitude_deg),
        "latitudeDeg": latitude_deg,
        "confidenceDeg": confidence_deg if confidence_deg is not None and confidence_deg >= 0 else None,
    }


def read_tpw_paths(workbook_config: TpwWorkbookConfig) -> list[dict[str, Any]]:
    """Read every configured TPW path.

    Usage:
        PaleoMagService, once per file version.

    Args:
        workbook_config: Workbook settings.

    Returns:
        ``[{"frameKey", "frameLabel", "points": [...]}]`` in configured order, points sorted by age.

    Raises:
        OSError: If the workbook cannot be read.
        ValueError: If the path sheet is missing.
    """
    sheet_rows = read_sheet_rows(workbook_config.workbook_path, workbook_config.path_sheet)
    tpw_paths: list[dict[str, Any]] = []
    for path_frame in workbook_config.path_frames:
        frame_points = [path_point(sheet_row, workbook_config, path_frame) for sheet_row in sheet_rows]
        present_points = sorted(
            (frame_point for frame_point in frame_points if frame_point), key=lambda frame_point: frame_point["ageMa"]
        )
        tpw_paths.append(
            {"frameKey": path_frame.frame_key, "frameLabel": path_frame.frame_label, "points": present_points}
        )
    return tpw_paths


def read_tpw_rates(workbook_config: TpwWorkbookConfig) -> list[dict[str, Any]]:
    """Read the polar-wander rates of the rate sheet.

    Usage:
        PaleoMagService (rate note under the TPW checkboxes).

    Args:
        workbook_config: Workbook settings (an empty rate sheet disables the rates).

    Returns:
        ``[{"ageMa", "rateDegPerMyr", "rateLowDegPerMyr", "rateHighDegPerMyr"}]`` sorted by age.

    Raises:
        OSError: If the workbook cannot be read.
        ValueError: If the rate sheet is missing.
    """
    if not workbook_config.rate_sheet or not workbook_config.rate_column:
        return []
    rate_samples: list[dict[str, Any]] = []
    for sheet_row in read_sheet_rows(workbook_config.workbook_path, workbook_config.rate_sheet):
        age_ma = number_or_none(sheet_row.get(workbook_config.age_column))
        rate_value = number_or_none(sheet_row.get(workbook_config.rate_column))
        if age_ma is None or rate_value is None:
            continue
        rate_samples.append(
            {
                "ageMa": age_ma,
                "rateDegPerMyr": rate_value,
                "rateLowDegPerMyr": number_or_none(sheet_row.get(workbook_config.rate_low_column)),
                "rateHighDegPerMyr": number_or_none(sheet_row.get(workbook_config.rate_high_column)),
            }
        )
    return sorted(rate_samples, key=lambda rate_sample: rate_sample["ageMa"])


def read_net_angles(table_path: Path | None) -> list[dict[str, Any]]:
    """Read the TPW rate and net-angle table with polars.

    Usage:
        PaleoMagService (rate note under the TPW checkboxes).

    Args:
        table_path: CSV with ``age``, ``PW_rate`` and ``net_angle`` columns, or None.

    Returns:
        ``[{"ageMa", "rateDegPerMyr", "netAngleDeg"}]`` sorted by age (either value may be None).

    Raises:
        OSError: If the table cannot be read.
        polars.exceptions.PolarsError: If it is not a CSV with those columns.
    """
    if table_path is None:
        return []
    raw_frame = pl.read_csv(table_path, infer_schema_length=0, encoding="utf8-lossy")
    angle_frame = (
        raw_frame.select(
            pl.col("age").str.strip_chars().cast(pl.Float64, strict=False).alias("ageMa"),
            pl.col("PW_rate").str.strip_chars().cast(pl.Float64, strict=False).alias("rateDegPerMyr"),
            pl.col("net_angle").str.strip_chars().cast(pl.Float64, strict=False).alias("netAngleDeg"),
        )
        .filter(pl.col("ageMa").is_not_null())
        .sort("ageMa")
    )
    return angle_frame.to_dicts()
