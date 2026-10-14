"""
Build the plate-reconstruction layers on demand (background thread).

The timeline needs derived GeoPackages in dataDir, written by the plate model's prep
script (lod.json plateModel.prepScript, e.g. public/external/cao_prep.sh): plate-tagged
twins of every land LOD, a simplified static-polygon file for point picking and the
plate-outline file drawn as a wireframe. They are rebuilt when missing or older than
their sources, so a fresh checkout or a LOD rebuild works without a manual step. Existing LOD files are never
modified. The world LOD is tagged first (seconds); detail LODs follow (minutes) and
become usable one by one.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

from server.build_utils import (
    STATUS_BUILDING,
    STATUS_FAILED,
    STATUS_READY,
    STATUS_UNAVAILABLE,
    last_log_line,
    modified_time,
    run_logged_script,
)
from server.plate_layer_paths import PlateLayerPaths


class PlateLayerBuilder:
    """Tracks the plate layers and rebuilds stale ones in the background.

    ``build_status`` is one of 'ready', 'building', 'failed' or 'unavailable' (no plate-model sources).
    """

    def __init__(self, layer_paths: PlateLayerPaths, on_rebuilt: Callable[[], None] | None = None) -> None:
        """Create the builder (no work starts until ensure_built()).

        Usage:
            ``PlateLayerBuilder(default_plate_layer_paths(), on_rebuilt=clear_caches)``.

        Args:
            layer_paths: Inputs/outputs of the build.
            on_rebuilt: Called after every build attempt, e.g. to drop response caches.

        Returns:
            None.
        """
        self.build_status = STATUS_UNAVAILABLE
        self.status_detail = ""
        self._layer_paths = layer_paths
        self._state_lock = threading.Lock()
        self._on_rebuilt = on_rebuilt

    def _base_mtime(self) -> float:
        """Newest modification time of the shared sources (static GPML and tools).

        Usage:
            Baseline every output must be newer than.

        Returns:
            Largest ``st_mtime`` among the sources (-1.0 for missing ones).
        """
        tool_times = (modified_time(tool_path) for tool_path in self._layer_paths.tool_sources)
        return max(modified_time(self._layer_paths.static_gpml), *tool_times)

    def _is_fresh(self, output_path: Path, source_path: Path | None) -> bool:
        """Tell whether an output is at least as new as its sources.

        Usage:
            Decide which outputs need a rebuild.

        Args:
            output_path: Derived file.
            source_path: Its specific source (a LOD file), or None.

        Returns:
            True when the output exists and is not older than any source.
        """
        newest_source = self._base_mtime()
        if source_path is not None:
            newest_source = max(newest_source, modified_time(source_path))
        return modified_time(output_path) >= newest_source

    def _fresh_shared_file(self, file_name: str) -> str | None:
        """Return a derived file name that depends only on the shared sources, when up to date.

        Usage:
            Static-polygon and plate-outline files.

        Args:
            file_name: File name inside the data directory.

        Returns:
            The file name, or None while it is missing or stale.
        """
        return file_name if self._is_fresh(self._layer_paths.data_directory / file_name, None) else None

    def static_file(self) -> str | None:
        """Return the static-polygon file name when it is up to date.

        Usage:
            Reported as ``staticFile`` by /api/plates/status.

        Returns:
            The file name, or None while it is missing or stale.
        """
        return self._fresh_shared_file(self._layer_paths.static_file)

    def outlines_file(self) -> str | None:
        """Return the plate-outline file name when it is up to date.

        Usage:
            Reported as ``outlinesFile`` by /api/plates/status.

        Returns:
            The file name, or None while it is missing or stale.
        """
        return self._fresh_shared_file(self._layer_paths.outlines_file)

    def ready_plate_files(self) -> dict[str, str]:
        """Map each LOD file to its plate-tagged twin, for twins that are up to date.

        Usage:
            Reported as ``plateFiles`` by /api/plates/status.

        Returns:
            Dictionary LOD file name -> twin file name.
        """
        ready_files: dict[str, str] = {}
        for lod_file in self._layer_paths.band_files:
            twin_file = self._layer_paths.twin_namer(lod_file)
            lod_path = self._layer_paths.data_directory / lod_file
            if lod_path.is_file() and self._is_fresh(self._layer_paths.data_directory / twin_file, lod_path):
                ready_files[lod_file] = twin_file
        return ready_files

    def ensure_built(self) -> None:
        """Start a background build for stale outputs (no-op while one is running).

        Usage:
            Called at startup and on every status poll. A failed build is not
            retried until the server restarts.

        Returns:
            None.
        """
        with self._state_lock:
            if self.build_status == STATUS_BUILDING:
                return
            if not self._layer_paths.static_gpml.is_file():
                self.build_status = STATUS_UNAVAILABLE
                self.status_detail = f"missing {self._layer_paths.static_gpml.name}"
                return
            ready_files = self.ready_plate_files()
            pending_lods = [
                lod_file
                for lod_file in self._layer_paths.band_files
                if (self._layer_paths.data_directory / lod_file).is_file() and lod_file not in ready_files
            ]
            if not pending_lods and self.static_file() and self.outlines_file():
                self.build_status, self.status_detail = STATUS_READY, ""
                return
            if self.build_status == STATUS_FAILED:
                return
            self.build_status, self.status_detail = STATUS_BUILDING, ""
        build_lods = pending_lods or self._layer_paths.band_files[:1]
        threading.Thread(target=self._run_build, args=(build_lods,), name="plate-model-prep", daemon=True).start()

    def _run_build(self, lod_files: list[str]) -> None:
        """Run the plate model's prep script for the given LODs and record the outcome.

        Usage:
            Thread target started by ensure_built().

        Args:
            lod_files: LOD file names from lod.json (never client input).

        Returns:
            None; updates ``build_status`` and ``status_detail``.
        """
        command_line = [
            "bash",
            str(self._layer_paths.prep_script),
            str(self._layer_paths.data_directory),
            str(self._layer_paths.static_gpml),
            self._layer_paths.model_tag,
            *lod_files,
        ]
        succeeded, self.status_detail = run_logged_script(
            command_line, self._layer_paths.log_file, self._layer_paths.project_root
        )
        if self._on_rebuilt:
            self._on_rebuilt()
        if succeeded:
            self.build_status, self.status_detail = STATUS_READY, ""
            return
        self.build_status = STATUS_FAILED
        failure_reason = last_log_line(self._layer_paths.log_file) or f"{self._layer_paths.prep_script.name} failed"
        self.status_detail = self.status_detail or failure_reason
