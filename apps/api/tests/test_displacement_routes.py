"""GET /api/displacement — keyless IDP/refugee counts (country-level, no geo).

This route isn't wired into ``app.main`` yet (owned exclusively per the task
split — see the MERGE SPEC in the wave notes), so tests build a standalone
FastAPI app around just this router rather than using the shared `client`
fixture from conftest."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import upstream
from app.routes import displacement as displacement_routes


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(displacement_routes.router)
    with TestClient(app) as c:
        yield c


def _resp(payload: Any) -> httpx.Response:
    return httpx.Response(200, json=payload, request=httpx.Request("GET", "https://x"))


def _patch_by_path(idps_payload: Any, refugees_payload: Any):
    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        if "refugees-persons-of-concern" in url:
            return _resp(refugees_payload)
        if "/idps" in url:
            return _resp(idps_payload)
        raise AssertionError(f"unexpected url {url}")

    return patch.object(httpx.AsyncClient, "get", new=fake_get)


IDPS_PAYLOAD = {
    "data": [
        {
            "location_code": "afg",
            "location_name": "Afghanistan",
            "population": 100,
            "reference_period_end": "2025-01-31T23:59:59",
        },
        # later round for the same country supersedes the earlier one
        {
            "location_code": "AFG",
            "location_name": "Afghanistan",
            "population": 250,
            "reference_period_end": "2025-05-31T23:59:59",
        },
        # tie on the latest end date: two concurrent operations, summed
        {
            "location_code": "BEN",
            "location_name": "Benin",
            "population": 10,
            "reference_period_end": "2025-06-30T23:59:59",
        },
        {
            "location_code": "BEN",
            "location_name": "Benin",
            "population": 5,
            "reference_period_end": "2025-06-30T23:59:59",
        },
        # missing population is skipped, not a crash
        {
            "location_code": "SDN",
            "location_name": "Sudan",
            "population": None,
            "reference_period_end": "2025-06-30T23:59:59",
        },
    ]
}

REFUGEES_PAYLOAD = {
    "data": [
        {
            "origin_location_code": "AFG",
            "origin_location_name": "Afghanistan",
            "population": 40,
            "reference_period_end": "2024-12-31T23:59:59",
        },
        {
            "origin_location_code": "SYR",
            "origin_location_name": "Syria",
            "population": 500,
            "reference_period_end": "2024-12-31T23:59:59",
        },
    ]
}


def test_displacement_aggregates_latest_per_country(client: TestClient) -> None:
    with _patch_by_path(IDPS_PAYLOAD, REFUGEES_PAYLOAD):
        r = client.get("/api/displacement")
    assert r.status_code == 200
    body = r.json()
    assert body["unavailable"] is False
    by_iso3 = {i["iso3"]: i for i in body["items"]}

    assert by_iso3["AFG"]["idps"] == 250  # later round wins, not summed with the earlier one
    assert by_iso3["AFG"]["refugees"] == 40
    assert by_iso3["AFG"]["country"] == "Afghanistan"
    assert by_iso3["AFG"]["asof"] == "2025-05-31"

    assert by_iso3["BEN"]["idps"] == 15  # tie on end date: summed
    assert by_iso3["BEN"]["refugees"] is None

    assert by_iso3["SYR"]["idps"] is None
    assert by_iso3["SYR"]["refugees"] == 500


def test_displacement_tolerates_missing_population(client: TestClient) -> None:
    with _patch_by_path(IDPS_PAYLOAD, REFUGEES_PAYLOAD):
        r = client.get("/api/displacement")
    body = r.json()
    iso3s = {i["iso3"] for i in body["items"]}
    assert "SDN" not in iso3s  # null-population row dropped, never crashes


def test_displacement_upstream_down_is_unavailable_not_500(client: TestClient) -> None:
    async def bad(self: object, url: str, **_: object) -> httpx.Response:
        return httpx.Response(503, text="down", request=httpx.Request("GET", "https://x"))

    with patch.object(httpx.AsyncClient, "get", new=bad):
        r = client.get("/api/displacement")
    assert r.status_code == 200
    body = r.json()
    assert body["unavailable"] is True
    assert body["items"] == []


def test_displacement_partial_upstream_failure_still_returns_the_other_series(
    client: TestClient,
) -> None:
    async def mixed(self: object, url: str, **_: object) -> httpx.Response:
        if "refugees-persons-of-concern" in url:
            return httpx.Response(503, text="down", request=httpx.Request("GET", "https://x"))
        return _resp(IDPS_PAYLOAD)

    with patch.object(httpx.AsyncClient, "get", new=mixed):
        r = client.get("/api/displacement")
    assert r.status_code == 200
    body = r.json()
    assert body["unavailable"] is False
    by_iso3 = {i["iso3"]: i for i in body["items"]}
    assert by_iso3["AFG"]["idps"] == 250
    assert by_iso3["AFG"]["refugees"] is None


async def test_displacement_summary_sums_idps_and_refugees() -> None:
    with _patch_by_path(IDPS_PAYLOAD, REFUGEES_PAYLOAD):
        summary = await displacement_routes.displacement_summary()
    assert summary["AFG"] == 250 + 40
    assert summary["BEN"] == 15
    assert summary["SYR"] == 500
    assert "SDN" not in summary  # no idps, no refugees -> nothing to sum
