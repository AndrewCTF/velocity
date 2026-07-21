"""GET /api/markets/* — thin passthrough router over ``app.markets``
(worldmonitor-gaps wave, task B1e). ``app.markets`` internals are owned by a
concurrent wave; these tests only prove the route wiring passes the module
fn's return value straight through untouched."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app import markets


def test_snapshot_passthrough(client: TestClient, monkeypatch: Any) -> None:
    payload = {"indices": [{"symbol": "^spx", "last": 5000.0}], "unavailable": False}

    async def fake_snapshot() -> dict[str, Any]:
        return payload

    monkeypatch.setattr(markets, "snapshot", fake_snapshot)
    r = client.get("/api/markets/snapshot")
    assert r.status_code == 200, r.text
    assert r.json() == payload


def test_predictions_passthrough(client: TestClient, monkeypatch: Any) -> None:
    payload = {"items": [{"title": "Will X happen?", "probability": 0.42}], "unavailable": False}

    async def fake_predictions() -> dict[str, Any]:
        return payload

    monkeypatch.setattr(markets, "predictions", fake_predictions)
    r = client.get("/api/markets/predictions")
    assert r.status_code == 200, r.text
    assert r.json() == payload


def test_stress_passthrough(client: TestClient, monkeypatch: Any) -> None:
    payload = {"score": 0.31, "components": {}, "degraded": False}

    async def fake_market_stress() -> dict[str, Any]:
        return payload

    monkeypatch.setattr(markets, "market_stress", fake_market_stress)
    r = client.get("/api/markets/stress")
    assert r.status_code == 200, r.text
    assert r.json() == payload
