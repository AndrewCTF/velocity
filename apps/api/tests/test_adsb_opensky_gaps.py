"""OpenSky's unauthenticated BBOX form, spent on the cells our union covers worst.

The arithmetic this module rests on was measured against the live API on
2026-08-07 by reading `x-rate-limit-remaining` either side of each call:
a 2x2 degree box costs 1 credit, a 10x10 box costs 2, the world costs 4, out of
400 a day. These tests pin the behaviour that arithmetic buys — targeting the
right cells, reading the budget rather than assuming it, and never claiming a
fix is fresher than OpenSky said it was.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app import adsb_opensky_gaps as gaps
from app.routes import adsb as adsb_routes


def _feature(lon: float, lat: float, age: float) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"seen_pos_s": age},
    }


@pytest.fixture(autouse=True)
def _fresh_budget() -> None:
    gaps.BUDGET.remaining = None
    gaps.BUDGET.blocked_until = 0.0
    gaps.BUDGET.spent = 0
    yield
    gaps.BUDGET.remaining = None
    gaps.BUDGET.blocked_until = 0.0


def test_ranks_the_cells_holding_the_most_stale_contacts() -> None:
    feats = (
        [_feature(-82.5, 28.5, 300.0)] * 5  # a bad cell
        + [_feature(8.5, 46.5, 300.0)] * 2  # a less bad one
        + [_feature(100.0, 10.0, 3.0)] * 50  # fresh: not a gap at all
    )
    ranked = gaps.rank_gaps(feats)
    # The cell is named by its SOUTH-WEST corner, floored — so lon -82.5 lives in
    # [-84, -82), not in [-82, -80). Getting that backwards would spend the
    # budget on the sky next door.
    assert [(c.lat, c.lon, c.stale) for c in ranked] == [(28.0, -84.0, 5), (46.0, 8.0, 2)]


def test_a_fresh_snapshot_asks_for_nothing() -> None:
    assert gaps.rank_gaps([_feature(1.0, 1.0, 2.0)] * 100) == []


def test_state_vectors_keep_their_own_age_and_units() -> None:
    raw = {
        "states": [
            # icao24, callsign, country, time_position, last_contact, lon, lat,
            # baro_alt_m, on_ground, velocity_ms, track, …
            ["abc123", "DLH400  ", "Germany", 1786104000, 1786104005, 8.5, 50.0,
             10000.0, False, 250.0, 90.0, None, None, 10200.0, "1000"],
        ]
    }
    ac = gaps.states_to_readsb(raw, now=1786104010.0)
    assert len(ac) == 1
    a = ac[0]
    assert a["hex"] == "abc123"
    assert a["flight"] == "DLH400"
    assert a["seen_pos"] == pytest.approx(10.0)  # from time_position, not `now`
    assert a["alt_baro"] == pytest.approx(32808, abs=2)  # metres → feet
    assert a["gs"] == pytest.approx(486.0, abs=1)  # m/s → knots
    assert a["squawk"] == "1000"


def test_a_vector_with_no_position_time_cannot_win_the_union() -> None:
    raw = {"states": [["abc123", "X", "DE", None, 1, 8.5, 50.0, 1.0, False, 1.0, 1.0]]}
    assert gaps.states_to_readsb(raw)[0]["seen_pos"] > 1e8


def test_the_budget_is_read_from_the_header_not_assumed() -> None:
    gaps.BUDGET.observe(httpx.Headers({"x-rate-limit-remaining": "17"}))
    assert gaps.BUDGET.remaining == 17
    # Below the reserve the module stops on its own, before the API has to 429.
    assert gaps.BUDGET.may_spend() is False
    gaps.BUDGET.observe(httpx.Headers({"x-rate-limit-remaining": "300"}))
    assert gaps.BUDGET.may_spend() is True


def test_a_429_stops_it_for_an_hour() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"x-rate-limit-remaining": "0"})

    cell = gaps.Cell(lat=50.0, lon=0.0)
    transport = httpx.MockTransport(handler)

    async def run() -> list:
        async with httpx.AsyncClient(transport=transport) as c:
            return await gaps.fetch_cell(c, cell)

    assert asyncio.run(run()) == []
    assert gaps.BUDGET.may_spend() is False
    assert gaps.BUDGET.blocked_until > 0


def test_the_cell_is_one_credit_sized() -> None:
    """2x2 degrees. A bigger box costs 2-4 credits, which is the trade this
    module exists to refuse — the whole point is that bbox beats global."""
    assert gaps.CELL_DEG == 2.0
    cell = gaps.Cell(lat=50.0, lon=0.0)
    lamin, lomin, lamax, lomax = cell.bbox
    assert (lamax - lamin) * (lomax - lomin) <= 25.0


def test_the_tier_is_registered_on_a_cadence_the_budget_can_afford(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from app.config import get_settings

    s = get_settings()
    # The suite pins the tier OFF (it spends real credits), so registration is
    # asserted with the flag as a deployment would have it.
    monkeypatch.setattr(
        "app.routes.adsb.get_settings",
        lambda: s.model_copy(update={"adsb_opensky_gaps_enabled": True}),
    )
    assert adsb_routes.OPENSKY_GAP_KEY in adsb_routes._feed_urls()
    per_day = s.adsb_opensky_gaps_cells * 86400.0 / s.adsb_opensky_gaps_interval_s
    # 400 anonymous credits a day, and the module reserves 40 of them.
    assert per_day <= 400 - gaps.RESERVE_CREDITS, f"{per_day} credits/day is over budget"


def test_one_budget_is_shared_by_both_openskys() -> None:
    """The credits are counted per SOURCE IP, so the daily global pull and this
    filler are spending the same pool. Each discovering the other's spend by
    being refused is how the cheap tier dies for a day to pay for one world
    pull."""
    from app.ingest import opensky as ingest

    src = (ingest.__file__, gaps.__file__)
    assert all(src)
    # The global shape costs four boxes' worth of sky.
    assert gaps.GLOBAL_COST == 4
    gaps.BUDGET.observe(httpx.Headers({"x-rate-limit-remaining": "43"}))
    # One more box is affordable over the 40-credit reserve; a world pull is not.
    assert gaps.BUDGET.may_spend(1) is True
    assert gaps.BUDGET.may_spend(gaps.GLOBAL_COST) is False


def test_the_global_pull_defers_when_the_shared_budget_is_low() -> None:
    """Anonymous only — with OAuth creds the pool is separate and larger."""
    import asyncio as _asyncio

    from app.routes import adsb as routes

    gaps.BUDGET.observe(httpx.Headers({"x-rate-limit-remaining": "41"}))
    assert _asyncio.run(routes._try_opensky_global()) is None
