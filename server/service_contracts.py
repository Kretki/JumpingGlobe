"""Abstractions the HTTP layer depends on (dependency inversion: routes never touch SQLite or files directly)."""

from __future__ import annotations

from typing import Any, Protocol

from server.rotation_tree import RotationTree
from server.spherical_geometry import BoundingBox


class LandResponder(Protocol):
    """Produces encoded land responses."""

    def available_lods(self) -> list[str]:
        """Return the servable GeoPackage file names."""
        ...

    def file_stats(self, file_name: str) -> dict[str, Any]:
        """Return feature count and size of one GeoPackage."""
        ...

    def land_json(self, file_name: str, bounding_box: BoundingBox, feature_limit: int, min_area: float) -> bytes:
        """Return the encoded FeatureCollection for a present-day bbox query."""
        ...

    def past_json(
        self,
        file_name: str,
        age_in_ma: float,
        view_center: tuple[float, float],
        radius_deg: float,
        feature_limit: int,
        min_area: float,
    ) -> bytes:
        """Return the encoded FeatureCollection for a past-age view-cap query."""
        ...


class RotationResponder(Protocol):
    """Serves the rotation model."""

    def is_available(self) -> bool:
        """Tell whether the rotation file exists."""
        ...

    def file_name(self) -> str:
        """Return the rotation file's base name (for error messages)."""
        ...

    def rotations_json(self) -> bytes:
        """Return the encoded rotation model."""
        ...


class RotationTreeSource(Protocol):
    """Supplies the current rotation tree (for past-age land queries)."""

    def rotation_tree(self) -> RotationTree:
        """Return the rotation tree of the current model files."""
        ...


class PlateLayerStatus(Protocol):
    """Readiness of the derived plate layers."""

    build_status: str
    status_detail: str

    def ensure_built(self) -> None:
        """Start a background build for stale layers if needed."""
        ...

    def ready_plate_files(self) -> dict[str, str]:
        """Return LOD file -> plate-tagged twin for up-to-date twins."""
        ...

    def static_file(self) -> str | None:
        """Return the static-polygon file name when it is up to date."""
        ...

    def outlines_file(self) -> str | None:
        """Return the plate-outline file name when it is up to date."""
        ...
