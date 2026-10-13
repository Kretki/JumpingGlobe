"""Parse a GPlates .rot file into the compact model the client reconstructs from."""

from __future__ import annotations

import math
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


# ---- Reconstruction (mirror of src/plates/rotation.ts; keep the two in sync) ----

Quat = tuple[float, float, float, float]
IDENTITY: Quat = (1.0, 0.0, 0.0, 0.0)
_D2R = math.pi / 180.0


def quat_from_pole(lat: float, lon: float, angle: float) -> Quat:
    la, lo, half = lat * _D2R, lon * _D2R, angle * _D2R / 2
    s, cl = math.sin(half), math.cos(la)
    return (math.cos(half), s * cl * math.cos(lo), s * cl * math.sin(lo), s * math.sin(la))


def quat_mul(a: Quat, b: Quat) -> Quat:
    return (
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    )


def quat_conj(q: Quat) -> Quat:
    return (q[0], -q[1], -q[2], -q[3])


def quat_slerp(a: Quat, b: Quat, t: float) -> Quat:
    dot = sum(x * y for x, y in zip(a, b))
    if dot < 0:
        b = tuple(-x for x in b)  # type: ignore[assignment]
        dot = -dot
    if dot > 0.9999995:
        k0, k1 = 1 - t, t
    else:
        th = math.acos(min(1.0, dot))
        s = math.sin(th)
        k0, k1 = math.sin((1 - t) * th) / s, math.sin(t * th) / s
    q = tuple(k0 * x + k1 * y for x, y in zip(a, b))
    n = math.sqrt(sum(x * x for x in q)) or 1.0
    return tuple(x / n for x in q)  # type: ignore[return-value]


def quat_rotate(q: Quat, v: tuple[float, float, float]) -> tuple[float, float, float]:
    w, qx, qy, qz = q
    x, y, z = v
    tx, ty, tz = 2 * (qy * z - qz * y), 2 * (qz * x - qx * z), 2 * (qx * y - qy * x)
    return (
        x + w * tx + (qy * tz - qz * ty),
        y + w * ty + (qz * tx - qx * tz),
        z + w * tz + (qx * ty - qy * tx),
    )


def lonlat_to_unit(lon: float, lat: float) -> tuple[float, float, float]:
    """GPlates convention: lon/lat treated as spherical coordinates."""
    la, lo = lat * _D2R, lon * _D2R
    return (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))


def unit_to_lonlat(v: tuple[float, float, float]) -> tuple[float, float]:
    return (math.atan2(v[1], v[0]) / _D2R, math.asin(max(-1.0, min(1.0, v[2]))) / _D2R)


class RotationTree:
    """Total rotation of a plate relative to the anchor at an age; None when undefined."""

    def __init__(self, model: dict[str, Any]) -> None:
        self.max_age = float(model["maxAge"])
        self._seqs: dict[int, list[tuple[int, list[float], list[Quat]]]] = {}
        for pid, poles in model["plates"].items():
            seqs: list[tuple[int, list[float], list[Quat]]] = []
            for age, lat, lon, angle, fixed in poles:
                if not seqs or seqs[-1][0] != int(fixed):
                    seqs.append((int(fixed), [], []))
                seqs[-1][1].append(float(age))
                seqs[-1][2].append(quat_from_pole(lat, lon, angle))
            self._seqs[int(pid)] = seqs

    def relative(self, plate: int, age: float) -> tuple[int, Quat] | None:
        for fixed, ages, quats in self._seqs.get(plate, ()):
            if age < ages[0] or age > ages[-1]:
                continue
            if len(ages) == 1:
                return fixed, quats[0]
            lo, hi = 0, len(ages) - 1
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if ages[mid] <= age:
                    lo = mid
                else:
                    hi = mid
            a0, a1 = ages[lo], ages[hi]
            t = (age - a0) / (a1 - a0) if a1 > a0 else 0.0
            return fixed, quat_slerp(quats[lo], quats[hi], t)
        return None

    def total(self, plate: int, age: float, _memo: dict[int, Quat | None] | None = None, _depth: int = 0) -> Quat | None:
        if plate == 0 or age <= 0:
            return IDENTITY
        memo = {} if _memo is None else _memo
        if plate in memo:
            return memo[plate]
        q: Quat | None = None
        rel = self.relative(plate, age) if _depth < 64 else None
        if rel is not None:
            fixed, rq = rel
            if fixed in (plate, 0):
                q = rq
            else:
                parent = self.total(fixed, age, memo, _depth + 1)
                q = quat_mul(parent, rq) if parent is not None else None
        memo[plate] = q
        return q
