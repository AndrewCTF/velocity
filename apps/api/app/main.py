"""FastAPI app factory."""

from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import ApiKeyMiddleware
from app.config import get_settings
from app.correlate import runner as correlate_runner
from app.routes import adsb as adsb_routes
from app.routes import ais as ais_routes
from app.routes import alerts as alerts_routes
from app.routes import aviation as aviation_routes
from app.routes import cables as cables_routes
from app.routes import cams as cams_routes
from app.routes import config as config_routes
from app.routes import correlations as correlations_routes
from app.routes import cyber as cyber_routes
from app.routes import entity as entity_routes
from app.routes import eq as eq_routes
from app.routes import events as events_routes
from app.routes import firms as firms_routes
from app.routes import health as health_routes
from app.routes import jamming as jamming_routes
from app.routes import maritime as maritime_routes
from app.routes import search as search_routes
from app.routes import seismic as seismic_routes
from app.routes import space as space_routes
from app.routes import tiles as tiles_routes
from app.routes import timeline as timeline_routes
from app.routes import weather as weather_routes


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    correlate_runner.start()
    try:
        yield
    finally:
        await correlate_runner.stop_all()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="OSINT Console API", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    # No-op when API_KEY env is unset; enforces X-API-Key otherwise.
    app.add_middleware(ApiKeyMiddleware)

    app.include_router(config_routes.router)
    app.include_router(health_routes.router)
    app.include_router(eq_routes.router)
    app.include_router(aviation_routes.router)
    app.include_router(adsb_routes.router)
    app.include_router(firms_routes.router)
    app.include_router(ais_routes.router)
    app.include_router(seismic_routes.router)
    app.include_router(events_routes.router)
    app.include_router(cables_routes.router)
    app.include_router(space_routes.router)
    app.include_router(weather_routes.router)
    app.include_router(cyber_routes.router)
    app.include_router(entity_routes.router)
    app.include_router(alerts_routes.router)
    app.include_router(tiles_routes.router)
    app.include_router(search_routes.router)
    app.include_router(correlations_routes.router)
    app.include_router(timeline_routes.router)
    app.include_router(maritime_routes.router)
    app.include_router(jamming_routes.router)
    app.include_router(cams_routes.router)

    return app


app = create_app()
