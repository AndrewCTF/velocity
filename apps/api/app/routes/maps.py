"""Shared named COP (common operational picture) + follow-along — Track D2.

A *named map* is a saved snapshot of the analyst's operational picture: the
camera viewport, which layers are on, the active imagery overlay, the selected
entity, and the faceted filter clauses. It is persisted as an **ontology object**
(``kind='map'``, id ``map:<uuid>``) via the P0 ``OntologyRegistry`` — no new
table, RLS-scoped to the caller exactly like every other ``objects`` row. So a
COP composes on the semantic spine the same way alerts / investigations do, and
degrades to 503 when Supabase is unconfigured (the store-not-configured contract
``targets.py`` / ``ontology.py`` expose).

    GET    /api/maps                      → list the caller's saved maps (newest first)
    POST   /api/maps                      → save (insert/replace) a named map
    GET    /api/maps/{map_id}             → load one map by id (404 if absent)
    DELETE /api/maps/{map_id}             → delete a saved map
    WS     /ws/cop?map=<id>&key=…         → live FOLLOW-ALONG delta channel

The WS channel is the *follow-along*: clients that join the same ``map`` id form
a room and broadcast ephemeral viewport / selection deltas to each other (the
"slave my view to the lead analyst" mechanic). Deltas are NOT persisted and never
touch the DB — they are an in-process fan-out (``_CopHub``, the same shape as the
alert bus), so the room is purely live. ``require_ws_key`` runs BEFORE ``accept``
(mirrors ``/ws/alerts``), and because the channel does no per-user RLS read it
needs only the gate, not ``current_user``.

The DURABLE map (the saved object) and the LIVE room (the WS deltas) are two
halves: you save/load the named picture over HTTP, then optionally join its room
to follow whoever is driving. A room with one viewer is harmless (it just echoes
nothing).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.auth import require_ws_key
from app.config import Settings, get_settings
from app.intel.ontology import Object, OntologyRegistry
from app.keys import UserCtx, _client, _headers, current_user

router = APIRouter(tags=["maps"])

# The ontology object kind a saved COP uses. Stored in ``props.kind`` (the
# ontology's structural ``kind`` column stays the catch-all ``"object"`` for
# analyst-minted nodes, exactly like watch.py's Alert objects), so a list query
# filters on ``props->>kind``.
_MAP_KIND = "map"

# Bound the saved-map list so a runaway client can't ask for the whole table.
_MAX_LIST = 100


# ── serialized COP state (the named picture) ────────────────────────────────────
# Mirrors the frontend stores it is built from: the Cesium camera viewport, the
# enabled layer ids (LayerRegistry), the imagery overlay (useImagery), the
# selected entity id (useSelection), and the faceted filter clauses (useFilters).
# Every field is optional with a safe default so an older/partial save still
# loads, and unknown extra keys are ignored (forward-compatible).


class Viewport(BaseModel):
    """Camera pose — enough to restore the view with ``Cartesian3.fromDegrees``.

    ``lon``/``lat`` are the camera *position* (degrees); ``height`` is eye
    altitude in metres; ``heading``/``pitch``/``roll`` are radians (Cesium's
    own units, so the frontend round-trips them verbatim). All bounded loosely
    — we validate ranges, not exact framing.
    """

    lon: float = Field(..., ge=-180, le=180)
    lat: float = Field(..., ge=-90, le=90)
    height: float = Field(..., gt=0, le=100_000_000)
    heading: float = 0.0
    pitch: float = -1.5707963267948966  # -PI/2 (nadir / top-down)
    roll: float = 0.0


class ImageryRef(BaseModel):
    """The date-templated overlay (``useImagery.overlay``), if one is active."""

    provider: str = Field(..., max_length=120)
    layer: str = Field(..., max_length=200)
    date: str = Field(..., max_length=20)
    maxZ: int = Field(12, ge=0, le=24)
    opacity: float = Field(1.0, ge=0.0, le=1.0)


class FilterClause(BaseModel):
    """One faceted filter clause (``useFilters`` — facet/value/mode)."""

    facet: str = Field(..., max_length=40)
    value: str = Field(..., max_length=120)
    mode: Literal["only", "not"] = "only"


class CopState(BaseModel):
    """The full serialized operational picture a named map carries."""

    viewport: Viewport | None = None
    layers: list[str] = Field(default_factory=list)
    imagery: ImageryRef | None = None
    selection: str | None = Field(None, max_length=200)
    filters: list[FilterClause] = Field(default_factory=list)


class MapIn(BaseModel):
    """Save payload — a name + the picture. ``id`` lets a client overwrite an
    existing map (re-save); omit it to mint a fresh ``map:<uuid>``."""

    name: str = Field(..., min_length=1, max_length=120)
    state: CopState = Field(default_factory=CopState)
    id: str | None = Field(None, max_length=200)


class SavedMap(BaseModel):
    """A persisted COP as returned to the client."""

    id: str
    name: str
    state: CopState
    updated_at: str | None = None
    created_at: str | None = None


# ── object ↔ saved-map coercion ─────────────────────────────────────────────────
# A saved map is an ontology Object whose props carry {kind, name, state,
# updated_at}. Keep the translation in one place so the route never hand-rolls
# the props shape.


def _to_object(map_id: str, body: MapIn, ts: str) -> Object:
    return Object(
        id=map_id,
        kind="object",  # structural kind stays the catch-all; semantic kind is in props
        props={
            "kind": _MAP_KIND,
            "name": body.name,
            "state": body.state.model_dump(),
            "updated_at": ts,
        },
    )


def _from_object(obj: Object) -> SavedMap | None:
    """Adapt an ontology Object back to a SavedMap, or ``None`` if it isn't a map.

    Tolerates a partial/older ``state`` blob (CopState fields are all optional)
    and a missing name — a row that somehow lacks the map shape is skipped by the
    list rather than crashing the response.
    """
    props = obj.props or {}
    if props.get("kind") != _MAP_KIND:
        return None
    try:
        state = CopState.model_validate(props.get("state") or {})
    except Exception:  # noqa: BLE001 — a malformed blob loads as an empty picture
        state = CopState()
    return SavedMap(
        id=obj.id,
        name=str(props.get("name") or obj.id),
        state=state,
        updated_at=props.get("updated_at"),
        created_at=obj.created_at,
    )


def _maps_url(s: Settings) -> str:
    """PostgREST base for the ``objects`` table (where maps live).

    Raises the same 503 the registry does when Supabase is unconfigured, so the
    list route degrades identically to ``get``/``upsert``.
    """
    if not s.supabase_url:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return s.supabase_url.rstrip("/") + "/rest/v1/objects"


# ── HTTP: save / list / load / delete ───────────────────────────────────────────


@router.get("/api/maps", response_model=list[SavedMap])
async def list_maps(ctx: UserCtx = Depends(current_user)) -> list[SavedMap]:
    """The caller's saved COPs, newest first.

    Queries the ``objects`` table directly (the registry has no list-by-kind),
    RLS-scoped to the user AND filtered to ``props->>kind = 'map'`` so other
    ontology nodes (alerts, investigations, flagged entities) never leak into the
    map picker. 503 when Supabase is unset.
    """
    s = get_settings()
    async with _client() as c:
        r = await c.get(
            _maps_url(s),
            params={
                "user_id": f"eq.{ctx.user_id}",
                "props->>kind": f"eq.{_MAP_KIND}",
                "select": "id,kind,props,created_at",
                "order": "created_at.desc",
                "limit": str(_MAX_LIST),
            },
            headers=_headers(ctx, s),
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="map store unavailable")
    rows = r.json()
    out: list[SavedMap] = []
    for row in rows if isinstance(rows, list) else []:
        obj = Object(
            id=row.get("id"),
            kind=row.get("kind") or "object",
            props=row.get("props") or {},
            created_at=row.get("created_at"),
        )
        sm = _from_object(obj)
        if sm is not None:
            out.append(sm)
    return out


@router.post("/api/maps", response_model=SavedMap, status_code=201)
async def save_map(body: MapIn, ctx: UserCtx = Depends(current_user)) -> SavedMap:
    """Save (insert) or overwrite (when ``id`` is supplied) a named COP.

    Persisted as a ``map:`` ontology object via the registry's upsert (unique on
    ``(user_id, id)``), so re-saving the same id replaces the picture rather than
    duplicating it. 503 when Supabase is unconfigured.
    """
    s = get_settings()
    map_id = body.id or f"{_MAP_KIND}:{uuid.uuid4().hex[:12]}"
    if not map_id.startswith(f"{_MAP_KIND}:"):
        # Defend the namespace: a client must not park arbitrary objects here.
        raise HTTPException(status_code=400, detail="map id must start with 'map:'")
    reg = OntologyRegistry(ctx, s)
    stored = await reg.upsert(_to_object(map_id, body, _now_iso()))
    sm = _from_object(stored)
    if sm is None:  # upsert echoed something unexpected — surface, don't 500 silently
        raise HTTPException(status_code=502, detail="could not save map")
    return sm


@router.get("/api/maps/{map_id:path}", response_model=SavedMap)
async def load_map(map_id: str, ctx: UserCtx = Depends(current_user)) -> SavedMap:
    """Load one saved COP by id (RLS-scoped). 404 if absent / not a map.

    ``:path`` because the canonical id carries a colon (``map:ab12…``) — same
    converter ``ontology.get_object`` uses.
    """
    reg = OntologyRegistry(ctx, get_settings())
    obj = await reg.get(map_id)
    sm = _from_object(obj) if obj is not None else None
    if sm is None:
        raise HTTPException(status_code=404, detail="map not found")
    return sm


@router.delete("/api/maps/{map_id:path}", status_code=204)
async def delete_map(map_id: str, ctx: UserCtx = Depends(current_user)) -> None:
    """Delete a saved COP (own rows only, RLS-scoped). Idempotent-ish: a missing
    row is a no-op 204 (PostgREST delete of zero rows still 200/204)."""
    s = get_settings()
    async with _client() as c:
        r = await c.delete(
            _maps_url(s),
            params={"id": f"eq.{map_id}", "user_id": f"eq.{ctx.user_id}"},
            headers=_headers(ctx, s),
        )
    if r.status_code not in (200, 204):
        raise HTTPException(status_code=502, detail="could not delete map")


# ── live follow-along: an in-process room hub (the /ws/cop delta channel) ────────
# COP deltas are ephemeral (viewport moves, selection changes) and map-scoped, so
# they get their OWN tiny fan-out keyed by map id — NOT the persisted alert bus.
# One asyncio.Queue per connected client; publish() drops on a full/slow queue so
# one stalled follower can never back-pressure the room (same drop-on-error spirit
# as the ADS-B blob broadcaster).


class _CopHub:
    """Per-map pub/sub of ephemeral COP deltas (viewport / selection).

    A *room* is everyone subscribed to one ``map`` id. ``publish`` fans a delta to
    every OTHER queue in the room (the sender doesn't echo to itself). Queues are
    bounded; a full queue is skipped rather than awaited, so a slow follower is
    dropped frames, not a stall for the lead.
    """

    def __init__(self) -> None:
        # map_id → set of subscriber queues.
        self._rooms: dict[str, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)

    def subscribe(self, map_id: str) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
        self._rooms[map_id].add(q)
        return q

    def unsubscribe(self, map_id: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        room = self._rooms.get(map_id)
        if room is None:
            return
        room.discard(q)
        if not room:
            # Reap the empty room so the dict doesn't grow unbounded with the
            # ids of every map ever joined.
            self._rooms.pop(map_id, None)

    def publish(
        self,
        map_id: str,
        delta: dict[str, Any],
        *,
        exclude: asyncio.Queue[dict[str, Any]] | None = None,
    ) -> int:
        """Fan ``delta`` to the room. Returns how many followers it reached.

        ``exclude`` is the sender's own queue (it already has the state). A full
        queue is skipped (drop-on-slow), never awaited.
        """
        room = self._rooms.get(map_id)
        if not room:
            return 0
        sent = 0
        for q in list(room):
            if q is exclude:
                continue
            try:
                q.put_nowait(delta)
                sent += 1
            except asyncio.QueueFull:
                pass
        return sent

    def room_size(self, map_id: str) -> int:
        return len(self._rooms.get(map_id, ()))


cop_hub = _CopHub()

# Cap an inbound delta so a client can't push an unbounded blob through the room.
_MAX_DELTA_BYTES = 8192
# Delta kinds we relay. Anything else is ignored (forward-compatible, and a
# client can't smuggle arbitrary control messages to peers).
_RELAY_KINDS: frozenset[str] = frozenset(("viewport", "selection", "filters", "ping"))


@router.websocket("/ws/cop")
async def cop_ws(ws: WebSocket, map: str | None = None) -> None:
    """Live follow-along room for one named map (``?map=<id>``).

    Auth gate FIRST (``require_ws_key`` before ``accept`` — the WS invariant),
    then join the room. Frames are JSON ``{kind, ...}``; a client SENDS its own
    viewport/selection deltas and RECEIVES everyone else's, so opening this on two
    tabs slaves one view to the other. Heartbeats keep the socket alive through
    proxies. The channel is ephemeral — nothing here reads or writes the DB, so it
    needs only the key gate, not ``current_user``.
    """
    if not await require_ws_key(ws):
        await ws.close(code=1008)
        return
    # A room id is required — without it there's nobody to follow. Accept first so
    # the client gets a clean close frame with a reason rather than a bare 403.
    if not map:
        await ws.accept()
        await ws.send_text(json.dumps({"kind": "error", "error": "missing ?map=<id>"}))
        await ws.close(code=1008)
        return

    await ws.accept()
    map_id = map
    q = cop_hub.subscribe(map_id)

    async def _pump_out() -> None:
        """Forward deltas published by peers to this socket (+ heartbeat).

        Returns on disconnect rather than raising, so the gathered task finishes
        cleanly (no 'Task exception was never retrieved'). A send to a gone socket
        raises WebSocketDisconnect/RuntimeError — both end this pump.
        """
        while True:
            try:
                delta = await asyncio.wait_for(q.get(), timeout=20.0)
                await ws.send_text(json.dumps(delta))
            except TimeoutError:
                try:
                    await ws.send_text(json.dumps({"kind": "heartbeat"}))
                except (WebSocketDisconnect, RuntimeError):
                    return
            except (WebSocketDisconnect, RuntimeError):
                return

    async def _pump_in() -> None:
        """Read this socket's outbound deltas and fan them to the room.

        Returns on disconnect (the common path — the client closes the tab); the
        WebSocketDisconnect is swallowed HERE so the task ends without leaving an
        unretrieved exception when the other pump is cancelled.
        """
        while True:
            try:
                raw = await ws.receive_text()
            except (WebSocketDisconnect, RuntimeError):
                return
            if len(raw) > _MAX_DELTA_BYTES:
                continue  # oversized — ignore, don't relay
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(msg, dict):
                continue
            kind = msg.get("kind")
            if kind not in _RELAY_KINDS or kind == "ping":
                continue
            # Re-stamp the map so a peer can't relay into a different room, and
            # publish to everyone EXCEPT the sender.
            cop_hub.publish(map_id, {**msg, "map": map_id}, exclude=q)

    try:
        # Announce current room size so a joiner knows whether anyone is driving.
        # Inside the try so a join-send to an already-gone socket still unsubscribes
        # q in the finally (otherwise the queue would leak in the room).
        await ws.send_text(
            json.dumps(
                {"kind": "joined", "map": map_id, "followers": cop_hub.room_size(map_id)}
            )
        )
        # Run both directions; whichever finishes first (a disconnect) tears down
        # the other.
        out_task = asyncio.create_task(_pump_out())
        in_task = asyncio.create_task(_pump_in())
        _, pending = await asyncio.wait(
            {out_task, in_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for t in pending:
            t.cancel()
            try:
                await t  # retrieve the CancelledError so it isn't logged as orphaned
            except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                pass
    except (WebSocketDisconnect, RuntimeError):
        # A disconnect during the join send (or an already-closed socket) — the
        # finally still unsubscribes, so just exit quietly (matches /ws/alerts).
        pass
    finally:
        cop_hub.unsubscribe(map_id, q)


def _now_iso() -> str:
    import time

    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
