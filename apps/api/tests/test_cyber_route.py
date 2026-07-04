"""GET /api/cyber/ioda/outages — IODA (CAIDA) outage proxy.

Contract: a slow/dead CAIDA upstream must fail FAST (tight ~8s timeout) and
degrade GRACEFULLY — the handler returns HTTP 200 with a typed
``{"items": [], "unavailable": True, "note": ...}`` payload (briefly cached)
so the frontend/correlator can handle it without erroring, instead of the old
~16s-then-502 (or a raw 500). The happy path passes the events through.
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


def test_ioda_connection_error_degrades_to_typed_unavailable(client: TestClient) -> None:
    async def boom(self: object, url: str, **_: Any) -> httpx.Response:
        raise httpx.ConnectError("ioda unreachable")

    with patch.object(httpx.AsyncClient, "get", new=boom):
        r = client.get("/api/cyber/ioda/outages")
    assert r.status_code == 200  # graceful, not 502/500
    body = r.json()
    assert body["unavailable"] is True
    assert body["items"] == []


def test_ioda_non_json_body_degrades_to_typed_unavailable(client: TestClient) -> None:
    async def html(self: object, url: str, **_: Any) -> httpx.Response:
        return httpx.Response(
            200, text="<html>error</html>", request=httpx.Request("GET", url)
        )

    with patch.object(httpx.AsyncClient, "get", new=html):
        r = client.get("/api/cyber/ioda/outages")
    assert r.status_code == 200
    body = r.json()
    assert body["unavailable"] is True
    assert body["items"] == []


def test_ioda_non_200_degrades_to_typed_unavailable(client: TestClient) -> None:
    async def upstream_404(self: object, url: str, **_: Any) -> httpx.Response:
        return httpx.Response(404, text="nope", request=httpx.Request("GET", url))

    with patch.object(httpx.AsyncClient, "get", new=upstream_404):
        r = client.get("/api/cyber/ioda/outages")
    assert r.status_code == 200
    body = r.json()
    assert body["unavailable"] is True
    assert "404" in body["note"]


def test_ioda_happy_path_passes_through(client: TestClient) -> None:
    async def ok(self: object, url: str, **_: Any) -> httpx.Response:
        return httpx.Response(
            200, json={"data": [{"id": 1}]}, request=httpx.Request("GET", url)
        )

    with patch.object(httpx.AsyncClient, "get", new=ok):
        r = client.get("/api/cyber/ioda/outages")
    assert r.status_code == 200
    assert r.json()["items"] == [{"id": 1}]
    assert "unavailable" not in r.json()
