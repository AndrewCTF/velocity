"""Per-client concurrent WebSocket cap (ASVS V2.4.1).

``ComputeRateLimitMiddleware`` is a BaseHTTPMiddleware, so WebSocket scopes are
never counted, and no handler bounded how many sockets one client could hold
open. Each ``/ws/*`` handler now takes a slot after ``require_ws_key`` and
before ``accept`` (the WS invariant: gate fully before accept), closes 1008 when
the client is at its cap, and gives the slot back in ``finally``.

The client is ``ratelimit.client_key`` — the same identity the HTTP limiter and
the auth-failure lockout use, so ``X-Forwarded-For`` is believed only from
``TRUSTED_PROXIES``. ``WS_MAX_CONN_PER_CLIENT`` (default 32, 0 = off): one
dashboard tab opens ADS-B, AIS, alerts and a COP room, so a handful of tabs on
one address stays far inside it. In-process only, like the rest of the limiter.
"""

from __future__ import annotations

import logging
import os
import threading

from starlette.websockets import WebSocket

log = logging.getLogger("app.security")

_DEFAULT_CAP = 32
_counts: dict[str, int] = {}
_lock = threading.Lock()


def cap() -> int:
    raw = os.getenv("WS_MAX_CONN_PER_CLIENT", "").strip()
    try:
        return max(0, int(raw)) if raw else _DEFAULT_CAP
    except ValueError:
        return _DEFAULT_CAP


def acquire(ws: WebSocket) -> str | None:
    """Take a slot for this socket's client. None = over the cap (close 1008)."""
    from app.ratelimit import client_key  # noqa: PLC0415

    client = getattr(ws, "client", None)
    key = client_key(client.host if client else "", ws.headers)
    limit = cap()
    with _lock:
        n = _counts.get(key, 0)
        if limit and n >= limit:
            path = getattr(getattr(ws, "url", None), "path", "") or ""
            log.warning("ws cap client=%s path=%s open=%d cap=%d", key, path, n, limit)
            return None
        _counts[key] = n + 1
    return key


def release(key: str | None) -> None:
    if key is None:
        return
    with _lock:
        n = _counts.get(key, 0) - 1
        if n > 0:
            _counts[key] = n
        else:
            _counts.pop(key, None)


def open_count(key: str) -> int:
    with _lock:
        return _counts.get(key, 0)
