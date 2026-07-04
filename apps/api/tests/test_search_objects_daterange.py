"""Absolute (static) date-range facet for object search (filter_objects).

Pure filter, no store/network: proves the absolute epoch-second bounds
start_s/end_s (inclusive) drop objects outside the range, that an open-ended
lower or upper bound works alone, and that the absolute range composes (AND)
with the existing rolling window since_s.
"""

from __future__ import annotations

from app.correlate.types import Observation
from app.routes.search import filter_objects

NOW = 1_000_000.0


def _obs(id_: str, kind: str, lon: float, lat: float, t: float, **attrs) -> Observation:
    return Observation(id=id_, source="test", t=t, lon=lon, lat=lat, emits_kind=kind, attrs=attrs)


def _fixture() -> list[Observation]:
    # Four aircraft spread across absolute time so the [start,end] boundaries bite.
    return [
        _obs("aircraft:t100", "aircraft", 10.0, 50.0, 100.0, callsign="A100"),
        _obs("aircraft:t200", "aircraft", 10.1, 50.1, 200.0, callsign="A200"),
        _obs("aircraft:t300", "aircraft", 10.2, 50.2, 300.0, callsign="A300"),
        _obs("aircraft:t400", "aircraft", 10.3, 50.3, 400.0, callsign="A400"),
    ]


def _ids(out: dict) -> set[str]:
    return {r["id"] for r in out["results"]}


def test_absolute_range_inside_passes_outside_dropped() -> None:
    # [200, 300] inclusive → t200 and t300 in; t100 and t400 out.
    out = filter_objects(
        _fixture(), type_="all", q=None, bbox=None, since_s=None,
        now=NOW, limit=100, start_s=200.0, end_s=300.0,
    )
    assert _ids(out) == {"aircraft:t200", "aircraft:t300"}
    assert out["count"] == 2
    # Boundaries are inclusive.
    edge = filter_objects(
        _fixture(), type_="all", q=None, bbox=None, since_s=None,
        now=NOW, limit=100, start_s=100.0, end_s=100.0,
    )
    assert _ids(edge) == {"aircraft:t100"}


def test_start_s_alone_open_upper_bound() -> None:
    # start_s only → everything at/after 300.
    out = filter_objects(
        _fixture(), type_="all", q=None, bbox=None, since_s=None,
        now=NOW, limit=100, start_s=300.0, end_s=None,
    )
    assert _ids(out) == {"aircraft:t300", "aircraft:t400"}


def test_end_s_alone_open_lower_bound() -> None:
    # end_s only → everything at/before 200.
    out = filter_objects(
        _fixture(), type_="all", q=None, bbox=None, since_s=None,
        now=NOW, limit=100, start_s=None, end_s=200.0,
    )
    assert _ids(out) == {"aircraft:t100", "aircraft:t200"}


def test_since_s_still_works_alone() -> None:
    # Rolling window unchanged: only objects newer than now - since_s pass.
    obs = [
        _obs("aircraft:fresh", "aircraft", 10.0, 50.0, NOW - 5, callsign="FRESH"),
        _obs("aircraft:stale", "aircraft", 11.0, 51.0, NOW - 5000, callsign="STALE"),
    ]
    out = filter_objects(
        obs, type_="all", q=None, bbox=None, since_s=60.0,
        now=NOW, limit=100, start_s=None, end_s=None,
    )
    assert _ids(out) == {"aircraft:fresh"}


def test_since_s_and_absolute_range_compose_with_and() -> None:
    # since_s keeps the last 250s (t >= NOW-250 = 999750); absolute [start,end]
    # further clips. Only objects satisfying BOTH survive.
    obs = [
        _obs("aircraft:a", "aircraft", 10.0, 50.0, NOW - 300, callsign="A"),  # 999700 — outside since window
        _obs("aircraft:b", "aircraft", 10.0, 50.0, NOW - 200, callsign="B"),  # 999800 — inside since, inside range
        _obs("aircraft:c", "aircraft", 10.0, 50.0, NOW - 100, callsign="C"),  # 999900 — inside since, above end
        _obs("aircraft:d", "aircraft", 10.0, 50.0, NOW - 10, callsign="D"),   # 999990 — inside since, above end
    ]
    out = filter_objects(
        obs, type_="all", q=None, bbox=None, since_s=250.0,
        now=NOW, limit=100, start_s=NOW - 220, end_s=NOW - 180,
    )
    # a fails since_s; c/d fail end_s; only b is in both.
    assert _ids(out) == {"aircraft:b"}
    assert out["count"] == 1
