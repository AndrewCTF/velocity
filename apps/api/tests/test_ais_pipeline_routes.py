"""Route-level guards for the AIS pipeline endpoints.

Uses the project's own ``client`` fixture from conftest (it sets ALLOWED_HOSTS
and the auth/database env the app expects). The endpoints under test are pure
reads over the in-process store, so no network is touched.
"""

from __future__ import annotations

import time

import pytest

from app.ais_pipeline import vessels as vessel_store
from app.ais_pipeline.providers import Fix


@pytest.fixture(autouse=True)
def _clean_store():
    """Each test gets an empty store so counts are deterministic."""
    vessel_store._by_mmsi.clear()
    vessel_store._grid.clear()
    vessel_store.seen_total = 0
    yield
    vessel_store._by_mmsi.clear()
    vessel_store._grid.clear()


@pytest.fixture
def api(client):
    """The test client, with auth neutralised.

    These endpoints are cheap keyless reads, which the middleware serves open
    on an unconfigured box — but conftest sets ALLOW_UNAUTHENTICATED with
    `setdefault`, so a developer's real .env can turn auth back on and make
    these assertions fail for a reason that has nothing to do with the route.
    Pin it for the duration so the tests test the ROUTE, not the deployment.
    """
    from app.config import get_settings

    s = get_settings()
    prev = s.allow_unauthenticated
    object.__setattr__(s, "allow_unauthenticated", True)
    try:
        yield client
    finally:
        object.__setattr__(s, "allow_unauthenticated", prev)


def _seed():
    now = time.time()
    vessel_store.merge(
        [
            Fix(mmsi=111111111, lat=1.2, lon=103.8, t=now, source="test", name="ONE"),
            Fix(mmsi=222222222, lat=1.3, lon=103.9, t=now, source="test", name="TWO"),
            # Far away — must not appear in the Singapore bbox.
            Fix(mmsi=333333333, lat=25.0, lon=56.0, t=now, source="test", name="HORMUZ"),
        ]
    )


def test_coverage_endpoint_returns_dense_grid(api):
    _seed()
    r = api.get("/api/maritime/coverage?max_age_s=3600")
    assert r.status_code == 200
    d = r.json()
    assert d["rows"] == 36 and d["cols"] == 72
    assert d["fresh"] == 3
    # The grid is a dense list-of-lists a client can render directly.
    assert isinstance(d["cells"], list) and len(d["cells"]) == 36
    assert all(len(row) == 72 for row in d["cells"])


def test_coverage_geojson_emits_occupied_cells_only(api):
    _seed()
    plain = api.get("/api/maritime/coverage").json()
    fc = api.get("/api/maritime/coverage?format=geojson").json()
    assert fc["type"] == "FeatureCollection"
    # Singapore holds two of the three seeds, Hormuz one: two cells, not 2592.
    assert len(fc["features"]) == plain["occupiedCells"] == 2
    by_count = {f["properties"]["count"]: f for f in fc["features"]}
    sg = by_count[2]
    assert sg["geometry"]["type"] == "Polygon"
    ring = sg["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1] and len(ring) == 5
    assert ring[0] == [100.0, 0.0] and ring[2] == [105.0, 5.0]
    assert sg["properties"]["kind"] == "coverage" and sg["properties"]["bucket"] == 0
    # The bucket rides in the id so a shade change arrives as a new entity.
    assert sg["id"].startswith("aiscov:") and sg["id"].endswith(":0")
    assert "—" not in sg["properties"]["name"]
    assert api.get("/api/maritime/coverage?format=xml").status_code == 422


def test_coverage_bucket_follows_the_count():
    from app.routes.ais_pipeline import coverage_geojson

    cells = [[0] * 72 for _ in range(36)]
    cells[18][36], cells[18][37], cells[18][38], cells[0][0] = 9, 10, 1282, 150
    fc = coverage_geojson({"gridDeg": 5, "cells": cells})
    got = {f["properties"]["count"]: f for f in fc["features"]}
    assert [got[n]["properties"]["bucket"] for n in (9, 10, 150, 1282)] == [0, 1, 2, 3]
    # A polar cell keeps four distinct corners.
    assert got[150]["geometry"]["coordinates"][0][0] == [-180.0, -89.5]


def test_vessels_bbox_filters(client):
    _seed()
    r = client.get("/api/maritime/vessels?bbox=103.6,1.0,104.2,1.4")
    assert r.status_code == 200
    d = r.json()
    assert d["count"] == 2
    assert {v["mmsi"] for v in d["vessels"]} == {111111111, 222222222}
    assert d["truncated"] is False


def test_vessels_serialises_name_and_age(client):
    _seed()
    d = client.get("/api/maritime/vessels?bbox=103.6,1.0,104.2,1.4").json()
    row = next(v for v in d["vessels"] if v["mmsi"] == 111111111)
    assert row["name"] == "ONE"
    assert row["id"] == "vessel:111111111"
    assert 0 <= row["ageS"] < 60


def test_vessels_rejects_malformed_bbox(client):
    assert client.get("/api/maritime/vessels?bbox=abc").status_code == 400
    assert client.get("/api/maritime/vessels?bbox=1,2,3").status_code == 400


def test_vessels_respects_limit_and_flags_truncation(client):
    _seed()
    d = client.get("/api/maritime/vessels?bbox=103.6,1.0,104.2,1.4&limit=1").json()
    assert d["count"] == 2
    assert d["returned"] == 1
    assert d["truncated"] is True


def test_pipeline_stats_reports_coverage_honestly(client):
    _seed()
    r = client.get("/api/maritime/pipeline/stats")
    assert r.status_code == 200
    d = r.json()
    assert d["store"]["vessels"] == 3
    # The note must not claim global coverage.
    note = d["coverageNote"].lower()
    assert "coastal" in note
    assert "sar" in note


def test_dark_endpoint_rejects_malformed_bbox(client):
    assert client.get("/api/maritime/dark?bbox=nope").status_code == 400
