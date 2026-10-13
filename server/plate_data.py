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

import subprocess
import threading
from pathlib import Path
from typing import Callable

try:
    from server.lod_config import BAND_FILES, DATA_DIR, MERDITH_DIR, ROOT, STATIC_POLYGONS_FILE, plates_file
except ImportError:  # running inside server/
    from lod_config import BAND_FILES, DATA_DIR, MERDITH_DIR, ROOT, STATIC_POLYGONS_FILE, plates_file

PREP_SCRIPT = ROOT / "public" / "data" / "merdith_prep.sh"
LOG_FILE = DATA_DIR / "merdith_prep.log"
STATIC_GPML = MERDITH_DIR / "shapes_static_polygons_Merdith_et_al.gpml"
TOOLS = [ROOT / "tools" / "plate_tag.py", ROOT / "tools" / "gpml_to_geojson.py"]


def _mtime(p: Path) -> float:
    return p.stat().st_mtime if p.is_file() else -1.0


class PlateData:
    """Status: 'ready' | 'building' | 'failed' | 'unavailable' (no Merdith sources)."""

    def __init__(self, on_rebuilt: Callable[[], None] | None = None) -> None:
        self.status = "unavailable"
        self.detail = ""
        self._lock = threading.Lock()
        self._on_rebuilt = on_rebuilt

    def _base_mtime(self) -> float:
        return max(_mtime(STATIC_GPML), *(_mtime(t) for t in TOOLS))

    def _fresh(self, out: Path, source: Path | None) -> bool:
        need = self._base_mtime() if source is None else max(self._base_mtime(), _mtime(source))
        return _mtime(out) >= need

    def static_file(self) -> str | None:
        return STATIC_POLYGONS_FILE if self._fresh(DATA_DIR / STATIC_POLYGONS_FILE, None) else None

    def ready_plate_files(self) -> dict[str, str]:
        """LOD file -> its plate-tagged twin, for twins that are up to date."""
        out: dict[str, str] = {}
        for lod in BAND_FILES:
            twin = plates_file(lod)
            if (DATA_DIR / lod).is_file() and self._fresh(DATA_DIR / twin, DATA_DIR / lod):
                out[lod] = twin
        return out

    def ensure(self) -> None:
        """Start a background build for stale outputs (no-op while one is running)."""
        with self._lock:
            if self.status == "building":
                return
            if not STATIC_GPML.is_file():
                self.status, self.detail = "unavailable", f"missing {STATIC_GPML.name}"
                return
            ready = self.ready_plate_files()
            todo = [lod for lod in BAND_FILES if (DATA_DIR / lod).is_file() and lod not in ready]
            if not todo and self.static_file():
                self.status, self.detail = "ready", ""
                return
            if self.status == "failed":
                return  # don't retry a failing build on every poll; restart the server instead
            self.status, self.detail = "building", ""
        threading.Thread(target=self._build, args=(todo or BAND_FILES[:1],), name="merdith-prep", daemon=True).start()

    def _build(self, lods: list[str]) -> None:
        cmd = ["bash", str(PREP_SCRIPT), str(DATA_DIR), str(MERDITH_DIR), *lods]
        try:
            with open(LOG_FILE, "w", encoding="utf-8") as log:
                proc = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, cwd=ROOT, timeout=6 * 3600)
            ok = proc.returncode == 0
        except (OSError, subprocess.SubprocessError) as exc:
            ok = False
            self.detail = str(exc)
        if self._on_rebuilt:
            self._on_rebuilt()
        if ok:
            self.status, self.detail = "ready", ""
            return
        tail = ""
        try:
            lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").strip().splitlines()
            tail = lines[-1] if lines else ""
        except OSError:
            pass
        self.status = "failed"
        self.detail = self.detail or tail or "merdith_prep.sh failed"
