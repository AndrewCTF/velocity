"""Optional X-API-Key authentication.

Enabled only when `API_KEY` is set in env. Public diag routes (`/api/health`,
`/api/config`) skip auth because the browser needs them before it can render
the boot error UI. NOTE: the SPA's key is NOT served by the backend — it is
baked into the bundle at build time via `VITE_API_KEY` (apps/web/src/transport/
http.ts). A deployment that sets API_KEY must also rebuild the web bundle with
a matching VITE_API_KEY, or the SPA will be locked out of every non-public
route.
"""

from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, Request, WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from app.config import get_settings

PUBLIC_PATHS = {"/api/health", "/api/config", "/docs", "/openapi.json", "/redoc"}
PUBLIC_PREFIXES = ("/tiles/",)


class ApiKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:  # type: ignore[no-untyped-def]
        key = get_settings().api_key
        if not key:
            return await call_next(request)
        path = request.url.path
        if path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES):
            return await call_next(request)
        # Allow either header or ?key= query (handy for WS upgrade hosts that
        # can't easily set headers).
        supplied = request.headers.get("x-api-key") or request.query_params.get("key")
        # Return a response directly: HTTPException raised inside a
        # BaseHTTPMiddleware is NOT seen by FastAPI's exception handlers
        # (they sit deeper in the ASGI stack), so raising here surfaced as a
        # 500 + stack trace instead of a clean 401.
        if not secrets.compare_digest(supplied or "", key):
            return JSONResponse({"detail": "invalid api key"}, status_code=401)
        return await call_next(request)


async def require_ws_key(ws: WebSocket) -> bool:
    """For WS routes: check key before accept(). Returns True if allowed."""
    key = get_settings().api_key
    if not key:
        return True
    supplied = ws.headers.get("x-api-key") or ws.query_params.get("key")
    return secrets.compare_digest(supplied or "", key)


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """Optional FastAPI Depends() form for individual routes."""
    key = get_settings().api_key
    if not key:
        return
    if not secrets.compare_digest(x_api_key or "", key):
        raise HTTPException(status_code=401, detail="invalid api key")
