"""Cross-domain incident fusion (app.intel.incidents)."""

from __future__ import annotations

import time

from app.intel import incidents
from app.intel.incidents import Signal


def _sig(domain: str, sev: str, lon: float, lat: float, t: float | None = None) -> Signal:
    return Signal(domain, sev, t if t is not None else time.time(), lon, lat, f"{domain} test")


# ── clustering ────────────────────────────────────────────────────────────────


def test_cluster_fuses_colocated_and_separates_distant():
    near_a = _sig("dark-vessel", "medium", 56.40, 26.60)
    near_b = _sig("gps-jamming", "high", 56.45, 26.62)  # ~6 km away
    far = _sig("military", "medium", 0.0, 0.0)  # different hemisphere
    groups = incidents._cluster([near_a, near_b, far], link_km=75.0)
    sizes = sorted(len(g) for g in groups)
    assert sizes == [1, 2]  # the two near signals fuse, the far one is alone


def test_cluster_bounds_diameter_no_chaining():
    # Seed clustering must NOT chain: A-B ~55 km (fuse), but C ~110 km from the
    # A/B seed stays separate even though it is within link_km of B. This bounds
    # an incident's diameter to ~2*link_km so a dense field can't merge into one
    # 300 km blob.
    a = _sig("gps-jamming", "high", 30.0, 45.0)  # strongest → seeds first
    b = _sig("dark-vessel", "medium", 30.0, 45.5)  # ~55 km from A → joins A
    c = _sig("military", "medium", 30.0, 46.0)  # ~110 km from A → new seed
    groups = incidents._cluster([a, b, c], link_km=75.0)
    sizes = sorted(len(g) for g in groups)
    assert sizes == [1, 2]


# ── scoring ───────────────────────────────────────────────────────────────────


def test_score_rewards_cross_domain():
    single = [_sig("dark-vessel", "medium", 10, 10)]
    fused = [_sig("dark-vessel", "medium", 10, 10), _sig("gps-jamming", "medium", 10, 10)]
    s_single, _ = incidents._score(single)
    s_fused, lvl_fused = incidents._score(fused)
    assert s_fused > s_single  # the cross-domain bonus makes fusion rank higher
    assert lvl_fused == "elevated"


def test_score_critical_forces_high():
    _, lvl = incidents._score([_sig("air-emergency", "critical", 10, 10)])
    assert lvl == "high"


# ── narrative (deterministic, cited) ──────────────────────────────────────────


def test_narrate_dark_vessel_plus_jamming_is_ew_cover():
    cl = [_sig("dark-vessel", "medium", 10, 10), _sig("gps-jamming", "high", 10, 10)]
    text = incidents._narrate(cl)
    assert "electronic-warfare cover" in text


def test_narrate_emergency_leads():
    cl = [_sig("air-emergency", "critical", 10, 10), _sig("military", "medium", 10, 10)]
    assert incidents._narrate(cl).startswith("Aircraft emergency")


def test_narrate_single_domain_falls_back_to_summary():
    cl = [_sig("quake", "high", 10, 10)]
    assert incidents._narrate(cl) == cl[0].summary


# ── promotion rule (brief orchestration) ──────────────────────────────────────


async def test_brief_promotes_convergence_and_lone_critical_only(monkeypatch):
    now = time.time()
    signals = [
        # converged pair (2 domains) -> incident
        Signal("dark-vessel", "medium", now, 56.40, 26.60, "dark vessel X", {"mmsi": 1}),
        Signal("gps-jamming", "high", now, 56.44, 26.62, "jam cell", {"cell": [56.44, 26.62]}),
        # lone critical emergency far away -> incident (single high/critical signal)
        Signal("air-emergency", "critical", now, -120.0, 35.0, "AAL1 7700", {"icao24": "x"}),
        # lone low-severity event far away -> NOT an incident (1 domain, low sev)
        Signal("event", "low", now, 10.0, 0.0, "headline", {"source": "gdelt"}),
    ]

    async def fake_gather(bbox, window_s):
        return signals

    monkeypatch.setattr(incidents, "_gather", fake_gather)
    out = await incidents.brief(bbox=None)

    assert out["incident_count"] == 2  # the pair + the lone critical, NOT the lone event
    assert out["top_threat_level"] == "high"  # critical emergency
    domains_seen = {tuple(i["domains"]) for i in out["incidents"]}
    assert ("dark-vessel", "gps-jamming") in domains_seen
    # every incident cites its evidence with refs
    for inc in out["incidents"]:
        assert inc["evidence"]
        assert all("ref" in e for e in inc["evidence"])
        assert inc["follow_up"]
