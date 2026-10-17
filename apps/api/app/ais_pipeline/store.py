"""Vessel store: MMSI-keyed dedup with FRESHEST-WIN, plus a spatial grid.

Why not just write into the shared ``ObservationStore``? Because that store is
last-write-wins (``add_many`` assigns ``_latest[id]`` unconditionally). Feed it
from a slow world-poll plus a fast regional feed and the SLOW one wins by
arrival order, not by data age — a cached tier steals the MMSI from a live
source. This store compares ``t`` and only overwrites with a genuinely newer
fix; ``ais_pipeline._mirror`` then bridges the survivors into the shared store
(freshness-gated per id) for ``/api/maritime/snapshot`` and the correlation
layers.

Also carries what a "full coverage" claim needs to be checkable: a coverage grid
counting distinct vessels per ocean cell, and a stale tally, so a tier that
quietly stops delivering is visible instead of inferred.
"""

from __future__ import annotations

import math
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from app.ais_pipeline.providers import Fix

# Cells for the coverage grid. 5° keeps the grid small enough to serialize for
# /api/maritime/coverage while still resolving a strait.
_GRID_DEG = 5
# A fix older than this is no longer a position: it is a wreck, a decommissioned
# hull, or a vessel whose transmitter is off. Retaining it would let a months-old
# ghost sit on the map and would poison dark-vessel matching (a "dark" contact
# next to a 6-month-old ghost is not evidence of anything).
DEFAULT_MAX_FIX_AGE_S = 86_400.0


@dataclass
class VesselState:
    """The freshest known state for one MMSI, and where it came from."""

    fix: Fix
    # Every source that has reported this MMSI, with its last-seen fix time.
    sources: dict[str, float] = field(default_factory=dict)

    @property
    def mmsi(self) -> int:
        return self.fix.mmsi

    def to_json(self) -> dict[str, Any]:
        f = self.fix
        return {
            "id": f"vessel:{f.mmsi}",
            "mmsi": f.mmsi,
            "lat": f.lat,
            "lon": f.lon,
            "t": f.t,
            "ageS": round(max(0.0, time.time() - f.t), 1),
            "sog": f.sog,
            "cog": f.cog,
            "heading": f.heading,
            "name": f.name,
            "shipType": f.ship_type,
            "flag": f.flag,
            "origin": f.origin,
            "source": f.source,
            "sources": sorted(self.sources),
        }


class VesselStore:
    """MMSI-keyed latest-fix store with freshness-wins merge."""

    def __init__(self, max_fix_age_s: float = DEFAULT_MAX_FIX_AGE_S) -> None:
        self._by_mmsi: dict[int, VesselState] = {}
        self._grid: dict[tuple[int, int], set[int]] = defaultdict(set)
        self._max_fix_age_s = max_fix_age_s
        # Counters for /api/maritime/coverage — monotonic per process.
        self.seen_total = 0
        self.rejected_stale = 0
        self.rejected_invalid = 0
        self.superseded = 0  # a newer fix replaced an older one for the same MMSI
        self.by_source: dict[str, int] = defaultdict(int)
        self._last_merge_t: float = 0.0

    # ── merge ────────────────────────────────────────────────────────────────

    def merge(self, fixes: list[Fix]) -> int:
        """Merge a batch. Returns the number of MMSIs whose state changed.

        Out-of-order and duplicate reports are expected (three tiers polling the
        same ship), so the merge is idempotent: a fix that loses on ``t`` is
        counted, not written, and the vessel keeps the position it had.
        """
        changed = 0
        for fx in fixes:
            if fx.mmsi <= 0:
                self.rejected_invalid += 1
                continue
            self.seen_total += 1
            cur = self._by_mmsi.get(fx.mmsi)
            if cur is None:
                self._write(fx)
                self.by_source[fx.source] += 1
                changed += 1
                continue
            cur.sources[fx.source] = max(cur.sources.get(fx.source, 0.0), fx.t)
            if fx.t > cur.fix.t:
                self._write(fx)
                self.superseded += 1
                changed += 1
            # else: an older duplicate of a vessel we already have fresher data
            # for. Correctly a no-op.
        self._last_merge_t = time.time()
        return changed

    def prune(self, *, now: float | None = None) -> int:
        """Drop every vessel whose freshest fix is past ``max_fix_age_s``.

        Reads already filter by age, so nothing stale was ever SERVED — but the
        dict only ever grew (measured 2026-10-04: a 6-day-old fix held under a
        24 h cap), and ``stats()["vessels"]`` counted the ghosts. Runs after a
        merge cycle rather than inside ``merge`` so a caller replaying old data
        on purpose still gets freshness-wins semantics.
        """
        if self._max_fix_age_s <= 0:
            return 0
        cutoff = (time.time() if now is None else now) - self._max_fix_age_s
        dead = [m for m, st in self._by_mmsi.items() if st.fix.t < cutoff]
        for m in dead:
            st = self._by_mmsi.pop(m)
            self._grid[self._cell(st.fix.lat, st.fix.lon)].discard(m)
        self.rejected_stale += len(dead)
        return len(dead)

    def _write(self, fx: Fix) -> None:
        prev = self._by_mmsi.get(fx.mmsi)
        if prev is not None:
            self._grid[self._cell(prev.fix.lat, prev.fix.lon)].discard(fx.mmsi)
        st = self._by_mmsi.get(fx.mmsi)
        if st is None:
            st = VesselState(fix=fx, sources={fx.source: fx.t})
            self._by_mmsi[fx.mmsi] = st
        else:
            st.fix = fx
            st.sources[fx.source] = max(st.sources.get(fx.source, 0.0), fx.t)
        self._grid[self._cell(fx.lat, fx.lon)].add(fx.mmsi)

    # ── reads ────────────────────────────────────────────────────────────────

    def __len__(self) -> int:
        return len(self._by_mmsi)

    def get(self, mmsi: int) -> VesselState | None:
        return self._by_mmsi.get(mmsi)

    def all(self, *, max_age_s: float | None = None) -> list[VesselState]:
        """Every vessel, optionally filtered to fixes newer than ``max_age_s``."""
        now = time.time()
        cap = self._max_fix_age_s if max_age_s is None else max_age_s
        if cap <= 0:
            return list(self._by_mmsi.values())
        return [s for s in self._by_mmsi.values() if now - s.fix.t <= cap]

    def in_bbox(
        self, lon0: float, lat0: float, lon1: float, lat1: float, *, max_age_s: float | None = None
    ) -> list[VesselState]:
        """Vessels inside a lon/lat box, crossing the antimeridian if needed."""
        out = []
        for st in self.all(max_age_s=max_age_s):
            lo, la = st.fix.lon, st.fix.lat
            in_lon = lon0 <= lo <= lon1 if lon0 <= lon1 else (lo >= lon0 or lo <= lon1)
            if in_lon and lat0 <= la <= lat1:
                out.append(st)
        return out

    def nearest(
        self, lat: float, lon: float, *, radius_km: float, max_age_s: float | None = None
    ) -> tuple[VesselState, float] | None:
        """Nearest vessel within ``radius_km``, with its distance.

        Great-circle (haversine) so the match radius is honest at high latitude —
        a planar approximation badly overstates reach near the poles, which is
        exactly where dark-vessel AOI work happens.
        """
        now = time.time()
        cap = self._max_fix_age_s if max_age_s is None else max_age_s
        best: tuple[VesselState, float] | None = None
        for st in self._by_mmsi.values():
            if cap > 0 and now - st.fix.t > cap:
                continue
            d = haversine_km(lat, lon, st.fix.lat, st.fix.lon)
            if d <= radius_km and (best is None or d < best[1]):
                best = (st, d)
        return best

    # ── coverage accounting ──────────────────────────────────────────────────

    @staticmethod
    def _cell(lat: float, lon: float) -> tuple[int, int]:
        # lat 90.0 exactly lands one row past the grid; it belongs to the top row.
        row = min(int((lat + 90.0) // _GRID_DEG), 180 // _GRID_DEG - 1)
        return row, int(((lon + 180.0) % 360.0) // _GRID_DEG)

    def coverage(self, *, max_age_s: float = 3600.0) -> dict[str, Any]:
        """Per-cell vessel counts + freshness, so coverage is measurable.

        ``cells`` is a dense ``[row][col]`` grid over the whole globe: row 0 is
        90S..85S, col 0 is 180W..175W. The frontend can render it directly.
        """
        rows = 180 // _GRID_DEG
        cols = 360 // _GRID_DEG
        grid = [[0] * cols for _ in range(rows)]
        fresh = stale = 0
        now = time.time()
        for st in self._by_mmsi.values():
            age = now - st.fix.t
            if age > max_age_s:
                stale += 1
                continue
            fresh += 1
            r, c = self._cell(st.fix.lat, st.fix.lon)
            grid[r][c] += 1
        return {
            "gridDeg": _GRID_DEG,
            "rows": rows,
            "cols": cols,
            "cells": grid,
            "fresh": fresh,
            "stale": stale,
            "occupiedCells": sum(1 for row in grid for n in row if n),
            "maxAgeS": max_age_s,
        }

    def stats(self) -> dict[str, Any]:
        now = time.time()
        ages = sorted(now - s.fix.t for s in self._by_mmsi.values())
        return {
            "vessels": len(self._by_mmsi),
            "seenTotal": self.seen_total,
            "bySource": dict(sorted(self.by_source.items())),
            "superseded": self.superseded,
            "rejectedInvalid": self.rejected_invalid,
            "prunedStale": self.rejected_stale,
            "ageMedianS": round(ages[len(ages) // 2], 1) if ages else None,
            "ageP95S": round(ages[int(len(ages) * 0.95)], 1) if ages else None,
            "ageMaxS": round(ages[-1], 1) if ages else None,
            "lastMergeAgeS": round(now - self._last_merge_t, 1) if self._last_merge_t else None,
            "maxFixAgeS": self._max_fix_age_s,
        }


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km."""
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))
