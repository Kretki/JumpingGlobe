"""Print values of lod.json for shell scripts (public/fetch_sources.sh).

Usage:
    python -m tools.lod_settings <query>

Queries:
    data-dir        lod.json dataDir (project-relative)
    lod-count       number of LOD bands
    model-tag       plateModel.tag
    model-files     plateModel rotation files, static polygons and topology files (one per line)
    topology-files  plateModel.topologyFiles (one per line)

Exit status 0 on success, 2 on an unknown query.
"""

from __future__ import annotations

import sys
from collections.abc import Callable, Sequence
from typing import Any

from server.configuration.lod_config import LOD_CONFIG

USAGE_TEXT = "usage: python -m tools.lod_settings data-dir|lod-count|model-tag|model-files|topology-files"


def plate_model_files(lod_settings: dict[str, Any]) -> list[str]:
    """Every source file of the plate model.

    Usage:
        ``model-files`` query.

    Args:
        lod_settings: Parsed lod.json.

    Returns:
        Rotation files, the static-polygon file and the topology files.
    """
    model_section = lod_settings["plateModel"]
    return [*model_section["rotationFiles"], model_section["staticPolygons"], *model_section.get("topologyFiles", [])]


QUERY_HANDLERS: dict[str, Callable[[dict[str, Any]], list[str]]] = {
    "data-dir": lambda lod_settings: [str(lod_settings["dataDir"])],
    "lod-count": lambda lod_settings: [str(len(lod_settings["bands"]))],
    "model-tag": lambda lod_settings: [str(lod_settings["plateModel"]["tag"])],
    "model-files": plate_model_files,
    "topology-files": lambda lod_settings: [
        str(file_name) for file_name in lod_settings["plateModel"].get("topologyFiles", [])
    ],
}


def main(argument_list: Sequence[str]) -> int:
    """Command-line entry point.

    Usage:
        ``python -m tools.lod_settings data-dir``.

    Args:
        argument_list: Arguments without the program name (one query).

    Returns:
        Exit status (0 ok, 2 usage).
    """
    query_handler = QUERY_HANDLERS.get(argument_list[0]) if len(argument_list) == 1 else None
    if query_handler is None:
        print(USAGE_TEXT, file=sys.stderr)
        return 2
    print("\n".join(query_handler(LOD_CONFIG)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
