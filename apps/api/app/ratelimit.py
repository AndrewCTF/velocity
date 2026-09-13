"""Inbound rate limiting: cost/compute endpoints (issue #9), /mcp, and a
generous general per-client cap on every /api/ path (G11, 2026-09).

The platform boots keyless and its LLM/recon/imagery routes spend real money
(hosted inference) and hardware (GPU/CPU jobs). Nothing bounded *inbound* call
volume — a runaway client loop, or an open deployment, could drain the hosted-LLM
budget or saturate the GPU. This module adds a per-client sliding-window cap on
the COST/COMPUTE paths only; the cheap always-on data layers (ADS-B, AIS, quakes,
basemap, tiles) are untouched so the keyless product invariant holds.

The same ``is_compute_path`` predicate is the single source of truth for "this
route costs money/hardware" — ``app.auth`` reuses it to fail those paths CLOSED on
an unconfigured box (issue #8), so the two hardening controls never drift apart.
"""

from __future__ import annotations

import ipaddress
import logging
import time
from collections import defaultdict, deque
from functools import lru_cache

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from app.config import get_settings

_log = logging.getLogger("app.security")

# Endpoints that spend hosted-LLM credits or GPU/CPU compute per call. Prefixes
# are matched with ``startswith``; the ``/coa/propose`` suffix is matched
# separately because it hangs off a per-situation id path. Deliberately NARROW:
# cheap analysis GETs served from the warm snapshot (``/api/intel/area``,
# ``/api/intel/aircraft`` …) are polled by the UI and must NOT be throttled.
_COMPUTE_PREFIXES: tuple[str, ...] = (
    "/api/recon",                    # local 3DGS/RPC GPU+CPU jobs
    "/api/osint/recon",              # GPL deep-recon sidecar
    "/api/osint/investigate",        # LLM-backed OSINT orchestrator
    "/api/imagery/detect",           # YOLO detection subprocess
    "/api/imagery/splat",            # AOI chip → 3DGS reconstruction (GPU job)
    "/api/imagery/aoi",              # AOI chip fetch (paid provider egress/cache)
    "/api/extract",                  # LLM entity extraction
    "/api/intel/agent",              # LLM analysis agent
    "/api/intel/investigate",        # LLM investigation
    "/api/intel/brief",              # LLM incident brief
    "/api/intel/deception",          # LLM deception analysis
    "/api/intel/baseline",           # LLM baseline narrative
    "/api/intel/emitter",            # LLM emitter analysis
    "/api/intel/dossier/narrative",  # LLM dossier narrative
    "/api/ai/models",     # local model manager: downloads spend disk+bandwidth
    "/api/ai/engine",     # local engine switch (cheap, but gated with the rest)
    "/api/ai/selection",  # selection-inference brief (LLM call per entity click)
    "/api/workflows",     # op.python exec() + op.http dispatch — actuation, not
                          # just credits; MUST fail closed on a keyless box so a
                          # fresh self-host is not an anonymous RCE (see #8 gate).
)


def is_compute_path(path: str) -> bool:
    """True for the money/hardware-spending endpoints. Single source of truth
    shared by the rate limiter (#9) and the auth fail-closed gate (#8)."""
    if path.endswith("/coa/propose"):  # /api/situations/<id>/coa/propose (LLM COA)
        return True
    return any(path.startswith(p) for p in _COMPUTE_PREFIXES)


# Exempt from the general /api/ cap: the browser needs these before it can
# render, and an operator needs them to diagnose a throttled box.
_GENERAL_EXEMPT: tuple[str, ...] = ("/api/health", "/api/status", "/api/config")


def _is_exempt(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") for p in _GENERAL_EXEMPT)


_WINDOW_S = 60.0
_MAX_KEYS = 8192  # bound the bucket table; evict stale keys past this


@lru_cache(maxsize=8)
def _trusted_nets(raw: str) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    """Parse ``TRUSTED_PROXIES`` once. A bare IP is its own /32 or /128; an
    unparseable entry is dropped rather than raised, because a typo in this
    setting must narrow trust, never take the app down."""
    nets = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            continue
    return tuple(nets)


def _peer_is_trusted(peer: str, raw: str) -> bool:
    nets = _trusted_nets(raw)
    if not nets:
        return False
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return any(addr in n for n in nets)


def client_key(peer: str, headers) -> str:  # type: ignore[no-untyped-def]
    """The per-client bucket key, shared by the limiter and the auth-failure
    throttle so both agree on who a client is.

    X-Forwarded-For is believed ONLY when the peer is a configured trusted
    proxy (``TRUSTED_PROXIES``, loopback by default — CF Worker -> Caddy ->
    uvicorn on the same box). Believing it unconditionally handed every caller
    a fresh bucket per request for the cost of varying one header.

    And from a trusted peer the RIGHTMOST address that is not itself a trusted
    proxy is the client, never the leftmost: each proxy APPENDS the address it
    saw, so everything left of the last hop we trust was written by the caller.
    A leftmost read let a client send ``X-Forwarded-For: <anything>`` and pick
    its own bucket through the proxy (ASVS V15.3.4).
    """
    raw = get_settings().trusted_proxies
    if peer and _peer_is_trusted(peer, raw):
        xff = headers.get("x-forwarded-for") if headers is not None else None
        if xff:
            hops = [h.strip() for h in xff.split(",") if h.strip()]
            for hop in reversed(hops):
                if not _peer_is_trusted(hop, raw):
                    return hop
            if hops:
                return hops[0]
    return peer or "unknown"


class SlidingWindow:
    """A per-key sliding one-minute window of events, bounded to ``_MAX_KEYS``.

    ``record`` appends an event; ``retry_after`` answers None while the key has
    room under ``limit``, else the seconds until its oldest event leaves the
    window. Used by the auth-failure throttle; the limiter below keeps its own
    table on the instance so each test app starts empty.
    """

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def clear(self) -> None:
        self._hits.clear()

    def _trim(self, key: str, now: float) -> deque[float]:
        dq = self._hits[key]
        cutoff = now - _WINDOW_S
        while dq and dq[0] < cutoff:
            dq.popleft()
        return dq

    def retry_after(self, key: str, *, limit: int) -> int | None:
        if key not in self._hits:
            return None
        now = time.monotonic()
        dq = self._trim(key, now)
        if len(dq) < limit:
            if not dq:
                self._hits.pop(key, None)
            return None
        return max(1, int(dq[0] + _WINDOW_S - now) + 1)

    def record(self, key: str, *, limit: int) -> None:
        now = time.monotonic()
        dq = self._trim(key, now)
        dq.append(now)
        # A locked key needs only its newest ``limit`` events to stay locked.
        while len(dq) > max(limit, 1):
            dq.popleft()
        if len(self._hits) > _MAX_KEYS:
            cutoff = now - _WINDOW_S
            for k in [k for k, v in self._hits.items() if not v or v[-1] < cutoff]:
                self._hits.pop(k, None)
            if len(self._hits) > _MAX_KEYS:
                for k in sorted(self._hits, key=lambda k: self._hits[k][-1])[
                    : len(self._hits) - _MAX_KEYS
                ]:
                    self._hits.pop(k, None)


class ComputeRateLimitMiddleware(BaseHTTPMiddleware):
    """Per-client-IP sliding-window limiter on the compute paths.

    State lives on the instance (one per app), so each ``create_app()`` in the
    test suite gets a fresh table and counts never bleed across tests. In
    production there is exactly one app, so the table is process-wide as intended.
    """

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _client_key(self, request: Request) -> str:
        """See ``client_key``."""
        return client_key(request.client.host if request.client else "", request.headers)

    def _evict(self, cutoff: float) -> None:
        """Hold the bucket table to ``_MAX_KEYS``.

        Drained buckets go first. If that is not enough the table is under a
        spread of distinct keys rather than normal traffic, so the
        least-recently-used ones go too: a GC that can only drop drained buckets
        is a bound on paper, since keys arriving faster than the window drains
        them are never drained.
        """
        if len(self._hits) <= _MAX_KEYS:
            return
        for k in [k for k, v in self._hits.items() if not v or v[-1] < cutoff]:
            self._hits.pop(k, None)
        if len(self._hits) > _MAX_KEYS:
            for k in sorted(self._hits, key=lambda k: self._hits[k][-1])[
                : len(self._hits) - _MAX_KEYS
            ]:
                self._hits.pop(k, None)

    async def dispatch(self, request: Request, call_next) -> Response:  # type: ignore[no-untyped-def]
        path = request.url.path
        is_mcp = path == "/mcp" or path.startswith("/mcp/")
        is_api = path.startswith("/api/") and not _is_exempt(path)
        # /tiler fetches a remote COG per request (GDAL egress), so it shares the
        # general per-client cap under its own bucket (ASVS V13.2.4 / V2.4.1).
        is_tiler = path == "/tiler" or path.startswith("/tiler/")
        if not (is_mcp or is_api or is_tiler):
            return await call_next(request)
        settings = get_settings()
        client = self._client_key(request)
        # (bucket key, limit) pairs; a request must fit EVERY applicable bucket.
        buckets: list[tuple[str, int]] = []
        if is_mcp:
            # /mcp gets its own, separately-tunable cap: an agent's tool-call burst
            # is a different traffic shape than a UI hitting a compute route, and
            # it must not hammer the rate-limited upstreams the tools proxy.
            buckets.append((f"{client}|mcp", settings.mcp_ratelimit_per_min))
        elif is_compute_path(path):
            # Compute routes bucket by their second path segment.
            seg = path.split("/")[2] if path.count("/") >= 2 else path
            buckets.append((f"{client}|{seg}", settings.ratelimit_compute_per_min))
        if is_api:
            buckets.append((f"{client}|api", settings.api_ratelimit_per_min))
        if is_tiler:
            buckets.append((f"{client}|tiler", settings.api_ratelimit_per_min))
        buckets = [(k, lim) for k, lim in buckets if lim > 0]  # 0 = that limiter off
        if not buckets:
            return await call_next(request)

        now = time.monotonic()
        cutoff = now - _WINDOW_S
        # Check all buckets before recording in any, so a refused request is not
        # charged against the buckets it did fit.
        for key, limit in buckets:
            dq = self._hits[key]
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= limit:
                retry = max(1, int(dq[0] + _WINDOW_S - now))
                _log.warning(
                    "rate limit exceeded client=%s path=%s bucket=%s", client, path,
                    key.split("|", 1)[-1],
                )
                return JSONResponse(
                    {"detail": "rate limit exceeded for this endpoint; slow down"},
                    status_code=429,
                    headers={"Retry-After": str(retry)},
                )
        for key, _ in buckets:
            self._hits[key].append(now)
        self._evict(cutoff)
        return await call_next(request)
