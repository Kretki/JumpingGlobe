"""Convert one worksheet of an .xlsx workbook to CSV (used for the PINT database download).

Usage:
    python -m tools.xlsx_to_csv <workbook.xlsx> <sheet name> <output.csv>

The worksheet's first row becomes the header. Cached cell values are written as they
are; whole numbers stored as floats are written without ``.0`` (site names such as
``93`` stay ``93``). The output is written to a temporary file next to it and moved into
place, so readers never see a partial file. Exit status 0 on success, 1 on a read or
write error, 2 on bad usage.
"""

from __future__ import annotations

import csv
import os
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

from server.paleomagnetism.xlsx_sheets import CellValue, read_sheet_rows

USAGE_TEXT = "usage: python -m tools.xlsx_to_csv <workbook.xlsx> <sheet name> <output.csv>"


def cell_text(cell_value: CellValue) -> str:
    """Text of one cell for the CSV.

    Usage:
        write_sheet_csv, per cell.

    Args:
        cell_value: Float, text or None.

    Returns:
        "" for empty cells, whole floats without a fraction, other values as Python prints them.
    """
    if cell_value is None:
        return ""
    if isinstance(cell_value, float) and cell_value.is_integer() and abs(cell_value) < 1e15:
        return str(int(cell_value))
    return str(cell_value)


def write_sheet_csv(workbook_path: Path, sheet_name: str, output_path: Path) -> int:
    """Write a worksheet as CSV.

    Usage:
        main; also importable for scripts.

    Args:
        workbook_path: Source workbook.
        sheet_name: Worksheet tab name.
        output_path: CSV file to write (replaced atomically).

    Returns:
        Number of data rows written.

    Raises:
        OSError: If a file cannot be read or written.
        ValueError: If the workbook or the sheet cannot be read.
    """
    sheet_rows = read_sheet_rows(workbook_path, sheet_name)
    header_names = list(sheet_rows[0]) if sheet_rows else []
    for sheet_row in sheet_rows[1:]:
        header_names.extend(column_name for column_name in sheet_row if column_name not in header_names)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    file_handle, partial_name = tempfile.mkstemp(prefix=".csv_", dir=output_path.parent)
    try:
        with os.fdopen(file_handle, "w", encoding="utf-8", newline="") as csv_file:
            csv_writer = csv.writer(csv_file)
            csv_writer.writerow(header_names)
            for sheet_row in sheet_rows:
                csv_writer.writerow([cell_text(sheet_row.get(column_name)) for column_name in header_names])
        os.chmod(partial_name, 0o644)
        os.replace(partial_name, output_path)
    except BaseException:
        Path(partial_name).unlink(missing_ok=True)
        raise
    return len(sheet_rows)


def main(argument_list: Sequence[str]) -> int:
    """Command-line entry point.

    Usage:
        ``python -m tools.xlsx_to_csv book.xlsx Sheet1 out.csv``.

    Args:
        argument_list: Arguments without the program name.

    Returns:
        Exit status (0 ok, 1 error, 2 usage).
    """
    if len(argument_list) != 3:
        print(USAGE_TEXT, file=sys.stderr)
        return 2
    workbook_path, sheet_name, output_path = Path(argument_list[0]), argument_list[1], Path(argument_list[2])
    try:
        row_count = write_sheet_csv(workbook_path, sheet_name, output_path)
    except (OSError, ValueError) as exception:
        print(f"xlsx_to_csv: {exception}", file=sys.stderr)
        return 1
    print(f"Wrote {row_count} rows -> {output_path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
