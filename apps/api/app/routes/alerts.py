"""Alerts API.

GET    /api/alerts                  — recent buffer
WS     /ws/alerts                   — live push of new alerts
GET    /api/jamming/alerts          — GPS-jamming cluster events (separate section,
                                       not mixed into the main alert stream)
POST   /api/alerts/watch-session    — register the caller's token with the
                                       geofence evaluator (intel.watch)
DELETE /api/alerts/watch-session    — drop the caller's session from the evaluator
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from app.auth import require_ws_key
from app.config import get_settings
from app.correlate.bus import bus, jamming_recent
from app.intel import watch
from app.intel.geo import NM_TO_KM, haversine_km
from app.keys import UserCtx, current_user_or_local

router = APIRouter(tags=["alerts"])


@router.get("/api/alerts")
async def recent_alerts(limit: int = 50) -> dict[str, Any]:
    return {"alerts": [a.to_json() for a in bus.recent(limit)]}


@router.post("/api/alerts/watch-session")
async def register_watch_session(
    ctx: UserCtx = Depends(current_user_or_local),
) -> dict[str, Any]:
    """Make the caller's Supabase token visible to the geofence evaluator.

    The ``intel.watch`` background loop has no request of its own, so it cannot
    forge a token for its per-user RLS reads (``alert_rules`` / ``objects`` /
    ``links``). It instead sweeps an explicit registry of ACTIVE SESSIONS that an
    authed entry point supplies — this route is that entry point. The frontend
    alerts client POSTs here on mount and re-POSTs periodically so the stored
    token stays fresh. ``current_user_or_local`` degrades to the shared
    ``local`` identity on a keyless boot (no Supabase configured), the same
    predicate ``routes/alert_rules.py`` uses — the evaluator already sweeps a
    synthetic local session on its own (``evaluate_all``), so this just gives
    a keyless caller the same registration path an authed one has.

    CAVEAT — tokens expire. The registry holds whatever token the caller last
    handed over; once it expires, the loop's reads for that session 401 and
    ``_list_enabled_rules`` returns ``[]`` (no crash, but also no firings). The
    periodic re-POST refreshes the token (``register_session`` is idempotent on
    ``user_id`` and overwrites the stored token); a session whose tab is gone
    stops re-POSTing and should be dropped via the DELETE below (and the loop's
    reads simply go quiet either way).
    """
    watch.register_session(ctx)
    return {"ok": True, "active_sessions": len(watch.active_sessions())}


@router.delete("/api/alerts/watch-session")
async def unregister_watch_session(
    ctx: UserCtx = Depends(current_user_or_local),
) -> dict[str, Any]:
    """Drop the caller's session so the evaluator stops reading their rules.

    Called by the frontend alerts client on unmount. Idempotent — dropping an
    already-absent session is a no-op.
    """
    watch.unregister_session(ctx.user_id)
    return {"ok": True, "active_sessions": len(watch.active_sessions())}


@router.get("/api/alerts/standing")
async def standing_detections(
    ctx: UserCtx = Depends(current_user_or_local),
) -> dict[str, Any]:
    """Current LEVEL view of the caller's standing detections.

    ``/ws/alerts`` is EDGE-triggered: it pushes a contact CROSSING into a watch
    area, once. The "Standing detections" panel asks the LEVEL question instead —
    what is inside my enabled watch areas RIGHT NOW — which the edge stream can't
    answer consistently (it looks alive only just after a crossing or a fresh tab's
    recent-edge backfill, then goes quiet while contacts sit inside). This recomputes
    the qualifying-inside set from the evaluator's most recent shared candidate set
    against the caller's RLS-scoped rules, so the panel is stable across reloads,
    reconnects, and backend restarts. ``current_user_or_local`` keeps this reachable
    on a keyless boot (mirrors ``routes/alert_rules.py`` CRUD, which already reads/
    writes rules under the shared ``local`` identity) — the Ops panel's poll would
    otherwise 401 forever with no way to distinguish "unreachable" from "zero".
    """
    s = get_settings()
    rules = await watch._list_enabled_rules(ctx, s)
    dets = watch.standing_detections(rules, watch.current_candidates())
    counts: dict[str, int] = {}
    for d in dets:
        w = d["severity_word"]
        counts[w] = counts.get(w, 0) + 1
    return {"detections": dets, "counts": counts, "as_of": watch.candidates_as_of()}


@router.get("/api/jamming/alerts")
async def recent_jamming_alerts(
    limit: int = 50,
    # bbox filter — all four required together
    min_lon: float | None = None,
    min_lat: float | None = None,
    max_lon: float | None = None,
    max_lat: float | None = None,
    # circle filter
    lat: float | None = None,
    lon: float | None = None,
    radius_nm: float | None = None,
) -> dict[str, Any]:
    """GPS-jamming cluster events — separate section, REST-poll only (no WS).

    These are gps_jam_cluster rule firings that have been deliberately kept
    out of the main alert bus so they don't pollute the alerts ticker / drawer.
    The frontend polls this endpoint every 30 s and renders results in the
    dedicated "GPS jamming clusters" section of the Intel panel.

    Optional geo-filters (applied after the limit fetch):
    - bbox: min_lon + min_lat + max_lon + max_lat (all four together)
    - circle: lat + lon + radius_nm (all three together)
    """
    alerts = list(jamming_recent(limit))

    bbox_active = all(v is not None for v in (min_lon, min_lat, max_lon, max_lat))
    circle_active = all(v is not None for v in (lat, lon, radius_nm))

    if bbox_active:
        alerts = [
            a for a in alerts
            if min_lon <= a.lon <= max_lon and min_lat <= a.lat <= max_lat  # type: ignore[operator]
        ]

    if circle_active:
        radius_km = radius_nm * NM_TO_KM  # type: ignore[operator]
        alerts = [
            a for a in alerts
            if haversine_km(lon, lat, a.lon, a.lat) <= radius_km  # type: ignore[arg-type]
        ]

    return {"alerts": [a.to_json() for a in alerts]}


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
            except TimeoutError:
                # heartbeat to keep the socket alive through proxies
                await ws.send_text(json.dumps({"kind": "heartbeat"}))
    except WebSocketDisconnect:
        pass
    finally:
        bus.unsubscribe(q)
