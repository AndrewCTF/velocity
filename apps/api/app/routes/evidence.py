"""Evidence locker routes (P1) — chain-of-custody capture + retrieval.

Turns what an investigation touches into hash-verified, custody-logged evidence
objects (see app/intel/evidence.py for the design). Every route runs keyless
(``current_user_or_local``) and none is a compute path, so a fresh
``docker compose up`` can preserve evidence without ALLOW_UNAUTHENTICATED.

Capture paths, in the roadmap's priority order:
- POST /api/evidence/capture/url          — URL → self-contained page capture
- POST /api/evidence/upload               — file/image/video upload (multipart)
- POST /api/evidence/capture/screenshot   — globe/app screenshot (base64 PNG)
- POST /api/evidence/capture/feed-freeze  — notarize a moment of the live world

Retrieval / custody:
- GET  /api/evidence                       — list captured evidence
- GET  /api/evidence/{sha}                 — object + append-only custody chain
- GET  /api/evidence/{sha}/blob            — original bytes (hash re-verified)
- GET  /api/evidence/{sha}/verify          — {ok, sha256}
- POST /api/evidence/{sha}/attach          — link into a Situation (case file)
- POST /api/evidence/manifest              — per-case hash-of-hashes manifest
"""

from __future__ import annotations

import asyncio
import base64
import re
import time
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field

from app import history
from app.audit import audit_mutation
from app.config import get_settings
from app.intel import evidence as ev
from app.intel.ontology import Object, visible_to
from app.keys import UserCtx, current_user_or_local
from app.security import Principal, current_principal_or_local
from app.uploads import read_capped

router = APIRouter(tags=["evidence"], dependencies=[Depends(audit_mutation)])

# ~24 MB of base64 (~18 MB decoded) — ample for a screenshot, bounds the JSON
# body so a giant paste can't be buffered into memory. Files use the multipart
# upload path (streamed + capped) for anything larger.
_MAX_B64 = 24_000_000


def _content_disposition(filename: str, disposition: str = "inline") -> str:
    """Build a header-safe Content-Disposition. A user-supplied filename with
    non-Latin-1 chars (e.g. Cyrillic) or a quote/CRLF would otherwise raise
    UnicodeEncodeError at the ASGI layer (HTTP 500). Emit an ASCII fallback plus
    the RFC 5987 UTF-8 form so the real name survives where supported.

    The quoted fallback keeps only ``[A-Za-z0-9._ -]`` (ASVS V5.4.2): a trailing
    backslash escapes the closing quote of an RFC 6266 quoted-string, and tab or
    NUL make the header invalid. The percent-encoded ``filename*`` carries the
    real name."""
    ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "", filename).strip() or "download"
    return (
        f"{disposition}; filename=\"{ascii_name}\"; "
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )


# ── request/response models ────────────────────────────────────────────────


class CaptureUrlIn(BaseModel):
    url: str = Field(min_length=1, max_length=4000)
    context: str | None = Field(default=None, max_length=8000)
    situation_id: str | None = Field(default=None, max_length=200)


class CaptureScreenshotIn(BaseModel):
    # base64-encoded image bytes (data-URL prefix tolerated).
    data_base64: str = Field(min_length=1, max_length=_MAX_B64)
    # A type/subtype token (ASVS V2.2.1): it is served back as Content-Type.
    media_type: str = Field(
        default="image/png", max_length=200, pattern=f"^{ev.MEDIA_TYPE_RE.pattern}$"
    )
    title: str | None = Field(default=None, max_length=400)
    context: str | None = Field(default=None, max_length=8000)
    situation_id: str | None = Field(default=None, max_length=200)


class FeedFreezeIn(BaseModel):
    entity_id: str = Field(min_length=1, max_length=200)
    snapshot: dict[str, Any]
    context: str | None = Field(default=None, max_length=8000)
    situation_id: str | None = Field(default=None, max_length=200)


class ReplayWindowIn(BaseModel):
    """A box and two moments. Deliberately NOT a diff — the server computes that
    from its own archive, so the evidence is something the platform derived
    rather than something the caller asserted."""

    lamin: float = Field(ge=-90, le=90)
    lomin: float = Field(ge=-180, le=180)
    lamax: float = Field(ge=-90, le=90)
    lomax: float = Field(ge=-180, le=180)
    at_a: float = Field(description="Centre of the earlier window, epoch seconds")
    at_b: float | None = Field(default=None, description="Centre of the later window; default now")
    window_sec: int = Field(default=600, ge=60, le=86_400)
    kind: str | None = Field(default=None, max_length=32)
    context: str | None = Field(default=None, max_length=8000)
    situation_id: str | None = Field(default=None, max_length=200)


class AttachIn(BaseModel):
    situation_id: str = Field(min_length=1, max_length=200)
    rel: str = Field(default="evidence", max_length=64)
    note: str | None = Field(default=None, max_length=2000)


class ManifestIn(BaseModel):
    evidence_ids: list[str] = Field(default_factory=list, max_length=5000)


class EvidenceDetail(BaseModel):
    object: Object
    custody: list[dict[str, Any]]
    blob_present: bool


# ── helpers ─────────────────────────────────────────────────────────────────


async def _maybe_attach(ctx: UserCtx, obj: Object, situation_id: str | None) -> None:
    """Best-effort attach during capture: the evidence is already preserved, so a
    bad/stale situation_id must not fail the capture — the explicit /attach route
    is the one that 404s on an unknown situation."""
    if not situation_id:
        return
    sha = obj.props.get("sha256")
    if not sha:
        return
    try:
        await ev.attach_to_situation(ctx, sha, situation_id)
    except ev.EvidenceError:
        pass



def _ctx(p: Principal) -> UserCtx:
    """The user-scoping half of the principal — the identity these routes used
    before clearance reached them (``current_principal_or_local`` mirrors
    ``current_user_or_local``)."""
    return UserCtx(user_id=p.user_id, token=p.token)


def _readable(p: Principal, obj: Object) -> bool:
    """Is this evidence object within the caller's clearance?

    The READ gate for the locker. ``intel/evidence.py`` builds its own registry
    (it is the capture path too, and capture must not be clearance-filtered), so
    these routes filter what comes back rather than pushing the principal down
    — through the SAME predicate the registry uses, so the two cannot drift.
    """
    return visible_to(p, obj.classification, obj.compartments)


def _capture_error(exc: ev.EvidenceError) -> HTTPException:
    # A full locker is the server's condition, not a bad request (ASVS V2.4.1).
    if isinstance(exc, ev.EvidenceStorageFull):
        return HTTPException(status_code=507, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


# ── capture ─────────────────────────────────────────────────────────────────


@router.post("/api/evidence/capture/url", response_model=Object)
async def capture_url(
    body: CaptureUrlIn, ctx: UserCtx = Depends(current_user_or_local)
) -> Object:
    """Fetch a URL and notarize the exact response bytes (hash + headers)."""
    try:
        obj = await ev.capture_url(ctx, body.url, source_context=body.context)
    except ev.EvidenceError as exc:
        raise _capture_error(exc) from exc
    await _maybe_attach(ctx, obj, body.situation_id)
    return obj


@router.post("/api/evidence/upload", response_model=Object)
async def upload_evidence(
    file: UploadFile = File(...),
    context: str = Form(""),
    title: str = Form(""),
    situation_id: str = Form(""),
    ctx: UserCtx = Depends(current_user_or_local),
) -> Object:
    """Upload a file/image/video; SHA-256 at ingest, original bytes preserved."""
    # Chunked, stops at the cap: a multi-GB upload is never fully buffered.
    data = await read_capped(file, get_settings().evidence_max_blob_bytes)
    if not data:
        raise HTTPException(status_code=422, detail="empty upload")
    media_type = file.content_type or "application/octet-stream"
    try:
        obj = await ev.capture_bytes(
            ctx,
            data=data,
            media_type=media_type,
            capture_method=ev.METHOD_FILE,
            source_context=context or None,
            filename=file.filename,
            title=title or file.filename or None,
        )
    except ev.EvidenceError as exc:
        raise _capture_error(exc) from exc
    await _maybe_attach(ctx, obj, situation_id or None)
    return obj


@router.post("/api/evidence/capture/screenshot", response_model=Object)
async def capture_screenshot(
    body: CaptureScreenshotIn, ctx: UserCtx = Depends(current_user_or_local)
) -> Object:
    """Attach a globe/app screenshot (base64 PNG) as evidence."""
    raw = body.data_base64
    if "," in raw and raw.lstrip().startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail="invalid base64") from exc
    if not data:
        raise HTTPException(status_code=422, detail="empty screenshot")
    try:
        obj = await ev.capture_bytes(
            ctx,
            data=data,
            media_type=body.media_type or "image/png",
            capture_method=ev.METHOD_SCREENSHOT,
            source_context=body.context,
            title=body.title,
        )
    except ev.EvidenceError as exc:
        raise _capture_error(exc) from exc
    await _maybe_attach(ctx, obj, body.situation_id)
    return obj


@router.post("/api/evidence/capture/feed-freeze", response_model=Object)
async def capture_feed_freeze(
    body: FeedFreezeIn, ctx: UserCtx = Depends(current_user_or_local)
) -> Object:
    """Notarize an entity's current live state + track as evidence."""
    try:
        obj = await ev.capture_feed_freeze(
            ctx,
            entity_id=body.entity_id,
            snapshot=body.snapshot,
            source_context=body.context,
        )
    except ev.EvidenceError as exc:
        raise _capture_error(exc) from exc
    await _maybe_attach(ctx, obj, body.situation_id)
    return obj


@router.post("/api/evidence/capture/replay-window", response_model=Object)
async def capture_replay_window(
    body: ReplayWindowIn, ctx: UserCtx = Depends(current_user_or_local)
) -> Object:
    """Notarize what changed inside a box between two moments of the archive.

    The one thing a stateless globe cannot do. It can serialize a camera and a
    tracked target into a link; it cannot tell you the four vessels off that
    terminal are a different four to last Tuesday's, because it never held last
    Tuesday. This freezes that answer into the evidence locker with a SHA-256
    over canonical JSON, so it can be attached to a case and re-verified by
    someone who does not trust us.

    The diff is computed HERE from our own store. Accepting one from the client
    would make this a notary for whatever the caller typed.
    """
    b = time.time() if body.at_b is None else body.at_b
    bbox = (body.lomin, body.lamin, body.lomax, body.lamax)
    diff = await history.window_diff(
        body.kind,
        bbox,
        body.at_a - body.window_sec,
        body.at_a + body.window_sec,
        b - body.window_sec,
        b + body.window_sec,
        # The route's own ceiling, not the 500 default: an exhibit should carry
        # as much of the answer as the store will give it, and `truncated` on
        # the artifact says so when even this was not enough.
        5000,
    )
    try:
        obj = await ev.capture_replay_window(
            ctx,
            bbox=bbox,
            at_a=body.at_a,
            at_b=b,
            window_sec=body.window_sec,
            kind=body.kind,
            diff=diff,
            source_context=body.context,
        )
    except ev.EvidenceError as exc:
        raise _capture_error(exc) from exc
    await _maybe_attach(ctx, obj, body.situation_id)
    return obj


# ── retrieval / custody ──────────────────────────────────────────────────────


@router.get("/api/evidence", response_model=list[Object])
async def list_evidence(
    limit: int = Query(200, ge=1, le=1000),
    p: Principal = Depends(current_principal_or_local),
) -> list[Object]:
    rows = await ev.list_evidence(_ctx(p), limit=limit)
    return [o for o in rows if _readable(p, o)]


@router.get("/api/evidence/{sha}", response_model=EvidenceDetail)
async def get_evidence_detail(
    sha: str, p: Principal = Depends(current_principal_or_local)
) -> EvidenceDetail:
    obj, custody = await ev.get_evidence(_ctx(p), sha)
    # Out of clearance answers exactly like absent, so a sha cannot be probed.
    if obj is None or not _readable(p, obj):
        raise HTTPException(status_code=404, detail="evidence not found")
    # read + re-hash off the loop: a blob can be up to 200 MB, and a synchronous
    # hash here would block the 1 s ADS-B poll / WS push for the whole read.
    present = await asyncio.to_thread(
        ev.verify_blob, get_settings(), obj.props.get("sha256", sha)
    )
    return EvidenceDetail(object=obj, custody=custody, blob_present=present)


@router.get("/api/evidence/{sha}/blob")
async def get_evidence_blob(
    sha: str, p: Principal = Depends(current_principal_or_local)
) -> Response:
    """Return the original captured bytes. The hash is re-verified first, so a
    corrupted/tampered blob 409s rather than serving bad evidence."""
    settings = get_settings()
    obj, _ = await ev.get_evidence(_ctx(p), sha)
    if obj is None or not _readable(p, obj):
        raise HTTPException(status_code=404, detail="evidence not found")
    canonical = obj.props.get("sha256", sha)
    # read + re-hash off the loop (blobs are up to 200 MB — see get_evidence_detail).
    data = await asyncio.to_thread(ev.read_blob, settings, canonical)
    if data is None:
        raise HTTPException(status_code=404, detail="blob missing")
    if await asyncio.to_thread(ev.sha256_bytes, data) != canonical:
        raise HTTPException(status_code=409, detail="blob failed hash verification")
    # Declared type only when the bytes do not contradict it (ASVS V5.2.2).
    media_type = ev.served_media_type(obj.props)
    filename = str(obj.props.get("filename") or canonical[:16])
    return Response(
        content=data,
        media_type=media_type,
        headers={
            # media_type is client-declared (normalized to a type/subtype token
            # and overridden when the bytes disagree), and the locker runs keyless on the open
            # default. Force a download and forbid MIME sniffing + script/embed
            # execution so an anonymous text/html or image/svg+xml blob cannot
            # run in the app's origin when someone opens /blob directly. The FE
            # thumbnail/download paths fetch() the bytes, so disposition doesn't
            # affect them.
            "Content-Disposition": _content_disposition(filename, "attachment"),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-SHA256": canonical,
        },
    )


@router.get("/api/evidence/{sha}/verify")
async def verify_evidence(
    sha: str, p: Principal = Depends(current_principal_or_local)
) -> dict[str, Any]:
    obj, _ = await ev.get_evidence(_ctx(p), sha)
    if obj is None or not _readable(p, obj):
        raise HTTPException(status_code=404, detail="evidence not found")
    canonical = obj.props.get("sha256", sha)
    ok = await asyncio.to_thread(ev.verify_blob, get_settings(), canonical)
    return {"ok": ok, "sha256": canonical}


@router.post("/api/evidence/{sha}/attach")
async def attach_evidence(
    sha: str, body: AttachIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    obj, _ = await ev.get_evidence(ctx, sha)
    if obj is None:
        raise HTTPException(status_code=404, detail="evidence not found")
    try:
        await ev.attach_to_situation(
            ctx, sha, body.situation_id, rel=body.rel, note=body.note
        )
    except ev.EvidenceError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"attached": True, "situation_id": body.situation_id, "sha256": sha}


@router.post("/api/evidence/manifest")
async def evidence_manifest(
    body: ManifestIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    """Per-case hash-of-hashes custody manifest (Berkeley-checklist fields)."""
    return await ev.custody_manifest(ctx, body.evidence_ids)
