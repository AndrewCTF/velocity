"""Collab CRDT relay hub — fan-out, sender-exclusion, room reaping."""

from __future__ import annotations

import asyncio

import pytest

from app.routes.collab import _CollabHub


async def test_publish_fans_to_peers_excluding_sender() -> None:
    hub = _CollabHub()
    a = hub.subscribe("doc1")
    b = hub.subscribe("doc1")
    c = hub.subscribe("doc1")
    sent = hub.publish("doc1", b"\x00update", exclude=a)
    assert sent == 2  # b + c, not the sender a
    assert b.get_nowait() == b"\x00update"
    assert c.get_nowait() == b"\x00update"
    assert a.empty()


async def test_room_reaped_when_empty() -> None:
    hub = _CollabHub()
    q = hub.subscribe("doc2")
    assert hub.room_size("doc2") == 1
    hub.unsubscribe("doc2", q)
    assert hub.room_size("doc2") == 0
    assert hub.publish("doc2", b"x") == 0  # gone — no peers


async def test_publish_drops_on_full_queue() -> None:
    hub = _CollabHub()
    q = hub.subscribe("doc3")
    # fill the queue to its maxsize
    for _ in range(256):
        q.put_nowait(b"x")
    # next publish can't enqueue — dropped, not raised
    assert hub.publish("doc3", b"y") == 0
    await asyncio.sleep(0)  # let the event loop settle
