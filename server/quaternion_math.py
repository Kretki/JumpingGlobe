"""Quaternion and unit-vector_xyz helpers for plate rotations (mirror of src/plates/quaternionMath.ts; keep in sync)."""

from __future__ import annotations

import math

Quaternion = tuple[float, float, float, float]
"""Unit quaternion (w, x, y, z)."""
UnitVector = tuple[float, float, float]

IDENTITY_QUATERNION: Quaternion = (1.0, 0.0, 0.0, 0.0)
_DEG_TO_RAD = math.pi / 180.0
_SLERP_LINEAR_THRESHOLD = 0.9999995


def quat_from_pole(pole_latitude: float, pole_longitude: float, angle_deg: float) -> Quaternion:
    """Build the rotation quaternion of a finite Euler pole.

    Usage:
        Convert each row of a .rot file into a quaternion.

    Args:
        pole_latitude: Pole latitude in degrees.
        pole_longitude: Pole longitude in degrees.
        angle_deg: Rotation angle in degrees (right-handed about the pole).

    Returns:
        The unit quaternion (w, x, y, z).
    """
    latitude_rad = pole_latitude * _DEG_TO_RAD
    longitude_rad = pole_longitude * _DEG_TO_RAD
    half_angle = angle_deg * _DEG_TO_RAD / 2
    sin_half = math.sin(half_angle)
    cos_latitude = math.cos(latitude_rad)
    return (
        math.cos(half_angle),
        sin_half * cos_latitude * math.cos(longitude_rad),
        sin_half * cos_latitude * math.sin(longitude_rad),
        sin_half * math.sin(latitude_rad),
    )


def quat_multiply(left_quat: Quaternion, right_quat: Quaternion) -> Quaternion:
    """Hamilton product ``left_quat * right_quat`` (apply right first, then left).

    Usage:
        Compose a parent plate's total rotation with a child's relative rotation.

    Args:
        left_quat: Quaternion applied second.
        right_quat: Quaternion applied first.

    Returns:
        The product quaternion.
    """
    quat_a_w, quat_a_x, quat_a_y, quat_a_z = left_quat
    quat_b_w, quat_b_x, quat_b_y, quat_b_z = right_quat
    return (
        quat_a_w * quat_b_w - quat_a_x * quat_b_x - quat_a_y * quat_b_y - quat_a_z * quat_b_z,
        quat_a_w * quat_b_x + quat_a_x * quat_b_w + quat_a_y * quat_b_z - quat_a_z * quat_b_y,
        quat_a_w * quat_b_y - quat_a_x * quat_b_z + quat_a_y * quat_b_w + quat_a_z * quat_b_x,
        quat_a_w * quat_b_z + quat_a_x * quat_b_y - quat_a_y * quat_b_x + quat_a_z * quat_b_w,
    )


def quat_conjugate(quaternion: Quaternion) -> Quaternion:
    """Return the conjugate (the inverse rotation for a unit quaternion).

    Usage:
        Rotate a reconstructed position back to present-day coordinates.

    Args:
        quaternion: Unit quaternion (w, x, y, z).

    Returns:
        (w, -x, -y, -z).
    """
    return (quaternion[0], -quaternion[1], -quaternion[2], -quaternion[3])


def quat_slerp(start_quat: Quaternion, end_quat: Quaternion, fraction: float) -> Quaternion:
    """Spherical linear interpolation along the shorter arc.

    Usage:
        Interpolate between two total poles of the same sequence.

    Args:
        start_quat: Quaternion at fraction 0.
        end_quat: Quaternion at fraction 1.
        fraction: Interpolation parameter in [0, 1].

    Returns:
        The normalised interpolated quaternion.
    """
    dot_product = sum(start_part * end_part for start_part, end_part in zip(start_quat, end_quat, strict=True))
    if dot_product < 0:
        end_quat = (-end_quat[0], -end_quat[1], -end_quat[2], -end_quat[3])
        dot_product = -dot_product
    if dot_product > _SLERP_LINEAR_THRESHOLD:
        start_weight, end_weight = 1 - fraction, fraction
    else:
        arc_angle = math.acos(min(1.0, dot_product))
        sin_of_arc = math.sin(arc_angle)
        start_weight = math.sin((1 - fraction) * arc_angle) / sin_of_arc
        end_weight = math.sin(fraction * arc_angle) / sin_of_arc
    blended_quat = tuple(
        start_weight * start_part + end_weight * end_part
        for start_part, end_part in zip(start_quat, end_quat, strict=True)
    )
    magnitude = math.sqrt(sum(component * component for component in blended_quat)) or 1.0
    return (
        blended_quat[0] / magnitude,
        blended_quat[1] / magnitude,
        blended_quat[2] / magnitude,
        blended_quat[3] / magnitude,
    )


def quat_rotate(quaternion: Quaternion, vector_xyz: UnitVector) -> UnitVector:
    """Rotate a 3D vector_xyz by a unit quaternion.

    Usage:
        Move a present-day unit vector_xyz to its position at some age, or back.

    Args:
        quaternion: Unit quaternion (w, x, y, z).
        vector_xyz: Vector (x, y, z) to rotate.

    Returns:
        The rotated vector_xyz.
    """
    scalar_w, q_axis_x, q_axis_y, q_axis_z = quaternion
    vector_x, vector_y, vector_z = vector_xyz
    temp_vec_x = 2 * (q_axis_y * vector_z - q_axis_z * vector_y)
    temp_vec_y = 2 * (q_axis_z * vector_x - q_axis_x * vector_z)
    temp_vec_z = 2 * (q_axis_x * vector_y - q_axis_y * vector_x)
    return (
        vector_x + scalar_w * temp_vec_x + (q_axis_y * temp_vec_z - q_axis_z * temp_vec_y),
        vector_y + scalar_w * temp_vec_y + (q_axis_z * temp_vec_x - q_axis_x * temp_vec_z),
        vector_z + scalar_w * temp_vec_z + (q_axis_x * temp_vec_y - q_axis_y * temp_vec_x),
    )


def lonlat_to_unit(longitude: float, latitude: float) -> UnitVector:
    """Convert lon/lat to a unit vector_xyz, treating them as spherical coordinates (GPlates convention).

    Usage:
        Prepare a point for quaternion rotation.

    Args:
        longitude: Longitude in degrees.
        latitude: Latitude in degrees.

    Returns:
        Unit vector_xyz (x, y, z) with z towards the north pole.
    """
    latitude_rad, longitude_rad = latitude * _DEG_TO_RAD, longitude * _DEG_TO_RAD
    return (
        math.cos(latitude_rad) * math.cos(longitude_rad),
        math.cos(latitude_rad) * math.sin(longitude_rad),
        math.sin(latitude_rad),
    )


def unit_to_lonlat(vector_xyz: UnitVector) -> tuple[float, float]:
    """Convert a unit vector_xyz back to lon/lat (spherical, GPlates convention).

    Usage:
        Read the position of a rotated point.

    Args:
        vector_xyz: Unit vector_xyz (x, y, z).

    Returns:
        Tuple (longitude, latitude) in degrees.
    """
    return (
        math.atan2(vector_xyz[1], vector_xyz[0]) / _DEG_TO_RAD,
        math.asin(max(-1.0, min(1.0, vector_xyz[2]))) / _DEG_TO_RAD,
    )
