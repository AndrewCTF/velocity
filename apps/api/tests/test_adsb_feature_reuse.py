"""The snapshot cycle reuses feature objects instead of rebuilding them.

`_aircraft_geojson` was the largest on-loop cost in the cycle: 44 ms per 20 000
aircraft, of which 43 % was allocating four containers per contact (feature,
geometry, coordinates, properties), once a second, forever.

`_merge_raw_into` now derives the union straight from the raw records, deciding
freshest-wins BEFORE building anything, and updates a retained feature object per
id rather than allocating a new one.

`_aircraft_geojson` is untouched and is still the definition — seven per-request
callers use it. These tests are the anti-drift harness: they run the OLD
implementation (reconstructed here from that function plus the previous merge
loop) against the new one over a multi-cycle sequence and require identical
output, so the two cannot diverge silently.

The other half is isolation. Reusing objects is only safe because
`global_snapshot()` hands out an independent copy: `intel/analytics.py` retains
its result across `await`s and re-consumes it (`features=features`, :501→:510,
:613-614), and `intel/incidents.py` does the same (:95→:121). Under a shallow
copy those would compute half an answer from one cycle and half from the next.
"""

from __future__ import annotations

import asyncio
import copy
import random

import pytest

from app.routes import adsb as A

# ── the OLD implementation, kept here as the reference ───────────────────────


def _old_merge_raw_into(by_id: dict, raw: list[dict]) -> None:
    """Verbatim behaviour of the pre-2026-07-27 merge loop."""
    for f in A._aircraft_geojson(raw).get("features") or []:
        fid = f.get("id")
        if fid is None:
            continue
        cur = by_id.get(fid)
        if cur is None:
            by_id[fid] = f
            continue
        new_obs = A._feat_obs_at(f)
        cur_obs = A._feat_obs_at(cur)
        if new_obs is None and cur_obs is None:
            by_id[fid] = f
        elif new_obs is None:
            continue
        elif cur_obs is None or new_obs > cur_obs:
            by_id[fid] = f


# ── record generators covering every branch the filter chain has ─────────────


def _ac(i: int, *, ts: float, moving: bool = True, **over) -> dict:
    a = {
        "hex": f"{i:06x}",
        "lat": (i % 170) - 85 + (0.01 if moving else 0.0),
        "lon": (i % 350) - 175 + (0.01 if moving else 0.0),
        "flight": f"ABC{i % 9999:04d} ",
        "t": "A320",
        "r": f"N{i % 99999}",
        "category": "A3",
        "alt_baro": 30000 + i % 5000,
        "alt_geom": 30100 + i % 5000,
        "gs": 400.0 + (i % 100),
        "track": float(i % 360),
        "squawk": "1200",
        "emergency": "none",
        "nac_p": 9,
        "nic": 8,
        "sil": 3,
        "nac_v": 2,
        "seen": 0.4,
        "seen_pos": 0.9,
        "_seen_at": ts,
    }
    a.update(over)
    return a


def _edge_cases(t: float) -> list[dict]:
    """One of every record the filter chain treats specially."""
    return [
        _ac(9001, ts=t, category="C1"),  # surface vehicle → dropped
        _ac(9002, ts=t, category="", flight="SWEEPER2 "),  # ground infra callsign
        _ac(9003, ts=t, category="", flight="   ", alt_baro="ground", **{"t": ""}),  # ground, no id
        _ac(9004, ts=t, lat=None),  # no position
        _ac(9005, ts=t, hex=""),  # no icao24
        _ac(9006, ts=t, seen_pos=None),  # no seen_pos → obs falls back to seen_at
        {k: v for k, v in _ac(9007, ts=t).items() if k != "_seen_at"},  # unstamped
        _ac(9008, ts=t, alt_baro="ground", flight="DAL123 "),  # on ground, real flight
        _ac(9009, ts=t, alt_baro=None, alt_geom=None),  # no altitude at all
        _ac(9010, ts=t, gs=None, track=None, squawk=None),  # sparse kinematics
    ]


@pytest.fixture(autouse=True)
def _clean_cache() -> None:
    A._FEATURE_CACHE.clear()
    A._FEATURE_CACHE_SEEN.clear()
    yield
    A._FEATURE_CACHE.clear()
    A._FEATURE_CACHE_SEEN.clear()


def test_identical_output_over_many_cycles() -> None:
    """The whole point: same ids, same values, cycle after cycle."""
    rnd = random.Random(11)
    t = 1_700_000_000.0
    for cycle in range(12):
        t += 1.0
        # A drifting population: some contacts persist, some drop out, some new.
        live = [_ac(i, ts=t) for i in range(60) if rnd.random() > 0.15]
        live += [_ac(500 + cycle, ts=t)]  # a newcomer each cycle
        live += _edge_cases(t)

        new_by_id: dict = {}
        A._merge_raw_into(new_by_id, live)
        old_by_id: dict = {}
        _old_merge_raw_into(old_by_id, live)

        assert sorted(new_by_id) == sorted(old_by_id), f"id set diverged at cycle {cycle}"
        for fid in old_by_id:
            assert new_by_id[fid] == old_by_id[fid], f"{fid} diverged at cycle {cycle}"


def test_identical_under_multi_tier_freshest_wins() -> None:
    """Three tiers merged into ONE by_id, with deliberately mixed freshness.

    This is where the rewrite is most likely to be wrong: it now compares the
    raw record's observation time against the incumbent FEATURE's, and skips
    building entirely when the record loses.
    """
    t = 1_700_000_000.0
    for cycle in range(6):
        t += 1.0
        stale = [_ac(i, ts=t - 30.0, seen_pos=25.0) for i in range(40)]  # cached tier
        fresh = [_ac(i, ts=t, seen_pos=0.2) for i in range(0, 40, 2)]  # half, fresher
        unstamped = [{k: v for k, v in _ac(i, ts=t).items() if k != "_seen_at"} for i in range(0, 40, 3)]

        for order in ([stale, fresh, unstamped], [fresh, stale, unstamped], [unstamped, stale, fresh]):
            A._FEATURE_CACHE.clear()
            A._FEATURE_CACHE_SEEN.clear()
            new_by_id: dict = {}
            for tier in order:
                A._merge_raw_into(new_by_id, tier)
            old_by_id: dict = {}
            for tier in order:
                _old_merge_raw_into(old_by_id, tier)
            assert sorted(new_by_id) == sorted(old_by_id)
            for fid in old_by_id:
                assert new_by_id[fid] == old_by_id[fid], f"{fid} diverged, cycle {cycle}"


def test_reuses_the_same_object_across_cycles() -> None:
    """The actual optimisation — not a new feature dict every cycle."""
    t = 1_700_000_000.0
    by_id: dict = {}
    A._merge_raw_into(by_id, [_ac(1, ts=t)])
    first = by_id["aircraft:000001"]

    by_id2: dict = {}
    A._merge_raw_into(by_id2, [_ac(1, ts=t + 1.0)])
    second = by_id2["aircraft:000001"]

    assert second is first, "the feature object should be retained and updated, not rebuilt"
    # …and it must actually carry the NEW values.
    assert second["properties"]["seen_at"] == t + 1.0


def test_a_dropped_optional_key_does_not_go_stale() -> None:
    """`seen_pos_s`/`seen_at` are conditional. Updating key-by-key would leave a
    stale value behind when a later record omits them; the properties dict is
    replaced wholesale so it cannot."""
    t = 1_700_000_000.0
    by_id: dict = {}
    A._merge_raw_into(by_id, [_ac(2, ts=t, seen_pos=5.0)])
    assert by_id["aircraft:000002"]["properties"]["seen_pos_s"] == 5.0

    A._FEATURE_CACHE_SEEN.clear()  # allow the older record through
    by_id2: dict = {}
    A._merge_raw_into(by_id2, [_ac(2, ts=t + 10.0, seen_pos=None)])
    props = by_id2["aircraft:000002"]["properties"]
    assert "seen_pos_s" not in props, "a key the new record lacks must not survive"


def test_cache_is_pruned() -> None:
    t = 1_700_000_000.0
    by_id: dict = {}
    A._merge_raw_into(by_id, [_ac(i, ts=t) for i in range(20)])
    assert len(A._FEATURE_CACHE) == 20
    # Age every entry past the TTL, then run a cycle with a single contact.
    for k in A._FEATURE_CACHE_SEEN:
        A._FEATURE_CACHE_SEEN[k] -= A._FEATURE_CACHE_TTL_S + 1
    A._merge_raw_into({}, [_ac(0, ts=t + 1)])
    assert len(A._FEATURE_CACHE) == 1, "stale retained features must be evicted"


# ── isolation: the half that makes reuse safe ────────────────────────────────


def test_global_snapshot_is_isolated_from_later_cycles() -> None:
    """A consumer holding the result across an `await` must not see it change.

    `intel/analytics.py` and `intel/incidents.py` both do exactly this.
    """

    async def scenario() -> None:
        t = 1_700_000_000.0
        by_id: dict = {}
        A._merge_raw_into(by_id, [_ac(i, ts=t) for i in range(25)])
        A._LATEST_SNAPSHOT = {"type": "FeatureCollection", "features": list(by_id.values())}
        A._SNAPSHOT_STARTED = True

        held = await A.global_snapshot()
        before = copy.deepcopy(held)

        # A later cycle updates the same retained objects.
        by_id2: dict = {}
        A._merge_raw_into(by_id2, [_ac(i, ts=t + 60.0, moving=False) for i in range(25)])

        assert held == before, "a retained snapshot mutated under its holder"
        # …and the live view really did move on, so the test is not vacuous.
        assert A._FEATURE_CACHE["aircraft:000000"]["properties"]["seen_at"] == t + 60.0

    asyncio.run(scenario())


def test_snapshot_view_is_the_shared_one() -> None:
    """`snapshot_view()` is documented as read-now; prove it does NOT copy, so
    the hot bbox path is not silently paying for one."""
    A._LATEST_SNAPSHOT = {"type": "FeatureCollection", "features": []}
    assert A.snapshot_view() is A._LATEST_SNAPSHOT


def test_isolate_fc_copies_every_mutated_container() -> None:
    src = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "aircraft:abc123",
                "geometry": {"type": "Point", "coordinates": [1.0, 2.0, 3.0]},
                "properties": {"icao24": "abc123", "seen_at": 1.0},
            }
        ],
    }
    out = A.isolate_fc(src)
    assert out == src
    f_src, f_out = src["features"][0], out["features"][0]
    assert f_out is not f_src
    assert f_out["geometry"] is not f_src["geometry"]
    assert f_out["geometry"]["coordinates"] is not f_src["geometry"]["coordinates"]
    assert f_out["properties"] is not f_src["properties"]
