"""Grid index over the present-day static polygons that own land."""

from __future__ import annotations

import math
from collections.abc import Iterator
from dataclasses import dataclass

from osgeo import ogr

from plate_tagging.geometry_filters import Envelope, polygonal_part

CELL_DEG = 5.0
MAX_SEARCH_PAD_DEG = 360.0


@dataclass(frozen=True)
class StaticEntry:
    """One present-day static polygon."""

    plate_id: int
    from_age_ma: float
    to_age_ma: float
    geometry: ogr.Geometry
    envelope: Envelope


def grid_cells(envelope: Envelope) -> Iterator[tuple[int, int]]:
    """Yield the grid cells an envelope touches.

    Usage:
        Index insertion and candidate lookup.

    Args:
        envelope: (min x, max x, min y, max y) in degrees.

    Returns:
        Iterator of (column, row) cell keys of CELL_DEG-sized cells.
    """
    env_min_x, env_max_x, env_min_y, env_max_y = envelope
    for cell_column in range(math.floor(env_min_x / CELL_DEG), math.floor(env_max_x / CELL_DEG) + 1):
        for cell_row in range(math.floor(env_min_y / CELL_DEG), math.floor(env_max_y / CELL_DEG) + 1):
            yield cell_column, cell_row


def envelopes_overlap(first_env: Envelope, second_env: Envelope) -> bool:
    """Test two OGR envelopes for overlap.

    Usage:
        Pre-filter before exact geometry tests.

    Args:
        first_env: (min x, max x, min y, max y).
        second_env: (min x, max x, min y, max y).

    Returns:
        True when they share at least one point.
    """
    return (
        first_env[0] <= second_env[1]
        and first_env[1] >= second_env[0]
        and first_env[2] <= second_env[3]
        and first_env[3] >= second_env[2]
    )


def envelope_contains(outer_env: Envelope, inner_env: Envelope) -> bool:
    """Test whether one OGR envelope contains another.

    Usage:
        Shortcut before an exact Contains test.

    Args:
        outer_env: (min x, max x, min y, max y).
        inner_env: (min x, max x, min y, max y).

    Returns:
        True when inner_env lies within outer_env.
    """
    return (
        outer_env[0] <= inner_env[0]
        and outer_env[1] >= inner_env[1]
        and outer_env[2] <= inner_env[2]
        and outer_env[3] >= inner_env[3]
    )


class StaticPolygonIndex:
    """Static polygons that exist today, bucketed into a regular lon/lat grid."""

    def __init__(self) -> None:
        """Create an empty index.

        Usage:
            ``StaticPolygonIndex.from_file(path)`` is the normal constructor.

        Returns:
            None.
        """
        self.static_entries: list[StaticEntry] = []
        self._cell_grid: dict[tuple[int, int], list[int]] = {}

    @classmethod
    def from_file(cls, static_path: str) -> StaticPolygonIndex:
        """Load the static polygons that are present today (to_age == 0).

        Usage:
            Called once per worker process.

        Args:
            static_path: GeoPackage with plate_id, from_age and to_age fields.

        Returns:
            The populated index.
        """
        static_index = cls()
        datasource = ogr.Open(static_path)
        for static_feature in datasource.GetLayer(0):
            if float(static_feature.GetField("to_age") or 0) > 0:
                continue  # not present today: cannot own present-day land
            geometry = polygonal_part(static_feature.GetGeometryRef().Clone())
            if geometry is not None:
                static_index.add_polygon(
                    int(static_feature.GetField("plate_id")), float(static_feature.GetField("from_age")), geometry
                )
        return static_index

    def add_polygon(self, plate_id: int, from_age_ma: float, geometry: ogr.Geometry) -> None:
        """Insert one present-day static polygon.

        Usage:
            Called by from_file.

        Args:
            plate_id: Reconstruction plate id.
            from_age_ma: Age (Ma) when the polygon appears.
            geometry: Its MultiPolygon geometry.

        Returns:
            None.
        """
        envelope = geometry.GetEnvelope()
        entry_idx = len(self.static_entries)
        self.static_entries.append(StaticEntry(plate_id, from_age_ma, 0.0, geometry, envelope))
        for cell_key in grid_cells(envelope):
            self._cell_grid.setdefault(cell_key, []).append(entry_idx)

    def candidates(self, envelope: Envelope) -> list[int]:
        """Entries whose envelope overlaps a query envelope.

        Usage:
            Pre-filter for piece assignment.

        Args:
            envelope: (min x, max x, min y, max y).

        Returns:
            Entry indices sorted oldest first, so overlaps resolve to the
            long-lived owner.
        """
        matched_ids: set[int] = set()
        for cell_key in grid_cells(envelope):
            for entry_idx in self._cell_grid.get(cell_key, ()):
                entry_envelope = self.static_entries[entry_idx].envelope
                if entry_idx not in matched_ids and envelopes_overlap(entry_envelope, envelope):
                    matched_ids.add(entry_idx)
        return sorted(matched_ids, key=lambda entry_idx: -self.static_entries[entry_idx].from_age_ma)

    def nearest_entry(self, geometry: ogr.Geometry) -> int:
        """Entry closest to a geometry, searching outward in growing rings.

        Usage:
            Owner for land in gaps between static polygons.

        Args:
            geometry: Land piece not covered by any static polygon.

        Returns:
            Index of the nearest entry (0 when nothing is found within 360°).
        """
        envelope = geometry.GetEnvelope()
        search_pad = CELL_DEG
        while search_pad <= MAX_SEARCH_PAD_DEG:
            padded_env = (
                envelope[0] - search_pad,
                envelope[1] + search_pad,
                envelope[2] - search_pad,
                envelope[3] + search_pad,
            )
            nearby_ids = self.candidates(padded_env)
            if nearby_ids:
                return min(nearby_ids, key=lambda entry_idx: geometry.Distance(self.static_entries[entry_idx].geometry))
            search_pad *= 2
        return 0
