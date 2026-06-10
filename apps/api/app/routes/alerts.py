"""Alerts API.

GET  /api/alerts            — recent buffer
WS   /ws/alerts             — live push of new alerts
GET  /api/jamming/alerts    — GPS-jamming cluster events (separate section,
                              not mixed into the main alert stream)
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.auth import require_ws_key
from app.correlate.bus import bus, jamming_recent

router = APIRouter(tags=["alerts"])


@router.get("/api/alerts")
async def recent_alerts(limit: int = 50) -> dict[str, Any]:
    return {"alerts": [a.to_json() for a in bus.recent(limit)]}


@router.get("/api/jamming/alerts")
async def recent_jamming_alerts(limit: int = 50) -> dict[str, Any]:
    """GPS-jamming cluster events — separate section, REST-poll only (no WS).

    These are gps_jam_cluster rule firings that have been deliberately kept
    out of the main alert bus so they don't pollute the alerts ticker / drawer.
    The frontend polls this endpoint every 30 s and renders results in the
    dedicated "GPS jamming clusters" section of the Intel panel.
    """
    return {"alerts": [a.to_json() for a in jamming_recent(limit)]}


@router.websocket("/ws/alerts")
async def alerts_ws(ws: WebSocket) -> None:
    if not await require_ws_key(ws):
        await ws.close(code=1008)
        return
    await ws.accept()
    # Backfill recent so a freshly-opened tab isn't empty
    for a in bus.recent(20):
        await ws.send_text(json.dumps(a.to_json()))
    q = bus.subscribe()
    try:
        while True:
            try:
                a = await asyncio.wait_for(q.get(), timeout=20.0)
                await ws.send_text(json.dumps(a.to_json()))
            except asyncio.TimeoutError:
                # heartbeat to keep the socket alive through proxies
                await ws.send_text(json.dumps({"kind": "heartbeat"}))
    except WebSocketDisconnect:
        pass
    finally:
        bus.unsubscribe(q)
