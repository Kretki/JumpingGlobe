"""
Land polygon GeoPackage API: application factory and wiring.

Serves EPSG:4326 features from LOD GPKGs via bbox queries so the browser
never loads the full multi-hundred-MB (or 1.5 GiB) datasets. Routes live in
server/api_routes.py.

Run:
  uv run uvicorn server.application:app --reload --host 127.0.0.1 --port 8765

Environment:
  JUMPING_GLOBE_CORS_ORIGINS  comma-separated browser origins allowed to call the
                              API directly (default: the Vite dev server). The Vite
                              proxy is same-origin and needs no CORS at all.
  JUMPING_GLOBE_HOST          bind address for ``python -m server.application``
                              (default 127.0.0.1).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from server.api_routes import build_api_router
from server.gpkg_store import GeoPackageStore
from server.land_queries import LandQueryEngine
from server.lod_config import DATA_DIR, FULL_RESOLUTION_FILE, PROJECT_ROOT, WORLD_FILE
from server.plate_layer_paths import default_plate_layer_paths
from server.plate_layers import PlateLayerBuilder
from server.plate_model_config import PLATE_MODEL
from server.response_services import LandService
from server.rotation_service import RotationService
from server.route_support import RouteDependencies
from server.topology_layer import TopologyLayerBuilder, default_topology_paths
from server.topology_service import TopologyFileService

DEFAULT_CORS_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")
DEFAULT_BIND_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def allowed_origins() -> list[str]:
    """Read the CORS origin allow-list.

    Usage:
        Called once by create_application.

    Returns:
        Origins from JUMPING_GLOBE_CORS_ORIGINS, or the Vite dev-server origins.
        A wildcard is never used.
    """
    configured = os.environ.get("JUMPING_GLOBE_CORS_ORIGINS", "")
    origin_list = [origin_text.strip() for origin_text in configured.split(",") if origin_text.strip()]
    return [origin_text for origin_text in origin_list if origin_text != "*"] or list(DEFAULT_CORS_ORIGINS)


def project_relative(target_path: Path) -> str:
    """Express a path relative to the project root when possible.

    Usage:
        Report directories without leaking absolute server paths.

    Args:
        target_path: Path to describe.

    Returns:
        The project-relative path, or the bare name for paths outside the project.
    """
    try:
        return str(Path(target_path).resolve().relative_to(PROJECT_ROOT))
    except ValueError:
        return Path(target_path).name


def create_application() -> FastAPI:
    """Build the FastAPI application with its services, middleware and routes.

    Usage:
        ``app = create_application()``; uvicorn serves ``server.application:app``.

    Returns:
        The configured FastAPI application.
    """
    gpkg_store = GeoPackageStore(DATA_DIR, FULL_RESOLUTION_FILE)
    rotation_service = RotationService(PLATE_MODEL.rotation_files, PLATE_MODEL.max_age_ma)
    land_service = LandService(gpkg_store, LandQueryEngine(gpkg_store), rotation_service)
    plate_builder = PlateLayerBuilder(default_plate_layer_paths(), on_rebuilt=land_service.clear_caches)
    topology_builder = TopologyLayerBuilder(default_topology_paths())

    @asynccontextmanager
    async def application_lifespan(_application: FastAPI) -> AsyncIterator[None]:
        """Start the background plate-layer and topology builds on startup (non-blocking).

        Usage:
            Passed to FastAPI as ``lifespan``.

        Args:
            _application: The application (unused).

        Returns:
            Async iterator yielding once while the app runs.
        """
        plate_builder.ensure_built()
        topology_builder.ensure_built()
        yield

    web_application = FastAPI(title="Land GPKG API", version="1.0.0", lifespan=application_lifespan)
    web_application.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins(),
        allow_methods=["GET"],
        allow_headers=[],
    )
    web_application.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)
    web_application.include_router(
        build_api_router(
            RouteDependencies(
                land_responder=land_service,
                rotation_responder=rotation_service,
                plate_status=plate_builder,
                topology_status=topology_builder,
                topology_responder=TopologyFileService(topology_builder.topology_path),
                world_file=WORLD_FILE,
                data_directory_label=project_relative(DATA_DIR),
                full_resolution_path=DATA_DIR / FULL_RESOLUTION_FILE,
            )
        )
    )
    return web_application


# ASGI entry point; the name ``app`` is the uvicorn/FastAPI convention.
app = create_application()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server.application:app",
        host=os.environ.get("JUMPING_GLOBE_HOST", DEFAULT_BIND_HOST),
        port=DEFAULT_PORT,
        reload=True,
        app_dir=str(PROJECT_ROOT),
    )
