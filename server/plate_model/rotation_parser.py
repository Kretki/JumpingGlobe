"""Parse GPlates .rot files into the compact rotation model the client reconstructs from."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

# GPlates convention: moving plate 999 marks a commented-out pole.
_COMMENT_PLATE = 999
_MIN_POLE_FIELDS = 6

PoleRecord = list[float]
"""[age Ma, pole latitude, pole longitude, angle deg, fixed plate id]."""
PlatePoles = dict[str, list[PoleRecord]]


def parse_pole_line(text_line: str) -> tuple[int, PoleRecord] | None:
    """Parse one line of a .rot file.

    Usage:
        Called for every line by read_rotation_file; text after ``!`` is a comment.

    Args:
        text_line: Raw line of the rotation file.

    Returns:
        Tuple (moving plate id, pole row), or None for comments, short or
        malformed lines and commented-out poles (moving plate 999).
    """
    field_list = text_line.split("!", 1)[0].split()
    if len(field_list) < _MIN_POLE_FIELDS:
        return None
    try:
        moving_plate = int(field_list[0])
        pole_age, pole_latitude, pole_longitude, angle_deg = (float(field_value) for field_value in field_list[1:5])
        fixed_plate = int(field_list[5])
    except ValueError:
        return None
    if moving_plate == _COMMENT_PLATE:
        return None
    return moving_plate, [pole_age, pole_latitude, pole_longitude, angle_deg, fixed_plate]


def read_rotation_file(rotation_path: Path, plate_poles: PlatePoles) -> float:
    """Append the poles of one .rot file to a per-plate pole table.

    Usage:
        Called once per file by parse_rotation_files, in load order.

    Args:
        rotation_path: Path of the .rot file.
        plate_poles: Table ``moving_id_str -> rows`` extended in place.

    Returns:
        Oldest pole age found in this file, in Ma (0.0 for an empty file).

    Raises:
        OSError: If the file cannot be read.
    """
    oldest_age = 0.0
    with open(rotation_path, encoding="utf-8", errors="replace") as rotation_file:
        for text_line in rotation_file:
            parsed_pole = parse_pole_line(text_line)
            if parsed_pole is None:
                continue
            moving_plate, pole_row = parsed_pole
            plate_poles.setdefault(str(moving_plate), []).append(pole_row)
            oldest_age = max(oldest_age, pole_row[0])
    return oldest_age


def parse_rotation_files(rotation_paths: Sequence[Path]) -> dict[str, Any]:
    """Read one or more GPlates rotation files into ``{"maxAge", "plates"}``.

    Usage:
        Build the model served by /api/rotations and used by RotationTree. Models
        split over several files (Cao et al. 2024: 0-1000 Ma and 1000-1800 Ma) are
        concatenated per moving plate in file order; RotationTree starts a new
        interpolation sequence wherever the fixed plate changes or the age goes
        back, so each file's sequences stay separate and earlier files win where
        their age ranges overlap.

    Args:
        rotation_paths: .rot files in load order.

    Returns:
        ``{"maxAge": float, "plates": {moving_id_str: [[age, lat, lon, angle, fixed_id], ...]}}``.

    Raises:
        OSError: If a file cannot be read.
    """
    plate_poles: PlatePoles = {}
    oldest_age = 0.0
    for rotation_path in rotation_paths:
        oldest_age = max(oldest_age, read_rotation_file(rotation_path, plate_poles))
    return {"maxAge": oldest_age, "plates": plate_poles}
