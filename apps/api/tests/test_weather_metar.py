"""GET /api/weather/metar — aviationweather.gov passthrough.

Standalone FastAPI app around just app.routes.weather, upstream monkeypatched
(pattern from test_maritime_warnings.py / test_airspace.py) — no live network.
Fixture is a real single-station METAR pull (tests/fixtures/metar_kjfk.json,
2026-07-11).
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes import weather

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "metar_kjfk.json").read_text())


def _make_app(monkeypatch, payload=FIXTURE, status_code=200, calls=None):
    class FakeResponse:
        def __init__(self):
            self.status_code = status_code

        def json(self):
            return payload

    class FakeClient:
        async def get(self, url, params=None, headers=None):
            if calls is not None:
                calls.append(params)
            return FakeResponse()

    weather.cache.invalidate("metar:KJFK")
    monkeypatch.setattr(weather, "get_client", lambda: FakeClient())

    app = FastAPI()
    app.include_router(weather.router)
    return TestClient(app)


def test_metar_passthrough_shape(monkeypatch):
    tc = _make_app(monkeypatch)
    r = tc.get("/api/weather/metar", params={"ids": "KJFK"})
    assert r.status_code == 200
    body = r.json()
    data = body["data"]
    assert isinstance(data, list) and len(data) == 1
    row = data[0]
    assert row["icaoId"] == "KJFK"
    assert row["fltCat"] == "VFR"
    assert row["wdir"] == 50
    assert row["wspd"] == 7
    assert row["rawOb"].startswith("METAR KJFK")


def test_metar_ids_normalized_for_cache_key(monkeypatch):
    """'kjfk' and 'KJFK' (or a different comma/space order for multi-id
    requests) must hit the SAME cache entry — the upstream loader only runs
    once."""
    calls: list = []
    tc = _make_app(monkeypatch, calls=calls)
    r1 = tc.get("/api/weather/metar", params={"ids": "kjfk"})
    r2 = tc.get("/api/weather/metar", params={"ids": "KJFK"})
    assert r1.status_code == r2.status_code == 200
    assert len(calls) == 1, "second (normalized-duplicate) request should be a cache hit"


def test_metar_multi_id_sorted_query(monkeypatch):
    weather.cache.invalidate("metar:EGLL,KJFK")
    calls: list = []
    tc = _make_app(monkeypatch, calls=calls)
    r = tc.get("/api/weather/metar", params={"ids": "EGLL,KJFK"})
    assert r.status_code == 200
    assert calls[0]["ids"] == "EGLL,KJFK"  # sorted, deduped


def test_metar_too_many_ids_rejected(monkeypatch):
    tc = _make_app(monkeypatch)
    ids = ",".join(f"K{i:03d}" for i in range(11))
    r = tc.get("/api/weather/metar", params={"ids": ids})
    assert r.status_code == 400


def test_metar_empty_ids_rejected(monkeypatch):
    tc = _make_app(monkeypatch)
    r = tc.get("/api/weather/metar", params={"ids": "  ,  "})
    assert r.status_code == 400


def test_metar_upstream_failure_502(monkeypatch):
    tc = _make_app(monkeypatch, status_code=503)
    r = tc.get("/api/weather/metar", params={"ids": "KJFK"})
    assert r.status_code == 502


def test_json_or_502_degrades_non_json_body() -> None:
    # A 200 + non-JSON body (a CDN maintenance / rate-limit HTML page) must become
    # a 502, not raise out of the cache.get_or_fetch loader and 500 the route.
    import pytest
    from fastapi import HTTPException

    from app.routes.weather import _json_or_502

    class _R:
        status_code = 200

        def json(self) -> object:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")

    with pytest.raises(HTTPException) as exc:
        _json_or_502(_R(), "test")
    assert exc.value.status_code == 502
