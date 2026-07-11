"""Local model manager routes — ``/api/ai/hardware``, ``/api/ai/models*``,
``/api/ai/engine`` (design doc "API contract", 2026-07-11).

Keyless via ``current_user_or_local`` — same discipline as the ontology /
situations / maps / foundry routes (the store itself is not user-scoped;
single-operator local platform). ``/api/ai/models`` and ``/api/ai/engine``
(and ``/api/ai/selection``, wired by a later change) are registered in
``app.ratelimit._COMPUTE_PREFIXES`` — downloads and engine switches are cheap
per-call but gated with the rest of the cost/compute surface for consistency.
``/api/ai/hardware`` is a cheap read and is deliberately NOT in that list.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import get_settings
from app.keys import UserCtx, current_user_or_local
from app.localllm import binary, catalog, hardware, manager, state

router = APIRouter(tags=["ai-models"])


async def _probe_health(url: str) -> bool:
    """Best-effort liveness probe — never raises, short timeout so an offline
    box (the common case, no sidecar running) resolves near-instantly."""
    try:
        async with httpx.AsyncClient(timeout=0.4) as c:
            r = await c.get(url)
            return r.status_code < 500
    except (httpx.HTTPError, OSError):
        return False


@router.get("/api/ai/hardware")
async def get_hardware(_ctx: UserCtx = Depends(current_user_or_local)) -> dict[str, Any]:
    root = manager.models_root()
    gpu, ram_mb, disk_free_mb = await asyncio.gather(
        asyncio.to_thread(hardware.detect_gpu),
        asyncio.to_thread(hardware.detect_ram_mb),
        asyncio.to_thread(hardware.detect_disk_free_mb, root),
    )
    return hardware.build_report(gpu, ram_mb, disk_free_mb)


async def _engines_status() -> dict[str, Any]:
    settings = get_settings()
    root = manager.models_root()
    llamacpp_installed, llamacpp_version = await asyncio.to_thread(binary.status, settings, root)
    llamacpp_running, ollama_running = await asyncio.gather(
        _probe_health(settings.llamacpp_host.rstrip("/") + "/health"),
        _probe_health(settings.ollama_host.rstrip("/") + "/api/tags"),
    )
    vllm_running = (
        await _probe_health(settings.vllm_host.rstrip("/") + "/health")
        if settings.vllm_enabled
        else False
    )
    return {
        "llamacpp": {
            "installed": llamacpp_installed,
            "version": llamacpp_version,
            "running": llamacpp_running,
        },
        "vllm": {"installed": settings.vllm_enabled, "version": None, "running": vllm_running},
        "ollama": {"installed": ollama_running, "version": None, "running": ollama_running},
    }


@router.get("/api/ai/models")
async def get_models(_ctx: UserCtx = Depends(current_user_or_local)) -> dict[str, Any]:
    gpu, ram_mb, engines = await asyncio.gather(
        asyncio.to_thread(hardware.detect_gpu),
        asyncio.to_thread(hardware.detect_ram_mb),
        _engines_status(),
    )
    installed = await asyncio.to_thread(manager.list_installed)
    return {
        "engines": engines,
        "active": manager.get_active(),
        "hot": manager.get_hot(),
        "installed": installed,
        "catalog": catalog.catalog_payload(gpu["vram_mb"] if gpu else None, ram_mb),
    }


class DownloadIn(BaseModel):
    # Same regex as the catalog org restriction — a custom repo and a catalog
    # pick take the identical path, no "trusted" bypass.
    repo_id: str = Field(pattern=manager.REPO_ID_PATTERN)
    quant: str = Field(pattern=manager.QUANT_PATTERN, min_length=1, max_length=32)


@router.post("/api/ai/models/download", status_code=202)
async def post_download(
    body: DownloadIn, _ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    job_id = await manager.start_download(body.repo_id, body.quant)
    return {"job_id": job_id}


@router.get("/api/ai/models/download/{job_id}")
async def get_download(
    job_id: str, _ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    job = manager.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job id")
    return job


@router.delete("/api/ai/models/{key}")
async def delete_model(key: str, _ctx: UserCtx = Depends(current_user_or_local)) -> dict[str, Any]:
    await asyncio.to_thread(manager.delete_model, key)
    return {"ok": True}


class ActiveIn(BaseModel):
    role: Literal["main", "selection"]
    key: str | None = None


@router.post("/api/ai/models/active")
async def post_active(
    body: ActiveIn, _ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    active = await asyncio.to_thread(manager.set_active, body.role, body.key)
    return {"ok": True, "active": active}


class HotIn(BaseModel):
    key: str
    hot: bool


@router.post("/api/ai/models/hot")
async def post_hot(body: HotIn, _ctx: UserCtx = Depends(current_user_or_local)) -> dict[str, Any]:
    hot = await asyncio.to_thread(manager.set_hot, body.key, body.hot)
    return {"ok": True, "hot": hot}


class EngineIn(BaseModel):
    engine: Literal["auto", "llamacpp", "vllm", "ollama"]


@router.post("/api/ai/engine")
async def post_engine(
    body: EngineIn, _ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    state.set_engine(body.engine)
    return {"ok": True, "engine": state.get_engine()}
