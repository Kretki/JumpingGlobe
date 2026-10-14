"""HTTP routes of the land GeoPackage API (thin layer: validate, delegate, map errors to status codes).

Plate-model routes (health, rotations, plate status, topologies, stats) live in server/plate_routes.py,
the paleomagnetic route in server/paleomag_routes.py.

  GET /api/land?file=<worldFile from lod.json>&bbox=west,south,east,north&limit=25000&min_area=0
  GET /api/land/past?file=<plate twin>&age=<Ma>&lon=&lat=&radius=&limit=&min_area=
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response

from server.paleomag_routes import register_paleomag_routes
from server.plate_routes import register_status_routes, register_topology_routes
from server.request_parsing import parse_bbox
from server.route_support import (
    DEFAULT_QUERY_LIMIT,
    LAND_CACHE_HEADERS,
    MAX_QUERY_LIMIT,
    RouteDependencies,
    json_response,
    raise_http_error,
)


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
    register_status_routes(api_router, dependencies)
    register_topology_routes(api_router, dependencies)
    register_paleomag_routes(api_router, dependencies)
    _register_land_routes(api_router, dependencies)
    return api_router


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

