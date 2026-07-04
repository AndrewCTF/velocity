"""Watch-officer briefs — /api/watch-officer/*.

Read + triage the draft briefs the ``intel.watch_officer`` loop files. Keyless,
like ``/api/alerts`` — this is a personal analyst surface reading in-process state,
and gating it behind ``current_user`` would 401 whenever Supabase is unset (the
standing-detections trap). The briefs are derived from public fusion output; there
is nothing user-scoped to protect here.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.intel import watch_officer

router = APIRouter(tags=["watch-officer"])


@router.get("/api/watch-officer/briefs")
async def briefs() -> dict[str, Any]:
    """Open draft briefs the watch-officer has filed, newest first."""
    return {"briefs": watch_officer.list_briefs()}


@router.post("/api/watch-officer/briefs/{bid}/dismiss")
async def dismiss_brief(bid: str) -> dict[str, Any]:
    """Drop a brief as noise. 404 if unknown/expired."""
    if not watch_officer.dismiss(bid):
        raise HTTPException(status_code=404, detail="unknown brief")
    return {"ok": True, "id": bid}


@router.post("/api/watch-officer/briefs/{bid}/ack")
async def ack_brief(bid: str) -> dict[str, Any]:
    """Acknowledge a brief (operator saw the finding). 404 if unknown/expired."""
    if not watch_officer.ack(bid):
        raise HTTPException(status_code=404, detail="unknown brief")
    return {"ok": True, "id": bid}
