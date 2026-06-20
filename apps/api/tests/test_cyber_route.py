"""GET /api/cyber/ioda/outages — IODA (CAIDA) outage proxy.

Regression: the loader RAISES on failure (so a blip stays uncached), but a
transport error before the status check, or a 200 with a non-JSON body, used to
escape the guard as a raw 500. Both must now degrade to 502 like the sibling
cloudflare_outages handler — never an unhandled 500.
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


def test_ioda_connection_error_degrades_to_502(client: TestClient) -> None:
    async def boom(self: object, url: str, **_: Any) -> httpx.Response:
        raise httpx.ConnectError("ioda unreachable")

    with patch.object(httpx.AsyncClient, "get", new=boom):
        r = client.get("/api/cyber/ioda/outages")
    assert r.status_code == 502  # not 500


def test_ioda_non_json_body_degrades_to_502(client: TestClient) -> None:
    async def html(self: object, url: str, **_: Any) -> httpx.Response:
        return httpx.Response(
            200, text="<html>error</html>", request=httpx.Request("GET", url)
        )

    with patch.object(httpx.AsyncClient, "get", new=html):
        r = client.get("/api/cyber/ioda/outages")
    assert r.status_code == 502  # not 500


def test_ioda_non_200_degrades_to_502(client: TestClient) -> None:
    async def upstream_404(self: object, url: str, **_: Any) -> httpx.Response:
        return httpx.Response(404, text="nope", request=httpx.Request("GET", url))

    with patch.object(httpx.AsyncClient, "get", new=upstream_404):
        r = client.get("/api/cyber/ioda/outages")
    assert r.status_code == 502


def test_ioda_happy_path_passes_through(client: TestClient) -> None:
    async def ok(self: object, url: str, **_: Any) -> httpx.Response:
        return httpx.Response(
            200, json={"data": [{"id": 1}]}, request=httpx.Request("GET", url)
        )

    with patch.object(httpx.AsyncClient, "get", new=ok):
        r = client.get("/api/cyber/ioda/outages")
    assert r.status_code == 200
    assert r.json()["items"] == [{"id": 1}]
