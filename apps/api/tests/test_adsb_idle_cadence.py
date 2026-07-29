"""The snapshot cycle relaxes when nothing is reading it.

The 1.0 s cadence is a guarded operator decision (CLAUDE.md, "Cadence /
backend") and it is UNCHANGED whenever anything is watching. What changed on
2026-07-27 is what happens when nothing is: measured at ~17k contacts one cycle
costs 200-410 ms wall, of which 56-84 ms is loop-blocking CPU, so an unattended
backend was paying a permanent 20-40 % tax to rebuild a payload no one had
asked for — and that was the floor under the event-loop lag tail.

Any read re-arms the fast cadence immediately, and the reader is still answered
from the sticky snapshot, so nobody ever waits for a cycle.
"""

from __future__ import annotations

import pytest

from app.routes import adsb as adsb_routes


@pytest.fixture(autouse=True)
def _reset() -> None:
    adsb_routes._LAST_DEMAND_AT = 0.0
    adsb_routes._WS_SUBSCRIBERS.clear()
    yield
    adsb_routes._LAST_DEMAND_AT = 0.0
    adsb_routes._WS_SUBSCRIBERS.clear()


def test_idle_with_no_reader_relaxes_the_cycle() -> None:
    assert adsb_routes._target_cycle_s() == adsb_routes._IDLE_CYCLE_S


def test_a_read_re_arms_the_guarded_one_second_cadence() -> None:
    adsb_routes.note_demand()
    assert adsb_routes._target_cycle_s() == adsb_routes._SNAPSHOT_TARGET_CYCLE_S
    assert adsb_routes._SNAPSHOT_TARGET_CYCLE_S == 1.0, (
        "the 1 s cadence is a guarded decision; this test exists to keep the "
        "idle path from quietly becoming the normal path"
    )


def test_demand_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    adsb_routes.note_demand()
    armed = adsb_routes._LAST_DEMAND_AT
    monkeypatch.setattr(
        adsb_routes.time, "monotonic", lambda: armed + adsb_routes._IDLE_AFTER_S + 1
    )
    assert adsb_routes._target_cycle_s() == adsb_routes._IDLE_CYCLE_S


def test_a_ws_subscriber_alone_holds_the_fast_cadence() -> None:
    adsb_routes._WS_SUBSCRIBERS.add(object())  # type: ignore[arg-type]
    assert adsb_routes._target_cycle_s() == adsb_routes._SNAPSHOT_TARGET_CYCLE_S


def test_idle_cycle_stays_inside_the_staleness_gate() -> None:
    """A relaxed cycle must never let the snapshot trip _SNAPSHOT_STALE_S, which
    is what makes a low-count snapshot get accepted unconditionally."""
    assert adsb_routes._IDLE_CYCLE_S * 2 < adsb_routes._SNAPSHOT_STALE_S
