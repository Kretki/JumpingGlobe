"""Shared pieces of the HTTP layer: injected dependencies, limits and response helpers."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

from fastapi import HTTPException, Response

from server.contracts.service_contracts import (
    LandResponder,
    PaleoMagResponder,
    PlateLayerStatus,
    RotationResponder,
    TopologyResponder,
    TopologyStatus,
)

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
    topology_status: TopologyStatus
    topology_responder: TopologyResponder
    paleomag_responder: PaleoMagResponder
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
