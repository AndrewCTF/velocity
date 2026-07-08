"""Inbound rate limiting for the cost/compute endpoints (issue #9).

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

import time
from collections import defaultdict, deque

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from app.config import get_settings

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
    "/api/extract",                  # LLM entity extraction
    "/api/intel/agent",              # LLM analysis agent
    "/api/intel/investigate",        # LLM investigation
    "/api/intel/brief",              # LLM incident brief
    "/api/intel/deception",          # LLM deception analysis
    "/api/intel/baseline",           # LLM baseline narrative
    "/api/intel/emitter",            # LLM emitter analysis
    "/api/intel/dossier/narrative",  # LLM dossier narrative
)


def is_compute_path(path: str) -> bool:
    """True for the money/hardware-spending endpoints. Single source of truth
    shared by the rate limiter (#9) and the auth fail-closed gate (#8)."""
    if path.endswith("/coa/propose"):  # /api/situations/<id>/coa/propose (LLM COA)
        return True
    return any(path.startswith(p) for p in _COMPUTE_PREFIXES)


_WINDOW_S = 60.0
_MAX_KEYS = 8192  # bound the bucket table; evict stale keys past this


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
        # X-Forwarded-For first hop when behind the gateway/nginx; else peer IP.
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    async def dispatch(self, request: Request, call_next) -> Response:  # type: ignore[no-untyped-def]
        path = request.url.path
        if not is_compute_path(path):
            return await call_next(request)
        limit = get_settings().ratelimit_compute_per_min
        if limit <= 0:  # limiter disabled
            return await call_next(request)

        now = time.monotonic()
        key = f"{self._client_key(request)}|{path.split('/')[2] if path.count('/') >= 2 else path}"
        dq = self._hits[key]
        cutoff = now - _WINDOW_S
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= limit:
            retry = max(1, int(dq[0] + _WINDOW_S - now))
            return JSONResponse(
                {"detail": "rate limit exceeded for this endpoint; slow down"},
                status_code=429,
                headers={"Retry-After": str(retry)},
            )
        dq.append(now)
        if len(self._hits) > _MAX_KEYS:  # opportunistic GC of drained buckets
            for k in [k for k, v in self._hits.items() if not v or v[-1] < cutoff]:
                self._hits.pop(k, None)
        return await call_next(request)
