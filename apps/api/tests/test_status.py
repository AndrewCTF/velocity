"""Public /api/status: live counts, feed health, honest coverage note."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.routes import status as status_mod


def _patch_snapshot(
    monkeypatch: pytest.MonkeyPatch, n: int, age: float | None, vessels: int = 50
) -> None:
    async def fake_snap() -> dict:
        return {"type": "FeatureCollection", "features": [{} for _ in range(n)]}

    async def fake_vessels() -> dict:
        return {"type": "FeatureCollection", "features": [{} for _ in range(vessels)]}

    from app.routes import maritime

    monkeypatch.setattr(status_mod.adsb_routes, "global_snapshot", fake_snap)
    monkeypatch.setattr(status_mod.adsb_routes, "snapshot_age_s", lambda: age)
    monkeypatch.setattr(maritime, "digitraffic_snapshot", fake_vessels)


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


def _ais_feed(client: TestClient) -> dict:
    return next(f for f in client.get("/api/status").json()["feeds"] if "keyless" in f["name"])


def test_status_ais_does_not_undersell_global_coverage(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The keyless AIS feed is worldwide and must not claim otherwise.

    It described a global union as "Northern Europe only (Norway + Baltic)" for
    ten days after ShipXplorer + MyShipTracking landed (2026-07-05) — while
    serving 56k vessels, ~46k of them from exactly those two global sources.
    """
    _patch_snapshot(monkeypatch, 9000, 3.0)
    detail = _ais_feed(client)["detail"]
    assert "Northern Europe only" not in detail
    assert "worldwide" in detail


def test_status_ais_reports_a_stale_sidecar_instead_of_staying_green(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Green while a wedged feeder replays a 27-minute-old union is the bug.

    2026-07-15: /api/status read green + "58012 vessels" while 21944 of them were
    frozen positions from a sidecar that had lost the site 27 minutes earlier.
    """
    _patch_snapshot(monkeypatch, 9000, 3.0)
    from app import ais_keyless

    monkeypatch.setattr(
        ais_keyless,
        "stats",
        lambda: {
            "shipxplorer_enabled": True,
            "myshiptracking_sidecar_enabled": True,
            "myshiptracking_vessels": 0,
            "myshiptracking_stale_s": 1631,
        },
    )
    feed = _ais_feed(client)
    assert feed["status"] == "degraded"
    assert "1631s-old" in feed["detail"]


def test_status_ais_does_not_name_a_source_that_is_reporting_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_snapshot(monkeypatch, 9000, 3.0)
    from app import ais_keyless

    monkeypatch.setattr(
        ais_keyless,
        "stats",
        lambda: {
            "shipxplorer_enabled": True,
            "myshiptracking_sidecar_enabled": True,
            "myshiptracking_vessels": 0,
            "myshiptracking_stale_s": 0,
        },
    )
    detail = _ais_feed(client)["detail"]
    assert "MyShipTracking is not reporting" in detail
    assert "deduped across ShipXplorer plus" in detail  # not "...and MyShipTracking plus"


def test_status_never_500s_on_snapshot_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom() -> dict:
        raise RuntimeError("snapshot down")

    from app.routes import maritime

    monkeypatch.setattr(status_mod.adsb_routes, "global_snapshot", boom)
    monkeypatch.setattr(status_mod.adsb_routes, "snapshot_age_s", lambda: None)
    monkeypatch.setattr(maritime, "digitraffic_snapshot", boom)
    r = client.get("/api/status")
    assert r.status_code == 200
    assert r.json()["status"] == "down"
