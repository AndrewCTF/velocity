"""`/api/status` is public, unauthenticated and polled — it must stay cheap.

It used to call `global_snapshot()` for nothing but an aircraft count and
`len(store.latest("vessel"))` for a vessel count. That took `_SNAPSHOT_LOCK`
(held by the 1 Hz refresher across its merge), shallow-copied the snapshot, and
materialised a list of every live vessel — 57 089 entries measured 2026-07-27.
On a cold process it would also have kicked a synchronous fan-out from an
anonymous request; the lifespan already warms the snapshot (`start_snapshot()`),
so no request needs to.

Measured p50 12.5 ms -> 10.1 ms over equal 30 s windows. The route's
multi-second tail is NOT from this and did not change: sampled over the same
window, `/api/health` (a literal dict, no state) shows MAX 2470 ms against
status's 2272 ms, so the tail is the event loop being blocked by the snapshot
cycle, paid equally by every request.

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


async def test_snapshot_count_equals_the_original_locked_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cheap read must return EXACTLY what `global_snapshot()` would.

    This is the direct comparison, both paths against the same state, because
    two different HTTP endpoints cannot prove it: `/api/adsb/global` serves
    `_HOT_BLOB`, which is built AFTER `_LATEST_SNAPSHOT` is rebound, so those two
    are legitimately one build apart and a delta between them says nothing about
    whether this read is exact.
    """
    monkeypatch.setattr(adsb_routes, "_SNAPSHOT_STARTED", True)
    for n in (0, 1, 123, 20_000):
        fc = {
            "type": "FeatureCollection",
            "features": [{"id": f"aircraft:{i}"} for i in range(n)],
        }
        monkeypatch.setattr(adsb_routes, "_LATEST_SNAPSHOT", fc)
        via_lock = await adsb_routes.global_snapshot()
        assert adsb_routes.snapshot_count() == len(via_lock.get("features") or []) == n


def test_snapshot_count_takes_no_lock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Readable while the refresher HOLDS the lock — which is the whole point:
    the old path made a public anonymous request wait on the event loop's lock
    (757 ms tail, measured 2026-07-27)."""
    fc = {"type": "FeatureCollection", "features": [{"id": f"aircraft:{i}"} for i in range(77)]}
    monkeypatch.setattr(adsb_routes, "_LATEST_SNAPSHOT", fc)

    # Hold the snapshot lock for the duration of the read.
    assert not adsb_routes._SNAPSHOT_LOCK.locked()
    import asyncio

    async def _hold_and_read() -> int:
        async with adsb_routes._SNAPSHOT_LOCK:
            assert adsb_routes._SNAPSHOT_LOCK.locked()
            # Would deadlock (or block) if this acquired the lock.
            return await asyncio.wait_for(
                asyncio.to_thread(adsb_routes.snapshot_count), timeout=2.0
            )

    assert asyncio.run(_hold_and_read()) == 77


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
    module state and must never grow a snapshot or store walk.

    Scoped to the status_perf FUNCTION. This previously sliced from status_perf
    to end-of-file, which held only because status_perf happened to be last: the
    next cold diagnostic route appended to the module failed a guard about a
    route it is not. The protection for status_perf is unchanged and now says
    what it means, so it cannot be satisfied by moving code above the slice
    either.
    """
    src = status_routes.__file__
    assert src
    body = open(src, encoding="utf-8").read()
    start = body.index("async def status_perf")
    # End at the next route decorator, or EOF when status_perf really is last.
    nxt = body.find("@router.get(", start)
    perf = body[start:] if nxt == -1 else body[start:nxt]
    assert "async def status_perf" in perf and len(perf) > 200, "slice lost the function body"
    assert "global_snapshot" not in perf
    assert "store.latest" not in perf
