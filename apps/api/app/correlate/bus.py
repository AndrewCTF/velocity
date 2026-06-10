"""Async alert pub/sub. Workers publish; WS clients subscribe."""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator, Callable

from app.correlate.types import Alert

# Separate ring-buffer for GPS-jamming cluster events.  These are NOT pushed
# to the main alert bus (no WS push, no alerts ticker/drawer) — the frontend
# polls /api/jamming/alerts independently so the operator sees them in their
# own dedicated section.
JAMMING_RECENT: deque[Alert] = deque(maxlen=200)


def jamming_recent(n: int = 50) -> list[Alert]:
    """Return up to *n* most-recent GPS-jamming cluster alerts."""
    items = list(JAMMING_RECENT)
    return items[-n:]


class AlertBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[Alert]] = set()
        self._recent: list[Alert] = []
        self._max_recent = 500
        # Synchronous on-publish callbacks for things that want to maintain
        # indexes off the alert stream (e.g. correlations route inverted index).
        # Kept sync so the publish path stays cheap and exception-isolated.
        self._on_publish: list[Callable[[Alert], None]] = []

    def subscribe(self) -> asyncio.Queue[Alert]:
        q: asyncio.Queue[Alert] = asyncio.Queue(maxsize=200)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[Alert]) -> None:
        self._subscribers.discard(q)

    def on_publish(self, cb: Callable[[Alert], None]) -> Callable[[], None]:
        """Register a synchronous callback invoked for every published alert.
        Returns an unsubscribe handle. Callbacks are isolated — exceptions are
        swallowed so a misbehaving index can't kill the publish path."""
        self._on_publish.append(cb)

        def _off() -> None:
            try:
                self._on_publish.remove(cb)
            except ValueError:
                pass

        return _off

    def publish(self, alert: Alert) -> None:
        self._recent.append(alert)
        if len(self._recent) > self._max_recent:
            del self._recent[: len(self._recent) - self._max_recent]
        for cb in self._on_publish:
            try:
                cb(alert)
            except Exception:
                # Indexes must never break the publish path.
                pass
        for q in list(self._subscribers):
            try:
                q.put_nowait(alert)
            except asyncio.QueueFull:
                pass

    def recent(self, n: int = 50) -> list[Alert]:
        return list(self._recent[-n:])

    async def stream(self) -> AsyncIterator[Alert]:
        q = self.subscribe()
        try:
            while True:
                yield await q.get()
        finally:
            self.unsubscribe(q)


bus = AlertBus()
