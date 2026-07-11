"""Pure-function + route-shape tests for the NGA warnings section of
app.routes.maritime (GET /api/maritime/warnings).

No live network. Coordinate parsing is tested against a real 10-warning
sample trimmed from a live 386-warning broadcast-warn pull on 2026-07-11
(tests/fixtures/broadcast_warn.json), including both real mine warnings in
that sample (msgNumber 2017 has coordinates, 789 does not) and several
distinct real coordinate-text variants (decimal-minutes, degrees-minutes-
seconds, multi-position rosters, and warnings with no embedded coordinate at
all).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes import maritime

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "broadcast_warn.json").read_text()
)
WARNINGS_BY_NUM = {w["msgNumber"]: w for w in FIXTURE["broadcast-warn"]}


# ── pure parsing: parse_warning_coords on real text variants ────────────────


def test_decimal_minutes_single_coord():
    # msgNumber 2017: "OF 45-07.10N 030-09.70E." (also the mine warning)
    text = WARNINGS_BY_NUM[2017]["text"]
    coords = maritime.parse_warning_coords(text)
    assert len(coords) == 1
    lon, lat = coords[0]
    assert lat == pytest.approx(45 + 7.10 / 60.0, abs=1e-6)
    assert lon == pytest.approx(30 + 9.70 / 60.0, abs=1e-6)


def test_degrees_minutes_seconds_format():
    # msgNumber 1157: "20-03-44N 072-58-02W"
    text = WARNINGS_BY_NUM[1157]["text"]
    coords = maritime.parse_warning_coords(text)
    assert len(coords) == 1
    lon, lat = coords[0]
    expected_lat = 20 + 3 / 60.0 + 44 / 3600.0
    expected_lon = -(72 + 58 / 60.0 + 2 / 3600.0)
    assert lat == pytest.approx(expected_lat, abs=1e-6)
    assert lon == pytest.approx(expected_lon, abs=1e-6)


def test_single_port_notice_coord():
    # msgNumber 490: "39-16.00N 076-35.00W" (Port of Baltimore)
    text = WARNINGS_BY_NUM[490]["text"]
    coords = maritime.parse_warning_coords(text)
    assert len(coords) == 1
    lon, lat = coords[0]
    assert lat == pytest.approx(39 + 16.0 / 60.0, abs=1e-6)
    assert lon == pytest.approx(-(76 + 35.0 / 60.0), abs=1e-6)


def test_multi_coord_facility_list():
    # msgNumber 460: 6 USCG remote comms facilities, one coord each
    text = WARNINGS_BY_NUM[460]["text"]
    coords = maritime.parse_warning_coords(text)
    assert len(coords) == 6
    # first: BOSTON 41-42.80N 070-30.30W
    lon0, lat0 = coords[0]
    assert lat0 == pytest.approx(41 + 42.80 / 60.0, abs=1e-6)
    assert lon0 == pytest.approx(-(70 + 30.30 / 60.0), abs=1e-6)


def test_large_roster_capped_at_25():
    # msgNumber 517: MODU roster with 87 raw coordinate matches — must cap.
    text = WARNINGS_BY_NUM[517]["text"]
    coords = maritime.parse_warning_coords(text)
    assert len(coords) == maritime.MAX_COORDS_PER_WARNING == 25


def test_no_coordinate_junk_tolerance():
    # msgNumber 498 ("in force as of" summary) and 3226 (admin notice) have
    # no embedded coordinate at all — must return [] without raising.
    assert maritime.parse_warning_coords(WARNINGS_BY_NUM[498]["text"]) == []
    assert maritime.parse_warning_coords(WARNINGS_BY_NUM[3226]["text"]) == []
    # genuinely empty / garbage input
    assert maritime.parse_warning_coords("") == []
    assert maritime.parse_warning_coords("no coordinates here at all") == []
    assert maritime.parse_warning_coords(None) == []  # type: ignore[arg-type]


def test_out_of_range_values_rejected():
    # 999 degrees is not a valid lat/lon — parser must drop it, not crash.
    assert maritime.parse_warning_coords("999-00.00N 030-00.00E") == []


# ── mine flag ────────────────────────────────────────────────────────────────


def test_mine_flag_true_on_mine_fixture_with_coords():
    feats = maritime.warning_to_features(WARNINGS_BY_NUM[2017])
    assert len(feats) == 1
    assert feats[0]["properties"]["mine"] is True


def test_mine_flag_false_on_non_mine_warning():
    feats = maritime.warning_to_features(WARNINGS_BY_NUM[490])
    assert len(feats) == 1
    assert feats[0]["properties"]["mine"] is False


def test_mine_warning_without_coords_yields_no_feature():
    # msgNumber 789 is also a mine warning but has no embedded coordinate —
    # must not fabricate a position; it should simply not appear.
    feats = maritime.warning_to_features(WARNINGS_BY_NUM[789])
    assert feats == []


# ── warning_to_features / parse_broadcast_warn shape ────────────────────────


def test_warning_to_features_point_geometry_and_props():
    feats = maritime.warning_to_features(WARNINGS_BY_NUM[2017])
    feat = feats[0]
    assert feat["geometry"]["type"] == "Point"
    props = feat["properties"]
    assert props["msgNumber"] == 2017
    assert props["msgYear"] == 2023
    assert props["navArea"] == "A"
    assert props["subregion"] == "55"
    assert len(props["text"]) <= maritime.WARNING_TEXT_TRUNCATE
    assert props["issueDate"] == "071541Z SEP 2023"
    assert props["authority"]


def test_parse_broadcast_warn_full_fixture_coverage():
    """Coverage check against the trimmed 10-warning sample: warnings with a
    parseable coordinate produce >=1 feature each; the 2 that legitimately
    have none produce zero."""
    fc = maritime.parse_broadcast_warn(FIXTURE)
    assert fc["type"] == "FeatureCollection"
    msg_numbers_with_features = {f["properties"]["msgNumber"] for f in fc["features"]}
    # 8 of the 10 fixture warnings have >=1 embedded coordinate (498, 3226 do not)
    assert msg_numbers_with_features == {2017, 517, 1157, 490, 460, 466, 500}
    mine_feats = [f for f in fc["features"] if f["properties"]["mine"]]
    assert len(mine_feats) == 1  # only 2017 (789 has no coord to attach to)


# ── route shape: standalone app around just this router ─────────────────────


def test_route_returns_feature_collection(monkeypatch):
    maritime.cache.invalidate("maritime:warnings")

    class FakeResponse:
        status_code = 200

        def json(self):
            return FIXTURE

    class FakeClient:
        async def get(self, url, params=None, headers=None):
            return FakeResponse()

    monkeypatch.setattr(maritime, "get_client", lambda: FakeClient())

    app = FastAPI()
    app.include_router(maritime.router)
    client = TestClient(app)
    r = client.get("/api/maritime/warnings")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) > 0
    assert any(f["properties"]["mine"] for f in body["features"])


def test_route_retries_on_503_then_succeeds(monkeypatch):
    maritime.cache.invalidate("maritime:warnings")
    calls = {"n": 0}

    class FakeResponse:
        def __init__(self, status_code, payload=None):
            self.status_code = status_code
            self._payload = payload

        def json(self):
            return self._payload

    class FakeClient:
        async def get(self, url, params=None, headers=None):
            calls["n"] += 1
            if calls["n"] < 3:
                return FakeResponse(503)
            return FakeResponse(200, FIXTURE)

    async def fast_sleep(_):
        return None

    monkeypatch.setattr(maritime, "get_client", lambda: FakeClient())
    monkeypatch.setattr(maritime.asyncio, "sleep", fast_sleep)

    app = FastAPI()
    app.include_router(maritime.router)
    client = TestClient(app)
    r = client.get("/api/maritime/warnings")
    assert r.status_code == 200
    assert calls["n"] == 3


def test_route_503_exhausted_returns_502(monkeypatch):
    maritime.cache.invalidate("maritime:warnings")

    class FakeResponse:
        status_code = 503

        def json(self):
            return {}

    class FakeClient:
        async def get(self, url, params=None, headers=None):
            return FakeResponse()

    async def fast_sleep(_):
        return None

    monkeypatch.setattr(maritime, "get_client", lambda: FakeClient())
    monkeypatch.setattr(maritime.asyncio, "sleep", fast_sleep)

    app = FastAPI()
    app.include_router(maritime.router)
    client = TestClient(app)
    r = client.get("/api/maritime/warnings")
    assert r.status_code == 502
