"""Sliding-window in-memory Observation store.

Phase 1 implementation — single process, bounded by retention AND total count
so memory + per-tick scan time stay predictable under heavy ADS-B/AIS load.
Latest-per-entity index gives O(1) "current state" lookups without scanning.

At 2200 aircraft observed every 15s × 1h ≈ 530k observations — well above
the cap, so the deque rolls; old entries fall off. Migrates to TimescaleDB
hypertable in Phase 2 per the plan §locked-decisions #5.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Iterable

from app.correlate.types import Observation

DEFAULT_RETENTION_SEC = 3600  # 1h
DEFAULT_MAX_COUNT = 200_000

# Cadence at which _evict() also does a full retention sweep of _latest.
# Per-call pruning handles the common case (popleft → drop _latest if it's the
# same entry); the periodic sweep catches the long tail of stale ids whose
# latest fix predates retention but never reaches the buffer front (because
# the entity stopped emitting before falling off).
_LATEST_SWEEP_INTERVAL = 200


class ObservationStore:
    def __init__(
        self,
        retention_sec: float = DEFAULT_RETENTION_SEC,
        max_count: int = DEFAULT_MAX_COUNT,
    ) -> None:
        self._buf: deque[Observation] = deque(maxlen=max_count)
        self._retention = retention_sec
        self._latest: dict[str, Observation] = {}
        self._evict_count = 0

    def add(self, obs: Observation) -> None:
        self._buf.append(obs)
        self._latest[obs.id] = obs
        self._evict()

    def add_many(self, batch: Iterable[Observation]) -> None:
        for o in batch:
            self._buf.append(o)
            self._latest[o.id] = o
        self._evict()

    def _evict(self) -> None:
        self._evict_count += 1
        cutoff = time.time() - self._retention
        while self._buf and self._buf[0].t < cutoff:
            popped = self._buf.popleft()
            # If the entry we just dropped from the front IS the latest fix
            # for this id, the latest is now stale too — drop it. Avoids the
            # "stale latest hangs around forever for a no-longer-emitting id"
            # case without an O(N) sweep on every call.
            current = self._latest.get(popped.id)
            if current is popped:
                del self._latest[popped.id]
        # Periodic full sweep catches stale latest entries whose buffer
        # observation already fell off via maxlen (not popleft). Runs on a
        # FIXED CADENCE only — never per-call. A global high-cardinality feed
        # (AISStream whole-world firehose) keeps _latest well above any size
        # threshold permanently, so a `len(...) > N` trigger here turned EVERY
        # add() into an O(n) dict rebuild on the event loop and wedged the whole
        # backend (all routes, incl the /tiles/basemap globe texture, timed out).
        # _latest is naturally bounded by distinct ids seen within retention, so
        # the cadence sweep is enough. ponytail: amortized O(n / interval).
        if self._evict_count % _LATEST_SWEEP_INTERVAL == 0:
            cutoff2 = time.time() - self._retention
            self._latest = {k: v for k, v in self._latest.items() if v.t >= cutoff2}

    def window(self, seconds: float, kinds: set[str] | None = None) -> list[Observation]:
        cutoff = time.time() - seconds
        return [
            o for o in self._buf
            if o.t >= cutoff and (kinds is None or o.emits_kind in kinds)
        ]

    def latest(self, kind: str | None = None) -> list[Observation]:
        """Latest fix per entity id, optionally filtered by kind. O(N) over
        distinct entities seen this retention window — typically a fraction
        of the full buffer length.

        Always filters by retention so callers never see fixes older than the
        store's retention window, even if _evict hasn't run since the entry
        went stale.
        """
        cutoff = time.time() - self._retention
        if kind is None:
            return [o for o in self._latest.values() if o.t >= cutoff]
        return [o for o in self._latest.values() if o.t >= cutoff and o.emits_kind == kind]

    def latest_for(self, entity_id: str) -> Observation | None:
        o = self._latest.get(entity_id)
        if o is None:
            return None
        if o.t < time.time() - self._retention:
            return None
        return o

    def __len__(self) -> int:
        return len(self._buf)


store = ObservationStore()
