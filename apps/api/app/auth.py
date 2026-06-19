"""Optional API authentication — static key and/or Supabase login.

Auth is OFF until at least one credential source is configured, so a bare
localhost dev box stays open. It turns ON (and is then ENFORCED on every
non-public route) when either is set:

  * ``API_KEY``  — a static shared secret, supplied via ``X-API-Key`` header or
    ``?key=`` query. For server/MCP callers and CI.
  * Supabase     — ``SUPABASE_JWT_SECRET`` (preferred) or ``SUPABASE_URL`` +
    ``SUPABASE_ANON_KEY``. Callers then present a Supabase **access token** —
    the JWT the browser receives after signing in — via ``Authorization:
    Bearer <jwt>`` (or ``?key=<jwt>`` on WS upgrades, which can't set headers).
    This is "the API key you get from Supabase".

Token validation is LOCAL HS256 when the JWT secret is set (no round-trip,
mirrors the gateway Worker's check); otherwise a call to GoTrue's
``/auth/v1/user`` with the anon key. Either way a successful check is cached
per-token until the token's own ``exp`` (capped at 5 min) so the 1 Hz ADS-B
poll validates at most once per session, not once per request.

Public diag/asset routes (`/api/health`, `/api/config`, `/tiles/*`, the docs)
skip auth because the browser needs them before it can render or before a
session exists.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

import httpx
from fastapi import Header, HTTPException, Request, WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from app.config import Settings, get_settings

PUBLIC_PATHS = {"/api/health", "/api/config", "/docs", "/openapi.json", "/redoc"}
PUBLIC_PREFIXES = ("/tiles/",)


# ── auth-enabled predicate ──────────────────────────────────────────────────


def _auth_enabled(s: Settings) -> bool:
    return bool(
        s.api_key
        or s.supabase_jwt_secret
        or (s.supabase_url and s.supabase_anon_key)
    )


# ── JWT helpers (HS256, matches the Supabase legacy signing scheme) ──────────


def _b64url_decode(seg: str) -> bytes:
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def _jwt_claims(token: str) -> dict | None:
    try:
        _, payload, _ = token.split(".")
        return json.loads(_b64url_decode(payload))
    except Exception:  # noqa: BLE001 — malformed token → no claims
        return None


def _verify_hs256(token: str, secret: str) -> bool:
    try:
        header, payload, sig = token.split(".")
        expected = hmac.new(
            secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256
        ).digest()
        if not hmac.compare_digest(_b64url_decode(sig), expected):
            return False
        claims = json.loads(_b64url_decode(payload)) or {}
        exp = claims.get("exp")
        if exp and float(exp) < time.time():
            return False
        # Only a signed-in USER session passes. The public anon key is a validly
        # signed JWT too (role "anon") — without this it would be accepted as a
        # credential, which it must not be. Service-role tokens are server
        # secrets, not browser sessions, so they're excluded as well.
        return claims.get("role") == "authenticated"
    except Exception:  # noqa: BLE001 — malformed/short token
        return False


# ── per-token validation cache ───────────────────────────────────────────────

_token_ok_until: dict[str, float] = {}  # token -> wall-clock expiry


async def _gotrue_validate(token: str, s: Settings) -> bool:
    """Ask GoTrue whether the access token is currently valid."""
    url = s.supabase_url.rstrip("/") + "/auth/v1/user"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(8.0, connect=5.0),
            # IPv4-pinned: some egress hosts publish broken AAAA (see app.llm).
            transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=1),
        ) as c:
            r = await c.get(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": s.supabase_anon_key,
                },
            )
        return r.status_code == 200
    except Exception:  # noqa: BLE001 — upstream down → deny (fail closed)
        return False


async def _valid_supabase_token(token: str, s: Settings) -> bool:
    if not token:
        return False
    now = time.time()
    cached = _token_ok_until.get(token)
    if cached and cached > now:
        return True

    if s.supabase_jwt_secret:
        ok = _verify_hs256(token, s.supabase_jwt_secret)
    elif s.supabase_url and s.supabase_anon_key:
        ok = await _gotrue_validate(token, s)
    else:
        return False

    if ok:
        exp = (_jwt_claims(token) or {}).get("exp")
        ttl_exp = now + 300.0
        if exp:
            ttl_exp = min(ttl_exp, float(exp))
        _token_ok_until[token] = ttl_exp
        if len(_token_ok_until) > 4096:  # bound: drop already-expired entries
            for k in [k for k, v in _token_ok_until.items() if v <= now]:
                _token_ok_until.pop(k, None)
    return ok


def _bearer(headers) -> str | None:  # type: ignore[no-untyped-def]
    h = headers.get("authorization") or headers.get("Authorization") or ""
    return h[7:] if h.lower().startswith("bearer ") else None


async def _authorized(
    static_supplied: str | None, token: str | None, s: Settings
) -> bool:
    """True if either the static key matches or the Supabase token is valid."""
    if s.api_key and secrets.compare_digest(static_supplied or "", s.api_key):
        return True
    return await _valid_supabase_token(token or "", s)


# ── middleware + dependencies ────────────────────────────────────────────────


class ApiKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next) -> Response:  # type: ignore[no-untyped-def]
        s = get_settings()
        path = request.url.path
        if not _auth_enabled(s):
            # Fail CLOSED for the agent endpoint: the backend origin is publicly
            # resolvable, so /mcp must NEVER be served on a deployment that has
            # no credential configured (set API_KEY and/or Supabase). Every
            # other route stays open on an unconfigured (local dev) box.
            if path == "/mcp" or path.startswith("/mcp/"):
                return JSONResponse(
                    {"detail": "mcp endpoint requires authentication to be configured"},
                    status_code=503,
                )
            return await call_next(request)
        if path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES):
            return await call_next(request)
        static_supplied = request.headers.get("x-api-key") or request.query_params.get("key")
        # The Supabase token may arrive as a Bearer header, ?key= (WS), or in
        # X-API-Key — accept any, then validate. Static-key match is tried first.
        token = (
            _bearer(request.headers)
            or request.query_params.get("key")
            or request.headers.get("x-api-key")
        )
        # Return a response directly: an HTTPException raised inside a
        # BaseHTTPMiddleware is NOT seen by FastAPI's exception handlers
        # (they sit deeper in the ASGI stack), so it would surface as a 500.
        if not await _authorized(static_supplied, token, s):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)


async def require_ws_key(ws: WebSocket) -> bool:
    """For WS routes: check the credential before accept(). True if allowed."""
    s = get_settings()
    if not _auth_enabled(s):
        return True
    static_supplied = ws.headers.get("x-api-key") or ws.query_params.get("key")
    token = (
        _bearer(ws.headers)
        or ws.query_params.get("key")
        or ws.headers.get("x-api-key")
    )
    return await _authorized(static_supplied, token, s)


async def require_api_key(
    request: Request,
    x_api_key: str | None = Header(default=None),
) -> None:
    """Optional FastAPI Depends() form for individual routes (static or token)."""
    s = get_settings()
    if not _auth_enabled(s):
        return
    static_supplied = x_api_key or request.query_params.get("key")
    token = _bearer(request.headers) or request.query_params.get("key") or x_api_key
    if not await _authorized(static_supplied, token, s):
        raise HTTPException(status_code=401, detail="unauthorized")
