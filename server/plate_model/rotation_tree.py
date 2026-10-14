"""Plate rotation tree: a plate's total rotation relative to the anchor at an age.

Mirror of src/plates/rotationTree.ts; keep the two in sync.
"""

from __future__ import annotations

from typing import Any

from server.shared_utils.quaternion_math import (
    IDENTITY_QUATERNION,
    Quaternion,
    quat_from_pole,
    quat_multiply,
    quat_slerp,
)

_MAX_CHAIN_DEPTH = 64

PoleSequence = tuple[int, list[float], list[Quaternion]]
"""(fixed plate id, ascending ages, quaternion per age)."""
RotationMemo = dict[int, Quaternion | None]


def build_sequences(pole_rows: list[list[float]]) -> list[PoleSequence]:
    """Group a moving plate's poles into runs with the same fixed plate and ascending ages.

    Usage:
        Called once per moving plate when the tree is built. A new run starts when
        the fixed plate changes (crossover) or the age goes back (the next
        rotation file of a multi-file model), so every run is interpolable.

    Args:
        pole_rows: Rows ``[age, lat, lon, angle, fixed_id]`` in file order.

    Returns:
        List of (fixed plate id, ages, quaternions) sequences in file order.
    """
    sequences: list[PoleSequence] = []
    for age_in_ma, pole_latitude, pole_longitude, angle_deg, fixed_plate in pole_rows:
        if not sequences or sequences[-1][0] != int(fixed_plate) or float(age_in_ma) < sequences[-1][1][-1]:
            sequences.append((int(fixed_plate), [], []))
        sequences[-1][1].append(float(age_in_ma))
        sequences[-1][2].append(quat_from_pole(pole_latitude, pole_longitude, angle_deg))
    return sequences


def interpolate_sequence(sequence_ages: list[float], quaternions: list[Quaternion], age_in_ma: float) -> Quaternion:
    """Interpolate a pole sequence at an age inside its range.

    Usage:
        Called by RotationTree.relative once the covering sequence is found.

    Args:
        sequence_ages: Ascending ages of the sequence (Ma).
        quaternions: Quaternion for each age.
        age_in_ma: Age within [sequence_ages[0], sequence_ages[-1]].

    Returns:
        The slerp-interpolated quaternion (the only pole for single-pole sequences).
    """
    if len(sequence_ages) == 1:
        return quaternions[0]
    lower_idx, upper_idx = 0, len(sequence_ages) - 1
    while upper_idx - lower_idx > 1:
        middle_idx = (lower_idx + upper_idx) // 2
        if sequence_ages[middle_idx] <= age_in_ma:
            lower_idx = middle_idx
        else:
            upper_idx = middle_idx
    lower_age, upper_age = sequence_ages[lower_idx], sequence_ages[upper_idx]
    fraction = (age_in_ma - lower_age) / (upper_age - lower_age) if upper_age > lower_age else 0.0
    return quat_slerp(quaternions[lower_idx], quaternions[upper_idx], fraction)


class RotationTree:
    """Total rotation of a plate relative to the anchor at an age; None where undefined."""

    def __init__(self, rotation_model: dict[str, Any]) -> None:
        """Build the per-plate pole sequences.

        Usage:
            ``RotationTree(parse_rotation_file(path))``.

        Args:
            rotation_model: Model from rotation_parser.parse_rotation_file.

        Returns:
            None.
        """
        self.max_age_ma = float(rotation_model["maxAge"])
        self._sequences: dict[int, list[PoleSequence]] = {
            int(plate_key): build_sequences(pole_rows) for plate_key, pole_rows in rotation_model["plates"].items()
        }

    def relative(self, plate_id: int, age_in_ma: float) -> tuple[int, Quaternion] | None:
        """Rotation of a plate relative to its fixed plate at an age.

        Usage:
            One link of the plate chain; total() walks the chain.

        Args:
            plate_id: Moving plate id.
            age_in_ma: Age in Ma.

        Returns:
            Tuple (fixed plate id, quaternion), or None when no sequence covers the age.
        """
        for fixed_plate, sequence_ages, quaternions in self._sequences.get(plate_id, ()):
            if sequence_ages[0] <= age_in_ma <= sequence_ages[-1]:
                return fixed_plate, interpolate_sequence(sequence_ages, quaternions, age_in_ma)
        return None

    def total_rotation(
        self, plate_id: int, age_in_ma: float, rotation_memo: RotationMemo | None = None, chain_depth: int = 0
    ) -> Quaternion | None:
        """Rotation of a plate relative to the anchor (plate 0) at an age.

        Usage:
            ``tree.total_rotation(plate_id, age, memo)``; reuse one memo dict for many plates
            at the same age to avoid recomputing shared parents.

        Args:
            plate_id: Plate id; 0 is the anchor.
            age_in_ma: Age in Ma; ages <= 0 give the identity.
            rotation_memo: Optional per-age cache, filled in place.
            chain_depth: Recursion depth guard (internal).

        Returns:
            The total quaternion, or None when some link of the chain has no poles
            at that age (callers hide such geometry).
        """
        if plate_id == 0 or age_in_ma <= 0:
            return IDENTITY_QUATERNION
        memo_cache: RotationMemo = {} if rotation_memo is None else rotation_memo
        if plate_id in memo_cache:
            return memo_cache[plate_id]
        total_quat: Quaternion | None = None
        relative_link = self.relative(plate_id, age_in_ma) if chain_depth < _MAX_CHAIN_DEPTH else None
        if relative_link is not None:
            fixed_plate, relative_quat = relative_link
            if fixed_plate in (plate_id, 0):
                total_quat = relative_quat
            else:
                parent_quat = self.total_rotation(fixed_plate, age_in_ma, memo_cache, chain_depth + 1)
                total_quat = quat_multiply(parent_quat, relative_quat) if parent_quat is not None else None
        memo_cache[plate_id] = total_quat
        return total_quat
