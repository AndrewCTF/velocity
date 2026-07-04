"""Collab CRDT relay hub — fan-out, sender-exclusion, room reaping."""

from __future__ import annotations

import asyncio

import pytest

from app.routes import collab as collab_mod
from app.routes.collab import _CollabHub
from app.security import Principal


class _FakeWS:
    headers: dict = {}
    query_params: dict = {"key": "tok"}


def _async(val):  # type: ignore[no-untyped-def]
    async def _f(*a: object, **k: object) -> object:
        return val
    return _f


async def test_join_gate_open_when_auth_disabled(monkeypatch) -> None:
    monkeypatch.setattr(collab_mod, "_auth_enabled", lambda s: False)
    assert await collab_mod._collab_join_allowed(_FakeWS(), "doc") is True  # type: ignore[arg-type]


async def test_join_gate_denies_undercleared(monkeypatch) -> None:
    monkeypatch.setattr(collab_mod, "_auth_enabled", lambda s: True)
    monkeypatch.setattr(collab_mod, "principal_for_token", _async(Principal("u", "tok", clearance=2)))
    monkeypatch.setattr(collab_mod, "_doc_acl", _async((3, [])))  # SECRET doc
    assert await collab_mod._collab_join_allowed(_FakeWS(), "doc") is False  # type: ignore[arg-type]


async def test_join_gate_allows_cleared(monkeypatch) -> None:
    monkeypatch.setattr(collab_mod, "_auth_enabled", lambda s: True)
    monkeypatch.setattr(
        collab_mod, "principal_for_token", _async(Principal("u", "tok", clearance=3, compartments=("FVEY",)))
    )
    monkeypatch.setattr(collab_mod, "_doc_acl", _async((3, ["FVEY"])))
    assert await collab_mod._collab_join_allowed(_FakeWS(), "doc") is True  # type: ignore[arg-type]


async def test_join_gate_new_doc_allowed(monkeypatch) -> None:
    monkeypatch.setattr(collab_mod, "_auth_enabled", lambda s: True)
    monkeypatch.setattr(collab_mod, "principal_for_token", _async(Principal("u", "tok", clearance=0)))
    monkeypatch.setattr(collab_mod, "_doc_acl", _async(None))  # doc does not exist yet
    assert await collab_mod._collab_join_allowed(_FakeWS(), "doc") is True  # type: ignore[arg-type]


async def test_join_gate_denies_no_principal(monkeypatch) -> None:
    monkeypatch.setattr(collab_mod, "_auth_enabled", lambda s: True)
    monkeypatch.setattr(collab_mod, "principal_for_token", _async(None))
    assert await collab_mod._collab_join_allowed(_FakeWS(), "doc") is False  # type: ignore[arg-type]


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
