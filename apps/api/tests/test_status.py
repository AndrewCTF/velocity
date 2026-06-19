"""Public /api/status: live counts, feed health, honest coverage note."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.routes import status as status_mod


def _patch_snapshot(monkeypatch: pytest.MonkeyPatch, n: int, age: float | None) -> None:
    async def fake_snap() -> dict:
        return {"type": "FeatureCollection", "features": [{} for _ in range(n)]}

    monkeypatch.setattr(status_mod.adsb_routes, "global_snapshot", fake_snap)
    monkeypatch.setattr(status_mod.adsb_routes, "snapshot_age_s", lambda: age)


def test_status_operational(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_snapshot(monkeypatch, 9000, 3.0)
    r = client.get("/api/status")
    assert r.status_code == 200
    d = r.json()
    assert d["aircraft_count"] == 9000
    assert d["status"] == "operational"
    assert any(f["name"].startswith("ADS-B") for f in d["feeds"])
    # coverage honesty is part of the contract
    assert "absence" in d["note"].lower()


def test_status_degraded_when_thin(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_snapshot(monkeypatch, 12, None)
    d = client.get("/api/status").json()
    assert d["status"] == "degraded"
    adsb_feed = next(f for f in d["feeds"] if f["name"].startswith("ADS-B"))
    assert adsb_feed["status"] == "degraded"


def test_status_never_500s_on_snapshot_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom() -> dict:
        raise RuntimeError("snapshot down")

    monkeypatch.setattr(status_mod.adsb_routes, "global_snapshot", boom)
    monkeypatch.setattr(status_mod.adsb_routes, "snapshot_age_s", lambda: None)
    r = client.get("/api/status")
    assert r.status_code == 200
    assert r.json()["status"] == "down"
