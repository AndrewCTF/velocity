"""TiTiler COG sub-app (Track B2) — XYZ tiles for any Cloud-Optimized GeoTIFF.

This turns a Cloud-Optimized GeoTIFF (a Maxar Open Data S3 asset, a future SAR
delivery, an on-demand tasking COG) into web-mercator XYZ tiles + a tilejson +
a bbox crop, so the *universal* chip server B3/B4/B5 can drape arbitrary COGs on
the globe. It is built on ``titiler.core``'s ``TilerFactory`` (rio-tiler /
rasterio / GDAL), reading the COG straight from its remote URL via GDAL's
``/vsicurl/`` virtual filesystem — nothing is staged to disk.

GRACEFUL-OPTIONAL BY DESIGN
---------------------------
``titiler-core`` pulls ``rasterio``/GDAL, which do NOT install cleanly on every
platform / Python build. So the import + the whole factory build is wrapped in
``build_tiler_app()`` returning ``FastAPI | None``: on any ImportError (or a
GDAL load failure surfacing as one) it logs a warning and returns ``None``, and
``main.py`` simply skips the mount. The rest of the app — and the test suite and
typecheck — must stay green whether or not titiler is present. Do NOT import
titiler at module top level; that would make the whole ``app.imagery`` package
fail to import on a box without rasterio.

AUTH INVARIANT (read before "making it keyless")
-------------------------------------------------
The mount lives under the parent app's ``ApiKeyMiddleware`` (a
``BaseHTTPMiddleware`` runs on the OUTER app, before routing, and DOES see
mounted sub-app paths — verified). ``/tiler`` is therefore **gated by the
existing API-key / Supabase dependency by default**, exactly like every other
non-public route — so mounting it does NOT break the auth invariant the brief's
reviewer M-6 flagged.

The brief calls the tiler "keyless by design, like ``imagery_tile``" because a
browser ``UrlTemplateImageryProvider`` fetches tiles directly and cannot attach
the ``apiFetch``/``withWsKey`` header. To make the drape work browser-direct the
operator must add ``"/tiler/"`` to ``PUBLIC_PREFIXES`` in ``app/auth.py`` (a
one-line allowlist, owned by the auth module — NOT changed here). NOTE: this is
the SAME unresolved keyless-vs-gated exception that ``/api/imagery/chip`` already
carries today (its docstring claims keyless but it is not in ``PUBLIC_PREFIXES``
either). Until that allowlist entry is added, ``/tiler`` answers authenticated
callers (server-side fusion, the MCP tools, ``apiFetch`` XHRs) and 401s an
unauthenticated browser tile fetch — fail-safe, never fail-open.

GZIP INTERACTION
----------------
``SelectiveGZipMiddleware`` (``main.py``) only BYPASSES ``/mcp``; ``/tiler``
responses are gzip-eligible. That is harmless here: tile bodies are PNG/JPEG
(already compressed, so gzip ~no-ops above ``minimum_size``) and — unlike the
MCP SSE stream — they send a body immediately, so the gzip "buffer the start
message" stall does not apply. tilejson/info are small JSON. No special-casing
needed.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("app.imagery.tiler")

__all__ = ["build_tiler_app", "TILER_AVAILABLE"]

# Resolved by build_tiler_app() on first call; None until then / if titiler is
# absent. Exposed so callers (and the test) can introspect without re-importing.
TILER_AVAILABLE: bool | None = None


def build_tiler_app() -> object | None:
    """Build the mountable TiTiler COG sub-app, or ``None`` if unavailable.

    Returns a ``fastapi.FastAPI`` instance serving the ``TilerFactory`` routes
    (``/tiles/{tileMatrixSetId}/{z}/{x}/{y}``, ``/tilejson.json``, ``/info``,
    ``/bbox/...``, ``/point/...`` etc.) for a COG addressed by a ``?url=``
    query, OR ``None`` when ``titiler-core`` / ``rasterio`` cannot be imported
    (logged once as a warning). The return type is annotated loosely so this
    module imports — and typechecks — on a box with no rasterio.
    """
    global TILER_AVAILABLE
    try:
        from fastapi import FastAPI
        from titiler.core.errors import DEFAULT_STATUS_CODES, add_exception_handlers
        from titiler.core.factory import TilerFactory
    except Exception as exc:  # noqa: BLE001 — ImportError OR a GDAL load surfacing as one
        TILER_AVAILABLE = False
        logger.warning(
            "TiTiler COG tiler unavailable (%s: %s); /tiler mount skipped. "
            "Install with `.venv/bin/pip install titiler-core` to enable COG tiles.",
            type(exc).__name__,
            exc,
        )
        return None

    # A standalone sub-app so it owns its own OpenAPI + exception handlers and
    # composes cleanly under app.mount(). Docs are kept (small, useful for the
    # operator to discover the COG tile/tilejson URLs); they sit at /tiler/docs.
    tiler_app = FastAPI(
        title="Velocity COG Tiler",
        description=(
            "XYZ / tilejson tiles for any Cloud-Optimized GeoTIFF (pass ?url=<cog>). "
            "Powered by TiTiler + rio-tiler. Mounted at /tiler."
        ),
        version="0.1.0",
    )

    # The default TilerFactory already serves WebMercatorQuad (XYZ) tiles plus
    # tilejson / info / preview / bbox / point — the full COG surface B3/B4/B5
    # consume. Mount its router at the sub-app root so paths read
    # /tiler/tiles/WebMercatorQuad/{z}/{x}/{y}.
    cog = TilerFactory(router_prefix="")
    tiler_app.include_router(cog.router)

    # rio-tiler raises typed errors (TileOutsideBounds, InvalidColorMapName,
    # RasterioIOError on a bad/absent COG URL, …). Without these handlers they
    # surface as a bare 500; with them the operator gets a clean 4xx/404/5xx +
    # JSON detail instead of a stack trace. Same wiring TiTiler's own app uses.
    add_exception_handlers(tiler_app, DEFAULT_STATUS_CODES)

    @tiler_app.get("/healthz", include_in_schema=False)
    def _healthz() -> dict[str, bool]:
        return {"ok": True}

    TILER_AVAILABLE = True
    logger.info("TiTiler COG tiler mounted at /tiler (%d routes)", len(cog.router.routes))
    return tiler_app
