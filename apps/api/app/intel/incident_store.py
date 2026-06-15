"""Incident change-tracking + history.

The incident brief (``app.intel.incidents``) is a snapshot of NOW. This store
gives it memory: it assigns each incident a STABLE key (so the same convergence
is the same incident across ticks), records snapshots per scope, and diffs the
newest snapshot against the previous one — yielding what is NEW, ESCALATED,
DE-ESCALATED, or RESOLVED. That diff powers the standing-watch endpoint, the
incident-history timeline, and the threat push (HIGH transitions → alert bus).

Stable key = 0.5° centroid grid + the sorted domain set. Two ticks that produce
a convergence at roughly the same place with the same domains map to the same
incident; movement past ~half a degree, or a change in which domains are
present, is treated as a new incident — which is the behaviour an analyst wants.
"""

from __future__ import annotations

import time
from typing import Any

_LEVEL_RANK = {"low": 1, "elevated": 2, "high": 3}
_MAX_SNAPSHOTS = 360  # per scope; ~6h at a 60s cadence


def incident_key(inc: dict[str, Any]) -> str:
    c = inc.get("centroid") or {}
    gx = round(float(c.get("lon", 0.0)) * 2) / 2
    gy = round(float(c.get("lat", 0.0)) * 2) / 2
    return f"{gx}:{gy}:{'+'.join(inc.get('domains') or [])}"


def _summary(inc: dict[str, Any]) -> dict[str, Any]:
    return {
        "key": incident_key(inc),
        "threat_level": inc.get("threat_level"),
        "score": inc.get("score"),
        "domains": inc.get("domains"),
        "narrative": inc.get("narrative"),
        "centroid": inc.get("centroid"),
        "signal_count": inc.get("signal_count"),
    }


class IncidentStore:
    def __init__(self) -> None:
        # scope -> list of (t, {key: summary})
        self._history: dict[str, list[tuple[float, dict[str, dict[str, Any]]]]] = {}
        # scope -> last computed diff (so a reader can fetch it without recompute)
        self._last_changes: dict[str, dict[str, Any]] = {}

    def record(self, scope: str, incidents: list[dict[str, Any]]) -> dict[str, Any]:
        """Store a snapshot for ``scope`` and diff it against the previous one."""
        now = time.time()
        cur: dict[str, dict[str, Any]] = {}
        for inc in incidents:
            cur[incident_key(inc)] = _summary(inc)

        snaps = self._history.setdefault(scope, [])
        prev = snaps[-1][1] if snaps else {}

        new, escalated, deescalated, resolved = [], [], [], []
        steady = 0
        for k, s in cur.items():
            if k not in prev:
                new.append(s)
                continue
            old_r = _LEVEL_RANK.get(prev[k].get("threat_level"), 0)
            new_r = _LEVEL_RANK.get(s.get("threat_level"), 0)
            if new_r > old_r:
                escalated.append({**s, "from_level": prev[k].get("threat_level")})
            elif new_r < old_r:
                deescalated.append({**s, "from_level": prev[k].get("threat_level")})
            else:
                steady += 1
        for k, s in prev.items():
            if k not in cur:
                resolved.append(s)

        snaps.append((now, cur))
        if len(snaps) > _MAX_SNAPSHOTS:
            del snaps[: len(snaps) - _MAX_SNAPSHOTS]

        diff = {
            "scope": scope,
            "checked_at": int(now),
            "had_baseline": bool(prev),
            "new": new,
            "escalated": escalated,
            "deescalated": deescalated,
            "resolved": resolved,
            "steady": steady,
            "active": len(cur),
        }
        self._last_changes[scope] = diff
        return diff

    def last_changes(self, scope: str) -> dict[str, Any] | None:
        return self._last_changes.get(scope)

    def history(self, scope: str, since_s: float) -> dict[str, Any]:
        """Per-incident timeline over the recent window — for the scrubber.

        Returns each incident key that appeared in the window with the series of
        (t, level, score) points at which it was observed, so the frontend can
        plot how a convergence built up over time.
        """
        cutoff = time.time() - since_s
        snaps = [(t, m) for (t, m) in self._history.get(scope, []) if t >= cutoff]
        tracks: dict[str, dict[str, Any]] = {}
        for t, m in snaps:
            for k, s in m.items():
                tr = tracks.setdefault(
                    k,
                    {"key": k, "domains": s.get("domains"), "narrative": s.get("narrative"),
                     "centroid": s.get("centroid"), "points": []},
                )
                tr["centroid"] = s.get("centroid")
                tr["narrative"] = s.get("narrative")
                tr["points"].append(
                    {"t": int(t), "level": s.get("threat_level"), "score": s.get("score")}
                )
        series = sorted(tracks.values(), key=lambda x: len(x["points"]), reverse=True)
        return {
            "scope": scope,
            "window_hours": round(since_s / 3600, 1),
            "snapshots": len(snaps),
            "incident_count": len(series),
            "incidents": series,
        }


incident_store = IncidentStore()
