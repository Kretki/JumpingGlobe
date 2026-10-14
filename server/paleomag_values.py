"""Parsing of the free-text cells of the paleomagnetic tables: numbers, confidence radii and ages.

The tables come from paper supplements, so cells hold forms such as ``−29.5``,
``3.0/1.8``, ``5.5(1)``, ``≥4.2``, ``~820–810``, ``848 ± 27/834 ± 9``,
``≤779.52 ± 0.92`` or a period name such as ``Late Cretaceous``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

_BOUND_PREFIXES = "~≤≥<>"
_RANGE_DASHES = ("–", "—", " to ")
_PART_SEPARATORS = ("&", "/")
_PLUS_MINUS = "±"


@dataclass(frozen=True)
class AgeWindow:
    """Ages a value applies to.

    Attributes:
        young_age_ma: Youngest age in Ma.
        old_age_ma: Oldest age in Ma (>= young_age_ma).
        nominal_age_ma: Representative age in Ma (middle of the window).
    """

    young_age_ma: float
    old_age_ma: float
    nominal_age_ma: float


def clean_cell(cell_text: str | None) -> str:
    """Normalise a table cell (Unicode minus, surrounding blanks).

    Usage:
        Before any parsing of a cell.

    Args:
        cell_text: Raw cell text (None for a missing cell).

    Returns:
        The cleaned text ("" for a missing cell).
    """
    return (cell_text or "").replace("−", "-").strip()


def strip_footnote(cell_text: str) -> str:
    """Remove a trailing numeric footnote marker such as ``(1)``.

    Usage:
        Rate cells like ``5.5(1)``.

    Args:
        cell_text: Cleaned cell text.

    Returns:
        The text without the marker.
    """
    open_index = cell_text.rfind("(")
    if cell_text.endswith(")") and open_index > 0 and cell_text[open_index + 1 : -1].isdigit():
        return cell_text[:open_index].strip()
    return cell_text


def parse_number(cell_text: str | None) -> float | None:
    """Read one number, ignoring bound prefixes (``~``, ``≤``, ``≥``) and footnote markers.

    Usage:
        Latitudes, longitudes, angles, rates.

    Args:
        cell_text: Raw cell text.

    Returns:
        The value, or None when the cell holds no number.
    """
    number_text = strip_footnote(clean_cell(cell_text)).lstrip(_BOUND_PREFIXES).strip()
    try:
        return float(number_text)
    except ValueError:
        return None


def parse_confidence(cell_text: str | None) -> float | None:
    """Read a 95 % confidence radius; for a ``dp/dm`` ellipse the larger semi-axis.

    Usage:
        ``a95_or_dmdp`` columns.

    Args:
        cell_text: Raw cell text, e.g. ``6.6`` or ``3.0/1.8``.

    Returns:
        Radius in degrees, or None when absent.
    """
    axis_values = [parse_number(axis_text) for axis_text in clean_cell(cell_text).split("/")]
    present_values = [axis_value for axis_value in axis_values if axis_value is not None]
    return max(present_values) if present_values else None


def split_parts(age_text: str) -> list[str]:
    """Split an age cell into independent determinations (``a & b``, ``a/b``).

    Usage:
        parse_age_window.

    Args:
        age_text: Cleaned age text with range dashes already replaced by ``-``.

    Returns:
        Non-empty parts.
    """
    part_list = [age_text]
    for separator_text in _PART_SEPARATORS:
        part_list = [piece_text for part_text in part_list for piece_text in part_text.split(separator_text)]
    return [part_text.strip() for part_text in part_list if part_text.strip()]


def part_range(part_text: str) -> tuple[float, float] | None:
    """Age range of one determination: ``v ± e``, ``a-b`` or a single value.

    Usage:
        parse_age_window.

    Args:
        part_text: One part, e.g. ``834 ± 9``, ``820-810`` or ``832``.

    Returns:
        (young, old) in Ma, or None when it holds no age.
    """
    core_text = part_text.lstrip(_BOUND_PREFIXES).strip()
    if _PLUS_MINUS in core_text:
        value_text, error_text = core_text.split(_PLUS_MINUS, 1)
        central_age, age_error = parse_number(value_text), parse_number(error_text)
        if central_age is None or age_error is None:
            return None
        return central_age - abs(age_error), central_age + abs(age_error)
    if "-" in core_text[1:]:
        first_text, second_text = core_text.split("-", 1)
        first_age, second_age = parse_number(first_text), parse_number(second_text)
        if first_age is None or second_age is None:
            return None
        return min(first_age, second_age), max(first_age, second_age)
    single_age = parse_number(core_text)
    return None if single_age is None else (single_age, single_age)


def parse_age_window(
    age_cell: str | None, named_ages: Mapping[str, tuple[float, float]], min_window_myr: float
) -> AgeWindow | None:
    """Read an age cell as the window of ages the value applies to.

    Usage:
        Pole and rotation ages. Windows narrower than ``min_window_myr`` are widened
        around their middle so a pole dated ``821.64 ± 0.2`` is still shown on a 1 Myr timeline.

    Args:
        age_cell: Raw cell, e.g. ``~820–810``, ``848 ± 27/834 ± 9`` or ``Late Cretaceous``.
        named_ages: Period name -> (young, old) in Ma.
        min_window_myr: Narrowest window in Myr (> 0).

    Returns:
        The window (union of all determinations in the cell), or None when unreadable.
    """
    age_text = clean_cell(age_cell)
    named_range = named_ages.get(age_text)
    if named_range is not None:
        part_ranges = [named_range]
    else:
        for dash_text in _RANGE_DASHES:
            age_text = age_text.replace(dash_text, "-")
        parsed_ranges = [part_range(part_text) for part_text in split_parts(age_text)]
        part_ranges = [age_range for age_range in parsed_ranges if age_range is not None]
    if not part_ranges:
        return None
    youngest_age = max(0.0, min(age_range[0] for age_range in part_ranges))
    oldest_age = max(age_range[1] for age_range in part_ranges)
    nominal_age = (youngest_age + oldest_age) / 2
    half_window = max((oldest_age - youngest_age) / 2, min_window_myr / 2)
    return AgeWindow(max(0.0, nominal_age - half_window), nominal_age + half_window, nominal_age)
