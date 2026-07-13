"""geoBoundaries admin-boundary resolver — containment, mappings, batch route.

Strike/attack events shade the REAL admin polygon (district/region) containing
them, not an uncertainty circle. This exercises the pure-python point-in-
polygon core, the FIPS 10-4 → ISO3 and country-name → ISO3 mappings the event
feeds depend on, and the batch POST /api/geo/event-shapes route. No live
network: the resolver's network load is monkeypatched.
"""

from __future__ import annotations

import asyncio

import pytest

from app.geo import adminshapes
from app.routes import geo_shapes

# ── point-in-polygon core ────────────────────────────────────────────────────
# A 1×1 square around the origin with a hole punched in its centre.

_SQUARE_WITH_HOLE = {
    "type": "Polygon",
    "coordinates": [
        [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]],  # exterior
        [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4], [-0.4, -0.4]],  # hole
    ],
}

_TWO_POLYS = {
    "type": "MultiPolygon",
    "coordinates": [
        [[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]],
        [[[-10, -10], [-5, -10], [-5, -5], [-10, -5], [-10, -10]]],
    ],
}


def test_ring_contains_inside_and_outside():
    ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    assert adminshapes._ring_contains(ring, 5, 5) is True
    assert adminshapes._ring_contains(ring, 15, 5) is False


def test_polygon_contains_hole_exclusion():
    # Inside the exterior but in the hole → not contained.
    assert adminshapes._polygon_contains(_SQUARE_WITH_HOLE["coordinates"], 0, 0) is False
    # In the ring between exterior and hole → contained.
    assert adminshapes._polygon_contains(_SQUARE_WITH_HOLE["coordinates"], 0.7, 0.7) is True
    # Outside entirely.
    assert adminshapes._polygon_contains(_SQUARE_WITH_HOLE["coordinates"], 5, 5) is False


def test_geometry_contains_multipolygon():
    assert adminshapes._geometry_contains(_TWO_POLYS, 15, 15) is True
    assert adminshapes._geometry_contains(_TWO_POLYS, -7, -7) is True
    assert adminshapes._geometry_contains(_TWO_POLYS, 0, 0) is False


def test_geometry_bbox():
    bbox = adminshapes._geometry_bbox(_SQUARE_WITH_HOLE)
    assert bbox == (-1.0, -1.0, 1.0, 1.0)


# ── resolve (network load monkeypatched) ─────────────────────────────────────


def _feat(geom, name="UnitTest", shape_id="ID1"):
    return {"type": "Feature", "geometry": geom, "properties": {"shapeName": name, "shapeID": shape_id}}


@pytest.fixture(autouse=True)
def _clear_indexes(monkeypatch, tmp_path):
    # Reset the module-level in-memory indexes + point the disk cache at a tmp
    # dir so tests can't bleed cached state into each other.
    monkeypatch.setattr(adminshapes, "_INDEX", {})
    monkeypatch.setattr(adminshapes, "_INDEX_LOADED_AT", {})
    monkeypatch.setattr(adminshapes, "_MISS_UNTIL", {})
    monkeypatch.setattr(adminshapes, "_LOCKS", {})
    monkeypatch.setattr(adminshapes, "_CACHE_DIR", tmp_path)


def test_resolve_finds_containing_unit(monkeypatch):
    fc = {"type": "FeatureCollection", "features": [_feat(_SQUARE_WITH_HOLE, name="Center", shape_id="A")]}

    async def fake_download(*a, **k):
        return fc

    monkeypatch.setattr(adminshapes, "_download", fake_download)
    out = asyncio.run(adminshapes.resolve("ZZZ", 0.7, 0.7, "adm2"))
    assert out is not None and out["name"] == "Center" and out["level"] == "adm2"
    assert out["iso3"] == "ZZZ" and out["geometry"] is _SQUARE_WITH_HOLE


def test_resolve_misses_point_in_hole(monkeypatch):
    fc = {"type": "FeatureCollection", "features": [_feat(_SQUARE_WITH_HOLE)]}

    async def fake_download(*a, **k):
        return fc

    monkeypatch.setattr(adminshapes, "_download", fake_download)
    assert asyncio.run(adminshapes.resolve("ZZZ", 0, 0, "adm2")) is None


def test_resolve_adm2_falls_back_to_adm1(monkeypatch):
    calls: list[str] = []

    async def fake_download(iso3, level):
        calls.append(level)
        if level.upper() == "ADM2":
            return {"type": "FeatureCollection", "features": []}  # no ADM2 data
        return {"type": "FeatureCollection", "features": [_feat(_SQUARE_WITH_HOLE, name="Prov")]}

    monkeypatch.setattr(adminshapes, "_download", fake_download)
    out = asyncio.run(adminshapes.resolve("ZZZ", 0.7, 0.7, "adm2"))
    # _load passes the lowercase level; _download uppercases internally.
    called = {c.upper() for c in calls}
    assert out is not None and out["level"] == "adm1" and {"ADM2", "ADM1"} <= called


def test_resolve_rejects_bad_inputs(monkeypatch):
    monkeypatch.setattr(adminshapes, "_download", lambda *a: {})
    assert asyncio.run(adminshapes.resolve("ZZ", 0, 0, "adm2")) is None   # iso3 too short
    assert asyncio.run(adminshapes.resolve("ZZZZ", 0, 0, "adm2")) is None  # iso3 too long
    assert asyncio.run(adminshapes.resolve("ZZZ", 0, 0, "adm9")) is None   # bad level


def test_resolve_returns_none_on_upstream_failure(monkeypatch):
    # The real _download swallows upstream faults and returns None; the resolver
    # must degrade to a miss (None), never raise. Simulate that failure path.
    async def empty(*a, **k):
        return None

    monkeypatch.setattr(adminshapes, "_download", empty)
    assert asyncio.run(adminshapes.resolve("ZZZ", 0.7, 0.7, "adm2")) is None


# ── FIPS 10-4 → ISO3 (the GDELT collisions) ──────────────────────────────────


@pytest.mark.parametrize(
    ("fips", "iso3"),
    [
        ("UP", "UKR"), ("IZ", "IRQ"), ("GM", "DEU"), ("IS", "ISR"),
        ("IC", "ISL"), ("JA", "JPN"), ("KS", "KOR"), ("KN", "PRK"),
        ("SP", "ESP"), ("SW", "SWE"), ("SZ", "CHE"), ("EI", "IRL"),
        ("UK", "GBR"), ("AS", "AUS"), ("CH", "CHN"), ("RS", "RUS"),
        ("IR", "IRN"), ("SY", "SYR"), ("US", "USA"), ("EZ", "CZE"),
    ],
)
def test_fips_to_iso3_divergent_pairs(fips, iso3):
    assert adminshapes.fips_to_iso3(fips) == iso3


def test_fips_unknown_returns_none():
    assert adminshapes.fips_to_iso3("ZZ") is None
    assert adminshapes.fips_to_iso3(None) is None


# ── country name → ISO3 (UCDP / ACLED ship names) ────────────────────────────


@pytest.mark.parametrize(
    ("name", "iso3"),
    [
        ("Russia (Soviet Union)", "RUS"),
        ("DR Congo (Zaire)", "COD"),
        ("Myanmar (Burma)", "MMR"),
        ("United States", "USA"),
        ("Iran", "IRN"),
        ("North Korea", "PRK"),
        ("South Korea", "KOR"),
        ("Bosnia-Herzegovina", "BIH"),
        ("Czech Republic", "CZE"),
        # Plain ISO official name still resolves via the bundled iso table.
        ("Germany", "DEU"),
        ("France", "FRA"),
    ],
)
def test_country_name_to_iso3(name, iso3):
    assert adminshapes.country_name_to_iso3(name) == iso3


def test_country_name_unknown_returns_none():
    assert adminshapes.country_name_to_iso3("Atlantis") is None
    assert adminshapes.country_name_to_iso3("") is None


# ── POST /api/geo/event-shapes batch route ───────────────────────────────────


def _override_resolve(monkeypatch, table):
    async def fake_resolve(iso3, lon, lat, level):
        # Match on the rounded key so tests read like the real join.
        k = f"{iso3}|{level}|{lat:.3f}|{lon:.3f}"
        return table.get(k)

    monkeypatch.setattr(adminshapes, "resolve", fake_resolve)


def test_route_dedupes_shape_across_queries(client, monkeypatch):
    # Two queries land in the same (rounded) unit → ONE shape with both keys.
    _override_resolve(
        monkeypatch,
        {
            "UKR|adm2|48.600|38.000": {
                "id": "A", "name": "Bakhmut", "level": "adm2", "iso3": "UKR",
                "geometry": _SQUARE_WITH_HOLE,
            }
        },
    )
    r = client.post(
        "/api/geo/event-shapes",
        json={"queries": [
            {"lat": 48.6, "lon": 38.0, "level": "adm2", "iso3": "UKR"},
            {"lat": 48.6004, "lon": 38.0003, "level": "adm2", "iso3": "UKR"},  # rounds same
        ]},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["shapes"]) == 1
    assert body["shapes"][0]["name"] == "Bakhmut"
    # Both queries round to the same key → one shape, that key listed once.
    assert body["shapes"][0]["keys"] == ["UKR|adm2|48.600|38.000"]
    assert body["misses"] == []


def test_route_reports_misses_and_never_500s(client, monkeypatch):
    _override_resolve(monkeypatch, {})
    r = client.post("/api/geo/event-shapes", json={"queries": [
        {"lat": 0.0, "lon": 0.0, "level": "adm1", "iso3": "ZZZ"},
    ]})
    assert r.status_code == 200
    body = r.json()
    assert body["shapes"] == []
    assert body["misses"] == ["ZZZ|adm1|0.000|0.000"]


def test_route_rejects_over_cap(client):
    queries = [{"lat": float(i % 80), "lon": 0.0, "level": "adm1", "iso3": "ZZZ"} for i in range(geo_shapes._MAX_QUERIES + 1)]
    r = client.post("/api/geo/event-shapes", json={"queries": queries})
    assert r.status_code == 422


def test_route_rejects_bad_level(client):
    r = client.post("/api/geo/event-shapes", json={"queries": [
        {"lat": 0.0, "lon": 0.0, "level": "adm9", "iso3": "ZZZ"},
    ]})
    assert r.status_code == 422


def test_route_key_rounds_to_3_decimals(client, monkeypatch):
    captured = {}
    async def fake_resolve(iso3, lon, lat, level):
        captured["key"] = f"{iso3.upper()}|{level}|{lat:.3f}|{lon:.3f}"
        return None
    monkeypatch.setattr(adminshapes, "resolve", fake_resolve)
    client.post("/api/geo/event-shapes", json={"queries": [
        {"lat": 48.60004, "lon": 38.00009, "level": "adm2", "iso3": "ukr"},
    ]})
    # iso3 uppercased, lat/lon rounded to 3 dp — matches the frontend's shapeKey().
    assert captured["key"] == "UKR|adm2|48.600|38.000"
