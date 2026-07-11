"""Guards for /api/conflict/ucdp (token-gated, honest degrade, actor props)."""

from __future__ import annotations

import httpx
import pytest

from app.config import get_settings
from app.intel import ucdp
from app.upstream import cache


@pytest.fixture(autouse=True)
def _clear_cache():
    yield
    # get_or_fetch keys persist between tests otherwise.
    cache.invalidate(f"conflict:ucdp:{ucdp.DEFAULT_VERSION}")


def test_no_token_degrades_empty(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "ucdp_token", "", raising=False)
    r = client.get("/api/conflict/ucdp")
    assert r.status_code == 200
    body = r.json()
    assert body["features"] == [] and body["unavailable"] is True
    assert "token" in body["note"]


def test_actor_props_and_geojson_shape(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "ucdp_token", "test-token", raising=False)

    rows = [
        {
            "id": 501, "latitude": "33.3", "longitude": "44.4",
            "side_a": "Government of Iraq", "side_b": "IS",
            "dyad_name": "Government of Iraq - IS", "type_of_violence": 1,
            "best": 4, "low": 4, "high": 7, "date_start": "2026-06-01",
            "country": "Iraq", "where_description": "Mosul",
        }
    ]

    async def fake_get(self, url, **kwargs):
        assert kwargs["headers"]["x-ucdp-access-token"] == "test-token"
        return httpx.Response(200, json={"Result": rows}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    r = client.get("/api/conflict/ucdp")
    assert r.status_code == 200
    feats = r.json()["features"]
    assert len(feats) == 1
    f = feats[0]
    assert f["id"] == "conflict_ucdp:501"
    p = f["properties"]
    assert p["side_a"] == "Government of Iraq" and p["side_b"] == "IS"
    assert p["type_of_violence"] == "state-based conflict"
    assert p["deaths_best"] == 4
    assert "vs" in p["label"]


def test_upstream_error_degrades(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "ucdp_token", "test-token", raising=False)

    async def fake_get(self, url, **kwargs):
        return httpx.Response(403, text="nope", request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    r = client.get("/api/conflict/ucdp")
    assert r.status_code == 200
    body = r.json()
    assert body["features"] == [] and body["unavailable"] is True


def test_version_param_validated(client):
    assert client.get("/api/conflict/ucdp", params={"version": "evil;str"}).status_code == 422
