"""Real-time multi-analyst collaboration — CRDT relay + classified snapshots.

Two surfaces for one shared document (an investigation graph / annotation set):

* ``WS /ws/collab?doc=<id>`` — a binary fan-out room. Every Yjs update / awareness
  frame a client sends is relayed to the other peers in the room; the server is a
  dumb relay (no server-side Yjs engine). Frames are ``[tag][payload]`` where tag
  ``0x00`` = sync update, ``0x01`` = awareness, ``0xFF`` = heartbeat (server-sent).
  Live relay is key-gated only — like ``/ws/cop`` it touches no DB.

* ``GET /api/collab/{doc}`` / ``POST /api/collab/{doc}/snapshot`` — persistence,
  RLS-gated. A user can only load/save a doc's state if their clearance covers the
  doc's classification (``collab_docs`` RLS), and may not tag a snapshot above
  their own clearance/compartments. The LIVE channel join is also clearance-gated
  (the bearer is resolved to a Principal and the doc ACL read via the
  ``collab_doc_acl`` SECURITY DEFINER RPC) so an under-cleared user is rejected
  before ``accept``. Residual: a doc reclassified UPWARD mid-session is re-checked
  only on the next join, not per frame.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.auth import _auth_enabled, _bearer, require_ws_key
from app.config import get_settings
from app.intel import classification as clf
from app.keys import _client, _headers
from app.security import Principal, current_principal, principal_for_token

router = APIRouter(tags=["collab"])

_MAX_UPDATE_BYTES = 256 * 1024  # a Yjs update/snapshot frame ceiling
_HEARTBEAT = b"\xff"


class _CollabHub:
    """Per-doc set of subscriber queues carrying raw binary frames."""

    def __init__(self) -> None:
        self._rooms: dict[str, set[asyncio.Queue[bytes]]] = {}

    def subscribe(self, doc: str) -> asyncio.Queue[bytes]:
        q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=256)
        self._rooms.setdefault(doc, set()).add(q)
        return q

    def unsubscribe(self, doc: str, q: asyncio.Queue[bytes]) -> None:
        room = self._rooms.get(doc)
        if room is None:
            return
        room.discard(q)
        if not room:
            self._rooms.pop(doc, None)

    def publish(self, doc: str, data: bytes, *, exclude: asyncio.Queue[bytes] | None = None) -> int:
        """Fan ``data`` to every peer except ``exclude``. Drop-on-slow, never await."""
        room = self._rooms.get(doc)
        if not room:
            return 0
        sent = 0
        for q in list(room):
            if q is exclude:
                continue
            try:
                q.put_nowait(data)
                sent += 1
            except asyncio.QueueFull:
                pass
        return sent

    def room_size(self, doc: str) -> int:
        return len(self._rooms.get(doc, ()))


collab_hub = _CollabHub()


def _ws_token(ws: WebSocket) -> str:
    return (
        _bearer(ws.headers)
        or ws.query_params.get("key")
        or ws.headers.get("x-api-key")
        or ""
    )


async def _doc_acl(token: str, doc: str) -> tuple[int, list[str]] | None:
    """A doc's (classification, compartments) via the definer RPC, or None if the
    doc does not exist yet (new doc) / the store is unreachable."""
    s = get_settings()
    if not s.supabase_url:
        return None
    url = s.supabase_url.rstrip("/") + "/rest/v1/rpc/collab_doc_acl"
    headers = {
        "apikey": s.supabase_anon_key,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        async with _client() as c:
            r = await c.post(url, json={"p_doc": doc}, headers=headers)
    except Exception:  # noqa: BLE001 — store down → fail closed below
        return None
    if r.status_code != 200:
        return None
    rows = r.json()
    if not rows:
        return None
    row = rows[0]
    return int(row.get("classification") or 0), list(row.get("compartments") or [])


async def _collab_join_allowed(ws: WebSocket, doc: str) -> bool:
    """Clearance gate for the LIVE channel. On an auth-enabled deployment, an
    under-cleared user must not receive a classified doc's live updates even if
    they know the id. On a keyless dev box (auth disabled) the gate is a no-op."""
    s = get_settings()
    if not _auth_enabled(s):
        return True
    p = await principal_for_token(_ws_token(ws))
    if p is None:
        return False
    acl = await _doc_acl(p.token, doc)
    if acl is None:
        return True  # new doc (or store unreachable) — creating, allow
    level, comps = acl
    return clf.can_read(p.clearance, list(p.compartments), level, comps)


@router.websocket("/ws/collab")
async def collab_ws(ws: WebSocket, doc: str | None = None) -> None:
    # Gate fully BEFORE accept (the WS invariant) — key, doc id, then clearance.
    if not await require_ws_key(ws):
        await ws.close(code=1008)
        return
    if not doc:
        await ws.close(code=1008)
        return
    if not await _collab_join_allowed(ws, doc):
        await ws.close(code=1008)
        return
    await ws.accept()
    q = collab_hub.subscribe(doc)

    async def _out() -> None:
        while True:
            try:
                data = await asyncio.wait_for(q.get(), timeout=25.0)
            except TimeoutError:
                data = _HEARTBEAT  # detect a dead socket; client ignores 0xFF
            try:
                await ws.send_bytes(data)
            except (WebSocketDisconnect, RuntimeError):
                return

    async def _in() -> None:
        while True:
            try:
                data = await ws.receive_bytes()
            except (WebSocketDisconnect, RuntimeError, KeyError):
                return
            if not data or len(data) > _MAX_UPDATE_BYTES:
                continue
            collab_hub.publish(doc, data, exclude=q)

    out_task = asyncio.create_task(_out())
    in_task = asyncio.create_task(_in())
    try:
        _, pending = await asyncio.wait({out_task, in_task}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
    finally:
        collab_hub.unsubscribe(doc, q)


# ── persistence (RLS-gated via the user's own token) ──────────────────────────


def _collab_url() -> str:
    s = get_settings()
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return s.supabase_url.rstrip("/") + "/rest/v1/collab_docs"


class SnapshotBody(BaseModel):
    state: str = Field(..., min_length=1, max_length=2_000_000)  # base64 Yjs state
    kind: str = Field("investigation", max_length=40)
    classification: int = 0
    compartments: list[str] = Field(default_factory=list)


@router.get("/api/collab/{doc_id:path}")
async def load_doc(doc_id: str, p: Principal = Depends(current_principal)) -> dict[str, Any]:
    s = get_settings()
    async with _client() as c:
        r = await c.get(
            _collab_url(),
            params={"doc_id": f"eq.{doc_id}", "select": "state,classification,compartments,kind", "limit": "1"},
            headers=_headers(p, s),  # type: ignore[arg-type]
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="collab store unavailable")
    rows = r.json()
    if not rows:  # new doc, or not cleared (RLS hid it) — caller starts fresh
        return {"exists": False, "doc_id": doc_id}
    row = rows[0]
    return {
        "exists": True,
        "doc_id": doc_id,
        "state": row.get("state"),
        "kind": row.get("kind"),
        "classification": row.get("classification", 0),
        "marking": clf.marking(row.get("classification", 0), row.get("compartments")),
    }


@router.post("/api/collab/{doc_id:path}/snapshot")
async def save_snapshot(
    doc_id: str, body: SnapshotBody, p: Principal = Depends(current_principal)
) -> dict[str, Any]:
    level = clf.clamp(body.classification)
    if level > p.clearance:
        raise HTTPException(status_code=403, detail="cannot classify above your clearance")
    if not clf.holds(p.compartments, body.compartments):
        raise HTTPException(status_code=403, detail="cannot use compartments you do not hold")
    s = get_settings()
    row = {
        "doc_id": doc_id,
        "kind": body.kind,
        "classification": level,
        "compartments": body.compartments,
        "owner_uid": p.user_id,
        "state": body.state,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    headers = {**_headers(p, s, write=True), "Prefer": "resolution=merge-duplicates,return=minimal"}  # type: ignore[arg-type]
    async with _client() as c:
        r = await c.post(_collab_url(), json=row, headers=headers)
    if r.status_code not in (200, 201, 204):
        raise HTTPException(status_code=502, detail="could not save collab snapshot")
    return {"ok": True, "doc_id": doc_id, "marking": clf.marking(level, body.compartments)}
