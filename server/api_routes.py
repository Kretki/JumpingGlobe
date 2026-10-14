"""HTTP routes of the land GeoPackage API (thin layer: validate, delegate, map errors to status codes).

  GET /api/health
  GET /api/rotations
  GET /api/plates/status
  GET /api/land/stats
  GET /api/land?file=<worldFile from lod.json>&bbox=west,south,east,north&limit=25000&min_area=0
  GET /api/land/past?file=<plate twin>&age=<Ma>&lon=&lat=&radius=&limit=&min_area=
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

from fastapi import APIRouter, HTTPException, Query, Response

from server.request_parsing import parse_bbox
from server.service_contracts import LandResponder, PlateLayerStatus, RotationResponder

JSON_MEDIA_TYPE = "application/json"
LAND_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600"}
MAX_QUERY_LIMIT = 100_000
DEFAULT_QUERY_LIMIT = 25_000


@dataclass(frozen=True)
class RouteDependencies:
    """Everything the routes need, injected by the application factory."""

    land_responder: LandResponder
    rotation_responder: RotationResponder
    plate_status: PlateLayerStatus
    world_file: str
    data_directory_label: str
    full_resolution_path: Path


def raise_http_error(exception: Exception) -> NoReturn:
    """Translate a service exception into an HTTP error.

    Usage:
        ``except (FileNotFoundError, ValueError) as exception: raise_http_error(exception)``.

    Args:
        exception: FileNotFoundError (-> 404) or ValueError (-> 400).

    Returns:
        Never returns.

    Raises:
        HTTPException: Always.
    """
    status_code = 404 if isinstance(exception, FileNotFoundError) else 400
    raise HTTPException(status_code=status_code, detail=str(exception)) from exception


def json_response(response_body: bytes, extra_headers: dict[str, str] | None = None) -> Response:
    """Wrap pre-encoded JSON bytes in a response.

    Usage:
        Return cached bodies without re-serialising them.

    Args:
        response_body: UTF-8 JSON bytes.
        extra_headers: Optional response headers.

    Returns:
        FastAPI Response with media type application/json.
    """
    return Response(content=response_body, media_type=JSON_MEDIA_TYPE, headers=extra_headers)


def build_api_router(dependencies: RouteDependencies) -> APIRouter:
    """Create the API router bound to its services.

    Usage:
        ``application.include_router(build_api_router(RouteDependencies(...)))``.

    Args:
        dependencies: Injected services and settings.

    Returns:
        An APIRouter with every /api route.
    """
    api_router = APIRouter(prefix="/api")
    _register_status_routes(api_router, dependencies)
    _register_land_routes(api_router, dependencies)
    return api_router


def _register_status_routes(api_router: APIRouter, dependencies: RouteDependencies) -> None:
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
            ``{"status", "detail", "plateFiles": {lod: twin}, "staticFile", "outlinesFile"}``.
        """
        plate_status.ensure_built()
        return {
            "status": plate_status.build_status,
            "detail": plate_status.status_detail,
            "plateFiles": plate_status.ready_plate_files(),
            "staticFile": plate_status.static_file(),
            "outlinesFile": plate_status.outlines_file(),
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


def _register_land_routes(api_router: APIRouter, dependencies: RouteDependencies) -> None:
    """Register the land feature routes.

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

    @api_router.get("/land/past")
    def land_past(
        file_name: str = Query(
            ..., alias="file", description="Plate-tagged GPKG (see /api/plates/status plateFiles)"
        ),
        age_in_ma: float = Query(..., alias="age", ge=0.0, description="Reconstruction age in Ma"),
        longitude: float = Query(..., alias="lon", ge=-180.0, le=180.0, description="View centre at `age` (degrees)"),
        latitude: float = Query(..., alias="lat", ge=-90.0, le=90.0),
        radius_deg: float = Query(..., alias="radius", gt=0.0, le=90.0, description="View cap radius in degrees"),
        feature_limit: int = Query(DEFAULT_QUERY_LIMIT, alias="limit", ge=1, le=MAX_QUERY_LIMIT),
        min_area: float = Query(0.0, ge=0.0),
    ) -> Response:
        """Detail land around a view centre as it was at an age.

        Usage:
            ``GET /api/land/past?...``; pieces stay in present-day coordinates.

        Args:
            file_name: Plate-tagged GeoPackage (query ``file``).
            age_in_ma: Reconstruction age in Ma (query ``age``).
            longitude: View centre longitude at that age (query ``lon``).
            latitude: View centre latitude at that age (query ``lat``).
            radius_deg: View cap radius in degrees (query ``radius``).
            feature_limit: Maximum number of features (query ``limit``).
            min_area: Minimum envelope area in deg².

        Returns:
            GeoJSON FeatureCollection; 400/404 on invalid or missing files.
        """
        if not rotation_responder.is_available():
            raise HTTPException(status_code=404, detail="Rotation file not found")
        try:
            response_body = land_responder.past_json(
                file_name, age_in_ma, (longitude, latitude), radius_deg, feature_limit, min_area
            )
        except (FileNotFoundError, ValueError) as exception:
            raise_http_error(exception)
        return json_response(response_body)

    @api_router.get("/land")
    def land_features(
        file_name: str = Query(
            dependencies.world_file, alias="file", description="GPKG filename under lod.json dataDir"
        ),
        bbox_text: str = Query(
            ...,
            alias="bbox",
            description="west,south,east,north in EPSG:4326 degrees (west>east = antimeridian wrap)",
            examples=["-10,35,40,60"],
        ),
        feature_limit: int = Query(DEFAULT_QUERY_LIMIT, alias="limit", ge=1, le=MAX_QUERY_LIMIT),
        min_area: float = Query(
            0.0,
            ge=0.0,
            description="Minimum envelope area in deg² (drop tiny islands when zoomed out)",
        ),
    ) -> Response:
        """Land polygons intersecting a lon/lat box.

        Usage:
            ``GET /api/land?file=land_lod3.gpkg&bbox=-10,35,40,60``.

        Args:
            file_name: GeoPackage file name (query ``file``).
            bbox_text: ``west,south,east,north`` (query ``bbox``).
            feature_limit: Maximum number of features (query ``limit``).
            min_area: Minimum envelope area in deg².

        Returns:
            GeoJSON FeatureCollection with a one-hour Cache-Control header;
            400/404 on invalid input or missing files.
        """
        try:
            bounding_box = parse_bbox(bbox_text)
        except ValueError as exception:
            raise_http_error(exception)
        try:
            response_body = land_responder.land_json(file_name, bounding_box, feature_limit, min_area)
        except (FileNotFoundError, ValueError) as exception:
            raise_http_error(exception)
        return json_response(response_body, LAND_CACHE_HEADERS)

