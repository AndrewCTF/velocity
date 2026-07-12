"""Evidence locker — chain-of-custody capture (P1).

The single largest sourced unserved need across OSINT practitioner segments
(docs/roadmap-practitioners-2026-07.md): platforms delete evidence faster than
anyone captures it, and "raw screenshots are easy to challenge". This module
turns a thing an investigation touches — a web page, an uploaded file, a globe
screenshot, or a *moment of the live world* — into a content-addressed,
hash-verified, custody-logged **evidence object**.

Design (Berkeley Protocol as the checklist — OHCHR: "the collection tool
should automatically add a hash value"):

- **Content addressing.** The object id is ``evidence:<sha256>`` where the
  SHA-256 is computed over the exact captured bytes at ingest. The hash IS the
  identity — two captures of identical bytes converge on one object (that is
  correct: same content, multiple observations), and any later mutation of the
  bytes changes the id, so a tampered blob can never masquerade as the
  original. Immutable blob bytes live under ``settings.evidence_dir`` named by
  hash; the object (metadata + custody log) lives in the local ontology store.

- **Append-only custody.** Every custody event (created, re-observed, linked to
  a case, exported) is written as an assertion on the evidence object under the
  ``custody`` prop, riding the existing append-only ``assertions`` table — the
  substrate was built for exactly this. Read the full timeline with
  ``get_assertions(id, prop="custody")`` (newest first). The materialized props
  blob keeps only the latest event; the chain lives in the assertions log.

Everything here works keyless: evidence capture is deliberately NOT a compute
path (see app/ratelimit.py::is_compute_path), so a fresh ``docker compose up``
can preserve evidence without ALLOW_UNAUTHENTICATED.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import ipaddress
import json
import socket
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from app.config import Settings, get_settings
from app.intel.ontology import Object, get_registry
from app.keys import UserCtx
from app.upstream import get_client

EVIDENCE_KIND = "evidence"
# Semantic kind of a Situation object (props.kind), for attach validation.
_SITUATION_KIND = "situation"
# Custody chains are short in practice; read generously so a long-lived exhibit's
# full timeline surfaces in detail/manifest (well under the per-object cap).
_CUSTODY_LIMIT = 5000

# Capture methods, in the roadmap's priority order.
METHOD_URL = "url"
METHOD_FILE = "file_upload"
METHOD_SCREENSHOT = "screenshot"
METHOD_FEED_FREEZE = "feed_freeze"
_METHODS = frozenset({METHOD_URL, METHOD_FILE, METHOD_SCREENSHOT, METHOD_FEED_FREEZE})

# Response headers worth notarizing on a URL capture (provenance, not the whole
# noisy set). Server/date/content-type place the capture; the security/caching
# headers help a skeptic reason about what was served.
_KEPT_HEADERS = frozenset(
    {
        "content-type",
        "content-length",
        "date",
        "last-modified",
        "etag",
        "server",
        "content-disposition",
        "content-security-policy",
        "strict-transport-security",
    }
)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def evidence_id(sha256: str) -> str:
    """Build the object id from a hash. Tolerates a full ``evidence:<sha>`` id
    being passed back in (routes take a bare ``{sha}`` path param, but callers
    that hand back the object id shouldn't double-prefix into a 404)."""
    if sha256.startswith(f"{EVIDENCE_KIND}:"):
        return sha256
    return f"{EVIDENCE_KIND}:{sha256}"


# Test-only override of the blob dir. Route handlers resolve settings via the
# cached ``get_settings()`` (not Depends), so ``dependency_overrides`` never
# reach the evidence dir — this hook mirrors ontology_local.override_db_path so
# the suite doesn't write ./data/evidence into the repo.
_DIR_OVERRIDE: str | None = None


def override_evidence_dir(path: str | None) -> None:
    global _DIR_OVERRIDE
    _DIR_OVERRIDE = path


def _blob_dir(settings: Settings) -> Path:
    return Path(_DIR_OVERRIDE or settings.evidence_dir)


def blob_path(settings: Settings, sha256: str) -> Path:
    """Sharded blob path: ``<evidence_dir>/<ab>/<sha256>``.

    Sharding by the first two hex chars keeps any single directory small even
    with hundreds of thousands of captures (256 buckets).
    """
    return _blob_dir(settings) / sha256[:2] / sha256


def _write_blob(settings: Settings, sha256: str, data: bytes) -> None:
    """Persist blob bytes idempotently (content-addressed → write-once)."""
    path = blob_path(settings, sha256)
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write to a temp sibling then atomically rename so a crash mid-write never
    # leaves a truncated blob under a hash that claims to verify. The temp name
    # is unique per writer: capture_bytes now runs this in a thread, so two
    # concurrent captures of identical bytes execute in parallel and must not
    # share one .partial file (they would double-replace it and raise). The
    # final content-addressed rename is idempotent — identical bytes either way.
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.partial")
    tmp.write_bytes(data)
    try:
        tmp.replace(path)
    except OSError:
        # A parallel writer already staged identical bytes into place; drop ours.
        tmp.unlink(missing_ok=True)


def read_blob(settings: Settings, sha256: str) -> bytes | None:
    path = blob_path(settings, sha256)
    if not path.exists():
        return None
    return path.read_bytes()


def verify_blob(settings: Settings, sha256: str) -> bool:
    """Recompute the hash of the stored blob and confirm it matches its name.

    The chain-of-custody guarantee: the bytes on disk are exactly the bytes
    that were hashed at ingest. A False here means tampering or corruption.
    """
    data = read_blob(settings, sha256)
    if data is None:
        return False
    return sha256_bytes(data) == sha256


def blob_exists(settings: Settings, sha256: str) -> bool:
    """Cheap presence check (stat, no read). Used by the manifest so exporting a
    large case is not O(all bytes); the explicit /verify route re-hashes."""
    return blob_path(settings, sha256).exists()


class EvidenceError(Exception):
    """Capture failed (too large, upstream error, unusable input)."""


def _enforce_size(data: bytes, settings: Settings) -> None:
    cap = settings.evidence_max_blob_bytes
    if cap and len(data) > cap:
        raise EvidenceError(
            f"blob is {len(data):,} bytes, over the {cap:,}-byte evidence cap"
        )


def _filename_from_url(url: str) -> str | None:
    path = urlsplit(url).path
    if not path or path.endswith("/"):
        return None
    name = unquote(path.rsplit("/", 1)[-1])
    return name or None


# Serialize the get→upsert→custody section per content-hash so two concurrent
# captures of identical bytes can't both see "no existing object" and both log a
# "created" event (the second observation must be "re-observed"). Distinct
# content never contends. In-process only — the local SQLite store is
# single-process (docs/decisions.md ontology-local-first). Ref-counted so the
# registry stays bounded to in-flight captures rather than growing one entry per
# unique hash for the process lifetime; increment/decrement are synchronous
# (no await between them) so they are race-free under the single-threaded loop.
_capture_locks: dict[str, asyncio.Lock] = {}
_capture_lock_refs: dict[str, int] = {}


@contextlib.asynccontextmanager
async def _capture_lock(obj_id: str) -> Any:
    lock = _capture_locks.get(obj_id)
    if lock is None:
        lock = asyncio.Lock()
        _capture_locks[obj_id] = lock
    _capture_lock_refs[obj_id] = _capture_lock_refs.get(obj_id, 0) + 1
    try:
        async with lock:
            yield
    finally:
        _capture_lock_refs[obj_id] -= 1
        if _capture_lock_refs[obj_id] <= 0:
            _capture_lock_refs.pop(obj_id, None)
            _capture_locks.pop(obj_id, None)


async def _append_custody(
    reg: Any, obj_id: str, event: dict[str, Any], *, at: str
) -> None:
    """Append one immutable custody event to the assertions log.

    A per-event ``nonce`` guarantees the value is unique, so the store's
    identical-(value, source) dedup can never collapse two genuine custody
    events (e.g. two same-second re-observations or a double-attach).
    """
    action = str(event.get("action", "event"))
    stamped = {**event, "nonce": uuid.uuid4().hex}
    await reg.assert_props(
        obj_id,
        {"custody": stamped},
        source=f"custody:{action}",
        observed_at=at,
        derivation={"custody": True},
    )


async def capture_bytes(
    ctx: UserCtx,
    *,
    data: bytes,
    media_type: str,
    capture_method: str,
    source_url: str | None = None,
    source_context: str | None = None,
    filename: str | None = None,
    title: str | None = None,
    extra_props: dict[str, Any] | None = None,
    settings: Settings | None = None,
) -> Object:
    """Content-address ``data``, persist the blob, and mint/observe the object.

    If the exact bytes were captured before, the original object is preserved
    (never overwritten) and a ``re-observed`` custody event is appended with the
    new context — the correct chain-of-custody behavior for re-encountering the
    same content from a different source.
    """
    if capture_method not in _METHODS:
        raise EvidenceError(f"unknown capture method {capture_method!r}")
    settings = settings or get_settings()
    _enforce_size(data, settings)

    sha = sha256_bytes(data)
    obj_id = evidence_id(sha)
    reg = get_registry(ctx, settings)

    # Persist off the event loop — a blob can be up to evidence_max_blob_bytes
    # (200 MB default); a synchronous write would stall the 1 s ADS-B cadence.
    await asyncio.to_thread(_write_blob, settings, sha, data)

    async with _capture_lock(obj_id):
        now = _now_iso()
        existing = await reg.get(obj_id)

        if existing is None:
            props: dict[str, Any] = {
                "kind": EVIDENCE_KIND,  # list_by_kind filters on props.kind
                "sha256": sha,
                "size_bytes": len(data),
                "media_type": media_type or "application/octet-stream",
                "capture_method": capture_method,
                "source_url": source_url,
                "source_context": source_context,
                "filename": filename,
                "title": title or filename or source_url or f"evidence {sha[:12]}",
                "captured_by": ctx.user_id,
                "captured_at": now,
            }
            if extra_props:
                props.update(extra_props)
            await reg.upsert(
                Object(id=obj_id, kind=EVIDENCE_KIND, props=props),
                source=f"evidence:{capture_method}",
            )

        await _append_custody(
            reg,
            obj_id,
            {
                "action": "created" if existing is None else "re-observed",
                "at": now,
                "by": ctx.user_id,
                "method": capture_method,
                "sha256": sha,
                "source_url": source_url,
                "context": source_context,
            },
            at=now,
        )
    out = await reg.get(obj_id)
    assert out is not None  # just written
    return out


def _ip_is_blocked(ip: str) -> bool:
    """Block any non-public address (SSRF guard). Unparseable → blocked."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    # Unwrap IPv4-in-IPv6 encodings to their embedded IPv4 before classifying.
    # Older CPython (the pinned python:3.12-slim container) does NOT delegate a
    # mapped literal like ::ffff:169.254.169.254 to the is_* flags, so it would
    # otherwise read as public and slip past the guard to reach cloud metadata.
    if isinstance(addr, ipaddress.IPv6Address):
        embedded = addr.ipv4_mapped or addr.sixtofour
        if embedded is None and addr.teredo is not None:
            embedded = addr.teredo[1]  # Teredo client IPv4
        if embedded is not None:
            addr = embedded
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def _validate_public_host_sync(host: str) -> None:
    infos = socket.getaddrinfo(host, None)
    if not infos:
        raise EvidenceError(f"could not resolve {host!r}")
    for info in infos:
        ip = info[4][0]
        if _ip_is_blocked(ip):
            raise EvidenceError(
                "refusing to capture a private / loopback / link-local address "
                "(SSRF guard) — only public hosts can be fetched server-side"
            )


async def _validate_public_url(url: str) -> None:
    """Reject non-http(s), hostless, and internal-address URLs before fetching.

    A keyless / open box exposes capture_url unauthenticated; without this an
    attacker could make the server fetch 169.254.169.254 (cloud metadata) or an
    internal admin port and read the bytes back via /blob. Re-run per redirect
    hop so a public URL can't 302 to an internal one. (Residual DNS-rebinding
    TOCTOU is accepted — pinning the resolved IP into the socket would need a
    custom transport; this closes the direct SSRF path.)
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise EvidenceError("only http(s) URLs can be captured")
    host = parts.hostname
    if not host:
        raise EvidenceError("URL has no host")
    try:
        await asyncio.to_thread(_validate_public_host_sync, host)
    except EvidenceError:
        raise
    except OSError as exc:
        raise EvidenceError(f"DNS resolution failed: {exc}") from exc


class _Fetched:
    __slots__ = ("status", "headers", "final_url", "body")

    def __init__(self, status: int, headers: dict[str, str], final_url: str, body: bytes):
        self.status = status
        self.headers = headers
        self.final_url = final_url
        self.body = body


async def _fetch_guarded(url: str, settings: Settings, *, max_hops: int = 5) -> _Fetched:
    """Fetch with SSRF validation on every hop and a streaming byte cap."""
    client = get_client()
    cap = settings.evidence_max_blob_bytes
    current = url
    for _ in range(max_hops + 1):
        await _validate_public_url(current)
        async with client.stream("GET", current, follow_redirects=False) as resp:
            if resp.is_redirect:
                loc = resp.headers.get("location")
                if not loc:
                    raise EvidenceError("redirect without a Location header")
                current = str(resp.url.join(loc))
                continue
            chunks: list[bytes] = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if cap and total > cap:
                    raise EvidenceError(
                        f"response exceeds the {cap:,}-byte evidence cap"
                    )
                chunks.append(chunk)
            return _Fetched(
                status=resp.status_code,
                headers={k: v for k, v in resp.headers.items()},
                final_url=str(resp.url),
                body=b"".join(chunks),
            )
    raise EvidenceError("too many redirects")


async def capture_url(
    ctx: UserCtx,
    url: str,
    *,
    source_context: str | None = None,
    settings: Settings | None = None,
) -> Object:
    """Fetch ``url`` and notarize the exact response bytes as evidence.

    Keyless MVP: stores the raw response body (self-contained for HTML/JSON/
    images) plus HTTP status, final URL, and selected response headers as
    provenance. Guarded against SSRF (private/loopback/link-local rejected on
    every redirect hop) and bounded by ``evidence_max_blob_bytes`` while
    streaming. Full headless rendering + screenshot is a documented stretch
    (kill criterion: URL capture is marked experimental if it proves flaky —
    the file/screenshot/feed-freeze paths never depend on network fetch).
    """
    settings = settings or get_settings()
    try:
        fetched = await _fetch_guarded(url, settings)
    except EvidenceError:
        raise
    except Exception as exc:  # noqa: BLE001 — surface any network failure cleanly
        raise EvidenceError(f"fetch failed: {exc}") from exc

    media_type = (
        fetched.headers.get("content-type", "application/octet-stream")
        .split(";")[0]
        .strip()
    )
    kept_headers = {
        k: v for k, v in fetched.headers.items() if k.lower() in _KEPT_HEADERS
    }
    extra = {
        "http_status": fetched.status,
        "final_url": fetched.final_url,
        "response_headers": kept_headers,
    }
    return await capture_bytes(
        ctx,
        data=fetched.body,
        media_type=media_type or "text/html",
        capture_method=METHOD_URL,
        source_url=url,
        source_context=source_context,
        filename=_filename_from_url(url),
        title=url,
        extra_props=extra,
        settings=settings,
    )


async def capture_feed_freeze(
    ctx: UserCtx,
    *,
    entity_id: str,
    snapshot: dict[str, Any],
    source_context: str | None = None,
    settings: Settings | None = None,
) -> Object:
    """Notarize a moment of the live world — an entity's current state + track.

    Unique to a self-hosted archive: nobody else can attest to a moment of the
    live feed from your own store. The snapshot is serialized to canonical JSON
    (sorted keys) so the same state always yields the same hash.
    """
    canon = json.dumps(
        {"entity_id": entity_id, "snapshot": snapshot},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return await capture_bytes(
        ctx,
        data=canon,
        media_type="application/json",
        capture_method=METHOD_FEED_FREEZE,
        source_context=source_context,
        filename=f"{entity_id.replace(':', '_')}.json",
        title=f"Live state: {entity_id}",
        extra_props={"entity_id": entity_id, "entity_snapshot": snapshot},
        settings=settings,
    )


async def list_evidence(
    ctx: UserCtx, *, limit: int = 200, settings: Settings | None = None
) -> list[Object]:
    settings = settings or get_settings()
    reg = get_registry(ctx, settings)
    return await reg.list_by_kind(EVIDENCE_KIND, limit=limit)


async def get_evidence(
    ctx: UserCtx, sha256: str, *, settings: Settings | None = None
) -> tuple[Object | None, list[dict[str, Any]]]:
    """Return (object, custody-chain) for an evidence hash (chain newest-first)."""
    settings = settings or get_settings()
    reg = get_registry(ctx, settings)
    obj = await reg.get(evidence_id(sha256))
    if obj is None:
        return None, []
    chain = await reg.get_assertions(
        evidence_id(sha256), prop="custody", limit=_CUSTODY_LIMIT
    )
    events = [a.value for a in chain if isinstance(a.value, dict)]
    return obj, events


async def attach_to_situation(
    ctx: UserCtx,
    sha256: str,
    situation_id: str,
    *,
    rel: str = "evidence",
    note: str | None = None,
    settings: Settings | None = None,
) -> None:
    """Link ``situation --evidence--> evidence:<sha>`` and log the custody event.

    Consistent with routes/situations.py::link_child (situation owns outgoing
    edges to its children); traverse(depth=1) then surfaces the evidence in the
    situation's neighbourhood and the case export walks it.
    """
    settings = settings or get_settings()
    reg = get_registry(ctx, settings)
    obj_id = evidence_id(sha256)
    from app.intel.ontology import Link

    # Don't create a dangling edge to a situation that doesn't exist (the local
    # store has no FK). A typo'd/stale id would otherwise leave an orphan link +
    # a "linked" custody event pointing at nothing, which the case export shows.
    sit = await reg.get(situation_id)
    if sit is None or (sit.props or {}).get("kind") != _SITUATION_KIND:
        raise EvidenceError(f"{situation_id} is not an existing situation")

    await reg.link(
        Link(
            src=situation_id,
            dst=obj_id,
            rel=rel,
            props={"note": note} if note else {},
        )
    )
    now = _now_iso()
    await _append_custody(
        reg,
        obj_id,
        {
            "action": "linked",
            "at": now,
            "by": ctx.user_id,
            "situation_id": situation_id,
            "rel": rel,
            "note": note,
        },
        at=now,
    )


async def custody_manifest(
    ctx: UserCtx,
    evidence_ids: list[str],
    *,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Per-case hash-of-hashes manifest with explicit Berkeley-Protocol fields.

    ``evidence_ids`` may be bare hashes or full ``evidence:<sha>`` ids. The
    ``manifest_sha256`` is the SHA-256 of the sorted member hashes joined by
    newline — a single value that verifies the whole set has not changed.
    """
    settings = settings or get_settings()
    reg = get_registry(ctx, settings)
    items: list[dict[str, Any]] = []
    for raw in evidence_ids:
        sha = raw.split(":", 1)[1] if raw.startswith(f"{EVIDENCE_KIND}:") else raw
        obj = await reg.get(evidence_id(sha))
        if obj is None:
            continue
        chain = await reg.get_assertions(
            evidence_id(sha), prop="custody", limit=_CUSTODY_LIMIT
        )
        p = obj.props
        sha_val = p.get("sha256", sha)
        items.append(
            {
                "id": obj.id,
                "sha256": sha_val,
                "title": p.get("title"),
                "media_type": p.get("media_type"),
                "size_bytes": p.get("size_bytes"),
                "capture_method": p.get("capture_method"),
                "source_url": p.get("source_url"),
                "captured_by": p.get("captured_by"),
                "captured_at": p.get("captured_at"),
                # blob_present = cheap stat (does the file exist).
                "blob_present": blob_exists(settings, sha_val),
                # blob_verified = full re-hash: the exported/court-facing report
                # must not label a present-but-tampered exhibit "verified", so we
                # actually re-hash here. Off the event loop (up to 200 MB/blob).
                "blob_verified": await asyncio.to_thread(
                    verify_blob, settings, sha_val
                ),
                "custody_events": [
                    a.value for a in chain if isinstance(a.value, dict)
                ],
            }
        )
    member_hashes = sorted(i["sha256"] for i in items)
    manifest_sha = hashlib.sha256("\n".join(member_hashes).encode()).hexdigest()
    return {
        "generated_at": _now_iso(),
        "generated_by": ctx.user_id,
        "count": len(items),
        "manifest_sha256": manifest_sha,
        "items": items,
        "berkeley_protocol": {
            "hash_algorithm": "SHA-256",
            "hash_at_collection": True,
            "custody_log": "append-only assertions (per-item custody_events)",
            "content_addressed": True,
            "note": (
                "Each item's id is evidence:<sha256> of its bytes at ingest. "
                "blob_present=true means the blob file exists (stat only); "
                "blob_verified=true means its bytes were re-hashed and still "
                "match that sha256 (tamper check). manifest_sha256 fixes the "
                "membership of the whole set."
            ),
        },
    }
