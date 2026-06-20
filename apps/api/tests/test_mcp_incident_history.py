"""incident_history MCP tool — compaction + limit (Bug 7).

The backend route returns EVERY incident in the window, each with its full
per-snapshot points series and full narrative (~89 KB at the default 6 h), which
overflows the MCP response token cap and hard-errors the tool. The tool must
compact the payload and cap the incident count so the default call fits well
under the cap, while reporting an honest "showing N of M".

No network: we monkeypatch ``mcp_server._get`` to return a synthetic payload the
size of the real one.
"""

from __future__ import annotations

import json

import pytest

from app import mcp_server as M


@pytest.fixture(autouse=True)
def _no_autostart(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OSINT_MCP_NO_AUTOSTART", "1")
    M._BACKEND_READY = False
    M._BACKEND_PROC = None


def _fat_history(n_incidents: int = 40, n_points: int = 360) -> dict:
    """Mimic the raw /api/intel/incident-history payload that overflows the cap:
    many incidents, each with a long points series and a verbose narrative."""
    incidents = []
    for i in range(n_incidents):
        # Mostly-flat level run with a couple of transitions, like real data.
        points = []
        for j in range(n_points):
            level = "low" if j < n_points // 2 else ("elevated" if j < n_points - 5 else "high")
            points.append({"t": 1_700_000_000 + j * 60, "level": level, "score": 0.3 + j * 0.001})
        incidents.append(
            {
                "key": f"{i}.5:{i}.0:gps_jamming+dark_vessel",
                "domains": ["gps_jamming", "dark_vessel"],
                "narrative": (
                    "GPS jamming detected over the area with concurrent dark-vessel "
                    "activity; multiple military aircraft transiting. " * 6
                ),
                "centroid": {"lat": float(i), "lon": float(i)},
                "signal_count": 7,
                "points": points,
            }
        )
    # Route sorts by point-count desc; emulate that ordering being present.
    return {
        "scope": "global",
        "window_hours": 6.0,
        "snapshots": n_points,
        "incident_count": n_incidents,
        "incidents": incidents,
    }


def _patch_get(monkeypatch: pytest.MonkeyPatch, payload: dict) -> None:
    async def fake_get(path: str, params=None):
        assert path == "/api/intel/incident-history"
        return payload

    monkeypatch.setattr(M, "_get", fake_get)


@pytest.mark.asyncio
async def test_compact_default_well_under_token_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = _fat_history()
    # Sanity: the raw payload is genuinely huge (the bug condition, ~89 KB).
    assert len(json.dumps(raw)) > 80_000
    _patch_get(monkeypatch, raw)

    out = await M.incident_history()  # default limit=25
    size = len(json.dumps(out, separators=(",", ":")))
    # MCP cap is ~25k tokens; at ~4 chars/token that is ~100k chars. Bound the
    # compact default an order of magnitude under the raw payload and safely
    # below the cap.
    assert size < 15_000, f"compact default still too large: {size} chars"
    # Honest accounting preserved.
    assert out["incident_count"] == 40
    assert out["returned"] == 25
    assert out["truncated"] is True
    assert "showing 25 of 40" in out["note"]


@pytest.mark.asyncio
async def test_limit_truncates_and_series_downsampled(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_get(monkeypatch, _fat_history(n_incidents=40, n_points=360))

    out = await M.incident_history(limit=5)
    assert out["returned"] == 5
    assert len(out["incidents"]) == 5
    assert out["truncated"] is True
    # Each 360-point series is downsampled to <= max_points (12) compact entries.
    for inc in out["incidents"]:
        assert len(inc["series"]) <= 12
        # Compact list form [t, level, score], not the verbose dict.
        assert all(isinstance(p, list) and len(p) == 3 for p in inc["series"])
        # Endpoints + transitions are retained: first low, last high.
        assert inc["series"][0][1] == "low"
        assert inc["series"][-1][1] == "high"
        # Narrative is trimmed.
        assert len(inc["narrative"]) <= 240


@pytest.mark.asyncio
async def test_max_incidents_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_get(monkeypatch, _fat_history(n_incidents=40))
    out = await M.incident_history(max_incidents=3)
    assert out["returned"] == 3
    assert out["truncated"] is True


@pytest.mark.asyncio
async def test_not_truncated_when_within_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_get(monkeypatch, _fat_history(n_incidents=4, n_points=10))
    out = await M.incident_history()  # default 25 >= 4 incidents
    assert out["incident_count"] == 4
    assert out["returned"] == 4
    assert out["truncated"] is False
    assert "note" not in out


@pytest.mark.asyncio
async def test_error_payload_passes_through(monkeypatch: pytest.MonkeyPatch) -> None:
    # A backend error dict (no "incidents" list) must not be mangled.
    _patch_get(monkeypatch, {"error": "backend_unreachable", "hint": "start it"})
    out = await M.incident_history()
    assert out["error"] == "backend_unreachable"
