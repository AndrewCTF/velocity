"""FastAPI app factory."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

from app.auth import ApiKeyMiddleware
from app.config import get_settings
from app.correlate import runner as correlate_runner
from app.mcp_server import build_mcp_mount
from app.routes import actions as actions_routes
from app.routes import adsb as adsb_routes
from app.routes import ais as ais_routes
from app.routes import alert_rules as alert_rules_routes
from app.routes import alerts as alerts_routes
from app.routes import audit as audit_routes
from app.routes import aviation as aviation_routes
from app.routes import cables as cables_routes
from app.routes import cams as cams_routes
from app.routes import collab as collab_routes
from app.routes import config as config_routes
from app.routes import correlations as correlations_routes
from app.routes import cyber as cyber_routes
from app.routes import entity as entity_routes
from app.routes import eq as eq_routes
from app.routes import events as events_routes
from app.routes import extract as extract_routes
from app.routes import export as export_routes
from app.routes import firms as firms_routes
from app.routes import geocode as geocode_routes
from app.routes import health as health_routes
from app.routes import history as history_routes
from app.routes import imagery as imagery_routes
from app.routes import intel as intel_routes
from app.routes import jamming as jamming_routes
from app.routes import keys as keys_routes
from app.routes import maps as maps_routes
from app.routes import maritime as maritime_routes
from app.routes import news as news_routes_mod
from app.routes import ontology as ontology_routes
from app.routes import recon as recon_routes
from app.routes import sar as sar_routes
from app.routes import search as search_routes
from app.routes import seismic as seismic_routes
from app.routes import simulation as simulation_routes
from app.routes import situations as situations_routes
from app.routes import space as space_routes
from app.routes import status as status_routes
from app.routes import targets as targets_routes
from app.routes import tiles as tiles_routes
from app.routes import timeline as timeline_routes
from app.routes import weather as weather_routes


class SelectiveGZipMiddleware:
    """GZip every response EXCEPT the MCP endpoint.

    Starlette's GZipMiddleware buffers the response *start* message until the
    first body chunk arrives — but the MCP streamable-HTTP standby GET stream
    (SSE) sends no immediate body, so its headers would never reach the client
    and the stream hangs (POST tool calls are unaffected, which is why it hides).
    /mcp bypasses gzip entirely; its bodies are small JSON or SSE, not worth
    compressing.
    """

    def __init__(self, app: ASGIApp, **kwargs: Any) -> None:
        self._app = app
        self._gzip = GZipMiddleware(app, **kwargs)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope.get("path", "").startswith("/mcp"):
            await self._app(scope, receive, send)
        else:
            await self._gzip(scope, receive, send)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # OSINT_DISABLE_BACKGROUND short-circuits every boot-time poller. Unit
    # tests set it (tests/conftest.py) so TestClient lifespans never fire
    # real upstream HTTP from the correlate loops.
    background = not os.environ.get("OSINT_DISABLE_BACKGROUND")
    settings = get_settings()
    # The mounted /mcp endpoint's streamable-HTTP session manager runs a task
    # group that must stay live for the whole app lifetime. Starlette does NOT
    # invoke a mounted sub-app's lifespan, so drive it here (one-shot per app).
    mcp_cm = app.state.mcp_manager.run()
    await mcp_cm.__aenter__()
    try:
        if background:
            correlate_runner.start()
            # ADS-B sticky snapshot: start the background refresher at BOOT so the
            # snapshot (and the pre-gzipped world-view blob the hot route + /ws/adsb
            # push serve) is HOT before the first browser poll. Otherwise the first
            # /api/adsb/global call runs a 1-10s fan-out synchronously under the
            # bootstrap lock — the "takes seconds to start loading" stall. Torn down
            # by stop_snapshot() in the finally block.
            await adsb_routes.start_snapshot()
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
            # 24/7 background AIS poll: keep the keyless REST sources flowing into
            # the unified vessel store (/api/maritime/snapshot) without a viewer.
            # maritime_routes is module-imported — do NOT re-import locally.
            maritime_routes.start_background_poll()
            # AISStream global firehose (opt-in, keyed): when AISSTREAM_FIREHOSE
            # is set, run the keyed upstream always-on from boot so global
            # vessels stream without needing a browser on /ws/ais. Off by default
            # (AISStream's free tier is capped) — then it stays on-demand.
            if settings.aisstream_key and settings.aisstream_firehose:
                # ais_routes is imported at module scope; do NOT re-import here —
                # a local import would shadow it and UnboundLocalError the
                # shutdown call below on the no-background (test) path.
                ais_routes._ensure_upstream(settings.aisstream_key)
            # MarineTraffic (PAID global AIS) — dormant unless MARINETRAFFIC_KEY is
            # set; start() no-ops without a key, so this is free when unconfigured.
            from app import marinetraffic  # noqa: PLC0415

            marinetraffic.start()
            # Position history store for 3D replay/scrub.
            from app import history  # noqa: PLC0415

            history.start()
            # Standing-watchlist / geofence evaluator: sweeps each active session's
            # alert_rules against the warm snapshot + brief and fires persistent
            # Alert objects. Idles cheaply with no registered sessions, so starting
            # it at boot is free (same spirit as adsb start_snapshot above). Torn
            # down by watch.stop() in the finally block.
            from app.intel import watch as watch_eval  # noqa: PLC0415

            await watch_eval.start()
            # Warm the CCTV catalog so the first /api/cams hits a populated
            # TtlCache instead of a cold serial upstream fan-out (~18s). Same
            # spirit as the adsb start_snapshot() pre-warm above. Fire-and-
            # forget: a failed warm just leaves the cache cold for the next
            # request to fill — it never blocks boot.
            import asyncio  # noqa: PLC0415

            asyncio.create_task(cams_routes._get_catalog())
            # Pre-warm the low-zoom basemap tiles so the first browser load gets
            # a legible world map at once instead of a cold ~70-tile CDN burst
            # (the "map takes a while to become clear" report). Same fire-and-
            # forget spirit as the cams + adsb warms above.
            from app.routes import tiles as tiles_routes  # noqa: PLC0415

            asyncio.create_task(tiles_routes.warm_basemap())
            # News debias / fact-check refresher.
            if settings.news_enabled:
                from app.routes import news as news_routes  # noqa: PLC0415

                news_routes.start_refresher()

            # Pre-warm so AIRPLANES + MARITIME are HOT at boot — block (capped)
            # until both have data so the FIRST request is instant, not a cold
            # warm-up. Runs the two warms concurrently; each is wrapped in a hard
            # timeout so a slow/down upstream degrades to the background-fill
            # behaviour above instead of hanging startup. The refresher loops
            # started above keep them hot continuously thereafter.
            async def _warm_aircraft() -> None:
                try:
                    await asyncio.wait_for(adsb_routes.await_hot(22.0), timeout=24.0)
                except Exception:  # noqa: BLE001 — warm is best-effort
                    pass

            async def _warm_maritime() -> None:
                try:
                    await asyncio.wait_for(maritime_routes.digitraffic_snapshot(), timeout=15.0)
                except Exception:  # noqa: BLE001 — warm is best-effort
                    pass

            await asyncio.gather(_warm_aircraft(), _warm_maritime())
        yield
    finally:
        await mcp_cm.__aexit__(None, None, None)
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
                marinetraffic,  # noqa: PLC0415
            )
            from app.routes import news as news_routes  # noqa: PLC0415

            from app.intel import watch as watch_eval  # noqa: PLC0415

            await ais_firehose.stop()
            await ais_keyless.stop()
            await marinetraffic.stop()
            await maritime_routes.stop_background_poll()
            await history.stop()
            await watch_eval.stop()
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
    # Selective: /mcp must NOT be gzipped (would stall its SSE stream).
    app.add_middleware(SelectiveGZipMiddleware, minimum_size=1024, compresslevel=5)

    app.include_router(config_routes.router)
    app.include_router(health_routes.router)
    app.include_router(eq_routes.router)
    app.include_router(aviation_routes.router)
    app.include_router(adsb_routes.router)
    app.include_router(firms_routes.router)
    app.include_router(ais_routes.router)
    app.include_router(seismic_routes.router)
    app.include_router(events_routes.router)
    app.include_router(geocode_routes.router)
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
    app.include_router(export_routes.router)
    app.include_router(keys_routes.router)
    app.include_router(alert_rules_routes.router)
    app.include_router(targets_routes.router)
    app.include_router(status_routes.router)
    # Local 3DGS reconstruction jobs (Studio): images/video → COLMAP → gsplat →
    # .ply, on the box's GPU. SSE progress; keyless local passes through.
    app.include_router(recon_routes.router)
    app.include_router(simulation_routes.router)
    # Typed ontology spine (read) + governed write-back actions — the semantic
    # layer the kanban, alerts, and agent compose on (Track A1/C1).
    app.include_router(ontology_routes.router)
    app.include_router(actions_routes.router)
    # Shared named COP (save/load a viewport+layers+filters picture as a map:
    # ontology object) + the /ws/cop follow-along delta channel (Track D2).
    app.include_router(maps_routes.router)
    # Gotham-style Situation aggregate (situation: ontology object + contains
    # links) + grounded-LLM Courses of Action.
    app.include_router(situations_routes.router)
    app.include_router(audit_routes.router)
    app.include_router(extract_routes.router)
    app.include_router(collab_routes.router)

    # TiTiler COG sub-app (Track B2): XYZ tiles for any Cloud-Optimized GeoTIFF
    # (Maxar Open Data S3, future SAR delivery), so B3/B4/B5 have a universal
    # chip server. OPTIONAL — titiler-core pulls rasterio/GDAL, which may not be
    # installed; build_tiler_app() returns None on ImportError so the app still
    # boots. Inherits ApiKeyMiddleware gating (a BaseHTTPMiddleware sees mounted
    # paths), so the mount preserves the auth invariant; see tiler.py for the
    # keyless-vs-gated note (a /tiler/ entry in auth.PUBLIC_PREFIXES is what a
    # browser-direct keyless drape needs — owned by the auth module, not added
    # here).
    from app.imagery.tiler import build_tiler_app  # noqa: PLC0415

    tiler_app = build_tiler_app()
    if tiler_app is not None:
        app.mount("/tiler", tiler_app)

    # Agent-facing MCP endpoint (streamable-HTTP) at /mcp, in-process so its
    # tools share this app's warm snapshot + fusion engine. Gated by
    # ApiKeyMiddleware (above) exactly like every other non-public route; the
    # session manager is driven from the lifespan via app.state.mcp_manager.
    # The backend IS this process, so the tools' self-hop must never try to
    # auto-spawn a second uvicorn (would race / EADDRINUSE on :8000).
    os.environ.setdefault("OSINT_MCP_NO_AUTOSTART", "1")
    mcp_routes, mcp_manager = build_mcp_mount()
    app.state.mcp_manager = mcp_manager
    app.router.routes.extend(mcp_routes)

    # Serve the built frontend (apps/web/dist) at / so a LOCAL desktop window can
    # load the WHOLE app same-origin from this backend — /api, /tiles, /ws then
    # "just work" with no proxy and no per-file API-base rewrite. Mounted LAST so
    # every API/route above wins; only unmatched paths fall through to the SPA.
    # Keyless local runs pass ApiKeyMiddleware, so the static assets serve fine.
    from pathlib import Path as _Path  # noqa: PLC0415
    from fastapi.staticfiles import StaticFiles  # noqa: PLC0415
    from starlette.exceptions import HTTPException as _StarletteHTTPException  # noqa: PLC0415

    class _SPAStaticFiles(StaticFiles):
        # SPA fallback: client-side routes (/2d, /studio, …) have no matching file,
        # so a 404 falls back to index.html and React Router takes over.
        async def get_response(self, path: str, scope):  # type: ignore[no-untyped-def]
            try:
                return await super().get_response(path, scope)
            except _StarletteHTTPException as exc:
                if exc.status_code == 404:
                    return await super().get_response("index.html", scope)
                raise

    _dist = _Path(__file__).resolve().parents[2] / "web" / "dist"
    if _dist.is_dir():
        app.mount("/", _SPAStaticFiles(directory=str(_dist), html=True), name="web")

    return app


app = create_app()
