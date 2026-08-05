"""Corroboration: the one sanctioned use of a claim, and its guardrails."""

from __future__ import annotations

import datetime as dt

import pytest
from fastapi import HTTPException

from app.routes import corroborate as cb


def test_haversine_is_a_real_distance() -> None:
    assert cb.haversine_km(0, 0, 0, 0) == 0
    # Kyiv to Lviv, ~470 km.
    d = cb.haversine_km(30.52, 50.45, 24.03, 49.84)
    assert 450 < d < 490


def test_a_day_stamp_becomes_an_epoch_and_a_bad_one_does_not() -> None:
    assert cb._event_epoch({"day": "20260805"}) is not None
    for bad in ({"day": "2026080"}, {"day": "notaday"}, {}, {"day": "20261345"}):
        assert cb._event_epoch(bad) is None


def _fc(features: list[dict[str, object]]) -> dict[str, object]:
    return {"type": "FeatureCollection", "features": features}


def _event(lon: float, lat: float, day: str = "20260805") -> dict[str, object]:
    return {
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"day": day, "actor1": "A", "actor2": "B", "event": "x", "mentions": 1},
    }


@pytest.mark.asyncio
async def test_only_reports_inside_the_radius_are_returned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake(hours: int = 6) -> dict[str, object]:
        return _fc([_event(30.52, 50.43), _event(24.03, 49.84)])  # Kyiv, Lviv

    monkeypatch.setattr(cb, "conflict_events", fake)
    out = await cb.corroborate(lon=30.52, lat=50.45, at=None, radius_km=60, hours=24, limit=20)
    assert out["count"] == 1
    assert out["considered"] == 2
    assert out["nearby"][0]["distance_km"] < 5


@pytest.mark.asyncio
async def test_no_claim_nearby_is_a_result_not_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake(hours: int = 6) -> dict[str, object]:
        return _fc([_event(30.52, 50.43)])

    monkeypatch.setattr(cb, "conflict_events", fake)
    out = await cb.corroborate(lon=-150, lat=0, at=None, radius_km=60, hours=24, limit=20)
    assert out["count"] == 0
    assert out["considered"] == 1
    assert out["earliest_lag_s"] is None


@pytest.mark.asyncio
async def test_a_dead_claim_feed_is_an_error_not_an_empty_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # "Nobody said anything" and "we could not ask" are different, and the second
    # one dressed as the first is how an absence of evidence becomes evidence of
    # absence.
    async def fake(hours: int = 6) -> dict[str, object]:
        return {"type": "FeatureCollection", "features": [], "unavailable": True}

    monkeypatch.setattr(cb, "conflict_events", fake)
    with pytest.raises(HTTPException) as exc:
        await cb.corroborate(lon=0, lat=0, at=None, radius_km=50, hours=24, limit=20)
    assert exc.value.status_code == 502


@pytest.mark.asyncio
async def test_lag_is_signed_so_a_claim_before_the_observation_reads_negative(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The direction is the entire analytical value. A report that predates the
    # observation is a different kind of evidence from one that follows it.
    async def fake(hours: int = 6) -> dict[str, object]:
        return _fc([_event(30.52, 50.43, day="20260801")])

    monkeypatch.setattr(cb, "conflict_events", fake)
    later = dt.datetime(2026, 8, 5, tzinfo=dt.UTC).timestamp()
    out = await cb.corroborate(lon=30.52, lat=50.43, at=later, radius_km=60, hours=24, limit=20)
    assert out["nearby"][0]["lag_s"] < 0


@pytest.mark.asyncio
async def test_the_response_never_claims_the_report_is_about_the_observation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake(hours: int = 6) -> dict[str, object]:
        return _fc([_event(30.52, 50.43)])

    monkeypatch.setattr(cb, "conflict_events", fake)
    out = await cb.corroborate(lon=30.52, lat=50.43, at=None, radius_km=60, hours=24, limit=20)
    assert "nearby" in out and "matching" not in out
    assert out["tier"] == "claim"
    assert "Proximity is not aboutness" in out["note"]
