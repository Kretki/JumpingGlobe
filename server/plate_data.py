"""
Build the plate-reconstruction layers on demand (background thread).

The timeline needs two derived GeoPackages in dataDir (see public/data/merdith_prep.sh):
the plate-tagged world LOD and the continental-crust layer. They are rebuilt when
missing or older than their sources, so a fresh checkout or a LOD rebuild works
without a manual step. Existing LOD files are never modified.
"""

from __future__ import annotations

import subprocess
import threading
from pathlib import Path
from typing import Callable

try:
    from server.lod_config import (
        CONTINENTS_FILE,
        DATA_DIR,
        MERDITH_DIR,
        PLATE_WORLD_FILE,
        ROOT,
        WORLD_FILE,
    )
except ImportError:  # running inside server/
    from lod_config import CONTINENTS_FILE, DATA_DIR, MERDITH_DIR, PLATE_WORLD_FILE, ROOT, WORLD_FILE

PREP_SCRIPT = ROOT / "public" / "data" / "merdith_prep.sh"
LOG_FILE = DATA_DIR / "merdith_prep.log"
_SOURCES = ("shapes_static_polygons_Merdith_et_al.gpml", "shapes_continents.gpml")


class PlateData:
    """Status: 'ready' | 'building' | 'failed' | 'unavailable' (no Merdith sources)."""

    def __init__(self, on_rebuilt: Callable[[], None] | None = None) -> None:
        self.status = "unavailable"
        self.detail = ""
        self._lock = threading.Lock()
        self._on_rebuilt = on_rebuilt

    @property
    def outputs(self) -> list[Path]:
        return [DATA_DIR / PLATE_WORLD_FILE, DATA_DIR / CONTINENTS_FILE]

    def _sources(self) -> list[Path]:
        return [DATA_DIR / WORLD_FILE] + [MERDITH_DIR / name for name in _SOURCES]

    def _stale(self) -> bool:
        srcs = self._sources()
        newest = max(p.stat().st_mtime for p in srcs)
        return any(not p.is_file() or p.stat().st_mtime < newest for p in self.outputs)

    def ensure(self) -> None:
        """Start a background build if needed (no-op while one is running)."""
        with self._lock:
            if self.status == "building":
                return
            if not all(p.is_file() for p in self._sources()):
                missing = [p.name for p in self._sources() if not p.is_file()]
                self.status, self.detail = "unavailable", "missing " + ", ".join(missing)
                return
            if not self._stale():
                self.status, self.detail = "ready", ""
                return
            self.status, self.detail = "building", ""
        threading.Thread(target=self._build, name="merdith-prep", daemon=True).start()

    def _build(self) -> None:
        cmd = ["bash", str(PREP_SCRIPT), str(DATA_DIR), str(MERDITH_DIR), WORLD_FILE]
        try:
            with open(LOG_FILE, "w", encoding="utf-8") as log:
                proc = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, cwd=ROOT, timeout=3600)
            ok = proc.returncode == 0 and all(p.is_file() for p in self.outputs)
        except (OSError, subprocess.SubprocessError) as exc:
            ok = False
            self.detail = str(exc)
        if ok:
            self.status, self.detail = "ready", ""
            if self._on_rebuilt:
                self._on_rebuilt()
        else:
            tail = ""
            try:
                tail = LOG_FILE.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-1]
            except (OSError, IndexError):
                pass
            self.status = "failed"
            self.detail = self.detail or tail or "merdith_prep.sh failed"
