"""Read the true-polar-wander data into JSON-ready records.

* TPW paths: per configured frame, the spin-axis pole (lon, lat) and its 95 % confidence
  radius at each age of the path sheet; ages where the frame has no pole are left out.
* Polar-wander rates of the rate sheet (with lower and upper bounds).
* Net TPW angles: a CSV with ``age``, ``PW_rate`` and ``net_angle`` (empty cells allowed).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from server.paleomag_config import CsvSource
from server.paleomag_tables import table_rows, wrapped_longitude
from server.paleomag_values import parse_number
from server.tpw_config import TpwFrameColumns, TpwWorkbookConfig
from server.xlsx_sheets import CellValue, read_sheet_rows


def number_or_none(cell_value: CellValue | str | None) -> float | None:
    """Read a workbook or CSV cell as a number.

    Usage:
        Every numeric cell below.

    Args:
        cell_value: Float, text or None.

    Returns:
        The number, or None when empty or not numeric.
    """
    if isinstance(cell_value, float):
        return cell_value
    return parse_number(cell_value)


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


def read_net_angles(table_path_source: CsvSource | None) -> list[dict[str, Any]]:
    """Read the TPW rate and net-angle table.

    Usage:
        PaleoMagService (rate note under the TPW checkboxes).

    Args:
        table_path_source: CsvSource of the table, or None.

    Returns:
        ``[{"ageMa", "rateDegPerMyr", "netAngleDeg"}]`` sorted by age (either value may be None).

    Raises:
        OSError: If the table cannot be read.
    """
    if table_path_source is None:
        return []
    angle_samples: list[dict[str, Any]] = []
    for table_row in table_rows(table_path_source.file_path):
        age_ma = parse_number(table_row.get("age"))
        if age_ma is None:
            continue
        angle_samples.append(
            {
                "ageMa": age_ma,
                "rateDegPerMyr": parse_number(table_row.get("PW_rate")),
                "netAngleDeg": parse_number(table_row.get("net_angle")),
            }
        )
    return sorted(angle_samples, key=lambda angle_sample: angle_sample["ageMa"])
