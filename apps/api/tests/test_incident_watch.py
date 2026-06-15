"""Incident change-tracking (incident_store) + dossier track stats."""

from __future__ import annotations

from app.correlate.types import Observation
from app.intel import dossier
from app.intel.incident_store import IncidentStore, incident_key


def _inc(lon, lat, domains, level):
    return {"centroid": {"lon": lon, "lat": lat}, "domains": domains,
            "threat_level": level, "score": 9, "narrative": "x", "signal_count": 3}


# ── stable key ────────────────────────────────────────────────────────────────


def test_incident_key_stable_within_half_degree():
    a = _inc(24.0, 59.0, ["dark-vessel", "gps-jamming"], "high")
    b = _inc(24.1, 59.1, ["dark-vessel", "gps-jamming"], "high")  # <0.5° away
    assert incident_key(a) == incident_key(b)


def test_incident_key_differs_on_domains():
    a = _inc(24.0, 59.0, ["dark-vessel", "gps-jamming"], "high")
    b = _inc(24.0, 59.0, ["military"], "high")
    assert incident_key(a) != incident_key(b)


# ── diff ──────────────────────────────────────────────────────────────────────


def test_record_diffs_new_escalated_resolved():
    s = IncidentStore()
    a = _inc(24.0, 59.0, ["dark-vessel", "gps-jamming"], "elevated")
    b = _inc(10.0, 50.0, ["military"], "low")
    d1 = s.record("g", [a, b])
    assert d1["had_baseline"] is False
    assert len(d1["new"]) == 2

    a2 = _inc(24.0, 59.0, ["dark-vessel", "gps-jamming"], "high")  # escalated
    c = _inc(40.0, 45.0, ["event", "gps-jamming"], "high")  # new
    d2 = s.record("g", [a2, c])  # b dropped -> resolved
    assert [x["key"] for x in d2["escalated"]] == [incident_key(a2)]
    assert [x["key"] for x in d2["new"]] == [incident_key(c)]
    assert [x["key"] for x in d2["resolved"]] == [incident_key(b)]


def test_history_builds_per_incident_timeline():
    s = IncidentStore()
    a = _inc(24.0, 59.0, ["dark-vessel", "gps-jamming"], "elevated")
    s.record("g", [a])
    s.record("g", [_inc(24.0, 59.0, ["dark-vessel", "gps-jamming"], "high")])
    h = s.history("g", since_s=3600)
    assert h["incident_count"] == 1
    assert len(h["incidents"][0]["points"]) == 2  # two observations of the same incident


# ── dossier track stats ───────────────────────────────────────────────────────


def _obs(t, lon, lat):
    return Observation(id="vessel:1", source="test", t=t, lon=lon, lat=lat, emits_kind="vessel")


def test_track_stats_detects_gap_and_bbox():
    pts = [_obs(0, 0.0, 0.0), _obs(120, 0.0, 0.1), _obs(1000, 0.0, 0.2)]  # 880s gap > 600
    st = dossier._track_stats(pts)
    assert st["fixes"] == 3
    assert st["gap_count"] == 1
    assert st["bbox"]["max_lat"] == 0.2
    assert st["speed_kn"]["avg"] is not None
