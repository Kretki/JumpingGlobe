"""
Build the plate-topology model (plate polygons and boundary sections, JSON) on demand in the background.

The client resolves plate polygons, mid-ocean ridges, subduction zones and transforms
from this file at any age. It is exported by lod.json plateModel.topologyScript
(public/external/cao_topologies.sh) when missing or older than its sources; the export
takes about a second, independently of the land plate layers.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path

from server.build_utils import (
    STATUS_BUILDING,
    STATUS_FAILED,
    STATUS_READY,
    STATUS_UNAVAILABLE,
    last_log_line,
    modified_time,
    newest_time,
    run_logged_script,
)
from server.lod_config import DATA_DIR, PROJECT_ROOT
from server.plate_model_config import PLATE_MODEL


@dataclass(frozen=True)
class TopologyLayerPaths:
    """Inputs and outputs of the topology export.

    Attributes:
        project_root: Working directory of the export script.
        output_path: JSON file written into dataDir.
        log_path: Log file of the last export.
        export_script: Shell script running the exporter, or None when not configured.
        source_files: Topology GPML files (export order).
        tool_sources: Exporter sources; editing them makes the output stale.
    """

    project_root: Path
    output_path: Path
    log_path: Path
    export_script: Path | None
    source_files: tuple[Path, ...]
    tool_sources: list[Path] = field(default_factory=list)


def default_topology_paths() -> TopologyLayerPaths:
    """Build the paths from lod.json (plateModel section) and the repository layout.

    Usage:
        ``TopologyLayerBuilder(default_topology_paths())``.

    Returns:
        TopologyLayerPaths for this checkout.
    """
    tools_directory = PROJECT_ROOT / "tools"
    tool_sources = [tools_directory / "gpml_topologies.py", tools_directory / "gpml_to_geojson.py"]
    tool_sources += sorted((tools_directory / "topology_export").glob("*.py"))
    if PLATE_MODEL.topology_script is not None:
        tool_sources.append(PLATE_MODEL.topology_script)
    return TopologyLayerPaths(
        project_root=PROJECT_ROOT,
        output_path=DATA_DIR / PLATE_MODEL.topology_file,
        log_path=DATA_DIR / PLATE_MODEL.topology_log_name,
        export_script=PLATE_MODEL.topology_script,
        source_files=PLATE_MODEL.topology_files,
        tool_sources=tool_sources,
    )


class TopologyLayerBuilder:
    """Tracks the topology model file and re-exports it in the background when stale.

    ``build_status`` is one of 'ready', 'building', 'failed' or 'unavailable' (not configured or sources missing).
    """

    def __init__(self, topology_paths: TopologyLayerPaths) -> None:
        """Create the builder (no work starts until ensure_built()).

        Usage:
            ``TopologyLayerBuilder(default_topology_paths())``.

        Args:
            topology_paths: Inputs/outputs of the export.

        Returns:
            None.
        """
        self.build_status = STATUS_UNAVAILABLE
        self.status_detail = ""
        self._topology_paths = topology_paths
        self._state_lock = threading.Lock()

    def topology_path(self) -> Path | None:
        """Return the topology JSON path when it is up to date.

        Usage:
            Served by /api/plates/topologies.

        Returns:
            The path, or None while it is missing or stale.
        """
        paths = self._topology_paths
        newest_source = newest_time([*paths.source_files, *paths.tool_sources])
        return paths.output_path if modified_time(paths.output_path) >= newest_source else None

    def topology_file(self) -> str | None:
        """Return the topology file name when it is up to date.

        Usage:
            Reported as ``topologyFile`` by /api/plates/status.

        Returns:
            The file name, or None while it is missing or stale.
        """
        topology_path = self.topology_path()
        return topology_path.name if topology_path is not None else None

    def _missing_source(self) -> str | None:
        """Describe the first missing input, if any.

        Usage:
            ensure_built() reports 'unavailable' instead of failing the export.

        Returns:
            A short reason, or None when everything needed exists.
        """
        paths = self._topology_paths
        if paths.export_script is None or not paths.source_files:
            return "plateModel.topologyFiles / topologyScript not configured"
        for source_path in (paths.export_script, *paths.source_files):
            if not source_path.is_file():
                return f"missing {source_path.name}"
        return None

    def ensure_built(self) -> None:
        """Start a background export when the output is stale (no-op while one runs).

        Usage:
            Called at startup and on every status poll. A failed export is not
            retried until the server restarts.

        Returns:
            None.
        """
        with self._state_lock:
            if self.build_status == STATUS_BUILDING:
                return
            missing_reason = self._missing_source()
            if missing_reason:
                self.build_status, self.status_detail = STATUS_UNAVAILABLE, missing_reason
                return
            if self.topology_path() is not None:
                self.build_status, self.status_detail = STATUS_READY, ""
                return
            if self.build_status == STATUS_FAILED:
                return
            self.build_status, self.status_detail = STATUS_BUILDING, ""
        threading.Thread(target=self._run_export, name="topology-export", daemon=True).start()

    def _run_export(self) -> None:
        """Run the export script and record the outcome.

        Usage:
            Thread target started by ensure_built().

        Returns:
            None; updates ``build_status`` and ``status_detail``.
        """
        paths = self._topology_paths
        command_line = ["bash", str(paths.export_script), str(paths.output_path), *map(str, paths.source_files)]
        succeeded, error_detail = run_logged_script(command_line, paths.log_path, paths.project_root)
        if succeeded:
            self.build_status, self.status_detail = STATUS_READY, ""
            return
        self.build_status = STATUS_FAILED
        self.status_detail = error_detail or last_log_line(paths.log_path) or "topology export failed"
