"""Guards: what changed here between two moments.

The one question a stateless dashboard cannot answer, and therefore the reason
owning history is the defensible asset here rather than another live layer.
Every competitor surveyed in docs/research-last30days-2026-07-29.md §1.1 is a
stateless viewer of somebody else's API: they can show four vessels off a
terminal, and they have no way to tell you it is a different four to last week's.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app import history

_BBOX = (55.5, 25.5, 57.0, 27.0)  # (lomin, lamin, lomax, lamax) — Hormuz-ish
_INSIDE = (56.3, 26.6)
_OUTSIDE = (10.0, 10.0)


@pytest.fixture()
def store(tmp_path, monkeypatch):  # type: ignore[no-untyped-def]
    """A private history db per test, so these never read the operator's data."""
    history.override_db_path(str(tmp_path / "h.db"))
    yield history
    history.override_db_path(None)


def _write(rows: list[tuple[str, str, float, float, float]]) -> None:
    """rows = (kind, id, t, lon, lat)"""
    con = history._connect()
    con.executemany(
        "INSERT INTO positions (kind, id, t, lon, lat, track, extra)"
        " VALUES (?,?,?,?,?,0,'{}')",
        rows,
    )
    con.commit()
    con.close()


def _diff(a: float, b: float, kind: str | None = "vessel") -> dict:
    return asyncio.run(
        history.window_diff(kind, _BBOX, a - 60, a + 60, b - 60, b + 60)
    )


def test_arrived_departed_and_stayed_are_separated(store) -> None:  # type: ignore[no-untyped-def]
    t0, t1 = 1_000_000.0, 1_010_000.0
    _write(
        [
            ("vessel", "leaver", t0, *_INSIDE),
            ("vessel", "stayer", t0, *_INSIDE),
            ("vessel", "stayer", t1, *_INSIDE),
            ("vessel", "arriver", t1, *_INSIDE),
        ]
    )
    d = _diff(t0, t1)
    assert [r["id"] for r in d["arrived"]] == ["arriver"]
    assert [r["id"] for r in d["departed"]] == ["leaver"]
    assert [r["id"] for r in d["stayed"]] == ["stayer"]
    assert d["counts"] == {"a": 2, "b": 2, "arrived": 1, "departed": 1, "stayed": 1}


def test_the_box_is_respected(store) -> None:  # type: ignore[no-untyped-def]
    t0, t1 = 1_000_000.0, 1_010_000.0
    _write([("vessel", "elsewhere", t1, *_OUTSIDE)])
    d = _diff(t0, t1)
    assert d["counts"]["arrived"] == 0
    assert d["recorded"] is False


def test_kind_filters(store) -> None:  # type: ignore[no-untyped-def]
    t0, t1 = 1_000_000.0, 1_010_000.0
    _write([("aircraft", "plane", t1, *_INSIDE), ("vessel", "ship", t1, *_INSIDE)])
    assert [r["id"] for r in _diff(t0, t1, "vessel")["arrived"]] == ["ship"]
    assert [r["id"] for r in _diff(t0, t1, "aircraft")["arrived"]] == ["plane"]
    assert len(_diff(t0, t1, None)["arrived"]) == 2


def test_an_empty_store_is_distinguishable_from_nothing_changed(store) -> None:  # type: ignore[no-untyped-def]
    """Both produce zero counts. Silent emptiness reading as a real answer is
    exactly the failure mode this wave is pushing back on."""
    t0, t1 = 1_000_000.0, 1_010_000.0
    empty = _diff(t0, t1)
    assert empty["counts"]["arrived"] == 0
    assert empty["recorded"] is False

    _write([("vessel", "steady", t0, *_INSIDE), ("vessel", "steady", t1, *_INSIDE)])
    unchanged = _diff(t0, t1)
    assert unchanged["counts"]["arrived"] == 0
    assert unchanged["recorded"] is True


def test_rows_carry_where_the_contact_was_last_seen(store) -> None:  # type: ignore[no-untyped-def]
    t1 = 1_010_000.0
    _write(
        [
            ("vessel", "mover", t1 - 30, 56.0, 26.0),
            ("vessel", "mover", t1, 56.9, 26.9),
        ]
    )
    d = _diff(1_000_000.0, t1)
    row = d["arrived"][0]
    # Newest fix inside the window wins, so the position is where it ended up.
    assert row["lon"] == pytest.approx(56.9)
    assert row["lat"] == pytest.approx(26.9)


def test_newest_first(store) -> None:  # type: ignore[no-untyped-def]
    t1 = 1_010_000.0
    _write(
        [
            ("vessel", "older", t1 - 50, *_INSIDE),
            ("vessel", "newer", t1, *_INSIDE),
        ]
    )
    assert [r["id"] for r in _diff(1_000_000.0, t1)["arrived"]] == ["newer", "older"]


def test_a_missing_store_degrades_instead_of_raising(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A diff over an unreadable store must answer "nothing recorded", not 500."""
    history.override_db_path(str(tmp_path / "nope" / "missing.db"))
    try:
        d = asyncio.run(history.window_diff("vessel", _BBOX, 0, 1, 2, 3))
        assert d["recorded"] is False
        assert d["counts"]["arrived"] == 0
    finally:
        history.override_db_path(None)


def test_default_later_window_is_now(store) -> None:  # type: ignore[no-untyped-def]
    now = time.time()
    _write([("vessel", "recent", now, *_INSIDE)])
    d = asyncio.run(
        history.window_diff("vessel", _BBOX, now - 10_000, now - 9_000, now - 60, now + 60)
    )
    assert [r["id"] for r in d["arrived"]] == ["recent"]


# ── archived behaviour series ────────────────────────────────────────────────
#
# The archive has carried altitude in `extra` since ingest, and the by-id query
# dropped it, so the entity panel's sparkline could only ever plot what the
# current browser tab happened to observe. Surfacing it is what turns a position
# into a behaviour, and it is only possible because the history is owned.


def _write_extra(rows: list[tuple[str, str, float, float, float, str]]) -> None:
    """rows = (kind, id, t, lon, lat, extra_json)"""
    con = history._connect()
    con.executemany(
        "INSERT INTO positions (kind, id, t, lon, lat, track, extra)"
        " VALUES (?,?,?,?,?,0,?)",
        rows,
    )
    con.commit()
    con.close()


def test_series_returns_archived_altitude(store) -> None:  # type: ignore[no-untyped-def]
    _write_extra(
        [
            ("aircraft", "aircraft:abc123", 100.0, 1.0, 2.0, '{"baro_alt_m": 9000}'),
            ("aircraft", "aircraft:abc123", 200.0, 1.1, 2.1, '{"baro_alt_m": 10000}'),
        ]
    )
    out = asyncio.run(
        history.query_track_by_id("aircraft:abc123", 0, 1_000, include_series=True)
    )
    assert [s["alt_m"] for s in out["series"]] == [9000, 10000]
    assert [s["t"] for s in out["series"]] == [100.0, 200.0]


def test_series_is_opt_in_so_existing_callers_are_unchanged(store) -> None:  # type: ignore[no-untyped-def]
    _write_extra([("aircraft", "aircraft:abc123", 100.0, 1.0, 2.0, '{"baro_alt_m": 9000}')])
    out = asyncio.run(history.query_track_by_id("aircraft:abc123", 0, 1_000))
    assert "series" not in out
    # The positional points shape several callers index into is untouched.
    assert out["tracks"][0]["points"] == [[1.0, 2.0, 100.0, 0.0]]


def test_series_tolerates_a_fix_with_no_altitude(store) -> None:  # type: ignore[no-untyped-def]
    """A missing value must arrive as null, not as zero: a plotted 0 m would
    read as an aircraft on the ground."""
    _write_extra([("aircraft", "aircraft:abc123", 100.0, 1.0, 2.0, "{}")])
    out = asyncio.run(
        history.query_track_by_id("aircraft:abc123", 0, 1_000, include_series=True)
    )
    assert out["series"][0]["alt_m"] is None
