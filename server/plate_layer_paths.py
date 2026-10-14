"""Inputs and outputs of the plate-layer build, derived from lod.json and the repository layout."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from server.lod_config import BAND_FILES, DATA_DIR, PROJECT_ROOT
from server.plate_model_config import PLATE_MODEL


@dataclass(frozen=True)
class PlateLayerPaths:
    """Filesystem inputs and outputs of the plate-layer build.

    Attributes:
        project_root: Working directory of the prep script.
        data_directory: lod.json dataDir (LOD inputs and every derived output).
        band_files: LOD file names in processing order.
        model_tag: Plate-model tag passed to the prep script (names the outputs).
        static_gpml: Static-polygon source of the plate model (GPML or GPMLZ).
        static_file: Derived static-polygon GeoPackage name.
        outlines_file: Derived plate-outline GeoPackage name.
        twin_namer: Maps a LOD file name to its plate-tagged twin name.
        prep_script: Shell script that builds the outputs.
        log_file: Where the prep script's output is written.
        tool_sources: Scripts whose changes make every output stale.
    """

    project_root: Path
    data_directory: Path
    band_files: list[str]
    model_tag: str
    static_gpml: Path
    static_file: str
    outlines_file: str
    twin_namer: Callable[[str], str]
    prep_script: Path
    log_file: Path
    tool_sources: list[Path] = field(default_factory=list)


def default_plate_layer_paths() -> PlateLayerPaths:
    """Build the paths from lod.json (plateModel section) and the repository layout.

    Usage:
        ``PlateLayerBuilder(default_plate_layer_paths())``.

    Returns:
        PlateLayerPaths for this checkout. Tool sources include the prep script and
        every Python file of the tagging tools, so editing them triggers a rebuild.
    """
    tools_directory = PROJECT_ROOT / "tools"
    tool_sources = [PLATE_MODEL.prep_script, tools_directory / "plate_tag.py", tools_directory / "gpml_to_geojson.py"]
    tool_sources += sorted((tools_directory / "plate_tagging").glob("*.py"))
    return PlateLayerPaths(
        project_root=PROJECT_ROOT,
        data_directory=DATA_DIR,
        band_files=list(BAND_FILES),
        model_tag=PLATE_MODEL.model_tag,
        static_gpml=PLATE_MODEL.static_polygons,
        static_file=PLATE_MODEL.static_polygons_file,
        outlines_file=PLATE_MODEL.outlines_file,
        twin_namer=PLATE_MODEL.twin_name,
        prep_script=PLATE_MODEL.prep_script,
        log_file=DATA_DIR / PLATE_MODEL.log_file_name,
        tool_sources=tool_sources,
    )
