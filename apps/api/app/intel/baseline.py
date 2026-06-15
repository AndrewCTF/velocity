"""Per-AOI activity baselines — "is this normal?".

A background sampler records a handful of metrics (vessels, dark vessels,
high-severity jamming cells, military aircraft) for each watched chokepoint on a
fixed cadence into a rolling window. ``assess`` then z-scores the current value
against that window, so the analyst gets "vessel traffic is 3σ below normal for
Kerch" instead of a raw count he has to know the baseline for himself.

Phase 1: a single rolling window per (scope, metric) — matures within ~1h of
uptime and is in-memory (resets on restart), stated honestly. Hour-of-day /
day-of-week seasonality is a Phase 2 refinement.
"""

from __future__ import annotations

import math
import time
from collections import defaultdict, deque
from typing import Any

from app.correlate.store import store
from app.intel.geo import BBox, aircraft_category, feature_lonlat

_WINDOW = 288          # samples kept per metric (~24h at a 5-min cadence)
_MIN_SAMPLES = 6       # need this many before a z-score is meaningful
_FLAG_Z = 2.0          # |z| >= this is flagged anomalous


class BaselineStore:
    def __init__(self) -> None:
        self._w: dict[str, dict[str, deque[float]]] = defaultdict(
            lambda: defaultdict(lambda: deque(maxlen=_WINDOW))
        )
        self._last_sample_at: dict[str, float] = {}

    def sample(self, scope: str, metrics: dict[str, float]) -> None:
        for k, v in metrics.items():
            self._w[scope][k].append(float(v))
        self._last_sample_at[scope] = time.time()

    def _stats(self, vals: deque[float]) -> tuple[float, float]:
        n = len(vals)
        mean = sum(vals) / n
        var = sum((x - mean) ** 2 for x in vals) / n
        return mean, math.sqrt(var)

    def assess(self, scope: str, current: dict[str, float]) -> dict[str, Any]:
        metrics_out: dict[str, Any] = {}
        flags: list[str] = []
        for k, now in current.items():
            vals = self._w.get(scope, {}).get(k)
            if not vals or len(vals) < _MIN_SAMPLES:
                metrics_out[k] = {"now": now, "baseline": "insufficient",
                                  "samples": len(vals) if vals else 0}
                continue
            mean, std = self._stats(vals)
            z = (now - mean) / std if std > 1e-9 else 0.0
            state = "normal"
            if z >= _FLAG_Z:
                state = "high"
            elif z <= -_FLAG_Z:
                state = "low"
            if state != "normal":
                flags.append(f"{k} {state} ({z:+.1f}σ)")
            metrics_out[k] = {
                "now": round(now, 1), "mean": round(mean, 1), "std": round(std, 2),
                "z": round(z, 1), "state": state, "samples": len(vals),
            }
        return {
            "scope": scope,
            "last_sample_age_s": (
                int(time.time() - self._last_sample_at[scope])
                if scope in self._last_sample_at else None
            ),
            "anomalies": flags,
            "metrics": metrics_out,
        }


baseline_store = BaselineStore()


async def current_metrics(
    bbox: BBox | None, feats: list[dict[str, Any]] | None = None
) -> dict[str, float]:
    """The metrics we baseline for an area: vessel / dark-vessel counts (store),
    high-severity jamming cells + military aircraft (snapshot)."""
    from app.intel import analytics  # noqa: PLC0415

    feats = feats if feats is not None else await analytics._snapshot()
    vessels = dark = 0
    for o in store.latest("vessel"):
        if bbox is None or bbox.contains(o.lon, o.lat):
            vessels += 1
            a = o.attrs or {}
            if (a.get("name") in (None, "")) and a.get("shipType") is None:
                dark += 1
    jam = await analytics.jamming(bbox, features=feats)
    mil = 0
    for f in feats:
        ll = feature_lonlat(f)
        if ll is not None and (bbox is None or bbox.contains(ll[0], ll[1])):
            if aircraft_category(f.get("properties") or {}) == "military":
                mil += 1
    return {
        "vessels": float(vessels),
        "dark_vessels": float(dark),
        "jamming_high": float(jam["summary"]["high"]),
        "military": float(mil),
    }
