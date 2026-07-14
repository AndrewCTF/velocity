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

from app.upstream import cache, get_client

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
        raise HTTPException(502, f"upstream {r.status_code}")
    try:
        return r.json()
    except ValueError as exc:
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


async def cached(
    key: str, ttl: float, loader: Callable[[], Awaitable[dict[str, Any]]]
) -> dict[str, Any]:
    """Thin alias over ``cache.get_or_fetch`` so feed routes import one module."""
    return await cache.get_or_fetch(key, ttl, loader)


def num(v: Any) -> float | None:
    """Best-effort float coercion; ``None`` when the value is missing or unparseable."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
