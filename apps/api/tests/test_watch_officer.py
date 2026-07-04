"""Watch-officer loop logic — fusion diff → filed briefs, dedup, triage.

The incident-fusion (``incidents.brief``) and tip-and-cue (``cue.run``) upstreams
are stubbed: this proves OUR file/dedup/triage contract, not the live fusion.
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.intel import cue, incidents, watch_officer
from app.intel.incident_store import incident_store


def _incident(level: str, domains: list[str], lon: float, lat: float) -> dict[str, Any]:
    return {
        "id": "x",
        "threat_level": level,
        "score": 12.0,
        "domains": domains,
        "centroid": {"lon": lon, "lat": lat},
        "narrative": f"{level} {'+'.join(domains)}",
        "evidence": [{"domain": domains[0], "severity": "high", "summary": "s",
                      "lon": lon, "lat": lat, "ref": "r", "kind": "measured"}],
        "follow_up": ["look here"],
    }


def _reset(scope: str = "watch-officer") -> None:
    watch_officer.reset_state()
    incident_store._history.pop(scope, None)
    incident_store._last_changes.pop(scope, None)


def _stub_brief(incs: list[dict[str, Any]], monkeypatch) -> None:
    async def fake_brief(*a, **k) -> dict[str, Any]:
        return {"incidents": incs}
    monkeypatch.setattr(incidents, "brief", fake_brief)


def test_files_brief_for_high_incident(monkeypatch) -> None:
    _reset()
    _stub_brief([_incident("high", ["military", "gps-jamming"], 30.0, 26.0)], monkeypatch)

    filed = asyncio.run(watch_officer.run_once())

    assert filed == 1
    briefs = watch_officer.list_briefs()
    assert len(briefs) == 1
    assert briefs[0]["threat_level"] == "high"
    assert briefs[0]["narrative"] == "high military+gps-jamming"
    assert briefs[0]["follow_up"] == ["look here"]


def test_low_incident_not_filed(monkeypatch) -> None:
    _reset()
    _stub_brief([_incident("low", ["event"], 0.0, 0.0)], monkeypatch)
    assert asyncio.run(watch_officer.run_once()) == 0
    assert watch_officer.list_briefs() == []


def test_dedup_second_sweep_files_nothing(monkeypatch) -> None:
    _reset()
    _stub_brief([_incident("high", ["military"], 10.0, 10.0)], monkeypatch)
    assert asyncio.run(watch_officer.run_once()) == 1
    # Same picture next cycle → incident is steady, not new/escalated → no new brief.
    assert asyncio.run(watch_officer.run_once()) == 0
    assert len(watch_officer.list_briefs()) == 1


def test_dark_vessel_runs_sar_playbook(monkeypatch) -> None:
    _reset()
    calls: list[tuple[float, float]] = []

    async def fake_cue(lon: float, lat: float) -> dict[str, Any]:
        calls.append((lon, lat))
        return {"status": "ok", "aoi": "hormuz"}

    monkeypatch.setattr(cue, "run", fake_cue)
    _stub_brief([_incident("elevated", ["dark-vessel"], 56.3, 26.5)], monkeypatch)

    asyncio.run(watch_officer.run_once())

    assert calls == [(56.3, 26.5)]
    assert watch_officer.list_briefs()[0]["playbook"] == {"sar": "ok", "sar_aoi": "hormuz"}


def test_dismiss_and_ack_clear_brief(monkeypatch) -> None:
    _reset()
    _stub_brief([_incident("high", ["military"], 1.0, 1.0)], monkeypatch)
    asyncio.run(watch_officer.run_once())
    bid = watch_officer.list_briefs()[0]["id"]

    assert watch_officer.dismiss(bid) is True
    assert watch_officer.list_briefs() == []
    assert watch_officer.dismiss(bid) is False  # already gone → 404 upstream
    assert watch_officer.ack("nope") is False
