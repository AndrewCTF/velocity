"""Tests for app.intel.dossier — pattern-of-life dossiers.

No network. Uses a tmp SQLite positions DB (via history.override_db_path) and a
hand-seeded in-memory observation store. Covers the two stress-test fixes:

* BUG 9  — a dossier for an entity present ONLY in the 24/48h positions DB (no
           in-memory fix) still returns a real multi-fix track, so pattern-of-
           life is no longer "insufficient track".
* BUG 14 — vessel_dossier recovers name/category from an earlier static-bearing
           fix when the freshest fix is position-only (was name:null/other).
"""

from __future__ import annotations

import time

import pytest

import app.history as H
from app.correlate.store import store
from app.correlate.types import Observation
from app.intel import dossier

# ── fixtures / helpers ────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _isolate(tmp_path):
    """Each test gets a clean store + tmp DB path; restore globals afterwards so
    the rest of the suite isn't pointed at a vanished tmp DB."""
    store._buf.clear()
    store._latest.clear()
    yield
    store._buf.clear()
    store._latest.clear()
    H._buffer.clear()
    H._last.clear()
    H.override_db_path(None)


def _reset_store() -> None:
    store._buf.clear()
    store._latest.clear()


def _seed_db_aircraft(db: str, eid: str, n: int, now: float) -> None:
    """Write `n` aircraft fixes for `eid` into a fresh tmp positions DB."""
    H._buffer.clear()
    H._last.clear()
    H.override_db_path(db)
    rows = [
        ("aircraft", eid, now - (n - i) * 60.0, 10.0 + i * 0.05, 50.0, 90.0, "{}")
        for i in range(n)
    ]
    H._flush_sync(rows)


def _add_vessel(eid: str, mmsi: str, t: float, lon: float, lat: float,
                name: str | None, ship_type: int | None) -> None:
    store.add(Observation(
        id=eid, source="aisstream", t=t, lon=lon, lat=lat, emits_kind="vessel",
        attrs={"mmsi": mmsi, "name": name, "shipType": ship_type,
               "sog": 11.0, "cog": 90.0},
    ))


# ── BUG 9: DB-backed track depth ──────────────────────────────────────────────

async def test_aircraft_dossier_uses_db_history_when_not_in_memory(
    tmp_path,
) -> None:
    """An aircraft with only DB history (nothing in the in-memory store) must
    still produce a multi-fix track — not 'insufficient track'."""
    _reset_store()
    now = time.time()
    eid = "aircraft:abc123"
    # 40 fixes spanning ~40 min, all in the DB; none in the live store.
    _seed_db_aircraft(str(tmp_path / "hist.db"), eid, n=40, now=now)

    res = await dossier.aircraft_dossier("abc123")

    assert res["found"] is True
    assert res["track"]["fixes"] == 40, "every DB fix must feed the track"
    assert res["track"]["track_minutes"] >= 30.0, "track spans the DB window, not ~0"
    assert res["track"]["profile"] != "insufficient track", (
        "a long DB-backed track must classify a profile"
    )
    # icao24 is recovered from the entity id even with no in-memory attrs.
    assert res["icao24"] == "abc123"


async def test_dossier_merges_db_history_with_live_fix(tmp_path) -> None:
    """The DB history and the freshest in-memory fix combine: track length grows
    while last_fix stays the live (freshest) fix, not a staler DB row."""
    _reset_store()
    now = time.time()
    eid = "aircraft:dd00ee"
    _seed_db_aircraft(str(tmp_path / "hist2.db"), eid, n=20, now=now)
    # One fresh in-memory fix, 1s old, carrying identity the DB rows lack.
    store.add(Observation(
        id=eid, source="adsb", t=now - 1.0, lon=20.0, lat=51.0,
        emits_kind="aircraft",
        attrs={"icao24": "dd00ee", "callsign": "LIVE99", "squawk": "1200"},
    ))

    res = await dossier.aircraft_dossier("dd00ee")

    assert res["found"] is True
    # 20 DB + 1 live (the live fix is far in time from every DB row → no dedup).
    assert res["track"]["fixes"] == 21
    # Freshest fix wins for last_fix: it must be the live fix (lon 20 / lat 51),
    # not a staler DB row (lon ~10 / lat 50). Asserted by position rather than a
    # wall-clock age bound — the old `age_s <= 5` flaked on slow/loaded CI where
    # the test's own elapsed time pushed the live fix's age past 5 s.
    assert (res["last_fix"]["lon"], res["last_fix"]["lat"]) == (20.0, 51.0)
    assert res["callsign"] == "LIVE99"


async def test_db_disabled_falls_back_to_memory(tmp_path, monkeypatch) -> None:
    """When history is disabled the dossier still works from the in-memory store
    alone (no regression to the pre-fix behaviour)."""
    _reset_store()
    monkeypatch.setattr(H, "stats", lambda: {"enabled": False})
    now = time.time()
    eid = "aircraft:ffff01"
    for k in range(3):
        store.add(Observation(
            id=eid, source="adsb", t=now - 240 + k * 120, lon=1.0 + k * 0.2,
            lat=48.0, emits_kind="aircraft",
            attrs={"icao24": "ffff01", "callsign": "MEMNLY", "squawk": "1200"},
        ))

    res = await dossier.aircraft_dossier("ffff01")
    assert res["found"] is True
    assert res["track"]["fixes"] == 3
    assert res["callsign"] == "MEMNLY"


# ── BUG 14: vessel identity recovery ──────────────────────────────────────────

async def test_vessel_dossier_resolves_name_and_category(tmp_path) -> None:
    """vessel_dossier resolves a known MMSI's name + category even when the
    freshest fix is position-only (the reported null/other regression)."""
    _reset_store()
    H.override_db_path(str(tmp_path / "hist3.db"))  # empty DB → live store only
    now = time.time()
    eid = "vessel:311000977"
    # Earlier fix carries the static identity (name + cargo ship type 70)…
    _add_vessel(eid, "311000977", now - 120, 56.20, 26.40, "BALTIC HOLLYHOCK", 70)
    # …the freshest fix is a position report with NO identity.
    _add_vessel(eid, "311000977", now - 2, 56.21, 26.41, None, None)

    res = await dossier.vessel_dossier("311000977")

    assert res["found"] is True
    assert res["name"] == "BALTIC HOLLYHOCK", "name recovered from earlier fix"
    assert res["category"] == "cargo", "ship type 70 → cargo, not 'other'"
    assert res["ship_type"] == 70


async def test_vessel_dossier_stays_honest_without_identity(tmp_path) -> None:
    """A vessel that never carried a name/type stays name:null / category:other
    — the fix recovers real identity, it does not fabricate one."""
    _reset_store()
    H.override_db_path(str(tmp_path / "hist4.db"))
    now = time.time()
    _add_vessel("vessel:999999999", "999999999", now - 5, 10.0, 55.0, None, None)

    res = await dossier.vessel_dossier("999999999")
    assert res["found"] is True
    assert res["name"] is None
    assert res["category"] == "other"


async def test_vessel_dossier_not_found(tmp_path) -> None:
    """An MMSI absent from both the store and the DB returns found:False."""
    _reset_store()
    H.override_db_path(str(tmp_path / "hist5.db"))
    res = await dossier.vessel_dossier("123450000")
    assert res["found"] is False
