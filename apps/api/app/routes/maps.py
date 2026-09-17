"""Shared named COP (common operational picture) + follow-along — Track D2.

A *named map* is a saved snapshot of the analyst's operational picture: the
camera viewport, which layers are on, the active imagery overlay, the selected
entity, and the faceted filter clauses. It is persisted as an **ontology object**
(``kind='map'``, id ``map:<uuid>``) via the ontology registry — no new
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

from app import ws_limits
from app.auth import _bearer, require_ws_key
from app.config import get_settings
from app.intel.ontology import Object, get_registry
from app.keys import UserCtx, multi_user, user_id_for_token
from app.routes.ontology import (
    _refuse_overwrite_of_hidden_row,
    _refuse_write_above_clearance,
)
from app.security import Principal, current_principal_or_local

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
    # updated_at is typed str | None; pydantic v2 raises on a non-string value, and
    # props is a user-writable blob (POST /api/ontology/object is keyless), so a
    # crafted int/dict here would 500 the whole list. Coerce anything non-str to None.
    _upd = props.get("updated_at")
    return SavedMap(
        id=obj.id,
        name=str(props.get("name") or obj.id),
        state=state,
        updated_at=_upd if isinstance(_upd, str) else None,
        created_at=obj.created_at,
    )



def _reg(p: Principal, settings=None, *, filtered: bool = True):  # type: ignore[no-untyped-def]
    """The registry for this caller, clearance-filtered unless asked otherwise.

    ``current_principal_or_local`` mirrors ``current_user_or_local`` exactly, so
    ``UserCtx(p.user_id, p.token)`` is the identity these routes always scoped
    by; what is new is that the principal's clearance now reaches the store.
    """
    ctx = UserCtx(user_id=p.user_id, token=p.token)
    return get_registry(ctx, settings or get_settings(), principal=p if filtered else None)


# ── HTTP: save / list / load / delete ───────────────────────────────────────────


@router.get("/api/maps", response_model=list[SavedMap])
async def list_maps(p: Principal = Depends(current_principal_or_local)) -> list[SavedMap]:
    """The caller's saved COPs, newest first.

    ``list_by_kind`` filters on ``props->>kind = 'map'`` so other ontology
    nodes (alerts, investigations, flagged entities) never leak into the map
    picker.
    """
    reg = _reg(p)
    objs = await reg.list_by_kind(_MAP_KIND, limit=_MAX_LIST)
    out: list[SavedMap] = []
    for obj in objs:
        sm = _from_object(obj)
        if sm is not None:
            out.append(sm)
    return out


@router.post("/api/maps", response_model=SavedMap, status_code=201)
async def save_map(body: MapIn, p: Principal = Depends(current_principal_or_local)) -> SavedMap:
    """Save (insert) or overwrite (when ``id`` is supplied) a named COP.

    Persisted as a ``map:`` ontology object via the registry's upsert (unique on
    ``(user_id, id)``), so re-saving the same id replaces the picture rather than
    duplicating it. 503 when Supabase is unconfigured.

    ``id`` makes this an id-keyed overwrite and ``props`` is replaced wholesale,
    so the same two gates ``routes/ontology.py`` applies to its own upsert apply
    here: a caller may not classify above their own clearance and may not land a
    write on a row they are not cleared to read (otherwise a clearance-0 caller
    declassifies and replaces a classified COP it cannot even GET).
    """
    s = get_settings()
    map_id = body.id or f"{_MAP_KIND}:{uuid.uuid4().hex[:12]}"
    if not map_id.startswith(f"{_MAP_KIND}:"):
        # Defend the namespace: a client must not park arbitrary objects here.
        raise HTTPException(status_code=400, detail="map id must start with 'map:'")
    obj = _to_object(map_id, body, _now_iso())
    _refuse_write_above_clearance(p, obj.classification, obj.compartments)
    await _refuse_overwrite_of_hidden_row(p, map_id)
    reg = _reg(p, s)
    stored = await reg.upsert(obj)
    sm = _from_object(stored)
    if sm is None:  # upsert echoed something unexpected — surface, don't 500 silently
        raise HTTPException(status_code=502, detail="could not save map")
    return sm


@router.get("/api/maps/{map_id:path}", response_model=SavedMap)
async def load_map(map_id: str, p: Principal = Depends(current_principal_or_local)) -> SavedMap:
    """Load one saved COP by id (RLS-scoped). 404 if absent / not a map.

    ``:path`` because the canonical id carries a colon (``map:ab12…``) — same
    converter ``ontology.get_object`` uses.
    """
    reg = _reg(p)
    obj = await reg.get(map_id)
    sm = _from_object(obj) if obj is not None else None
    if sm is None:
        raise HTTPException(status_code=404, detail="map not found")
    return sm


@router.delete("/api/maps/{map_id:path}", status_code=204)
async def delete_map(map_id: str, p: Principal = Depends(current_principal_or_local)) -> None:
    """Delete a saved COP (own rows only, RLS-scoped). Idempotent-ish: a missing
    row is a no-op 204 (PostgREST delete of zero rows still 200/204).

    The same gate as an overwrite, because delete DESTROYS the row: the store's
    ``delete`` is not clearance-filtered, so without it a clearance-0 caller
    erases a classified COP it cannot read.
    """
    await _refuse_overwrite_of_hidden_row(p, map_id)
    reg = _reg(p)
    await reg.delete(map_id)


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
    # Per-client socket cap (ASVS V2.4.1, app/ws_limits.py): after the key
    # gate, before accept, released however the handler ends.
    slot = ws_limits.acquire(ws)
    if slot is None:
        await ws.close(code=1008)
        return
    try:
        # A room id is required — without it there's nobody to follow. Accept first so
        # the client gets a clean close frame with a reason rather than a bare 403.
        if not map:
            await ws.accept()
            await ws.send_text(json.dumps({"kind": "error", "error": "missing ?map=<id>"}))
            await ws.close(code=1008)
            return

        # Multi-user (ASVS V8.2.2): only a user who can LOAD the map may join its
        # room, and the room is keyed by owner + id, since two users can each own a
        # ``map:abc``. Saved maps are owner-scoped with no sharing model yet, so
        # follow-along on a multi-user deployment is between one user's own tabs
        # and devices. A caller with no user (static key) is refused. Single-user:
        # unchanged.
        room = map
        if multi_user():
            uid = await user_id_for_token(_bearer(ws.headers) or ws.query_params.get("key"))
            obj = None
            if uid:
                obj = await get_registry(UserCtx(user_id=uid, token=""), get_settings()).get(map)
            if obj is None or _from_object(obj) is None:
                await ws.close(code=1008)
                return
            room = f"{uid}|{map}"

        await ws.accept()
        map_id = map
        q = cop_hub.subscribe(room)

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
                cop_hub.publish(room, {**msg, "map": map_id}, exclude=q)

        try:
            # Announce current room size so a joiner knows whether anyone is driving.
            # Inside the try so a join-send to an already-gone socket still unsubscribes
            # q in the finally (otherwise the queue would leak in the room).
            await ws.send_text(
                json.dumps(
                    {"kind": "joined", "map": map_id, "followers": cop_hub.room_size(room)}
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
            cop_hub.unsubscribe(room, q)
    finally:
        ws_limits.release(slot)


def _now_iso() -> str:
    import time

    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
