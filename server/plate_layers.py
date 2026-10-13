"""
Build the plate-reconstruction layers on demand (background thread).

The timeline needs derived GeoPackages in dataDir (see public/data/merdith_prep.sh):
plate-tagged twins of every land LOD and a simplified static-polygon file for
point picking. They are rebuilt when missing or older than their sources, so a fresh
checkout or a LOD rebuild works without a manual step. Existing LOD files are never
modified. The world LOD is tagged first (seconds); detail LODs follow (minutes) and
become usable one by one.
"""

from __future__ import annotations

# subprocess only runs one fixed, repository-owned script with an argument list (no shell).
import subprocess  # nosec B404
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from server.lod_config import BAND_FILES, DATA_DIR, MERDITH_DIR, PROJECT_ROOT, STATIC_POLYGONS_FILE, plate_twin_name

BUILD_TIMEOUT_SECONDS = 6 * 3600
STATUS_READY = "ready"
STATUS_BUILDING = "building"
STATUS_FAILED = "failed"
STATUS_UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class PlateLayerPaths:
    """Filesystem inputs and outputs of the plate-layer build."""

    project_root: Path
    data_directory: Path
    merdith_directory: Path
    band_files: list[str]
    static_file: str
    prep_script: Path
    log_file: Path
    static_gpml: Path
    tool_sources: list[Path] = field(default_factory=list)


def default_plate_layer_paths() -> PlateLayerPaths:
    """Build the paths from lod.json and the repository layout.

    Usage:
        ``PlateLayerBuilder(default_plate_layer_paths())``.

    Returns:
        PlateLayerPaths for this checkout. Tool sources include every Python file
        of the tagging tools, so editing them triggers a rebuild.
    """
    tools_directory = PROJECT_ROOT / "tools"
    tool_sources = [tools_directory / "plate_tag.py", tools_directory / "gpml_to_geojson.py"]
    tool_sources += sorted((tools_directory / "plate_tagging").glob("*.py"))
    return PlateLayerPaths(
        project_root=PROJECT_ROOT,
        data_directory=DATA_DIR,
        merdith_directory=MERDITH_DIR,
        band_files=list(BAND_FILES),
        static_file=STATIC_POLYGONS_FILE,
        prep_script=PROJECT_ROOT / "public" / "data" / "merdith_prep.sh",
        log_file=DATA_DIR / "merdith_prep.log",
        static_gpml=MERDITH_DIR / "shapes_static_polygons_Merdith_et_al.gpml",
        tool_sources=tool_sources,
    )


def modified_time(file_path: Path) -> float:
    """Return a file's modification time, or -1 when it does not exist.

    Usage:
        Staleness checks (an output is fresh when not older than its sources).

    Args:
        file_path: File to inspect.

    Returns:
        ``st_mtime`` in seconds, or -1.0 for missing files.
    """
    return file_path.stat().st_mtime if file_path.is_file() else -1.0


def last_log_line(log_path: Path) -> str:
    """Return the last non-empty line of a log file.

    Usage:
        Short failure reason for the status endpoint.

    Args:
        log_path: Log file to read.

    Returns:
        The last line, or "" when the file is missing, unreadable or empty.
    """
    try:
        log_lines = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
    except OSError:
        return ""
    return log_lines[-1] if log_lines else ""


class PlateLayerBuilder:
    """Tracks the plate layers and rebuilds stale ones in the background.

    ``build_status`` is one of 'ready', 'building', 'failed' or 'unavailable' (no Merdith sources).
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

    def static_file(self) -> str | None:
        """Return the static-polygon file name when it is up to date.

        Usage:
            Reported as ``staticFile`` by /api/plates/status.

        Returns:
            The file name, or None while it is missing or stale.
        """
        static_path = self._layer_paths.data_directory / self._layer_paths.static_file
        return self._layer_paths.static_file if self._is_fresh(static_path, None) else None

    def ready_plate_files(self) -> dict[str, str]:
        """Map each LOD file to its plate-tagged twin, for twins that are up to date.

        Usage:
            Reported as ``plateFiles`` by /api/plates/status.

        Returns:
            Dictionary LOD file name -> twin file name.
        """
        ready_files: dict[str, str] = {}
        for lod_file in self._layer_paths.band_files:
            twin_file = plate_twin_name(lod_file)
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
            if not pending_lods and self.static_file():
                self.build_status, self.status_detail = STATUS_READY, ""
                return
            if self.build_status == STATUS_FAILED:
                return
            self.build_status, self.status_detail = STATUS_BUILDING, ""
        build_lods = pending_lods or self._layer_paths.band_files[:1]
        threading.Thread(target=self._run_build, args=(build_lods,), name="merdith-prep", daemon=True).start()

    def _run_build(self, lod_files: list[str]) -> None:
        """Run merdith_prep.sh for the given LODs and record the outcome.

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
            str(self._layer_paths.merdith_directory),
            *lod_files,
        ]
        try:
            with open(self._layer_paths.log_file, "w", encoding="utf-8") as log_stream:
                # Argument list, no shell; every argument comes from lod.json or the repo layout.
                completed = subprocess.run(  # noqa: S603  # nosec B603
                    command_line,
                    stdout=log_stream,
                    stderr=subprocess.STDOUT,
                    cwd=self._layer_paths.project_root,
                    timeout=BUILD_TIMEOUT_SECONDS,
                    check=False,
                )
            succeeded = completed.returncode == 0
        except (OSError, subprocess.SubprocessError) as exception:
            succeeded = False
            self.status_detail = str(exception)
        if self._on_rebuilt:
            self._on_rebuilt()
        if succeeded:
            self.build_status, self.status_detail = STATUS_READY, ""
            return
        self.build_status = STATUS_FAILED
        self.status_detail = self.status_detail or last_log_line(self._layer_paths.log_file) or "merdith_prep.sh failed"
