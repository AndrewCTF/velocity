"""Guards for /api/country/* (World Bank + UNSD proxies, keyless)."""

from __future__ import annotations

import httpx

from app.routes import country_stats


def test_country_list_and_manifest(client):
    r = client.get("/api/country/list")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) >= 240
    usa = next(c for c in rows if c["iso3"] == "USA")
    assert usa["m49"] == "840" and usa["iso2"] == "US"

    m = client.get("/api/country/indicators").json()
    assert any(i["id"] == "NY.GDP.MKTP.CD" for i in m["worldbank"])
    assert any(s["id"] == "SI_POV_DAY1" for s in m["un"])


def test_unknown_iso3_404(client):
    assert client.get("/api/country/XXX/worldbank").status_code == 404


def test_worldbank_series_shape(client, monkeypatch):
    wb_body = [
        {"page": 1},
        [
            {"indicator": {"id": "SP.POP.TOTL", "value": "Population, total"},
             "date": "2024", "value": 340000000},
            {"indicator": {"id": "SP.POP.TOTL", "value": "Population, total"},
             "date": "2023", "value": 339000000},
        ],
    ]

    async def fake_get(self, url, **kwargs):
        return httpx.Response(200, json=wb_body, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    r = client.get("/api/country/USA/worldbank", params={"indicators": "SP.POP.TOTL"})
    assert r.status_code == 200
    body = r.json()
    assert body["iso3"] == "USA" and body["source"] == "worldbank-api-v2"
    (ind,) = body["indicators"]
    assert ind["id"] == "SP.POP.TOTL"
    assert ind["series"] == [
        {"year": "2023", "value": 339000000},
        {"year": "2024", "value": 340000000},
    ]


def test_un_series_shape(client, monkeypatch):
    un_body = {"data": [
        {"timePeriodStart": 2020, "value": "1.2"},
        {"timePeriodStart": 2018, "value": "1.5"},
    ]}

    async def fake_get(self, url, **kwargs):
        assert kwargs["params"]["areaCode"] == "840"
        return httpx.Response(200, json=un_body, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    r = client.get("/api/country/USA/un", params={"series": "SI_POV_DAY1"})
    assert r.status_code == 200
    (s,) = r.json()["series"]
    assert s["id"] == "SI_POV_DAY1"
    assert [p["year"] for p in s["series"]] == [2018, 2020]


def test_malformed_indicator_rejected(client):
    assert (
        client.get("/api/country/USA/worldbank", params={"indicators": "evil;drop"}).status_code
        == 400
    )
    assert client.get("/api/country/USA/un", params={"series": "bad;code"}).status_code == 400


def test_upstream_failure_degrades_per_series(client, monkeypatch):
    async def fake_get(self, url, **kwargs):
        raise httpx.ConnectError("boom")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    from app.upstream import cache

    cache.invalidate("wb:FRA:SP.POP.TOTL:15")
    r = client.get("/api/country/FRA/worldbank", params={"indicators": "SP.POP.TOTL"})
    assert r.status_code == 200
    (ind,) = r.json()["indicators"]
    assert ind["unavailable"] is True and ind["series"] == []


def test_manifest_ids_wellformed():
    for i in country_stats.WB_INDICATORS:
        assert all(c.isalnum() or c == "." for c in i["id"])
    for s in country_stats.UN_SERIES:
        assert all(c.isalnum() or c == "_" for c in s["id"])
