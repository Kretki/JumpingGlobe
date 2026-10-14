"""HTTP route of the paleomagnetic data (thin layer: delegate, map errors to status codes).

  GET /api/paleomag
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from server.http_api.route_support import RouteDependencies, json_response


def register_paleomag_routes(api_router: APIRouter, dependencies: RouteDependencies) -> None:
    """Register the paleomagnetic-data route.

    Usage:
        Called by build_api_router.

    Args:
        api_router: Router to add routes to.
        dependencies: Injected services and settings.

    Returns:
        None.
    """
    paleomag_responder = dependencies.paleomag_responder

    @api_router.get("/paleomag")
    def paleomag_data() -> Response:
        """PINT sites (VGPs, moments, plates), TPW paths and TPW rates (lod.json paleoMagnetics).

        Usage:
            ``GET /api/paleomag`` once at start-up; the client decides per age what is shown.

        Returns:
            JSON ``{"version", "sites", "platesReady", "tpwPaths", "tpwRates", "tpwNetAngles"}``;
            404 when the tables are not configured or missing.
        """
        if not paleomag_responder.is_available():
            raise HTTPException(status_code=404, detail="Paleomagnetic data is not configured or missing")
        return json_response(paleomag_responder.paleomag_json())
