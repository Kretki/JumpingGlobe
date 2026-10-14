"""HTTP routes of the plate model: health, rotations, plate-layer status, topologies and file stats.

  GET /api/health
  GET /api/rotations
  GET /api/plates/status
  GET /api/plates/topologies
  GET /api/land/stats
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response

from server.route_support import RouteDependencies, json_response


def register_status_routes(api_router: APIRouter, dependencies: RouteDependencies) -> None:
    """Register health, rotation-model, plate-status and stats routes.

    Usage:
        Called by build_api_router.

    Args:
        api_router: Router to add routes to.
        dependencies: Injected services and settings.

    Returns:
        None.
    """
    land_responder = dependencies.land_responder
    rotation_responder = dependencies.rotation_responder
    plate_status = dependencies.plate_status
    topology_status = dependencies.topology_status

    @api_router.get("/health")
    def health_check() -> dict[str, Any]:
        """Liveness check plus the servable LOD files.

        Usage:
            ``GET /api/health``.

        Returns:
            ``{"ok": True, "data_dir": <project-relative data directory>, "lods": [...]}``.
        """
        return {"ok": True, "data_dir": dependencies.data_directory_label, "lods": land_responder.available_lods()}

    @api_router.get("/rotations")
    def rotation_model() -> Response:
        """Plate rotation model (lod.json plateModel): total poles per moving plate (file order).

        Usage:
            ``GET /api/rotations``; the client builds its RotationTree from it.

        Returns:
            JSON ``{"maxAge", "plates", "anchorPlate"}``; 404 when the file is missing.
        """
        if not rotation_responder.is_available():
            raise HTTPException(status_code=404, detail=f"Rotation file not found: {rotation_responder.file_name()}")
        return json_response(rotation_responder.rotations_json())

    @api_router.get("/plates/status")
    def plates_status() -> dict[str, Any]:
        """Readiness of the plate layers; the client polls this while they are built.

        Usage:
            ``GET /api/plates/status``; also kicks off a rebuild of stale layers.

        Returns:
            ``{"status", "detail", "plateFiles": {lod: twin}, "staticFile", "outlinesFile",
            "topologyStatus", "topologyDetail", "topologyFile"}``.
        """
        plate_status.ensure_built()
        topology_status.ensure_built()
        return {
            "status": plate_status.build_status,
            "detail": plate_status.status_detail,
            "plateFiles": plate_status.ready_plate_files(),
            "staticFile": plate_status.static_file(),
            "outlinesFile": plate_status.outlines_file(),
            "topologyStatus": topology_status.build_status,
            "topologyDetail": topology_status.status_detail,
            "topologyFile": topology_status.topology_file(),
        }

    @api_router.get("/land/stats")
    def land_stats() -> dict[str, Any]:
        """Feature counts and sizes of every servable GeoPackage.

        Usage:
            ``GET /api/land/stats``.

        Returns:
            ``{"lods": {file: stats | {"error"}}, "full_resolution": {...}, "srs"}``.
        """
        lod_stats: dict[str, Any] = {}
        for file_name in land_responder.available_lods():
            try:
                lod_stats[file_name] = land_responder.file_stats(file_name)
            except OSError as exception:
                lod_stats[file_name] = {"error": str(exception)}
        full_path = dependencies.full_resolution_path
        return {
            "lods": lod_stats,
            "full_resolution": {
                "path": full_path.name if full_path.is_file() else None,
                "size_bytes": full_path.stat().st_size if full_path.is_file() else 0,
                "note": "Too large for browser bulk load; use LOD gpkg files via /api/land",
            },
            "srs": "EPSG:4326",
        }


def register_topology_routes(api_router: APIRouter, dependencies: RouteDependencies) -> None:
    """Register the plate-topology route.

    Usage:
        Called by build_api_router.

    Args:
        api_router: Router to add routes to.
        dependencies: Injected services and settings.

    Returns:
        None.
    """
    topology_responder = dependencies.topology_responder

    @api_router.get("/plates/topologies")
    def plate_topologies() -> Response:
        """Topological plate polygons and their boundary sections (present-day coordinates).

        Usage:
            ``GET /api/plates/topologies`` once ``topologyFile`` is reported by /api/plates/status;
            the client resolves plates, ridges, subduction zones and transforms from it.

        Returns:
            JSON ``{"version", "features", "topologies"}``; 404 while the model is not built.
        """
        response_body = topology_responder.topology_json()
        if response_body is None:
            raise HTTPException(status_code=404, detail="Plate topologies are not available yet")
        return json_response(response_body)
