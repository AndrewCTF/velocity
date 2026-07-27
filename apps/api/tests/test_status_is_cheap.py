"""`/api/status` is public, unauthenticated and polled — it must stay cheap.

It used to call `global_snapshot()` for nothing but an aircraft count and
`len(store.latest("vessel"))` for a vessel count. That took `_SNAPSHOT_LOCK`
(held by the 1 Hz refresher across its merge), shallow-copied the snapshot, and
materialised a list of every live vessel — 57 089 entries measured 2026-07-27.
The route read p50 12.5 ms with a 757 ms tail against 0.8 ms for
`/api/status/perf`. On a cold process it would also have kicked a synchronous
fan-out from an anonymous request; the lifespan already warms the snapshot
(`start_snapshot()`), so no request needs to.

These assert the counts are still EXACT — the cheap path must not become an
approximate one — and that the expensive helpers are no longer on the route.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.correlate.store import ObservationStore
from app.correlate.types import Observation
from app.routes import adsb as adsb_routes
from app.routes import status as status_routes


def _obs(i: int, kind: str = "vessel", t: float | None = None) -> Observation:
    return Observation(
        id=f"{kind}:{i}",
        source="test",
        t=time.time() if t is None else t,
        lon=float(i % 180),
        lat=float(i % 80),
        emits_kind=kind,  # type: ignore[arg-type]
        attrs={},
    )


def test_count_matches_latest_exactly() -> None:
    """The cheap count must equal the list length it replaced, per kind."""
    s = ObservationStore()
    s.add_many([_obs(i, "vessel") for i in range(500)])
    s.add_many([_obs(i, "aircraft") for i in range(37)])
    assert s.count("vessel") == len(s.latest("vessel")) == 500
    assert s.count("aircraft") == len(s.latest("aircraft")) == 37
    assert s.count() == len(s.latest()) == 537


def test_count_applies_the_same_retention_filter() -> None:
    """A fix outside the retention window must not be counted, exactly as
    `latest()` excludes it — otherwise the status page would over-report."""
    s = ObservationStore()
    s.add_many([_obs(i, "vessel") for i in range(10)])
    s.add_many([_obs(100 + i, "vessel", t=time.time() - 10_000_000) for i in range(5)])
    assert s.count("vessel") == len(s.latest("vessel")) == 10


def test_snapshot_count_is_lock_free_and_exact(monkeypatch: pytest.MonkeyPatch) -> None:
    """Equal to what the locked `global_snapshot()` path returned, and readable
    while the refresher holds the lock — which is the point."""
    fc = {"type": "FeatureCollection", "features": [{"id": f"aircraft:{i}"} for i in range(123)]}
    monkeypatch.setattr(adsb_routes, "_LATEST_SNAPSHOT", fc)
    assert adsb_routes.snapshot_count() == 123

    async def _boom() -> dict[str, object]:  # pragma: no cover — must not be called
        raise AssertionError("status must not call global_snapshot()")

    monkeypatch.setattr(adsb_routes, "global_snapshot", _boom)
    assert adsb_routes.snapshot_count() == 123


def test_status_route_does_not_touch_the_expensive_helpers(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The regression this guards is someone reaching for the convenient helper
    again. Both raise if called."""
    called: list[str] = []

    async def _no_snapshot() -> dict[str, object]:
        called.append("global_snapshot")
        return {"type": "FeatureCollection", "features": []}

    monkeypatch.setattr(adsb_routes, "global_snapshot", _no_snapshot)

    from app.correlate.store import store

    real_latest = store.latest

    def _no_latest(kind: str | None = None) -> list[Observation]:
        called.append("latest")
        return real_latest(kind)

    monkeypatch.setattr(store, "latest", _no_latest)

    r = client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert "aircraft_count" in body and "vessel_count" in body
    assert called == [], f"/api/status called expensive helpers: {called}"


def test_status_perf_stays_free_of_the_snapshot_walk(client: TestClient) -> None:
    """`/api/status/perf` is sampled once a second by the harnesses; it reports
    module state and must never grow a snapshot or store walk."""
    src = status_routes.__file__
    assert src
    body = open(src, encoding="utf-8").read()
    perf = body[body.index("async def status_perf") :]
    assert "global_snapshot" not in perf
    assert 'store.latest' not in perf
