"""Optional X-API-Key authentication.

Enabled only when `API_KEY` is set in env. Public diag routes (`/api/health`,
`/api/config`) skip auth because the browser needs them before it knows the key
(and `/api/config` itself returns the key for the SPA to embed in subsequent
requests).
"""

from __future__ import annotations

from fastapi import Header, HTTPException, Request, WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.config import get_settings

PUBLIC_PATHS = {"/api/health", "/api/config", "/docs", "/openapi.json", "/redoc"}
PUBLIC_PREFIXES = ("/tiles/",)


class ApiKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        key = get_settings().api_key
        if not key:
            return await call_next(request)
        path = request.url.path
        if path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES):
            return await call_next(request)
        # Allow either header or ?key= query (handy for WS upgrade hosts that
        # can't easily set headers).
        supplied = request.headers.get("x-api-key") or request.query_params.get("key")
        if supplied != key:
            raise HTTPException(status_code=401, detail="invalid api key")
        return await call_next(request)


async def require_ws_key(ws: WebSocket) -> bool:
    """For WS routes: check key before accept(). Returns True if allowed."""
    key = get_settings().api_key
    if not key:
        return True
    supplied = ws.headers.get("x-api-key") or ws.query_params.get("key")
    return supplied == key


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """Optional FastAPI Depends() form for individual routes."""
    key = get_settings().api_key
    if not key:
        return
    if x_api_key != key:
        raise HTTPException(status_code=401, detail="invalid api key")
