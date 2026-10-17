"""The tile routes alone, in a process of their own.

The API's event loop belongs to the feed pipeline: a 2 ms route there waited
over 100 ms for 36 % of the wall clock and up to 4 s at a time (measured
2026-10-10 with the stall table in /api/status/perf). A Google 3D view is a
thousand tile requests, each of which queued behind that, so the mesh took 27 s
to sharpen on a loop that serves the same tiles in 8 s when it is left alone.

Nothing here but the tile router, so nothing else is ever on this loop. Same
routes, settings, upstream client and disk cache as the API, which still serves
/tiles itself for anything that does not run this (the containers, the desktop
shell). start.sh runs it and points the dev proxy at it for the tile families
that keep no state in the API process; Apple tiles need the signing session the
API holds and stay there.

    uvicorn app.tiles_main:app --app-dir apps/api --port 8001
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ponytail: importing the whole API for one middleware costs 1.3 s and 180 MB at
# boot. Move the class to its own module if that ever matters.
from app.config import get_settings
from app.main import SecurityHeadersMiddleware
from app.origin_guard import OriginHostGuardMiddleware
from app.routes import tiles

app = FastAPI(title="OSINT tiles", docs_url=None, redoc_url=None, openapi_url=None)
# A page on this machine asks this port for the mesh directly (GlobeCanvas,
# meshRootUrl), which makes every tile a cross-origin read. The API's own
# origins, reads only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
    allow_methods=["GET"],
)
app.add_middleware(OriginHostGuardMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.include_router(tiles.router)
