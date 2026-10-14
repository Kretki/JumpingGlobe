"""Read one worksheet of an .xlsx workbook as rows of cached cell values (no formulas evaluated).

Only the standard library ``zipfile`` and ``defusedxml`` are used. Every XML part is
size-checked before it is decompressed, and parsed with defusedxml, so a malformed or
hostile workbook cannot exhaust memory or expand entities.
"""

from __future__ import annotations

import posixpath
import zipfile
from pathlib import Path

from defusedxml import ElementTree

MAX_PART_BYTES = 32 * 1024 * 1024
_MAIN_NAMESPACE = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_RELATION_NAMESPACE = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_PACKAGE_RELATION_NAMESPACE = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_WORKBOOK_PART = "xl/workbook.xml"
_WORKBOOK_RELATIONS_PART = "xl/_rels/workbook.xml.rels"
_SHARED_STRINGS_PART = "xl/sharedStrings.xml"

CellValue = float | str | None


def read_part(workbook_zip: zipfile.ZipFile, part_name: str) -> bytes:
    """Read one part of the package after checking its uncompressed size.

    Usage:
        Every XML part read below.

    Args:
        workbook_zip: Open workbook package.
        part_name: Part path inside the package, e.g. ``xl/workbook.xml``.

    Returns:
        The part's bytes.

    Raises:
        KeyError: If the part does not exist.
        ValueError: If the part is larger than MAX_PART_BYTES.
    """
    part_info = workbook_zip.getinfo(part_name)
    if part_info.file_size > MAX_PART_BYTES:
        raise ValueError(f"{part_name} is too large ({part_info.file_size} bytes)")
    return workbook_zip.read(part_info)


def shared_strings(workbook_zip: zipfile.ZipFile) -> list[str]:
    """Read the shared-string table (empty when the workbook has none).

    Usage:
        Resolve cells of type ``s``.

    Args:
        workbook_zip: Open workbook package.

    Returns:
        Strings in table order (rich-text runs joined).
    """
    if _SHARED_STRINGS_PART not in workbook_zip.namelist():
        return []
    string_root = ElementTree.fromstring(read_part(workbook_zip, _SHARED_STRINGS_PART))
    return [
        "".join(text_node.text or "" for text_node in string_item.iter(f"{_MAIN_NAMESPACE}t"))
        for string_item in string_root.iter(f"{_MAIN_NAMESPACE}si")
    ]


def sheet_part_name(workbook_zip: zipfile.ZipFile, sheet_name: str) -> str:
    """Find the package part of a worksheet by its tab name.

    Usage:
        read_sheet_rows.

    Args:
        workbook_zip: Open workbook package.
        sheet_name: Worksheet tab name, e.g. ``TPWPs``.

    Returns:
        Part path such as ``xl/worksheets/sheet5.xml``.

    Raises:
        ValueError: If the sheet or its relationship is missing or points outside ``xl/``.
    """
    workbook_root = ElementTree.fromstring(read_part(workbook_zip, _WORKBOOK_PART))
    relation_id = next(
        (
            sheet_node.get(f"{_RELATION_NAMESPACE}id")
            for sheet_node in workbook_root.iter(f"{_MAIN_NAMESPACE}sheet")
            if sheet_node.get("name") == sheet_name
        ),
        None,
    )
    relations_root = ElementTree.fromstring(read_part(workbook_zip, _WORKBOOK_RELATIONS_PART))
    target_path = next(
        (
            relation_node.get("Target", "")
            for relation_node in relations_root.iter(f"{_PACKAGE_RELATION_NAMESPACE}Relationship")
            if relation_id is not None and relation_node.get("Id") == relation_id
        ),
        "",
    )
    part_name = posixpath.normpath(target_path.lstrip("/") if target_path.startswith("/") else f"xl/{target_path}")
    if not target_path or not part_name.startswith("xl/"):
        raise ValueError(f"worksheet {sheet_name!r} not found")
    return part_name


def column_index(cell_reference: str) -> int:
    """Zero-based column of a cell reference.

    Usage:
        Place cells of sparse rows.

    Args:
        cell_reference: Reference such as ``C12``.

    Returns:
        Column index (A = 0).
    """
    column_number = 0
    for reference_char in cell_reference:
        if not reference_char.isalpha():
            break
        column_number = column_number * 26 + (ord(reference_char.upper()) - ord("A") + 1)
    return column_number - 1


def cell_value(cell_node: ElementTree.Element, string_table: list[str]) -> CellValue:
    """Cached value of one cell.

    Usage:
        read_sheet_rows.

    Args:
        cell_node: ``<c>`` element.
        string_table: Shared strings.

    Returns:
        A float for numbers, a string for text, None for empty or unreadable cells.
    """
    cell_type = cell_node.get("t", "n")
    if cell_type == "inlineStr":
        return "".join(text_node.text or "" for text_node in cell_node.iter(f"{_MAIN_NAMESPACE}t"))
    value_node = cell_node.find(f"{_MAIN_NAMESPACE}v")
    value_text = value_node.text if value_node is not None else None
    if value_text is None:
        return None
    if cell_type == "s":
        string_index = int(value_text)
        return string_table[string_index] if 0 <= string_index < len(string_table) else None
    if cell_type in ("str", "e"):
        return value_text
    try:
        return float(value_text)
    except ValueError:
        return None


def read_sheet_rows(workbook_path: Path, sheet_name: str) -> list[dict[str, CellValue]]:
    """Read a worksheet whose first row holds column names.

    Usage:
        Tables of a configured workbook (the path never comes from a request).

    Args:
        workbook_path: The .xlsx file.
        sheet_name: Worksheet tab name.

    Returns:
        One dictionary per data row (column name -> value); rows without any value are skipped.

    Raises:
        OSError: If the file cannot be read.
        ValueError: If the file is not a workbook, the sheet is missing or a part is too large.
    """
    try:
        with zipfile.ZipFile(workbook_path) as workbook_zip:
            string_table = shared_strings(workbook_zip)
            sheet_root = ElementTree.fromstring(read_part(workbook_zip, sheet_part_name(workbook_zip, sheet_name)))
    except (zipfile.BadZipFile, KeyError) as exception:
        raise ValueError(f"{workbook_path.name}: not a readable .xlsx workbook") from exception
    grid_rows: list[dict[int, CellValue]] = []
    for row_node in sheet_root.iter(f"{_MAIN_NAMESPACE}row"):
        grid_rows.append(
            {
                column_index(cell_node.get("r", "")): cell_value(cell_node, string_table)
                for cell_node in row_node.iter(f"{_MAIN_NAMESPACE}c")
            }
        )
    if not grid_rows:
        return []
    header_names = {
        column_number: str(header_value).strip() for column_number, header_value in grid_rows[0].items() if header_value
    }
    table_rows = [
        {
            header_names[column_number]: row_value
            for column_number, row_value in grid_row.items()
            if column_number in header_names
        }
        for grid_row in grid_rows[1:]
    ]
    return [table_row for table_row in table_rows if any(row_value is not None for row_value in table_row.values())]
