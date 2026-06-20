"""GET /api/events/gdelt — GDELT GEO 2.0 proxy.

GDELT is frequently dead from datacenter egress (the stress test saw a 404).
Regression: the route used to hard-fail with 502 (or 500 on a transport error),
taking the whole endpoint — and the events/all + intel_brief fusion paths — down
with it. It must now degrade to an empty-but-VALID FeatureCollection flagged
`degraded`, so the route stays alive and the fusion paths (which tolerate empty
feeds) keep working.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app import upstream


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


def test_gdelt_upstream_404_degrades_not_502(client: TestClient) -> None:
    async def four04(self: object, url: str, **_: Any) -> httpx.Response:
        return httpx.Response(404, text="nope", request=httpx.Request("GET", url))

    with patch.object(httpx.AsyncClient, "get", new=four04):
        r = client.get("/api/events/gdelt")
    assert r.status_code == 200  # degrades, no longer 502
    b = r.json()
    assert b["type"] == "FeatureCollection"
    assert b["features"] == []
    assert b.get("degraded") is True
    assert "404" in b.get("note", "")


def test_gdelt_connection_error_degrades(client: TestClient) -> None:
    async def boom(self: object, url: str, **_: Any) -> httpx.Response:
        raise httpx.ConnectError("gdelt unreachable")

    with patch.object(httpx.AsyncClient, "get", new=boom):
        r = client.get("/api/events/gdelt")
    assert r.status_code == 200
    b = r.json()
    assert b["features"] == [] and b.get("degraded") is True


def test_gdelt_non_json_body_degrades(client: TestClient) -> None:
    async def html(self: object, url: str, **_: Any) -> httpx.Response:
        return httpx.Response(
            200, text="<html>oops</html>", request=httpx.Request("GET", url)
        )

    with patch.object(httpx.AsyncClient, "get", new=html):
        r = client.get("/api/events/gdelt")
    assert r.status_code == 200
    assert r.json().get("degraded") is True


def test_gdelt_happy_path_tags_features(client: TestClient) -> None:
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [35.0, 33.0]},
                "properties": {"name": "x"},
            }
        ],
    }

    async def ok(self: object, url: str, **_: Any) -> httpx.Response:
        return httpx.Response(200, json=fc, request=httpx.Request("GET", url))

    with patch.object(httpx.AsyncClient, "get", new=ok):
        r = client.get("/api/events/gdelt")
    assert r.status_code == 200
    b = r.json()
    assert "degraded" not in b
    assert b["features"][0]["properties"]["source"] == "gdelt"
    assert b["features"][0]["properties"]["kind"] == "event"
