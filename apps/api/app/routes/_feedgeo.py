"""Shared helpers for the keyless GeoJSON feed routes (2026-07-14 data-layers wave).

Every new feed route is a thin fetch → normalise → cache passthrough. Wrapping the
``cables.py`` idiom once keeps each of the 12 routes ~10 lines and gives one place
for timeout / non-200 / non-JSON handling so a flaky upstream degrades to a 502 the
frontend adapter already renders as a red status, never a 500.

Contract every feed follows so the whole platform can link the objects together:
each Feature carries a stable ``id`` of the form ``<kind>:<rawid>`` and a
``properties.kind`` equal to that prefix. That id is what ``/api/entity`` resolves,
what the correlations index keys on, and what the ontology graph promotes.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from fastapi import HTTPException

from app.upstream import cache, get_client, record_failure

Feature = dict[str, Any]


async def fetch_json(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    """GET ``url`` and return parsed JSON, raising HTTP 502 on any upstream trouble.

    Transport errors, non-200 status, and non-JSON bodies all collapse to a 502 so
    callers never leak a 500 for an upstream problem (airplanes.live-style throttles
    that answer 200 + ``text/plain`` are caught by the JSON guard).
    """
    try:
        r = await get_client().get(url, params=params, headers=headers)
    except (httpx.HTTPError, OSError) as exc:  # pragma: no cover - network shape
        raise HTTPException(502, f"upstream error: {exc}") from exc
    if r.status_code != 200:
        # 4xx/5xx are already in the health registry (the shared client records
        # them). A non-error non-200 is not, so say so here.
        if r.status_code < 400:
            record_failure(str(r.request.url.host), f"HTTP {r.status_code}", r.status_code)
        raise HTTPException(502, f"upstream {r.status_code}")
    try:
        return r.json()
    except ValueError as exc:
        # The ONE failure no client-level capture point can see: the upstream
        # answered 200, so the wire says success, and the body is a throttle
        # notice in text/plain. This is airplanes.live's documented behaviour and
        # the registry would otherwise go green at the exact moment the feed dies
        # its most common death.
        record_failure(str(r.request.url.host), "HTTP 200 with a non-JSON body", 200)
        raise HTTPException(502, "upstream returned a non-JSON body") from exc


async def fetch_text(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> str:
    """GET ``url`` and return the raw body text, 502 on transport/status trouble."""
    try:
        r = await get_client().get(url, params=params, headers=headers)
    except (httpx.HTTPError, OSError) as exc:  # pragma: no cover - network shape
        raise HTTPException(502, f"upstream error: {exc}") from exc
    if r.status_code != 200:
        if r.status_code < 400:
            record_failure(str(r.request.url.host), f"HTTP {r.status_code}", r.status_code)
        raise HTTPException(502, f"upstream {r.status_code}")
    return r.text


def fc(features: list[Feature]) -> dict[str, Any]:
    """Wrap a feature list in a GeoJSON FeatureCollection envelope."""
    return {"type": "FeatureCollection", "features": features}


def point(fid: str, lon: float, lat: float, props: dict[str, Any]) -> Feature:
    """Build a GeoJSON Point Feature with a stable ``<kind>:<rawid>`` id."""
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": props,
    }


def polygon(fid: str, ring: list[list[float]], props: dict[str, Any]) -> Feature:
    """Build a single-ring GeoJSON Polygon Feature (the frontend explodes MultiPolygon
    upstream into one Feature per ring, so the adapter only ever sees ``Polygon``)."""
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": props,
    }


# An empty answer expires fast. A real one keeps its full TTL.
#
# The 2026-08-20 sweep made this concrete: 17 routes answered 200 with an empty
# body, and because every one of those loaders catches its own upstream failure
# and RETURNS the empty rather than raising, the empty is a normal successful
# value — so get_or_fetch stores it for the loader's full TTL. GDELT's summary
# pinned `{"summary": {}}` for 10 minutes and the vessel-name index pinned `{}`
# for 12 hours, after ONE failed fetch. The upstream could recover five seconds
# later and the route would keep serving nothing.
#
# `cache.shorten` is the existing fix for exactly this (8 call sites, e.g. the
# ADS-B empty-cell TTL). Applying it once here covers every feed route instead
# of asking each of ~127 loaders to remember.
_EMPTY_TTL_S = 45.0


def _carries_nothing(payload: Any) -> bool:
    """True for a well-formed envelope with no data in it. Conservative: any
    non-empty collection anywhere makes it real."""
    if payload is None:
        return True
    if isinstance(payload, list):
        return not payload
    if not isinstance(payload, dict):
        return False
    if not payload:
        return True
    for v in payload.values():
        if isinstance(v, (list, dict)):
            if v:
                return False
        elif v not in (None, "", 0):
            return False
    return True


async def cached(
    key: str, ttl: float, loader: Callable[[], Awaitable[dict[str, Any]]]
) -> dict[str, Any]:
    """``cache.get_or_fetch``, but an empty result is not pinned for the full TTL."""
    out = await cache.get_or_fetch(key, ttl, loader)
    if ttl > _EMPTY_TTL_S and _carries_nothing(out):
        cache.shorten(key, _EMPTY_TTL_S)
    return out


def degraded_fc(note: str) -> dict[str, Any]:
    """An empty FeatureCollection that says WHY it is empty.

    A layer with no features and no explanation is indistinguishable from a
    working layer over a quiet area. This is the shape routes/events.py already
    uses; feed routes that swallow an upstream failure should answer with it
    rather than a bare `fc([])`.
    """
    return {"type": "FeatureCollection", "features": [], "degraded": True, "note": note}


def degraded(payload: dict[str, Any], note: str) -> dict[str, Any]:
    """Same idea for the non-GeoJSON envelopes."""
    return {**payload, "degraded": True, "note": note}


def num(v: Any) -> float | None:
    """Best-effort float coercion; ``None`` when the value is missing or unparseable."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
