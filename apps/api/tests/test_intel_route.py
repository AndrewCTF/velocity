"""Tests for the intel layer (/api/intel/*) and its classification helpers.

Network-free: the global ADS-B snapshot is patched (same pattern as
test_jamming_route) and the AOI dedicated fetch is stubbed so /area exercises
the snapshot-fallback path deterministically.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import upstream
from app.intel import aoi
from app.intel.geo import (
    aircraft_category,
    bbox_from_radius,
    haversine_km,
    is_military_callsign,
    vessel_category,
)


@pytest.fixture(autouse=True)
def _reset_state() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()
    aoi._AOIS.clear()


# A small Baltic-region fake snapshot covering the cases we classify on.
def _ac(
    lon: float,
    lat: float,
    *,
    icao: str,
    callsign: str | None = None,
    category: str | None = None,
    squawk: str | None = None,
    nac_p: int | None = 9,
    nic: int | None = 8,
    alt_m: float | None = 10000.0,
    on_ground: bool = False,
) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": f"aircraft:{icao}",
        "geometry": {"type": "Point", "coordinates": [lon, lat, alt_m or 0]},
        "properties": {
            "icao24": icao,
            "callsign": callsign,
            "category": category,
            "type": "B738",
            "squawk": squawk,
            "nac_p": nac_p,
            "nic": nic,
            "geo_alt_m": alt_m,
            "baro_alt_m": alt_m,
            "velocity_ms": 220.0,
            "track_deg": 90,
            "on_ground": on_ground,
            "source": "adsb",
        },
    }


def _fake_snapshot() -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [
            # Baltic cluster (lon 18-22, lat 54-58)
            _ac(20.0, 55.0, icao="aaa111", callsign="SAS123", category="A5"),
            _ac(20.2, 55.2, icao="bbb222", callsign="RCH401", category="A5"),  # military callsign
            _ac(20.4, 55.4, icao="ccc333", squawk="7700", category="A3"),       # emergency
            _ac(20.6, 55.6, icao="ddd444", category="A3", nac_p=2, nic=1),       # GNSS degraded
            _ac(20.6, 55.6, icao="eee555", category="A7"),                       # helicopter
            # Far away (Pacific) — must be excluded by Baltic bbox queries
            _ac(-150.0, 10.0, icao="fff666", callsign="UAL900", category="A5"),
        ],
    }


def _patch_snapshot():
    async def fake_global() -> dict[str, Any]:
        return _fake_snapshot()

    from app.routes import adsb as adsb_routes

    # Patch the plain snapshot helper — the single seam every internal consumer
    # (intel, jamming, analytics, the route handler) now reads through.
    return patch.object(adsb_routes, "global_snapshot", new=fake_global)


# ── classification helpers ────────────────────────────────────────────────────


def test_aircraft_category_priority() -> None:
    assert aircraft_category({"squawk": "7700"}) == "emergency"
    assert aircraft_category({"callsign": "RCH401", "category": "A5"}) == "military"
    assert aircraft_category({"source": "adsb_mil"}) == "military"
    assert aircraft_category({"category": "A7"}) == "helicopter"
    assert aircraft_category({"category": "A6"}) == "helicopter"
    assert aircraft_category({"category": "B1"}) == "glider"
    assert aircraft_category({"category": "A1"}) == "private"
    assert aircraft_category({"category": "A5"}) == "airliner"
    assert aircraft_category({}) == "airliner"  # uncategorised → airliner


def test_is_military_callsign() -> None:
    assert is_military_callsign("RCH401")
    assert is_military_callsign("REACH02")
    assert not is_military_callsign("RYR123")  # Ryanair, not military
    assert not is_military_callsign(None)


def test_vessel_category_itu_buckets() -> None:
    assert vessel_category(30) == "fishing"
    assert vessel_category(35) == "military"
    assert vessel_category(36) == "sailing"
    assert vessel_category(37) == "pleasure"
    assert vessel_category(70) == "cargo"
    assert vessel_category(85) == "tanker"
    assert vessel_category(65) == "passenger"
    assert vessel_category(None) == "other"


def test_bbox_from_radius_and_haversine() -> None:
    b = bbox_from_radius(55.0, 20.0, 200.0)
    assert b.contains(20.0, 55.0)
    assert not b.contains(40.0, 55.0)
    d = haversine_km(0.0, 0.0, 0.0, 1.0)
    assert 110.0 < d < 112.0  # 1° latitude ≈ 111 km


# ── routes ─────────────────────────────────────────────────────────────────────


def test_situation(client: TestClient) -> None:
    with _patch_snapshot():
        r = client.get("/api/intel/situation")
    assert r.status_code == 200
    b = r.json()
    assert b["aircraft"]["total"] == 6
    assert b["aircraft"]["by_category"]["emergency"] == 1
    assert b["aircraft"]["by_category"]["military"] == 1
    assert b["aircraft"]["by_category"]["helicopter"] == 1
    assert b["aircraft"]["gnss_degraded"] == 1
    assert len(b["aircraft"]["emergencies"]) == 1
    assert "gps_jamming" in b and "vessels" in b


def test_density_bbox_scopes_region(client: TestClient) -> None:
    with _patch_snapshot():
        r = client.get(
            "/api/intel/density",
            params={"min_lon": 18, "min_lat": 54, "max_lon": 22, "max_lat": 58, "cell_deg": 1.0},
        )
    assert r.status_code == 200
    b = r.json()
    # 5 Baltic aircraft in-box, Pacific one excluded.
    assert b["aircraft"]["total"] == 5
    assert b["aircraft"]["peak_cell"]["count"] >= 1


def test_density_center_radius(client: TestClient) -> None:
    with _patch_snapshot():
        r = client.get("/api/intel/density", params={"lat": 55.3, "lon": 20.3, "radius_nm": 200})
    assert r.status_code == 200
    assert r.json()["aircraft"]["total"] >= 1


def test_jamming_reports_degraded_cell(client: TestClient) -> None:
    with _patch_snapshot():
        r = client.get("/api/intel/jamming")
    assert r.status_code == 200
    b = r.json()
    assert b["summary"]["cells_flagged"] >= 1
    assert any(c["bad"] >= 1 for c in b["cells"])


def test_query_aircraft_filters(client: TestClient) -> None:
    with _patch_snapshot():
        r = client.get("/api/intel/aircraft", params={"category": "military"})
        b = r.json()
        assert b["matched_total"] == 1
        assert b["aircraft"][0]["callsign"] == "RCH401"

        r2 = client.get("/api/intel/aircraft", params={"emergency": True})
        assert r2.json()["matched_total"] == 1

        r3 = client.get("/api/intel/aircraft", params={"gnss_degraded": True})
        assert r3.json()["matched_total"] == 1


def test_lookup_aircraft(client: TestClient) -> None:
    with _patch_snapshot():
        r = client.get("/api/intel/aircraft/ccc333")
    b = r.json()
    assert b["found"] is True
    assert b["aircraft"]["category"] == "emergency"
    assert "EMERGENCY" in b["assessment"]


def test_lookup_aircraft_not_found(client: TestClient) -> None:
    with _patch_snapshot():
        r = client.get("/api/intel/aircraft/zzz999")
    assert r.json()["found"] is False


def test_vessels_empty_ok(client: TestClient) -> None:
    r = client.get("/api/intel/vessels", params={"lat": 55, "lon": 20, "radius_nm": 300})
    assert r.status_code == 200
    assert "vessels" in r.json()


def test_anomalies_flags_emergency(client: TestClient) -> None:
    with _patch_snapshot():
        r = client.get(
            "/api/intel/anomalies",
            params={"min_lon": 18, "min_lat": 54, "max_lon": 22, "max_lat": 58},
        )
    b = r.json()
    assert b["threat_level"] in ("low", "elevated", "high")
    assert len(b["emergency_aircraft"]) == 1


def test_area_loads_primary_snapshot_fallback(client: TestClient) -> None:
    # Stub the dedicated fetch → None forces the snapshot-subset fallback,
    # so /area resolves purely from the patched global snapshot (no network).
    async def no_direct(*_a: Any, **_k: Any) -> None:
        return None

    with _patch_snapshot(), patch.object(aoi, "_direct_point", new=no_direct):
        r = client.get("/api/intel/area", params={"lat": 55.3, "lon": 20.3, "radius_nm": 200})
    assert r.status_code == 200
    b = r.json()
    assert b["loaded_primary"] is True
    assert b["load_mode"] == "snapshot"
    assert b["aircraft"]["count"] >= 1
    assert "density" in b and "gps_jamming" in b and "anomalies" in b
    # AOI registered as primary
    assert b["aoi"]["last_count"] >= 1


def test_area_direct_fetch_mode(client: TestClient) -> None:
    async def fake_direct(lat: float, lon: float, radius_nm: int) -> dict[str, Any]:
        feats = _fake_snapshot()["features"][:2]
        return {"type": "FeatureCollection", "features": feats, "_host": "test"}

    with _patch_snapshot(), patch.object(aoi, "_direct_point", new=fake_direct):
        r = client.get("/api/intel/area", params={"lat": 55.3, "lon": 20.3, "radius_nm": 150})
    b = r.json()
    assert b["load_mode"] == "direct"
    assert b["upstream_host"] == "test"


def test_aois_listing(client: TestClient) -> None:
    async def no_direct(*_a: Any, **_k: Any) -> None:
        return None

    params = {"lat": 55, "lon": 20, "radius_nm": 100, "label": "Baltic"}
    with _patch_snapshot(), patch.object(aoi, "_direct_point", new=no_direct):
        client.get("/api/intel/area", params=params)
        r = client.get("/api/intel/aois")
    b = r.json()
    assert len(b["aois"]) == 1
    assert b["aois"][0]["label"] == "Baltic"


def test_sources(client: TestClient) -> None:
    r = client.get("/api/intel/sources")
    b = r.json()
    assert "always_on" in b and "key_gated" in b
    assert "ollama" in b


# ── robustness / edge cases ────────────────────────────────────────────────────


def _patch_empty():
    async def empty() -> dict[str, Any]:
        return {"type": "FeatureCollection", "features": []}

    from app.routes import adsb as adsb_routes

    return patch.object(adsb_routes, "global_snapshot", new=empty)


def test_empty_snapshot_no_crash(client: TestClient) -> None:
    with _patch_empty():
        assert client.get("/api/intel/situation").json()["aircraft"]["total"] == 0
        assert client.get("/api/intel/jamming").json()["summary"]["cells_flagged"] == 0
        d = client.get("/api/intel/density", params={"lat": 0, "lon": 0, "radius_nm": 100}).json()
        assert d["aircraft"]["total"] == 0 and d["aircraft"]["peak_cell"] is None
        assert client.get("/api/intel/anomalies").json()["threat_level"] == "low"


def test_invalid_bbox_min_ge_max_422(client: TestClient) -> None:
    r = client.get(
        "/api/intel/density",
        params={"min_lon": 10, "min_lat": 50, "max_lon": 5, "max_lat": 55},
    )
    assert r.status_code == 422


def test_radius_out_of_range_422(client: TestClient) -> None:
    # /area caps radius_nm at 250 (the /v2/point upstream ceiling).
    r = client.get("/api/intel/area", params={"lat": 50, "lon": 8, "radius_nm": 9999})
    assert r.status_code == 422


def test_lat_out_of_range_422(client: TestClient) -> None:
    r = client.get("/api/intel/area", params={"lat": 200, "lon": 8})
    assert r.status_code == 422


def test_antimeridian_bbox_no_crash(client: TestClient) -> None:
    # A bbox near +180 is truncated (not wrapped) but must never crash.
    with _patch_snapshot():
        r = client.get(
            "/api/intel/density",
            params={"min_lon": 170, "min_lat": -10, "max_lon": 180, "max_lat": 10},
        )
    assert r.status_code == 200
    assert "aircraft" in r.json()


def test_query_limit_capped(client: TestClient) -> None:
    # limit above the hard cap (200) must 422 at the route boundary.
    with _patch_snapshot():
        assert client.get("/api/intel/aircraft", params={"limit": 5000}).status_code == 422


def test_narrative_cache_is_bounded() -> None:
    # A stream of distinct entity ids must not grow the dossier-narrative cache
    # without limit (it had no eviction). _narrative_cache_put caps it.
    from app.routes import intel

    intel._NARRATIVE_CACHE.clear()
    try:
        far_future = 10.0**12  # nothing expires during the test
        for i in range(intel._NARRATIVE_CACHE_MAX + 50):
            intel._narrative_cache_put(f"vessel:{i}", far_future, {"ok": True})
        assert len(intel._NARRATIVE_CACHE) <= intel._NARRATIVE_CACHE_MAX
    finally:
        intel._NARRATIVE_CACHE.clear()


def test_dossier_narrative_bounds_a_stalled_model(monkeypatch) -> None:
    # A stalled reason-tier backend must not pin the worker past the edge budget:
    # the route wraps the LLM call in asyncio.wait_for and degrades to "model
    # unavailable" on timeout. Shrink the budget so the test is fast.
    import asyncio

    from app.routes import intel

    monkeypatch.setattr(intel, "_NARRATIVE_LLM_BUDGET_S", 0.05)

    async def _hang(*_a: object, **_k: object) -> object:
        await asyncio.sleep(5)  # longer than the budget → wait_for fires
        return {}, None

    async def _doss(_bare: str) -> dict:
        return {"track": [], "id": "x"}

    monkeypatch.setattr(intel.llm, "chat_json", _hang)
    monkeypatch.setattr(intel.dossier, "vessel_dossier", _doss)
    intel._NARRATIVE_CACHE.clear()

    out = asyncio.run(intel.intel_dossier_narrative(entity_id="vessel:1"))
    assert out["ok"] is False and out["error"] == "model unavailable"
