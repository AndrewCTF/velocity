"""WebSocket /ws/ais — bridge to AISStream.io.

Per research.md §1 / research_updated.md §2.6: AISStream wants a JSON
subscription frame within 3 s of connecting; messages are unlimited but
subscription updates throttled to ~1/s. We open ONE upstream socket and
fan out to all connected browser clients to stay polite.

When no AISSTREAM_KEY is configured the WS sends an info frame and closes
cleanly so the frontend feed-health goes amber → red gracefully.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import websockets
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from app.auth import require_ws_key
from app.config import Settings, get_settings
from app.correlate.store import store
from app.correlate.types import Observation

router = APIRouter(tags=["ais"])
log = logging.getLogger(__name__)

AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"

# Module-level fan-out so we don't open one upstream socket per browser tab.
_clients: set[WebSocket] = set()
_upstream_task: asyncio.Task[None] | None = None

# Cache the most recent static ITU ship type per MMSI. PositionReport messages
# don't carry ShipType; ShipStaticData does. The lookup lets every position
# update emit a category-tagged frame so the globe can pick a per-category
# icon without waiting for the next static refresh.
_ship_type_by_mmsi: dict[int, int] = {}
# Bound the cache so a long-running session can't grow it unbounded. ~50k
# distinct MMSIs covers any plausible bbox; we evict in FIFO order beyond that.
_SHIP_TYPE_CACHE_MAX = 50_000


async def _broadcast(payload: str) -> None:
    # Concurrent sends: the old serial loop head-of-line-blocked every client
    # behind the slowest one — at AISStream message rates a single stalled tab
    # backed the whole bridge up.
    clients = list(_clients)
    if not clients:
        return
    results = await asyncio.gather(
        *(c.send_text(payload) for c in clients), return_exceptions=True
    )
    for c, res in zip(clients, results, strict=True):
        if isinstance(res, BaseException):
            _clients.discard(c)


async def _run_upstream(key: str) -> None:
    sub = {
        "APIKey": key,
        # global bbox — frontend filters by AOI later
        "BoundingBoxes": [[[-90.0, -180.0], [90.0, 180.0]]],
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    }
    backoff = 1.0
    while True:
        try:
            async with websockets.connect(AISSTREAM_URL, ping_interval=20) as ws:
                await ws.send(json.dumps(sub))
                backoff = 1.0
                async for raw in ws:
                    text = raw if isinstance(raw, str) else raw.decode("utf-8", "replace")
                    normalized = _normalize(text)
                    if normalized is not None:
                        await _broadcast(normalized)
        except Exception as e:  # noqa: BLE001
            log.warning("AISStream upstream error, reconnecting in %.1fs: %s", backoff, e)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


def _remember_ship_type(mmsi: int, ship_type: Any) -> int | None:
    """Cache a ship's ITU type code keyed by MMSI. Returns the normalized int.

    AISStream sends ShipStaticData with `ShipType` as an int 0-99. We tolerate
    string values just in case and silently drop anything else.
    """
    code: int | None = None
    if isinstance(ship_type, bool):
        code = None  # bools are ints in python; explicitly reject
    elif isinstance(ship_type, int):
        code = ship_type
    elif isinstance(ship_type, str) and ship_type.strip():
        try:
            code = int(ship_type)
        except ValueError:
            code = None
    if code is None:
        return None
    if mmsi not in _ship_type_by_mmsi and len(_ship_type_by_mmsi) >= _SHIP_TYPE_CACHE_MAX:
        # FIFO eviction — pop the oldest entry to bound memory.
        oldest = next(iter(_ship_type_by_mmsi))
        _ship_type_by_mmsi.pop(oldest, None)
    _ship_type_by_mmsi[mmsi] = code
    return code


def _normalize(text: str) -> str | None:
    try:
        msg = json.loads(text)
    except json.JSONDecodeError:
        return None
    meta = msg.get("MetaData") or {}
    msg_type = msg.get("MessageType")
    mmsi = meta.get("MMSI")
    lat = meta.get("latitude")
    lon = meta.get("longitude")
    if mmsi is None or lat is None or lon is None:
        return None
    ship_name = (meta.get("ShipName") or "").strip() or None

    # Extract / cache the ITU ship type. ShipStaticData carries it; some
    # MetaData payloads also surface it. PositionReport falls back to the
    # cached value for the same MMSI.
    body_msg = msg.get("Message") or {}
    static_body = body_msg.get("ShipStaticData") or {}
    candidate_type = (
        static_body.get("Type")
        or static_body.get("ShipType")
        or meta.get("ShipType")
    )
    if candidate_type is not None:
        _remember_ship_type(int(mmsi), candidate_type)
    ship_type = _ship_type_by_mmsi.get(int(mmsi))

    out: dict[str, Any] = {
        "kind": "vessel",
        "id": f"vessel:{mmsi}",
        "mmsi": mmsi,
        "name": ship_name,
        "lat": lat,
        "lon": lon,
        "msgType": msg_type,
        "t": meta.get("time_utc"),
        "shipType": ship_type,
    }
    body = body_msg.get("PositionReport") or {}
    if body:
        out["sog"] = body.get("Sog")  # knots
        out["cog"] = body.get("Cog")  # degrees
        out["heading"] = body.get("TrueHeading")

    # Feed the fusion engine's observation store so correlation rules can
    # join AIS + military aircraft signals (proximity_mil_vessel etc).
    try:
        store.add(
            Observation(
                id=f"vessel:{mmsi}",
                source="aisstream",
                t=time.time(),
                lon=float(lon),
                lat=float(lat),
                emits_kind="vessel",
                attrs={
                    "mmsi": mmsi,
                    "name": ship_name,
                    "sog": out.get("sog"),
                    "cog": out.get("cog"),
                    "heading": out.get("heading"),
                    "shipType": ship_type,
                },
            )
        )
    except Exception:
        pass  # never break the websocket bridge on store errors
    return json.dumps(out, separators=(",", ":"))


def _ensure_upstream(key: str) -> None:
    global _upstream_task
    if _upstream_task is None or _upstream_task.done():
        _upstream_task = asyncio.create_task(_run_upstream(key))


async def _stop_upstream() -> None:
    """Cancel the AISStream upstream task (wired into the app lifespan for a
    clean shutdown). Safe to call when none is running."""
    global _upstream_task
    task = _upstream_task
    _upstream_task = None
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass


@router.websocket("/ws/ais")
async def ais_ws(ws: WebSocket, settings: Settings = Depends(get_settings)) -> None:
    if not await require_ws_key(ws):
        await ws.close(code=1008)
        return
    await ws.accept()
    # AISStream is the key-gated upstream; the keyless Kystverket firehose
    # (started at boot) also fans out to _clients, so we accept the socket even
    # with no key — vessels still flow. We only flag info when NEITHER source
    # can run.
    if settings.aisstream_key:
        _ensure_upstream(settings.aisstream_key)
    elif not settings.ais_firehose_enabled:
        await ws.send_text(
            json.dumps(
                {
                    "kind": "info",
                    "message": "No AIS source: set AISSTREAM_KEY or enable the keyless firehose",
                }
            )
        )
        await ws.close()
        return

    _clients.add(ws)
    try:
        while True:
            # we don't expect client messages, but keep the socket draining
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(ws)
        # On-demand AISStream: when the last viewer leaves, drop the keyed
        # upstream to conserve its API cap. The keyless Kystverket firehose
        # keeps feeding the store + any future clients regardless.
        if not _clients:
            await _stop_upstream()
