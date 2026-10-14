"""Read the paleomagnetic pole tables (CSV) into JSON-ready records.

Pole tables use the column names of the paper supplements: ``pole_id``, ``age_ma`` or
``age``, ``lat_N``, ``lon_E``, ``a95_or_dmdp`` and optionally ``block``, ``rock_unit``,
``references`` / ``pole_references``. Rows without the required numbers (such as the
trailing "Notes" rows) are skipped and counted.
"""

from __future__ import annotations

import csv
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from server.paleomag_config import CsvSource, PaleoMagConfig
from server.paleomag_values import clean_cell, parse_age_window, parse_confidence, parse_number


@dataclass
class TableRecords:
    """Records read from all tables.

    Attributes:
        pole_records: Paleomagnetic poles.
        skipped_rows: Rows that could not be read.
    """

    pole_records: list[dict[str, Any]] = field(default_factory=list)
    skipped_rows: int = 0


def table_rows(table_path: Path) -> Iterator[dict[str, str]]:
    """Iterate the rows of a CSV table with cleaned column names.

    Usage:
        Every table reader.

    Args:
        table_path: Configured table path (never from a request).

    Returns:
        Iterator of column -> cell dictionaries.

    Raises:
        OSError: If the file cannot be read.
    """
    with table_path.open(encoding="utf-8-sig", newline="") as table_file:
        for table_row in csv.DictReader(table_file):
            yield {clean_cell(column_name): cell_text for column_name, cell_text in table_row.items() if column_name}


def first_cell(table_row: Mapping[str, str], column_names: tuple[str, ...]) -> str:
    """Return the first non-empty cell among alternative column names.

    Usage:
        Columns named differently across tables (``age_ma`` / ``age``).

    Args:
        table_row: One row.
        column_names: Candidate columns in priority order.

    Returns:
        The cleaned cell, or "".
    """
    for column_name in column_names:
        cell_text = clean_cell(table_row.get(column_name))
        if cell_text:
            return cell_text
    return ""


def wrapped_longitude(longitude_deg: float) -> float:
    """Wrap a longitude to -180..180.

    Usage:
        Pole longitudes given as 0..360 east.

    Args:
        longitude_deg: Longitude in degrees.

    Returns:
        The equivalent longitude in -180..180.
    """
    return (longitude_deg + 180.0) % 360.0 - 180.0


def pole_record(
    table_row: Mapping[str, str], table_source: CsvSource, paleo_config: PaleoMagConfig
) -> dict[str, Any] | None:
    """Convert one pole row.

    Usage:
        read_pole_table.

    Args:
        table_row: Row of a pole table.
        table_source: The table (default block, file name).
        paleo_config: Block plate ids, named ages and the minimum window.

    Returns:
        JSON-ready pole, or None when position or age is missing or out of range.
    """
    latitude_deg = parse_number(table_row.get("lat_N"))
    longitude_deg = parse_number(table_row.get("lon_E"))
    age_cell = first_cell(table_row, ("age_ma", "age"))
    age_window = parse_age_window(age_cell, paleo_config.named_ages_ma, paleo_config.min_window_myr)
    if latitude_deg is None or longitude_deg is None or age_window is None or abs(latitude_deg) > 90:
        return None
    block_name = first_cell(table_row, ("block",)) or table_source.default_block
    return {
        "poleName": first_cell(table_row, ("pole_id", "pole_name")),
        "block": block_name,
        "plateId": paleo_config.block_plate_ids.get(block_name),
        "rockUnit": first_cell(table_row, ("rock_unit",)),
        "ageText": first_cell(table_row, ("age_ma", "age")),
        "youngAgeMa": age_window.young_age_ma,
        "oldAgeMa": age_window.old_age_ma,
        "nominalAgeMa": age_window.nominal_age_ma,
        "latitudeDeg": latitude_deg,
        "longitudeDeg": wrapped_longitude(longitude_deg),
        "confidenceDeg": parse_confidence(table_row.get("a95_or_dmdp")),
        "references": first_cell(table_row, ("references", "pole_references")),
        "sourceFile": table_source.file_path.name,
    }


def read_pole_table(table_source: CsvSource, paleo_config: PaleoMagConfig, table_records: TableRecords) -> None:
    """Append the poles of one table.

    Usage:
        read_all_tables.

    Args:
        table_source: The table.
        paleo_config: Paleomagnetic settings.
        table_records: Collected records (mutated).

    Returns:
        None.
    """
    for table_row in table_rows(table_source.file_path):
        parsed_pole = pole_record(table_row, table_source, paleo_config)
        if parsed_pole is None:
            table_records.skipped_rows += 1
        else:
            table_records.pole_records.append(parsed_pole)


def read_all_tables(paleo_config: PaleoMagConfig) -> TableRecords:
    """Read every configured pole table.

    Usage:
        PaleoMagService, once per file version (TPW data: server/tpw_tables.py).

    Args:
        paleo_config: Paleomagnetic settings.

    Returns:
        All poles and the count of skipped rows.

    Raises:
        OSError: If a configured table cannot be read.
    """
    table_records = TableRecords()
    for pole_source in paleo_config.pole_sources:
        read_pole_table(pole_source, paleo_config, table_records)
    return table_records
