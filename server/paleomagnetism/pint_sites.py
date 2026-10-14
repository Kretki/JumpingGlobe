"""Read the PINT paleointensity database with polars and derive each site's virtual geomagnetic pole.

PINT (v8.2) lists one row per site: location (``SLAT``, ``SLONG``), age (``AGE`` ± ``DAGE``),
polarity (``P``: N, R, T; O or empty = unknown), the site-mean field direction (``INC``,
``DEC``) and the dipole moment in 10²² A·m² (``VDM``, ``VADM`` or ``VDM/VADM``). Every
cell is read as text first and converted with ``strict=False``, so malformed cells become
nulls instead of failing the whole file.
"""

from __future__ import annotations

import math
from pathlib import Path

import polars as pl

_DEG_TO_RAD = math.pi / 180
_RAD_TO_DEG = 180 / math.pi
MAX_MOMENT_E22 = 60.0
KNOWN_POLARITIES = ("N", "R", "T")

_NUMBER_COLUMNS = {
    "SLAT": "site_lat",
    "SLONG": "site_lon",
    "AGE": "age_ma",
    "DAGE": "age_error",
    "INC": "inclination",
    "DEC": "declination",
    "VDM": "vdm_e22",
    "VADM": "vadm_e22",
    "VDM/VADM": "either_moment_e22",
}
_TEXT_COLUMNS = {"IDENT": "site_name", "P": "polarity"}


def number_column(source_name: str) -> pl.Expr:
    """Text column converted to a float (unreadable cells become null).

    Usage:
        Every numeric PINT column.

    Args:
        source_name: Column name in the CSV.

    Returns:
        Float64 expression.
    """
    return pl.col(source_name).str.strip_chars().cast(pl.Float64, strict=False)


def wrapped_longitude(longitude_expr: pl.Expr) -> pl.Expr:
    """Wrap longitudes to -180..180.

    Usage:
        Site and pole longitudes (PINT uses 0..360 east).

    Args:
        longitude_expr: Longitudes in degrees.

    Returns:
        Expression in -180..180.
    """
    return (longitude_expr + 180.0) % 360.0 - 180.0


def vgp_columns() -> list[pl.Expr]:
    """Virtual geomagnetic pole of each site (null without a direction).

    Usage:
        read_pint_sites. Standard formulas (e.g. Butler 1992): the pole's angular distance
        from the site is p = atan2(2·cos I, sin I); latitude and longitude follow from the
        spherical triangle with the declination.

    Returns:
        Expressions for ``vgp_lat`` and ``vgp_lon`` in degrees.
    """
    site_lat = pl.col("site_lat") * _DEG_TO_RAD
    inclination = pl.col("inclination") * _DEG_TO_RAD
    declination = pl.col("declination") * _DEG_TO_RAD
    pole_distance = pl.arctan2(2 * inclination.cos(), inclination.sin())
    pole_lat = (
        (site_lat.sin() * pole_distance.cos() + site_lat.cos() * pole_distance.sin() * declination.cos())
        .clip(-1, 1)
        .arcsin()
    )
    longitude_offset = (pole_distance.sin() * declination.sin() / pole_lat.cos()).clip(-1, 1).arcsin()
    near_side = pole_distance.cos() >= site_lat.sin() * pole_lat.sin()
    pole_lon = pl.when(near_side).then(longitude_offset).otherwise(math.pi - longitude_offset) * _RAD_TO_DEG + pl.col(
        "site_lon"
    )
    return [(pole_lat * _RAD_TO_DEG).alias("vgp_lat"), wrapped_longitude(pole_lon).alias("vgp_lon")]


def read_pint_sites(csv_path: Path) -> pl.DataFrame:
    """Read and clean the PINT table.

    Usage:
        PaleoMagService, once per file version (the path never comes from a request).

    Args:
        csv_path: PINT CSV file.

    Returns:
        One row per usable site: ``site_name``, ``site_lat``, ``site_lon``, ``age_ma``,
        ``age_error``, ``polarity`` (N/R/T/U), ``moment_e22`` (null when unknown),
        ``vgp_lat``/``vgp_lon`` (null without a direction), sorted by age. Rows without a valid
        location or age, or with neither a direction nor a moment, are dropped.

    Raises:
        OSError: If the file cannot be read.
        polars.exceptions.PolarsError: If the file is not a CSV with the PINT columns.
    """
    raw_frame = pl.read_csv(csv_path, infer_schema_length=0, encoding="utf8-lossy")
    raw_frame = raw_frame.rename({column_name: column_name.lstrip("﻿").strip() for column_name in raw_frame.columns})
    typed_frame = raw_frame.select(
        [number_column(source_name).alias(target_name) for source_name, target_name in _NUMBER_COLUMNS.items()]
        + [
            pl.col(source_name).str.strip_chars().alias(target_name)
            for source_name, target_name in _TEXT_COLUMNS.items()
        ]
    )
    moment = pl.coalesce("vdm_e22", "vadm_e22", "either_moment_e22")
    direction_known = pl.col("inclination").is_between(-90, 90) & pl.col("declination").is_not_null()
    cleaned_frame = typed_frame.with_columns(
        wrapped_longitude(pl.col("site_lon")).alias("site_lon"),
        pl.col("age_error").fill_null(0.0).abs().alias("age_error"),
        pl.when(pl.col("polarity").str.to_uppercase().is_in(KNOWN_POLARITIES))
        .then(pl.col("polarity").str.to_uppercase())
        .otherwise(pl.lit("U"))
        .alias("polarity"),
        pl.when((moment > 0) & (moment <= MAX_MOMENT_E22)).then(moment).otherwise(None).alias("moment_e22"),
        pl.col("site_name").fill_null(""),
    ).filter(pl.col("site_lat").is_between(-90, 90) & pl.col("site_lon").is_not_null() & (pl.col("age_ma") >= 0))
    with_poles = cleaned_frame.with_columns(
        [pl.when(direction_known).then(vgp_expr).otherwise(None) for vgp_expr in vgp_columns()]
    )
    usable_frame = with_poles.filter(pl.col("vgp_lat").is_not_null() | pl.col("moment_e22").is_not_null())
    return usable_frame.select(
        "site_name", "site_lat", "site_lon", "age_ma", "age_error", "polarity", "moment_e22", "vgp_lat", "vgp_lon"
    ).sort("age_ma")
