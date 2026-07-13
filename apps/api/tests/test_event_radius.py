"""Location-precision → uncertainty-radius props on conflict/strike events.

Upstreams ship a precision code with every event (UCDP ``where_prec``, ACLED
``geo_precision``, GDELT ``ActionGeo_Type``); the loaders must carry it plus a
``radius_m`` so the frontend can draw an uncertainty area instead of a bare
pin. ``radius_m`` is NEVER fabricated: absent or too-coarse precision → None.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.config import Settings, get_settings
from app.intel import conflict, ucdp
from app.routes import events
from app.upstream import cache


@pytest.fixture(autouse=True)
def _clear_cache():
    # Invalidate on BOTH sides: earlier suite tests may have cached these keys
    # (e.g. an events test populating acled:7), which would shadow the
    # monkeypatched upstreams below.
    keys = (f"conflict:ucdp:{ucdp.DEFAULT_VERSION}", "conflict:gdelt:1", "acled:7")
    for k in keys:
        cache.invalidate(k)
    yield
    for k in keys:
        cache.invalidate(k)


# ---------------------------------------------------------------- mappings


@pytest.mark.parametrize(
    ("prec", "radius"),
    [
        (1, 2000.0),
        (2, 25000.0),
        (3, 40000.0),
        (4, 90000.0),
        (5, 100000.0),
        (6, None),  # country-level — too coarse for an area
        (7, None),  # international waters/estimate
        ("3", 40000.0),  # UCDP API ships strings
        (None, None),
        ("", None),
        ("garbage", None),
    ],
)
def test_ucdp_where_prec_radius(prec, radius):
    assert ucdp.radius_for_where_prec(prec) == radius


@pytest.mark.parametrize(
    ("prec", "radius"),
    [
        (1, 3000.0),
        (2, 25000.0),
        (3, 75000.0),
        (4, None),  # unmapped code — no radius fabricated
        ("2", 25000.0),
        (None, None),
        ("", None),
        ("garbage", None),
    ],
)
def test_acled_geo_precision_radius(prec, radius):
    assert events.radius_for_geo_precision(prec) == radius


@pytest.mark.parametrize(
    ("geo_type", "radius"),
    [
        (3, 8000.0),  # US city
        (4, 8000.0),  # world city
        (2, 60000.0),  # US state
        (5, 60000.0),  # world state
        (1, None),  # country-level — too coarse
        (None, None),
    ],
)
def test_gdelt_geo_type_radius(geo_type, radius):
    assert conflict.radius_for_geo_type(geo_type) == radius


def test_gdelt_parse_geo_type_defensive():
    row = [""] * 61
    row[conflict._C_GEOTYPE] = "4"
    assert conflict.parse_geo_type(row) == 4
    row[conflict._C_GEOTYPE] = "garbage"
    assert conflict.parse_geo_type(row) is None
    assert conflict.parse_geo_type(["short", "row"]) is None


# ------------------------------------------------------------ loader paths


def test_ucdp_features_carry_precision_and_radius(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "ucdp_token", "test-token", raising=False)
    rows = [
        {
            "id": 601, "latitude": "33.3", "longitude": "44.4",
            "side_a": "A", "side_b": "B", "type_of_violence": 1,
            "where_prec": 2,
        },
        {
            "id": 602, "latitude": "34.0", "longitude": "45.0",
            "side_a": "A", "side_b": "B", "type_of_violence": 1,
            "where_prec": 6,  # country-level → no area
        },
        {
            "id": 603, "latitude": "35.0", "longitude": "46.0",
            "side_a": "A", "side_b": "B", "type_of_violence": 1,
            # where_prec missing entirely
        },
    ]

    async def fake_get(self, url, **kwargs):
        return httpx.Response(200, json={"Result": rows}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    r = client.get("/api/conflict/ucdp")
    assert r.status_code == 200
    props = {f["properties"]["id"]: f["properties"] for f in r.json()["features"]}
    assert props["601"]["where_prec"] == 2 and props["601"]["radius_m"] == 25000.0
    assert props["602"]["where_prec"] == 6 and props["602"]["radius_m"] is None
    assert props["603"]["where_prec"] is None and props["603"]["radius_m"] is None


def _gdelt_row(eid: str, geo_type: str) -> list[str]:
    c = [""] * 61
    c[conflict._C_ID] = eid
    c[conflict._C_DAY] = "20260712"
    c[conflict._C_A1], c[conflict._C_A2] = "RUSSIA", "UKRAINE"
    c[conflict._C_CODE], c[conflict._C_ROOT] = "195", "19"
    c[conflict._C_MENT] = "12"
    c[conflict._C_GEOTYPE] = geo_type
    c[conflict._C_LAT], c[conflict._C_LON] = "48.5", "35.1"
    c[conflict._C_URL] = "http://example.com/a"
    return c


def test_gdelt_features_carry_geo_type_and_radius(monkeypatch):
    async def fake_latest() -> str:
        return "20260712000000"

    rows = [_gdelt_row("9001", "4"), _gdelt_row("9002", "1"), _gdelt_row("9003", "")]

    async def fake_slice(ts: str) -> list[list[str]]:
        return rows if ts == "20260712000000" else []

    monkeypatch.setattr(conflict, "_latest_ts", fake_latest)
    monkeypatch.setattr(conflict, "_fetch_slice", fake_slice)
    out = asyncio.run(conflict.conflict_events(hours=1))
    props = {f["properties"]["id"]: f["properties"] for f in out["features"]}
    assert props["9001"]["geo_type"] == 4 and props["9001"]["radius_m"] == 8000.0
    assert props["9002"]["geo_type"] == 1 and props["9002"]["radius_m"] is None
    assert props["9003"]["geo_type"] is None and props["9003"]["radius_m"] is None


def test_acled_features_carry_precision_and_radius(monkeypatch):
    # The /api/events/acled route resolves Settings via Depends(get_settings),
    # which conftest's client fixture overrides with unconfigured test settings
    # — so exercise the loader directly with a keyed Settings (same path the
    # route and the /all aggregate call).
    s = Settings(acled_key="k", acled_email="e@example.com", commercial_mode=False)
    data = [
        {
            "event_id_cnty": "IRQ1", "latitude": "33.3", "longitude": "44.4",
            "event_type": "Battles", "geo_precision": "1",
        },
        {
            "event_id_cnty": "IRQ2", "latitude": "34.0", "longitude": "45.0",
            "event_type": "Battles", "geo_precision": 3,
        },
        {
            "event_id_cnty": "IRQ3", "latitude": "35.0", "longitude": "46.0",
            "event_type": "Battles",  # geo_precision missing
        },
    ]

    async def fake_get(self, url, **kwargs):
        return httpx.Response(200, json={"data": data}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    out = asyncio.run(events._load_acled(s, days=7))
    feats = {f["id"]: f["properties"] for f in out["features"]}
    assert feats["acled:IRQ1"]["geo_precision"] == 1
    assert feats["acled:IRQ1"]["radius_m"] == 3000.0
    assert feats["acled:IRQ2"]["geo_precision"] == 3
    assert feats["acled:IRQ2"]["radius_m"] == 75000.0
    assert feats["acled:IRQ3"]["geo_precision"] is None
    assert feats["acled:IRQ3"]["radius_m"] is None
