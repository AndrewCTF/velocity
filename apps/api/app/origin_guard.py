"""Host allowlist and cross-site write / WebSocket refusal (ASVS V3.5.1, V3.5.2,
V4.4.2; 2026-09-13).

A keyless box authenticates nothing, so the browser's same-origin policy was
its only protection, and it does not stop a WRITE: measured before this module,
a multipart ``POST /api/evidence/upload`` sent from ``Origin: evil.example``
answered 200 and planted an object, and any page could open ``/ws/alerts`` or
push Y.js updates into ``/ws/collab``. Any ``Host`` header was accepted too, so
DNS rebinding turned a public page into a same-origin client of
``localhost:8000``.

Two checks, pure ASGI (the ADS-B blob path must not gain a buffering wrapper):

* **Host.** ``ALLOWED_HOSTS`` (comma list; ``*`` disables). Empty = loopback
  names plus every host named in ``CORS_ORIGINS``. Anything else is 400.
* **Origin.** For a state-changing method (anything but GET/HEAD/OPTIONS) and
  for every WebSocket upgrade: when ``Origin`` is present it must be in
  ``CORS_ORIGINS`` or match the request's own Host; with no ``Origin``, a
  present ``Referer`` must satisfy the same rule. A request carrying neither is
  a server-to-server caller (curl, the MCP hop, a feeder) and passes: browsers
  always send ``Origin`` on these requests. Refused with 403 (WS: close before
  accept).
"""

from __future__ import annotations

import logging
from functools import lru_cache
from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import get_settings

_log = logging.getLogger("app.security")
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_LOOPBACK = ("localhost", "127.0.0.1", "::1", "[::1]", "tauri.localhost")


def _host_only(hostport: str) -> str:
    hostport = hostport.strip().lower()
    if hostport.startswith("["):
        return hostport.split("]", 1)[0] + "]"
    return hostport.rsplit(":", 1)[0] if hostport.count(":") == 1 else hostport


@lru_cache(maxsize=8)
def _allowed_hosts(raw: str, cors: str) -> frozenset[str] | None:
    if raw.strip() == "*":
        return None
    names = {h.strip().lower() for h in raw.split(",") if h.strip()}
    if not names:
        names = set(_LOOPBACK)
        for origin in cors.split(","):
            host = urlsplit(origin.strip()).hostname
            if host:
                names.add(host.lower())
    return frozenset(_host_only(n) if n != "::1" else n for n in names)


@lru_cache(maxsize=8)
def _cors_origins(cors: str) -> frozenset[str]:
    return frozenset(o.strip().rstrip("/").lower() for o in cors.split(",") if o.strip())


def _headers(scope: Scope) -> dict[str, str]:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}


def _origin_ok(origin: str, host_header: str, cors: str) -> bool:
    origin = origin.strip().rstrip("/").lower()
    if not origin or origin == "null":
        return False
    if origin in _cors_origins(cors):
        return True
    parts = urlsplit(origin)
    netloc = (parts.netloc or "").lower()
    return bool(netloc) and netloc == host_header.strip().lower()


class OriginHostGuardMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope["type"]
        if kind not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        s = get_settings()
        headers = _headers(scope)
        host_header = headers.get("host", "")
        path = scope.get("path", "")
        client = (scope.get("client") or ("", 0))[0]

        allowed = _allowed_hosts(s.allowed_hosts, s.cors_origins)
        if allowed is not None and _host_only(host_header) not in allowed:
            _log.warning("host refused client=%s path=%s host=%s", client, path, host_header[:80])
            await self._refuse(kind, scope, receive, send, 400, b"invalid host header")
            return

        needs_origin = kind == "websocket" or scope.get("method", "GET") not in _SAFE_METHODS
        if needs_origin:
            origin = headers.get("origin")
            source = origin if origin is not None else headers.get("referer")
            if source is not None:
                if origin is None:
                    parts = urlsplit(source)
                    source = f"{parts.scheme}://{parts.netloc}" if parts.netloc else ""
                if not _origin_ok(source, host_header, s.cors_origins):
                    _log.warning(
                        "cross-site refused client=%s path=%s origin=%s", client, path, source[:80]
                    )
                    await self._refuse(
                        kind, scope, receive, send, 403, b"cross-site request refused"
                    )
                    return
        await self.app(scope, receive, send)

    @staticmethod
    async def _refuse(
        kind: str, scope: Scope, receive: Receive, send: Send, status: int, body: bytes
    ) -> None:
        if kind == "websocket":
            await receive()  # the websocket.connect message
            await send({"type": "websocket.close", "code": 1008})
            return
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json")],
        })
        await send({"type": "http.response.body", "body": b'{"detail":"' + body + b'"}'})
