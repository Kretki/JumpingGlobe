"""Plate-model settings from the ``plateModel`` section of lod.json and the names of the files derived from it.

The model (currently Cao et al. 2024, 1.8 Ga) lives in ``plateModel.sourceDir``. Its prep
script (``plateModel.prepScript``) writes every derived file into lod.json ``dataDir``
under names that carry the model tag, so layers built from another model are never
mistaken for up-to-date ones.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from server.lod_config import LOD_CONFIG, PROJECT_ROOT

_MODEL_TAG_PATTERN = re.compile(r"^[a-z0-9_]{1,32}$")
_GPKG_SUFFIX = ".gpkg"


@dataclass(frozen=True)
class PlateModelConfig:
    """Validated plate-model paths and limits.

    Attributes:
        model_tag: Short lower-case model name used in derived file names (e.g. ``cao``).
        source_directory: Directory with the model's rotation and static-polygon files.
        rotation_files: Rotation files in load order (earlier files win where ages overlap).
        static_polygons: Static-polygon GPML/GPMLZ file (plate partition of the surface).
        max_age_ma: Oldest age offered to the client, in Ma (> 0).
        prep_script: Shell script that builds the derived layers.
        topology_files: GPML files with the topological plate polygons and every
            feature their sections reference (ridges, subduction zones, ...).
        topology_script: Shell script that exports the topologies to JSON.
    """

    model_tag: str
    source_directory: Path
    rotation_files: tuple[Path, ...]
    static_polygons: Path
    max_age_ma: float
    prep_script: Path
    topology_files: tuple[Path, ...] = ()
    topology_script: Path | None = None

    @property
    def static_polygons_file(self) -> str:
        """Name of the simplified static-polygon GeoPackage used for point picking.

        Usage:
            Reported as ``staticFile`` by /api/plates/status.

        Returns:
            File name inside dataDir, e.g. ``cao_static.gpkg``.
        """
        return f"{self.model_tag}_static{_GPKG_SUFFIX}"

    @property
    def outlines_file(self) -> str:
        """Name of the plate-outline GeoPackage (static polygons dissolved per plate and lifetime).

        Usage:
            Reported as ``outlinesFile`` by /api/plates/status.

        Returns:
            File name inside dataDir, e.g. ``cao_plate_outlines.gpkg``.
        """
        return f"{self.model_tag}_plate_outlines{_GPKG_SUFFIX}"

    @property
    def topology_file(self) -> str:
        """Name of the exported topology model (plate polygons and boundary sections).

        Usage:
            Reported as ``topologyFile`` by /api/plates/status; served by /api/plates/topologies.

        Returns:
            File name inside dataDir, e.g. ``cao_topologies.json``.
        """
        return f"{self.model_tag}_topologies.json"

    @property
    def topology_log_name(self) -> str:
        """Name of the topology export's log file.

        Usage:
            Written next to the derived layers by TopologyLayerBuilder.

        Returns:
            File name inside dataDir, e.g. ``cao_topologies.log``.
        """
        return f"{self.model_tag}_topologies.log"

    @property
    def log_file_name(self) -> str:
        """Name of the prep script's log file.

        Usage:
            Written next to the derived layers by PlateLayerBuilder.

        Returns:
            File name inside dataDir, e.g. ``cao_prep.log``.
        """
        return f"{self.model_tag}_prep.log"

    def twin_name(self, lod_file_name: str) -> str:
        """Return the file name of the plate-tagged twin of a land LOD file.

        Usage:
            Map a LOD GeoPackage name (from lod.json) to the derived file that the
            prep script writes next to it.

        Args:
            lod_file_name: LOD file name, e.g. ``land_lod2.gpkg``.

        Returns:
            The twin file name, e.g. ``land_lod2_cao_plates.gpkg``.
        """
        base_name = lod_file_name[: -len(_GPKG_SUFFIX)] if lod_file_name.endswith(_GPKG_SUFFIX) else lod_file_name
        return f"{base_name}_{self.model_tag}_plates{_GPKG_SUFFIX}"


def plain_file_name(config_value: Any, setting_name: str) -> str:
    """Validate a configured file name that must stay inside its directory.

    Usage:
        Rotation and static-polygon names of the plateModel section.

    Args:
        config_value: Value read from lod.json.
        setting_name: Setting name for the error message.

    Returns:
        The file name as a string.

    Raises:
        ValueError: If the value is empty, contains a directory part or ``..``.
    """
    file_name = str(config_value or "")
    if not file_name or Path(file_name).name != file_name or file_name in (".", ".."):
        raise ValueError(f"lod.json plateModel.{setting_name}: expected a bare file name, got {file_name!r}")
    return file_name


def read_plate_model(model_section: Mapping[str, Any], project_root: Path) -> PlateModelConfig:
    """Build a PlateModelConfig from the ``plateModel`` section of lod.json.

    Usage:
        Called once at import time (PLATE_MODEL below); tests may call it with a dict.

    Args:
        model_section: The ``plateModel`` mapping (tag, sourceDir, rotationFiles,
            staticPolygons, maxAgeMa, prepScript and optionally topologyFiles, topologyScript).
        project_root: Directory the relative paths are resolved against.

    Returns:
        The validated configuration.

    Raises:
        ValueError: If the tag is not ``[a-z0-9_]{1,32}``, a file name is not a bare
            name, no rotation file is configured or maxAgeMa is not positive.
    """
    model_tag = str(model_section.get("tag") or "")
    if not _MODEL_TAG_PATTERN.match(model_tag):
        raise ValueError(f"lod.json plateModel.tag must match {_MODEL_TAG_PATTERN.pattern}, got {model_tag!r}")
    source_directory = (project_root / str(model_section.get("sourceDir") or "")).resolve()
    rotation_names = [
        plain_file_name(file_name, "rotationFiles") for file_name in model_section.get("rotationFiles") or []
    ]
    if not rotation_names:
        raise ValueError("lod.json plateModel.rotationFiles must list at least one .rot file")
    max_age_ma = float(model_section.get("maxAgeMa") or 0.0)
    if max_age_ma <= 0:
        raise ValueError("lod.json plateModel.maxAgeMa must be a positive age in Ma")
    topology_names = [
        plain_file_name(file_name, "topologyFiles") for file_name in model_section.get("topologyFiles") or []
    ]
    topology_script = model_section.get("topologyScript")
    return PlateModelConfig(
        model_tag=model_tag,
        source_directory=source_directory,
        rotation_files=tuple(source_directory / file_name for file_name in rotation_names),
        static_polygons=source_directory / plain_file_name(model_section.get("staticPolygons"), "staticPolygons"),
        max_age_ma=max_age_ma,
        prep_script=(project_root / str(model_section.get("prepScript") or "")).resolve(),
        topology_files=tuple(source_directory / file_name for file_name in topology_names),
        topology_script=(project_root / str(topology_script)).resolve() if topology_script else None,
    )


PLATE_MODEL: PlateModelConfig = read_plate_model(LOD_CONFIG.get("plateModel") or {}, PROJECT_ROOT)
