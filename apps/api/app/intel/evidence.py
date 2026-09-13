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
import json
import os
import re
import socket
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

from app.config import Settings, get_settings
from app.intel.ontology import Object, get_registry
from app.keys import UserCtx
from app.netguard import is_non_public_ip
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
# A window of the OWNED ARCHIVE rather than a moment of the live feed: what
# arrived, departed and stayed inside a box between two times. It is a distinct
# method because the custody story is different — a feed freeze attests to what
# the platform was being told right now, this attests to what the platform
# RECORDED over a span, which is the thing a stateless viewer cannot produce at
# all and the thing a skeptic will actually ask about.
METHOD_REPLAY_WINDOW = "replay_window"
_METHODS = frozenset(
    {METHOD_URL, METHOD_FILE, METHOD_SCREENSHOT, METHOD_FEED_FREEZE, METHOD_REPLAY_WINDOW}
)

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
    _totals.clear()


_SHA256_RE = re.compile(r"[0-9a-f]{64}")


def _blob_dir(settings: Settings) -> Path:
    return Path(_DIR_OVERRIDE or settings.evidence_dir)


def blob_path(settings: Settings, sha256: str) -> Path:
    """Sharded blob path: ``<evidence_dir>/<ab>/<sha256>``.

    Sharding by the first two hex chars keeps any single directory small even
    with hundreds of thousands of captures (256 buckets).

    Raises ``ValueError`` unless ``sha256`` is 64 lowercase hex chars. The hash
    reaching here is ``props.sha256`` off an ontology object, and
    ``POST /api/ontology/object`` lets a caller write any props onto an
    ``evidence:`` id, so without this a ``../`` value reads any file on the box
    (``/dev/zero`` exhausts memory) and ``blob_exists`` becomes a file oracle.
    """
    if not _SHA256_RE.fullmatch(sha256 or ""):
        raise ValueError("not a sha256 hex digest")
    return _blob_dir(settings) / sha256[:2] / sha256


def _write_blob(settings: Settings, sha256: str, data: bytes) -> None:
    """Persist blob bytes idempotently (content-addressed → write-once)."""
    path = blob_path(settings, sha256)
    if path.exists():
        return
    # Identical bytes dedup above and cost nothing; only new bytes count.
    _reserve_bytes(settings, len(data))
    # 0700 dirs, 0600 blobs, as config.py documents: captured evidence is
    # whatever an analyst fetched, and another local account must not read it.
    root = _blob_dir(settings)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    path.parent.mkdir(mode=0o700, exist_ok=True)
    path.parent.chmod(0o700)
    # Write to a temp sibling then atomically rename so a crash mid-write never
    # leaves a truncated blob under a hash that claims to verify. The temp name
    # is unique per writer: capture_bytes now runs this in a thread, so two
    # concurrent captures of identical bytes execute in parallel and must not
    # share one .partial file (they would double-replace it and raise). The
    # final content-addressed rename is idempotent — identical bytes either way.
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.partial")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
    except BaseException:
        tmp.unlink(missing_ok=True)
        _release_bytes(settings, len(data))
        raise
    if path.exists():
        # A parallel writer landed identical bytes first; they were counted once.
        _release_bytes(settings, len(data))
    try:
        tmp.replace(path)
    except OSError:
        # A parallel writer already staged identical bytes into place; drop ours.
        tmp.unlink(missing_ok=True)


def read_blob(settings: Settings, sha256: str) -> bytes | None:
    try:
        path = blob_path(settings, sha256)
    except ValueError:
        return None
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
    try:
        return blob_path(settings, sha256).exists()
    except ValueError:
        return False


class EvidenceError(Exception):
    """Capture failed (too large, upstream error, unusable input)."""


class EvidenceStorageFull(EvidenceError):
    """The locker is at ``EVIDENCE_MAX_TOTAL_BYTES`` — the route answers 507."""


# ── media type: declared vs detected (ASVS V2.2.1 / V5.2.2) ───────────────────

# RFC 6838 type/subtype token shape. The declared type is client-controlled
# (multipart Content-Type, screenshot JSON, an upstream's header) and is served
# back as Content-Type, so anything else is recorded as octet-stream.
MEDIA_TYPE_RE = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}"
)
_OCTET = "application/octet-stream"

# Leading-byte signatures for the formats evidence actually arrives as. Text
# formats (HTML, JSON, CSV) have no signature, so they are never "detected" and
# the declared type stands.
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"%PDF-", "application/pdf"),
    (b"PK\x03\x04", "application/zip"),
    (b"\x1f\x8b", "application/gzip"),
    (b"\x1aE\xdf\xa3", "video/webm"),
    (b"OggS", "audio/ogg"),
    (b"ID3", "audio/mpeg"),
    (b"II*\x00", "image/tiff"),
    (b"MM\x00*", "image/tiff"),
)


def normalize_media_type(value: str | None) -> str:
    """Declared type reduced to a bare, well-formed ``type/subtype`` (lowercase),
    or octet-stream. Parameters (``; charset=``) are dropped."""
    base = (value or "").split(";", 1)[0].strip().lower()
    return base if MEDIA_TYPE_RE.fullmatch(base) else _OCTET


def sniff_media_type(data: bytes) -> str | None:
    """Type from the leading bytes, or None when the format has no signature."""
    head = data[:16]
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[4:8] == b"ftyp":
        return "video/mp4"
    for sig, mime in _MAGIC:
        if head.startswith(sig):
            return mime
    return None


def served_media_type(props: dict[str, Any]) -> str:
    """The Content-Type ``/blob`` may send for a stored object.

    The declared type is served only when the bytes do not contradict it; on a
    disagreement (a "PNG" that is really HTML) the blob goes out as octet-stream.
    The bytes are never rejected at capture — chain of custody keeps exactly what
    arrived, and both types stay on the object for an analyst to see.
    """
    declared = normalize_media_type(props.get("media_type"))
    detected = props.get("detected_media_type")
    if isinstance(detected, str) and detected and detected != declared:
        return _OCTET
    return declared


# ── storage cap (ASVS V2.4.1) ──────────────────────────────────────────────────

_DEFAULT_MAX_TOTAL_BYTES = 20 * 1024**3
_total_lock = threading.Lock()
# blob dir -> bytes on disk, measured once per dir then kept by adding writes.
_totals: dict[str, int] = {}


def max_total_bytes() -> int:
    """``EVIDENCE_MAX_TOTAL_BYTES`` (default 20 GiB; 0 disables the cap)."""
    raw = os.getenv("EVIDENCE_MAX_TOTAL_BYTES", "").strip()
    try:
        return max(0, int(raw)) if raw else _DEFAULT_MAX_TOTAL_BYTES
    except ValueError:
        return _DEFAULT_MAX_TOTAL_BYTES


def _measure_dir(root: Path) -> int:
    total = 0
    if not root.is_dir():
        return 0
    for shard in root.iterdir():
        if not shard.is_dir():
            continue
        for blob in shard.iterdir():
            with contextlib.suppress(OSError):
                total += blob.stat().st_size
    return total


def _reserve_bytes(settings: Settings, n: int) -> None:
    """Count ``n`` new bytes against the cap, or raise EvidenceStorageFull."""
    cap = max_total_bytes()
    root = _blob_dir(settings)
    key = str(root.resolve())
    with _total_lock:
        if key not in _totals:
            _totals[key] = _measure_dir(root)
        if cap and _totals[key] + n > cap:
            raise EvidenceStorageFull(
                f"evidence store is at {_totals[key]:,} of {cap:,} bytes "
                "(EVIDENCE_MAX_TOTAL_BYTES); free space or raise the cap"
            )
        _totals[key] += n


def _release_bytes(settings: Settings, n: int) -> None:
    key = str(_blob_dir(settings).resolve())
    with _total_lock:
        if key in _totals:
            _totals[key] = max(0, _totals[key] - n)


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
                # Declared (normalized) and detected-from-bytes, side by side:
                # served_media_type() decides what /blob may send.
                "media_type": normalize_media_type(media_type),
                "detected_media_type": sniff_media_type(data),
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
    return is_non_public_ip(ip)


def _validate_public_host_sync(host: str) -> str:
    """Resolve ``host`` ONCE, refuse if any address is non-public, and return the
    address to connect to (IPv4 first: this host's IPv6 egress is broken)."""
    infos = socket.getaddrinfo(host, None)
    if not infos:
        raise EvidenceError(f"could not resolve {host!r}")
    addrs: list[str] = []
    for info in infos:
        ip = str(info[4][0])
        if _ip_is_blocked(ip):
            from app.netguard import log_refusal  # noqa: PLC0415

            log_refusal("evidence-capture", host, f"non-public address {ip}")
            raise EvidenceError(
                "refusing to capture a private / loopback / link-local address "
                "(SSRF guard) — only public hosts can be fetched server-side"
            )
        if ip not in addrs:
            addrs.append(ip)
    v4 = [a for a in addrs if ":" not in a]
    return (v4 or addrs)[0]


async def _validate_public_url(url: str) -> str:
    """Reject non-http(s), hostless, and internal-address URLs before fetching,
    and return the validated address the fetch must connect to.

    A keyless / open box exposes capture_url unauthenticated; without this an
    attacker could make the server fetch 169.254.169.254 (cloud metadata) or an
    internal admin port and read the bytes back via /blob. Re-run per redirect
    hop so a public URL can't 302 to an internal one. The returned address is
    PINNED by ``_fetch_guarded`` (ASVS V1.3.6): httpx resolving the name a second
    time is exactly the window a rebinding name (public, then 127.0.0.1) uses.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise EvidenceError("only http(s) URLs can be captured")
    host = parts.hostname
    if not host:
        raise EvidenceError("URL has no host")
    try:
        return await asyncio.to_thread(_validate_public_host_sync, host)
    except EvidenceError:
        raise
    except OSError as exc:
        raise EvidenceError(f"DNS resolution failed: {exc}") from exc


def _pinned_request(url: str, ip: str) -> tuple[str, dict[str, str], dict[str, Any]]:
    """URL aimed at ``ip`` + the headers/extensions that keep it the same request.

    ``Host`` carries the original name (virtual hosting), and for https the
    ``sni_hostname`` extension makes httpcore send that name as SNI and verify
    the certificate against it — so pinning never weakens TLS. Userinfo is
    dropped: evidence capture has no business sending credentials.
    """
    parts = urlsplit(url)
    host = parts.hostname or ""
    ip_host = f"[{ip}]" if ":" in ip else ip
    netloc = f"{ip_host}:{parts.port}" if parts.port else ip_host
    host_header = f"{host}:{parts.port}" if parts.port else host
    if ":" in host and not host.startswith("["):
        host_header = f"[{host}]:{parts.port}" if parts.port else f"[{host}]"
    pinned = urlunsplit((parts.scheme, netloc, parts.path, parts.query, ""))
    extensions: dict[str, Any] = {}
    if parts.scheme == "https":
        extensions["sni_hostname"] = host
    # Connection: close — httpcore pools by origin, which is now (scheme, ip,
    # port): a keep-alive socket opened with one name's SNI and certificate would
    # otherwise be reused for a different name on the same address.
    return pinned, {"Host": host_header, "Connection": "close"}, extensions


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
        ip = await _validate_public_url(current)
        target, headers, extensions = _pinned_request(current, ip)
        async with client.stream(
            "GET", target, headers=headers, extensions=extensions, follow_redirects=False
        ) as resp:
            if resp.is_redirect:
                loc = resp.headers.get("location")
                if not loc:
                    raise EvidenceError("redirect without a Location header")
                # Join against the NAMED url, not resp.url (the pinned address).
                current = urljoin(current, loc)
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
                final_url=current,
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


async def capture_replay_window(
    ctx: UserCtx,
    *,
    bbox: tuple[float, float, float, float],
    at_a: float,
    at_b: float,
    window_sec: int,
    kind: str | None,
    diff: dict[str, Any],
    source_context: str | None = None,
    settings: Settings | None = None,
) -> Object:
    """Notarize what changed inside a box between two moments of our own archive.

    The competitor case, stated plainly because it is the whole argument for
    this function: a stateless fusion globe can serialize its camera, its layer
    set and one tracked target into a share URL. It cannot answer "is this a
    different four vessels than last Tuesday", because it never held last
    Tuesday. We do, so the answer exists — and once it exists it should leave
    the building as something a skeptic can re-check, not as a screenshot.

    The DIFF IS COMPUTED BY THE CALLER FROM THE ARCHIVE, never accepted from the
    client. That is the difference between evidence and an assertion: a
    feed-freeze notarizes a snapshot the client handed us, which is fine for
    "this is what my console showed", but a window that claims six vessels left
    a terminal has to be something the platform derived from its own store or it
    proves nothing.

    Canonical JSON with sorted keys, so the same window over the same archive
    always yields the same hash and `GET /api/evidence/{sha}/verify` can be run
    by someone who does not trust us.
    """
    payload = {
        "bbox": list(bbox),
        "at_a": at_a,
        "at_b": at_b,
        "window_sec": window_sec,
        "kind": kind,
        "diff": diff,
    }
    canon = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    # Take the TRUE counts off the diff, never len() of the lists. window_diff
    # caps the id arrays at `limit` while its own `counts` stay honest, so
    # measuring the arrays produced an artifact that said "500 stayed" about a
    # window where 979 did. An exhibit that silently truncates is worse than no
    # exhibit: it is wrong in a way that looks precise. `truncated` is recorded
    # alongside so a reader can tell a capped list from a complete one.
    true_counts = diff.get("counts") if isinstance(diff.get("counts"), dict) else None
    counts = {
        k: int((true_counts or {}).get(k, len(diff.get(k) or [])))
        for k in ("arrived", "departed", "stayed")
    }
    truncated = {
        k: counts[k] > len(diff.get(k) or []) for k in ("arrived", "departed", "stayed")
    }
    return await capture_bytes(
        ctx,
        data=canon,
        media_type="application/json",
        capture_method=METHOD_REPLAY_WINDOW,
        source_context=source_context,
        filename="replay-window.json",
        title=(
            f"Replay window: {counts['arrived']} arrived, "
            f"{counts['departed']} departed, {counts['stayed']} stayed"
        ),
        extra_props={
            "bbox": list(bbox),
            "at_a": at_a,
            "at_b": at_b,
            "window_sec": window_sec,
            "entity_kind": kind,
            "counts": counts,
            # True when the stored id list is shorter than the count it reports.
            "truncated": truncated,
            "diff": diff,
        },
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
