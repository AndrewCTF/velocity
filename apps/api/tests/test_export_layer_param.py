"""Regression test: /api/export?layer= overrides ?kinds= (B4 fix).

Prior to the fix, `layer` was an unknown param and was silently dropped,
so `?layer=vessels` always returned aircraft (the kinds default).
"""

from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.routes import adsb as adsb_routes


async def _fake_aircraft_snapshot() -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "aircraft:abc123",
                "geometry": {"type": "Point", "coordinates": [10.0, 50.0]},
                "properties": {"icao24": "abc123", "callsign": "DLH1"},
            }
        ],
    }


async def _fake_vessel_snapshot() -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "vessel:123456789",
                "geometry": {"type": "Point", "coordinates": [25.0, 60.0]},
                "properties": {"mmsi": "123456789", "name": "MV TEST"},
            }
        ],
    }


def test_layer_param_selects_vessels(client: TestClient) -> None:
    """?layer=vessels must return vessels, not aircraft (the default)."""
    from app.routes import maritime as maritime_routes

    with (
        patch.object(adsb_routes, "global_snapshot", new=_fake_aircraft_snapshot),
        patch.object(maritime_routes, "digitraffic_snapshot", new=_fake_vessel_snapshot),
    ):
        r = client.get("/api/export?layer=vessels")
    assert r.status_code == 200
    feats = r.json()["features"]
    kinds = {f["properties"]["kind"] for f in feats}
    assert kinds == {"vessel"}, f"expected only vessels, got {kinds}"


def test_layer_param_wins_over_kinds(client: TestClient) -> None:
    """When both ?layer= and ?kinds= are present, layer wins."""
    from app.routes import maritime as maritime_routes

    with (
        patch.object(adsb_routes, "global_snapshot", new=_fake_aircraft_snapshot),
        patch.object(maritime_routes, "digitraffic_snapshot", new=_fake_vessel_snapshot),
    ):
        # kinds says aircraft, layer says vessels — layer should win
        r = client.get("/api/export?layer=vessels&kinds=aircraft")
    assert r.status_code == 200
    feats = r.json()["features"]
    kinds = {f["properties"]["kind"] for f in feats}
    assert kinds == {"vessel"}, f"layer should override kinds; got {kinds}"


def test_layer_aircraft_explicit(client: TestClient) -> None:
    """?layer=aircraft returns only aircraft."""
    with patch.object(adsb_routes, "global_snapshot", new=_fake_aircraft_snapshot):
        r = client.get("/api/export?layer=aircraft")
    assert r.status_code == 200
    feats = r.json()["features"]
    assert len(feats) == 1
    assert feats[0]["properties"]["kind"] == "aircraft"
