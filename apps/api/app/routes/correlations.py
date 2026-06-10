"""GET /api/correlations/{eid} — alerts that mention the given entity.

The right-panel correlation card uses this to surface other feeds touching a
selected entity. We maintain an inverted index `contributing_id -> [alerts]`
populated via a bus on_publish callback so the request handler is O(1+k)
(k = number of alerts that mention the entity) instead of O(500) per call.
"""

from __future__ import annotations

from collections import deque
from typing import Any

from fastapi import APIRouter

from app.correlate.bus import bus
from app.correlate.types import Alert

router = APIRouter(tags=["correlations"])


# Bound the index to the same window the bus keeps (`_max_recent` = 500). We
# mirror the bus's behavior here: when our local ring fills, evict the oldest
# alert AND scrub its contributing-id entries from the inverted index. This
# keeps memory O(bus._max_recent × avg_contributing_per_alert) — small.
_INDEX_MAX = 500

_index: dict[str, list[Alert]] = {}
_ring: deque[Alert] = deque(maxlen=_INDEX_MAX)


def _on_alert(alert: Alert) -> None:
    # If the ring is at cap, the about-to-be-pushed-out alert is _ring[0].
    if len(_ring) == _ring.maxlen:
        evicted = _ring[0]
        for eid in evicted.contributing:
            lst = _index.get(eid)
            if not lst:
                continue
            # Remove by identity — same Alert object we appended on publish.
            try:
                lst.remove(evicted)
            except ValueError:
                pass
            if not lst:
                _index.pop(eid, None)
    _ring.append(alert)
    for eid in alert.contributing:
        _index.setdefault(eid, []).append(alert)


# Register at import time. main.create_app imports this module via the
# router, which wires the callback before any worker publishes.
bus.on_publish(_on_alert)


@router.get("/api/correlations/{eid:path}")
async def correlations_for(eid: str, limit: int = 50) -> dict[str, Any]:
    hits = _index.get(eid, ())
    # Newest first; cap to `limit`.
    related = [a.to_json() for a in reversed(hits)][:limit]
    return {"entityId": eid, "correlations": related}
