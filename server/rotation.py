"""Parse a GPlates .rot file into the compact model the client reconstructs from."""

from __future__ import annotations

from pathlib import Path
from typing import Any

# GPlates convention: moving plate 999 marks a commented-out pole.
_COMMENT_PLATE = 999


def parse_rot(path: Path) -> dict[str, Any]:
    """
    Return {"maxAge": float, "plates": {moving_id: [[age, lat, lon, angle, fixed_id], ...]}}.

    Poles keep file order per moving plate, so consecutive rows with the same fixed
    plate form one interpolation sequence and fixed-plate switches (crossovers)
    stay where the file puts them.
    """
    plates: dict[str, list[list[float]]] = {}
    max_age = 0.0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            data = line.split("!", 1)[0].split()
            if len(data) < 6:
                continue
            try:
                moving = int(data[0])
                age, lat, lon, angle = (float(v) for v in data[1:5])
                fixed = int(data[5])
            except ValueError:
                continue
            if moving == _COMMENT_PLATE:
                continue
            plates.setdefault(str(moving), []).append([age, lat, lon, angle, fixed])
            max_age = max(max_age, age)
    return {"maxAge": max_age, "plates": plates}
