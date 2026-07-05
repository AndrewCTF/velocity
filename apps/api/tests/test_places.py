"""Airport/port reference data: loader ranking, bbox GeoJSON, and the
/api/search merge that stops airport/port CODES getting buried under fuzzy
vessel-name substring matches.

Pure-logic tests hit app.places directly (no network); the route tests use the
shared TestClient fixture (conftest sets OSINT_DISABLE_BACKGROUND so no upstream
HTTP fires).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import places
from app.routes.search import _split_place_hits

# ── loader + ranking ─────────────────────────────────────────────────────────


def test_lax_iata_resolves_first() -> None:
    hits = places.search_places("LAX")
    assert hits, "LAX resolved nothing"
    top = hits[0]
    assert top["kind"] == "airport"
    assert top["iata"] == "LAX"
    assert abs(top["lat"] - 33.94) < 0.05, top


def test_egll_icao_resolves_first() -> None:
    hits = places.search_places("EGLL")
    assert hits
    assert hits[0]["icao"] == "EGLL", hits[0]
    assert hits[0]["kind"] == "airport"


def test_rotterdam_returns_a_port() -> None:
    hits = places.search_places("Rotterdam")
    ports = [h for h in hits if h["kind"] == "port"]
    assert ports, f"no port in {hits!r}"
    assert "Rotterdam" in ports[0]["label"]


def test_search_places_empty_query() -> None:
    assert places.search_places("") == []
    assert places.search_places("   ") == []


# ── bbox GeoJSON ─────────────────────────────────────────────────────────────


def test_bbox_ports_rotterdam_is_valid_geojson() -> None:
    fc = places.bbox_features("port", 4.0, 51.0, 5.0, 52.0, 2000)
    assert fc["type"] == "FeatureCollection"
    feats = fc["features"]
    assert len(feats) >= 1, "expected >=1 port near Rotterdam"
    f = feats[0]
    assert f["type"] == "Feature"
    assert f["geometry"]["type"] == "Point"
    lon, lat = f["geometry"]["coordinates"]
    assert 4.0 <= lon <= 5.0 and 51.0 <= lat <= 52.0
    assert f["properties"]["kind"] == "port"
    assert f["properties"]["name"]


def test_bbox_airports_props_and_large_only() -> None:
    # Box around LAX (lon -118.4, lat 33.94).
    fc = places.bbox_features("airport", -119.0, 33.0, -118.0, 34.0, 2000)
    codes = {f["properties"]["iata"] for f in fc["features"]}
    assert "LAX" in codes
    f = next(f for f in fc["features"] if f["properties"]["iata"] == "LAX")
    assert f["properties"]["kind"] == "airport"
    assert f["properties"]["atype"] == "large"
    assert f["properties"]["icao"] == "KLAX"

    # large_only drops medium airports.
    fc_large = places.bbox_features("airport", -119.0, 33.0, -118.0, 34.0, 2000, large_only=True)
    assert all(f["properties"]["atype"] == "large" for f in fc_large["features"])
    assert len(fc_large["features"]) <= len(fc["features"])


def test_bbox_airport_limit_keeps_large_before_medium() -> None:
    # A whole-world box overflows any small limit; large must survive the cap.
    fc = places.bbox_features("airport", -180.0, -90.0, 180.0, 90.0, 50)
    assert len(fc["features"]) == 50
    types = [f["properties"]["atype"] for f in fc["features"]]
    # Once a medium appears, no large may follow (stable large-before-medium).
    if "medium" in types:
        first_medium = types.index("medium")
        assert "large" not in types[first_medium:]


# ── split classifier used by the /api/search merge ───────────────────────────


def test_split_place_hits_code_is_exact() -> None:
    exact, fuzzy = _split_place_hits("LAX", places.search_places("LAX"))
    assert any(h["iata"] == "LAX" for h in exact), (exact, fuzzy)
    assert not any(h["iata"] == "LAX" for h in fuzzy)


# ── /api/search merge (route) ────────────────────────────────────────────────


def test_search_surfaces_airport_for_code(client: TestClient) -> None:
    r = client.get("/api/search", params={"q": "LAX"})
    assert r.status_code == 200
    results = r.json()["results"]
    assert results, "no search results for LAX"
    # The airport must be present AND rank at the top (exact code beats fuzzy
    # vessel/aircraft substring matches).
    assert results[0]["kind"] == "airport", results[:3]
    assert results[0]["id"] == "airport:LAX", results[0]


def test_search_surfaces_port_for_name(client: TestClient) -> None:
    r = client.get("/api/search", params={"q": "Rotterdam"})
    results = r.json()["results"]
    kinds = [x["kind"] for x in results]
    assert "port" in kinds, results[:3]


def test_places_airports_route_bbox(client: TestClient) -> None:
    r = client.get("/api/places/airports", params={"bbox": "-119,33,-118,34"})
    assert r.status_code == 200
    fc = r.json()
    assert fc["type"] == "FeatureCollection"
    assert any(f["properties"]["iata"] == "LAX" for f in fc["features"])


def test_places_ports_route_bbox(client: TestClient) -> None:
    r = client.get("/api/places/ports", params={"bbox": "4,51,5,52"})
    assert r.status_code == 200
    fc = r.json()
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) >= 1


def test_places_route_missing_bbox_is_empty_fc(client: TestClient) -> None:
    r = client.get("/api/places/airports")
    assert r.status_code == 200
    assert r.json() == {"type": "FeatureCollection", "features": []}
