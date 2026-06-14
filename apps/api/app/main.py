"""FastAPI app factory."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

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
from app.routes import history as history_routes
from app.routes import imagery as imagery_routes
from app.routes import intel as intel_routes
from app.routes import jamming as jamming_routes
from app.routes import maritime as maritime_routes
from app.routes import news as news_routes_mod
from app.routes import sar as sar_routes
from app.routes import search as search_routes
from app.routes import seismic as seismic_routes
from app.routes import space as space_routes
from app.routes import tiles as tiles_routes
from app.routes import timeline as timeline_routes
from app.routes import weather as weather_routes


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # OSINT_DISABLE_BACKGROUND short-circuits every boot-time poller. Unit
    # tests set it (tests/conftest.py) so TestClient lifespans never fire
    # real upstream HTTP from the correlate loops.
    background = not os.environ.get("OSINT_DISABLE_BACKGROUND")
    settings = get_settings()
    if background:
        correlate_runner.start()
        # AISStream (keyed) is engaged ON DEMAND — only when a browser opens
        # /ws/ais — and dropped when the last viewer leaves, to conserve its
        # API message cap. It is NOT started at boot. The keyless Kystverket
        # firehose below runs unconditionally so the MCP/intel vessel tools and
        # the always-on store still have vessels without a frontend.
        from app import ais_firehose  # noqa: PLC0415

        ais_firehose.start()
        # Extra keyless regional AIS (Norway Kystdatahuset + Finland Digitraffic
        # MQTT) — densify Northern-Europe vessels without any key.
        from app import ais_keyless  # noqa: PLC0415

        ais_keyless.start()
        # Position history store for 3D replay/scrub.
        from app import history  # noqa: PLC0415

        history.start()
        # News debias / fact-check refresher.
        if settings.news_enabled:
            from app.routes import news as news_routes  # noqa: PLC0415

            news_routes.start_refresher()
    try:
        yield
    finally:
        await correlate_runner.stop_all()
        # Cancel the intel AOI priority warmer and the ADS-B snapshot
        # refresher so no background task outlives the app's event loop
        # (clean shutdown + test isolation).
        from app.intel import aoi  # noqa: PLC0415

        await aoi.stop_warmer()
        await adsb_routes.stop_snapshot()
        await ais_routes._stop_upstream()
        if background:
            from app import (
                ais_firehose,  # noqa: PLC0415
                ais_keyless,  # noqa: PLC0415
                history,  # noqa: PLC0415
            )
            from app.routes import news as news_routes  # noqa: PLC0415

            await ais_firehose.stop()
            await ais_keyless.stop()
            await history.stop()
            await news_routes.stop_refresher()


def create_app() -> FastAPI:
    settings = get_settings()
    # Hot-path serialization: every route annotates its return type, so
    # FastAPI serializes straight to JSON bytes via pydantic-core — already
    # faster than swapping in ORJSONResponse (which FastAPI now deprecates).
    app = FastAPI(title="OSINT Console API", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    # No-op when API_KEY env is unset; enforces X-API-Key otherwise.
    app.add_middleware(ApiKeyMiddleware)
    # Added last → outermost. The global ADS-B snapshot is a multi-MB JSON
    # body once per second per client; gzip cuts it ~10x on the wire.
    # compresslevel 5 trades a little ratio for much less CPU than default 9.
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

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
    app.include_router(imagery_routes.router)
    app.include_router(sar_routes.router)
    app.include_router(search_routes.router)
    app.include_router(correlations_routes.router)
    app.include_router(timeline_routes.router)
    app.include_router(maritime_routes.router)
    app.include_router(jamming_routes.router)
    app.include_router(cams_routes.router)
    app.include_router(intel_routes.router)
    app.include_router(news_routes_mod.router)
    app.include_router(history_routes.router)

    return app


app = create_app()
