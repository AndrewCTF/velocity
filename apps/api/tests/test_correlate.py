"""Tests for the correlation engine — rules, store, bus."""

from __future__ import annotations

import asyncio
import time

import pytest

from app.correlate.bus import AlertBus
from app.correlate.rules import (
    EMERGENCY_SQUAWKS,
    ais_gap_in_aoi,
    emergency_squawk,
    gps_jam_cluster,
    haversine_km,
    mil_aircraft_in_aoi,
)
from app.correlate.store import ObservationStore
from app.correlate.types import Alert, Observation


def _ac(
    icao: str,
    lon: float,
    lat: float,
    *,
    squawk: str | None = None,
    callsign: str | None = None,
    source: str = "opensky",
    t: float | None = None,
    nac_p: int | None = None,
    nic: int | None = None,
) -> Observation:
    return Observation(
        id=f"aircraft:{icao}",
        source=source,
        t=t if t is not None else time.time(),
        lon=lon,
        lat=lat,
        emits_kind="aircraft",
        attrs={
            "icao24": icao,
            "callsign": callsign,
            "squawk": squawk,
            "source": source,
            "nac_p": nac_p,
            "nic": nic,
        },
    )


def _ship(mmsi: str, lon: float, lat: float, t: float, name: str | None = None) -> Observation:
    return Observation(
        id=f"vessel:{mmsi}",
        source="aisstream",
        t=t,
        lon=lon,
        lat=lat,
        emits_kind="vessel",
        attrs={"name": name, "mmsi": mmsi},
    )


# ── ObservationStore ──────────────────────────────────────────────────────

def test_store_retention_evicts_old() -> None:
    s = ObservationStore(retention_sec=1.0)
    s.add(_ac("a", 1, 1, t=time.time() - 5))  # too old
    s.add(_ac("b", 2, 2, t=time.time()))
    assert len(s) == 1


def test_store_window_filters_by_kind() -> None:
    s = ObservationStore()
    s.add(_ac("a", 1, 1))
    s.add(_ship("123", 1, 1, time.time()))
    assert len(s.window(60, kinds={"aircraft"})) == 1
    assert len(s.window(60, kinds={"vessel"})) == 1
    assert len(s.window(60)) == 2


# ── rules ─────────────────────────────────────────────────────────────────

def test_emergency_squawk_constants() -> None:
    assert EMERGENCY_SQUAWKS == {"7500", "7600", "7700"}


def test_emergency_squawk_fires_for_each_code() -> None:
    obs = [
        _ac("a1", 0, 0, squawk="7500", callsign="DAL1"),
        _ac("a2", 0, 0, squawk="7600", callsign="UAL2"),
        _ac("a3", 0, 0, squawk="7700", callsign="AAL3"),
        _ac("a4", 0, 0, squawk="1234", callsign="OK"),  # ignore
    ]
    alerts = emergency_squawk(obs)
    assert {a.rule_id for a in alerts} == {"emergency_squawk"}
    assert len(alerts) == 3
    # 7500 escalates to critical
    sev_by_message = {a.message: a.severity for a in alerts}
    assert any("7500" in m and sev == "critical" for m, sev in sev_by_message.items())
    assert all(sev == "high" for m, sev in sev_by_message.items() if "7500" not in m)


def test_gps_jam_cluster_skips_below_min_aircraft() -> None:
    # Two bad fixes in the same cell — below the floor of 3 — should not fire.
    obs = [
        _ac("a1", 56.5, 26.4, nac_p=0, nic=0),
        _ac("a2", 56.6, 26.6, nac_p=4, nic=2),
    ]
    assert gps_jam_cluster(obs) == []


def test_gps_jam_cluster_skips_when_majority_clean() -> None:
    # 4 aircraft, only 1 bad → 25% < 50% threshold → no alert.
    obs = [
        _ac("a1", 56.5, 26.4, nac_p=4, nic=2),  # bad
        _ac("a2", 56.6, 26.6, nac_p=10, nic=8),
        _ac("a3", 56.7, 26.7, nac_p=10, nic=8),
        _ac("a4", 56.8, 26.8, nac_p=10, nic=8),
    ]
    assert gps_jam_cluster(obs) == []


def test_gps_jam_cluster_fires_for_high_bad_ratio() -> None:
    # 3 aircraft in the same 1° cell, all bad → high-severity alert.
    obs = [
        _ac("a1", 56.1, 26.2, nac_p=0, nic=0),
        _ac("a2", 56.5, 26.4, nac_p=4, nic=2),
        _ac("a3", 56.9, 26.6, nac_p=6, nic=5),
    ]
    alerts = gps_jam_cluster(obs)
    assert len(alerts) == 1
    a = alerts[0]
    assert a.rule_id == "gps_jam_cluster"
    assert a.severity == "high"
    # Cell sentinel makes the dedup key stable across polls.
    assert a.contributing == ["jamcell:56:26"]
    assert "3/3" in a.message
    # Confidence climbs above the floor when the bad fraction is high.
    assert a.confidence >= 0.9


def test_gps_jam_cluster_ignores_aircraft_without_integrity_fields() -> None:
    # An aircraft without nac_p / nic is excluded from both numerator and
    # denominator — otherwise MLAT contacts would dilute the signal.
    obs = [
        _ac("a1", 56.5, 26.4, nac_p=0, nic=0),
        _ac("a2", 56.6, 26.6, nac_p=4, nic=2),
        _ac("a3", 56.7, 26.7, nac_p=6, nic=5),
        _ac("mlat", 56.8, 26.8),  # no nac_p/nic — excluded
    ]
    alerts = gps_jam_cluster(obs)
    assert len(alerts) == 1
    assert "3/3" in alerts[0].message  # MLAT contact not counted


def test_gps_jam_cluster_does_not_cross_cell_boundaries() -> None:
    # Three bad aircraft, but spread across three different 1° cells →
    # nothing fires (each cell has only one).
    obs = [
        _ac("a1", 56.5, 26.4, nac_p=0, nic=0),  # cell (56, 26)
        _ac("a2", 57.5, 27.4, nac_p=0, nic=0),  # cell (57, 27)
        _ac("a3", 58.5, 28.4, nac_p=0, nic=0),  # cell (58, 28)
    ]
    assert gps_jam_cluster(obs) == []


def test_gps_jam_cluster_only_one_integrity_field() -> None:
    # Aircraft may report only one of nac_p / nic; the rule treats each
    # field independently for the bad-flag and still includes the aircraft.
    obs = [
        _ac("a1", 56.5, 26.4, nac_p=4, nic=None),  # bad on nac_p
        _ac("a2", 56.6, 26.6, nac_p=None, nic=3),  # bad on nic
        _ac("a3", 56.7, 26.7, nac_p=None, nic=4),  # bad on nic
    ]
    alerts = gps_jam_cluster(obs)
    assert len(alerts) == 1
    assert "3/3" in alerts[0].message


def test_mil_in_aoi_filters_by_bbox_and_source() -> None:
    obs = [
        _ac("m1", 56.5, 26.4, source="adsb_mil"),  # inside Hormuz
        _ac("m2", 0, 0, source="adsb_mil"),  # outside
        _ac("civ", 56.5, 26.4, source="opensky"),  # civilian — ignore
    ]
    alerts = mil_aircraft_in_aoi(obs, (55.6, 25.5, 57.4, 27.2))
    assert len(alerts) == 1
    assert alerts[0].contributing == ["aircraft:m1"]


def test_haversine_km_returns_reasonable_distance() -> None:
    # Distance LAX → JFK ≈ 3,944 km
    d = haversine_km(-118.4081, 33.9425, -73.7781, 40.6413)
    assert 3900 < d < 4000


def test_ais_gap_in_aoi() -> None:
    now = time.time()
    last_fixes: dict[str, Observation] = {
        "111": _ship("111", 56.5, 26.4, now - 90 * 60),  # 90m gap — should fire
        "222": _ship("222", 56.5, 26.4, now - 10 * 60),  # 10m — fresh, skip
        "333": _ship("333", 0, 0, now - 90 * 60),  # outside AOI — skip
    }
    alerts = ais_gap_in_aoi(last_fixes, (55.6, 25.5, 57.4, 27.2), now)
    assert len(alerts) == 1
    assert alerts[0].contributing == ["vessel:111"]
    assert alerts[0].confidence > 0.5


# ── AlertBus ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_bus_publish_then_subscribe_replay() -> None:
    bus = AlertBus()
    q = bus.subscribe()
    bus.publish(
        Alert(id="x", rule_id="r", severity="high", t=0, lon=0, lat=0, confidence=1, message="m")
    )
    a = await asyncio.wait_for(q.get(), timeout=1.0)
    assert a.id == "x"


@pytest.mark.asyncio
async def test_bus_recent_buffer_capped() -> None:
    bus = AlertBus()
    for i in range(600):
        bus.publish(
            Alert(
                id=str(i), rule_id="r", severity="high",
                t=0, lon=0, lat=0, confidence=1, message=f"m{i}",
            )
        )
    assert len(bus.recent(1000)) <= 500


def test_store_high_cardinality_add_is_not_quadratic() -> None:
    # Regression: a global high-cardinality feed (AISStream whole-world firehose,
    # >50k distinct ids within retention) must NOT turn every add() into an O(n)
    # full _latest rebuild. That blocked the asyncio event loop and wedged the
    # whole backend (every route, incl /tiles/basemap, timed out). With the
    # cadence-only sweep, 60k distinct adds finish in well under a second; the
    # per-call-O(n) version was billions of ops (tens of seconds → minutes).
    store = ObservationStore()
    now = time.time()
    t0 = time.time()
    for i in range(60_000):
        store.add(
            Observation(
                id=f"vessel:{i}", source="aisstream", t=now,
                lon=0.0, lat=0.0, emits_kind="vessel",
            )
        )
    elapsed = time.time() - t0
    assert len(store._latest) >= 50_000  # we really are past the old threshold
    assert elapsed < 5.0, f"60k distinct adds took {elapsed:.1f}s — O(n)-per-add regression"
