"""tar1090 globe_history heatmap chunks: proxy, cache, decode, coverage.

Public keyless aggregators (globe.adsb.fi reaches 2024-01-01, adsb.lol has
gaps) serve readsb's 30-minute heatmap chunks at
`globe_history/YYYY/MM/DD/heatmap/NN.bin.ttf`, where NN is 2*hourUTC +
floor(minuteUTC/30) zero-padded. A chunk is packed `<iiihh` entries:
slice-separators carry the slice timestamp, and in between are positions,
callsigns, and squawks. The separator's alt field is the slice interval in
ms — 30 s on most hosts, 10 s on adsb.lol (180 slices per half hour).

This module proxies those chunks with a browser User-Agent, gzip-caches
them under the data dir (LRU by atime, under `heatmap_cache_gb`), decodes
them into the track shape the globe's replay owner consumes, and reports
which days a host covers — so the globe can replay any half hour back to
2024 without ever having recorded the fix itself.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import math
import os
import struct
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from app.config import get_settings
from app.routes.adsb import _FEED_UA
from app.upstream import get_client

log = logging.getLogger(__name__)

_SEPARATOR_HEX = 0xE7F7C9D
_SEP_BYTES = struct.pack("<i", _SEPARATOR_HEX)
_ENTRY = struct.Struct("<iiihh")
_ENTRY_LEN = _ENTRY.size  # 16
_DEFAULT_INTERVAL_MS = 30_000
_CACHE_GRACE_S = 60.0  # a chunk is only cacheable once its half hour is 60 s closed
_CHUNK_TIMEOUT_S = 20.0
_COVERAGE_TTL_S = 24 * 3600
_COVERAGE_MAX_DAYS = 366
_COVERAGE_CHUNK_INDEX = 24  # the 12:00-12:30 UTC chunk: one probe per (day, host)
_COVERAGE_CONCURRENCY = 8

_ADDR_TYPE_NAMES = [
    "adsb_icao",
    "adsb_icao_nt",
    "adsr_icao",
    "tisb_icao",
    "adsc",
    "mlat",
    "other",
    "mode_s",
    "adsb_other",
    "adsr_other",
    "tisb_trackfile",
    "tisb_other",
    "mode_ac",
]


def chunk_index(dt: datetime) -> int:
    """A UTC clock instant -> the half-hour chunk of its day (0..47)."""
    utc = dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)
    return 2 * utc.hour + utc.minute // 30


def chunk_key(day: date, index: int) -> str:
    """Stable key for one half hour: the URL path after /globe_history."""
    return f"{day:%Y/%m/%d}/{index:02d}"


def _data_dir() -> Path:
    """The data dir: wherever the history db lives (default ./data)."""
    return Path(get_settings().history_db_path).parent


def cache_path(day: date, index: int) -> Path:
    """On-disk cache location for one chunk: <data>/heatmap/YYYY/MM/DD/NN.bin.ttf.gz."""
    return (
        _data_dir()
        / "heatmap"
        / f"{day:%Y}"
        / f"{day:%m}"
        / f"{day:%d}"
        / f"{index:02d}.bin.ttf.gz"
    )


def _enabled_hosts() -> list[str]:
    """heatmap_hosts in configured order, minus anything disabled.

    A host is disabled when it equals an ADSB_DISABLED_HOSTS entry or ends
    with one, compared on the lowercased domain — so `adsb.fi` also drops
    `globe.adsb.fi`.
    """
    settings = get_settings()
    hosts = [h.strip() for h in (settings.heatmap_hosts or "").split(",") if h.strip()]
    off = {h.strip().lower() for h in (settings.adsb_disabled_hosts or "").split(",") if h.strip()}
    if not off:
        return hosts
    return [h for h in hosts if not any(h.lower().endswith(entry) for entry in off)]


def _chunk_end(day: date, index: int) -> datetime:
    start = datetime(day.year, day.month, day.day, tzinfo=UTC) + timedelta(minutes=index * 30)
    return start + timedelta(minutes=30)


def _has_separator(body: bytes) -> bool:
    """A genuine chunk carries a slice separator on a 16-byte boundary.

    `bytes.find` keeps this a C-speed scan over the whole (up to 18 MB)
    body instead of a million-iteration Python loop; the alignment check
    keeps the semantics exact - a separator byte-sequence that only
    shows up mid-entry is not a separator.
    """
    off = 0
    while True:
        found = body.find(_SEP_BYTES, off)
        if found < 0:
            return False
        if found % _ENTRY_LEN == 0:
            return True
        off = found + 1


def _read_cache(path: Path) -> bytes | None:
    """The gzipped chunk on disk, or None when missing/corrupt.

    Corrupt is a MISS, not an error: a gzip cut short raises EOFError (not
    OSError), and a wrong-shape payload decompresses just fine — both are
    deleted and re-fetched from the hosts, never surfaced as a 500 that
    retries on the same poisoned file forever. Touches atime on a hit so
    the LRU eviction in `enforce_cache_budget` keeps what the operator
    actually replays.
    """
    try:
        with gzip.open(path, "rb") as fh:
            blob = fh.read()
    except Exception:  # noqa: BLE001 — truncation is EOFError, a bad stream zlib.error
        if path.exists():
            log.info("heatmap cache: %s is unreadable, deleting and refetching", path.name)
        path.unlink(missing_ok=True)
        return None
    if len(blob) % _ENTRY_LEN != 0 or not _has_separator(blob):
        log.info("heatmap cache: %s is not a chunk shape, deleting and refetching", path.name)
        path.unlink(missing_ok=True)
        return None
    try:
        os.utime(path, None)
    except OSError:
        pass
    return blob


def _write_cache(path: Path, body: bytes) -> None:
    """Atomically: a kill or ENOSPC mid-write must not leave a partial .gz
    behind — a truncated gzip is a 500 on every retry of that chunk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with gzip.open(tmp, "wb") as fh:
        fh.write(body)
    tmp.replace(path)
    enforce_cache_budget(int(get_settings().heatmap_cache_gb * 1024**3))


async def fetch_chunk(day: date, index: int) -> tuple[bytes, str] | None:
    """The raw 30-minute chunk for day/index: disk cache, else the enabled hosts.

    Returns ``(bytes, host)`` — the host that served it, or `"cache"`.
    A 200 is only trusted when its length is a multiple of 16 and it
    carries a separator; anything else (404, 200-with-wrong-shape,
    network error) logs one line with host + status — never the body —
    and tries the next host. All failures return None, never raise.
    The open half hour is served but NOT cached.
    """
    cached = await asyncio.to_thread(_read_cache, cache_path(day, index))
    if cached is not None:
        return cached, "cache"

    client = get_client()
    for host in _enabled_hosts():
        url = f"https://{host}/globe_history/{day:%Y/%m/%d}/heatmap/{index:02d}.bin.ttf"
        try:
            resp = await client.get(url, headers={"User-Agent": _FEED_UA}, timeout=_CHUNK_TIMEOUT_S)
        except httpx.HTTPError as exc:
            log.info(
                "heatmap chunk %s: %s unreachable (%s)",
                chunk_key(day, index),
                host,
                exc.__class__.__name__,
            )
            continue
        if resp.status_code != 200:
            log.info(
                "heatmap chunk %s: %s -> HTTP %d",
                chunk_key(day, index),
                host,
                resp.status_code,
            )
            continue
        body = resp.content
        if len(body) % _ENTRY_LEN != 0 or not _has_separator(body):
            log.info(
                "heatmap chunk %s: %s -> 200 but %d bytes is not a chunk, trying next host",
                chunk_key(day, index),
                host,
                len(body),
            )
            continue
        if _chunk_end(day, index).timestamp() < time.time() - _CACHE_GRACE_S:
            try:
                await asyncio.to_thread(_write_cache, cache_path(day, index), body)
            except OSError:
                # A cache-write failure (ENOSPC, read-only dir) must never
                # fail a chunk the host already served — it is served anyway.
                log.info(
                    "heatmap chunk %s: cache write failed, serving anyway", chunk_key(day, index)
                )
        return body, host
    return None


def enforce_cache_budget(max_bytes: int) -> None:
    """Keep the on-disk cache under `max_bytes`, dropping stalest atime first.

    Only `*.gz` chunk files count; the coverage cache is exempt. Called
    after every cache write.
    """
    root = _data_dir() / "heatmap"
    if max_bytes <= 0 or not root.is_dir():
        return
    files = [(path, path.stat()) for path in root.rglob("*.gz") if path.is_file()]
    if not files:
        return
    total = sum(st.st_size for _, st in files)
    if total < max_bytes:
        return
    files.sort(key=lambda pair: pair[1].st_atime)
    for path, st in files:
        if total < max_bytes:
            break
        try:
            path.unlink()
            total -= st.st_size
        except OSError:
            log.info("heatmap cache: could not evict %s", path)


def _fmt_hex(hex_u32: int) -> str:
    """Six lowercase ICAO24 hex digits, `~`-prefixed when bit 24 says the
    address is not ICAO (the readsb heatmap marks those)."""
    prefix = "~" if (hex_u32 >> 24) & 1 else ""
    return f"{prefix}{hex_u32 & 0xFFFFFF:06x}"


def _addr_type(hex_u32: int) -> str:
    kind = (hex_u32 >> 27) & 0x1F
    return _ADDR_TYPE_NAMES[kind] if kind < len(_ADDR_TYPE_NAMES) else "unknown"


def chunk_interval_ms(buf: bytes) -> int:
    """The slice interval in ms the chunk reports, from its FIRST separator.

    A readsb separator entry (hex == `_SEPARATOR_HEX`, the 16-byte
    little-endian `<iiihh` layout of `decode_chunk`) carries the slice
    timestamp split across the lat/lon fields and the slice interval in ms
    in the alt field. Hosts that serve 10 s slices (adsb.lol: 180 slices
    per half hour) carry 10000; the 30 s default covers a separator with
    no positive interval and a chunk with no separator at all.
    """
    interval_ms = _DEFAULT_INTERVAL_MS
    for i in range(len(buf) // _ENTRY_LEN):
        hex_i, _, _, alt_i, _ = _ENTRY.unpack_from(buf, i * _ENTRY_LEN)
        if (hex_i & 0xFFFFFFFF) == _SEPARATOR_HEX:
            if alt_i > 0:
                interval_ms = alt_i
            break
    return interval_ms


def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial great-circle course from fix 1 to fix 2, degrees 0-360.

    Heatmap chunks store no bearing of their own, so a track is derived
    from where the same hex last was in this chunk.
    """
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    x = math.sin(dlon) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def decode_chunk(buf: bytes) -> dict:
    """Pure decode of a raw chunk into slices of positions + callsigns.

    Position entries carry a derived `track` (course from the previous fix
    of the same hex in this chunk; None for the first fix). Altitude is
    feet (ground/None for the -123/-124 sentinels), ground speed knots
    (None for the -1 sentinel).
    """
    slices: list[dict[str, Any]] = []
    interval_ms = _DEFAULT_INTERVAL_MS
    cur: dict[str, Any] | None = None
    last_fix: dict[str, tuple[float, float]] = {}

    for i in range(len(buf) // _ENTRY_LEN):
        hex_i, lat_i, lon_i, alt_i, gs_i = _ENTRY.unpack_from(buf, i * _ENTRY_LEN)
        hex_u32 = hex_i & 0xFFFFFFFF
        if hex_u32 == _SEPARATOR_HEX:
            ts_ms = ((lat_i & 0xFFFFFFFF) << 32) | (lon_i & 0xFFFFFFFF)
            if alt_i > 0:
                interval_ms = alt_i
            cur = {"t": ts_ms / 1000.0, "positions": [], "callsigns": {}}
            slices.append(cur)
            continue
        if cur is None:
            continue  # entries before the first separator belong to no slice
        if lat_i >= (1 << 30):
            hex_label = _fmt_hex(hex_u32)
            raw = buf[i * _ENTRY_LEN + 8 : (i + 1) * _ENTRY_LEN]
            callsign = raw.decode("ascii", "replace").rstrip(" \x00") if raw[0] else ""
            cur["callsigns"][hex_label] = {"callsign": callsign, "squawk": f"{lat_i & 0xFFFF:04d}"}
            continue
        hex_label = _fmt_hex(hex_u32)
        lat, lon = lat_i / 1e6, lon_i / 1e6
        if alt_i == -123:
            alt: str | int | None = "ground"
        elif alt_i == -124:
            alt = None
        else:
            alt = alt_i * 25
        gs: float | None = None if gs_i == -1 else gs_i / 10.0
        track: float | None = None
        prev = last_fix.get(hex_label)
        if prev is not None:
            track = _bearing(prev[0], prev[1], lat, lon)
        last_fix[hex_label] = (lat, lon)
        cur["positions"].append(
            {
                "hex": hex_label,
                "addrtype": _addr_type(hex_u32),
                "lat": lat,
                "lon": lon,
                "alt": alt,
                "gs": gs,
                "track": track,
            }
        )

    return {"interval_ms": interval_ms, "slices": slices}


def tracks_from_chunk(decoded: dict, bbox: tuple[float, float, float, float] | None = None) -> dict:
    """Shape a decoded chunk like /api/history/tracks, so replay treats
    upstream history exactly like owned history.

    `bbox` (min_lon, min_lat, max_lon, max_lat) keeps a track if ANY of
    its points is inside; None keeps all of them.
    """
    points_by_hex: dict[str, list[Any]] = {}
    callsign_by_hex: dict[str, str] = {}
    for sl in decoded.get("slices", []):
        t = sl["t"]
        for hex_label, row in sl.get("callsigns", {}).items():
            if row.get("callsign"):
                callsign_by_hex[hex_label] = row["callsign"]
        for p in sl.get("positions", []):
            points_by_hex.setdefault(p["hex"], []).append([p["lon"], p["lat"], t, p["track"]])

    tracks: list[dict[str, Any]] = []
    for hex_label, pts in points_by_hex.items():
        if bbox is not None:
            min_lon, min_lat, max_lon, max_lat = bbox
            if not any(
                min_lon <= lon <= max_lon and min_lat <= lat <= max_lat for lon, lat, _, _ in pts
            ):
                continue
        tracks.append(
            {
                "id": f"aircraft:{hex_label}",
                "kind": "aircraft",
                "points": pts,
                "callsign": callsign_by_hex.get(hex_label),
            }
        )
    return {"tracks": tracks, "source": "upstream"}


def _coverage_cache_path() -> Path:
    return _data_dir() / "heatmap" / "coverage.json"


def _coverage_cache_read() -> dict:
    try:
        return json.loads(_coverage_cache_path().read_text())
    except (OSError, ValueError):
        return {}


def _coverage_cache_write(cache: dict) -> None:
    path = _coverage_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("coverage.json.tmp")
    tmp.write_text(json.dumps(cache))
    tmp.replace(path)


async def _probe_chunk(client: httpx.AsyncClient, host: str, day: date) -> bool | None:
    """Does the day's noon chunk exist on this host? A 16-byte Range GET.

    True/False are definitive (200/206 vs 404/416) and get cached;
    anything else — network error, 5xx — is None and is NOT cached, so a
    dead upstream re-probes next time instead of a 24 h false absence.
    """
    url = f"https://{host}/globe_history/{day:%Y/%m/%d}/heatmap/{_COVERAGE_CHUNK_INDEX:02d}.bin.ttf"
    try:
        resp = await client.get(
            url,
            headers={"User-Agent": _FEED_UA, "Range": "bytes=0-15"},
            timeout=_CHUNK_TIMEOUT_S,
        )
    except httpx.HTTPError as exc:
        log.info(
            "coverage probe %s/%s: unreachable (%s)",
            day,
            host,
            exc.__class__.__name__,
        )
        return None
    if resp.status_code in (200, 206):
        return True
    if resp.status_code in (404, 416):
        return False
    log.info("coverage probe %s/%s: HTTP %d", day, host, resp.status_code)
    return None


async def coverage(day_from: date, day_to: date) -> dict:
    """Which days in the range does at least one enabled host have chunks for.

    Each (day, host) is one 16-byte probe of the noon chunk, kept on disk
    for 24 h, with probes bounded to 8 concurrent. Raises ValueError when
    the range runs backwards or exceeds `_COVERAGE_MAX_DAYS` days — the
    route turns that into a 422.
    """
    span_days = (day_to - day_from).days
    if span_days < 0 or span_days > _COVERAGE_MAX_DAYS - 1:
        raise ValueError(f"coverage range is {span_days + 1} days; the cap is {_COVERAGE_MAX_DAYS}")
    hosts = _enabled_hosts()
    days = [day_from + timedelta(days=offset) for offset in range(span_days + 1)]
    cache = await asyncio.to_thread(_coverage_cache_read)
    now = time.time()

    pending = [
        (day, host)
        for day in days
        for host in hosts
        if now - cache.get(f"{day}/{host}", {}).get("ts", 0.0) >= _COVERAGE_TTL_S
    ]
    if pending:
        client = get_client()
        sem = asyncio.Semaphore(_COVERAGE_CONCURRENCY)

        async def probe(day: date, host: str) -> None:
            async with sem:
                present = await _probe_chunk(client, host, day)
            if present is not None:
                cache[f"{day}/{host}"] = {"ts": now, "present": present}

        await asyncio.gather(*(probe(day, host) for day, host in pending))
        await asyncio.to_thread(_coverage_cache_write, cache)

    result: list[dict[str, Any]] = []
    for day in days:
        present_hosts = [host for host in hosts if cache.get(f"{day}/{host}", {}).get("present")]
        if present_hosts:
            result.append({"day": day.isoformat(), "hosts": present_hosts})
    return {"days": result}
