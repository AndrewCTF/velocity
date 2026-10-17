"""VesselFinder's public map feeds, read the way its own map script reads them.

Two keyless binary endpoints back the live map at vesselfinder.com. Both answer
a plain client (no browser, no cookie, not Cloudflare-gated; verified
2026-10-04) and both use AIS 1/10000-minute units, 600 000 per degree, for the
bbox AND for the positions:

  /api/pub/mp2   identified vessels: MMSI, position, name, a type class, a
                 heading step, and the AGE of the position.
  /api/pub/sfl   "Satellite Position" markers: position, type class and heading
                 only. No MMSI, no name, and no age the site itself displays.

The layouts below are a port of ``drawShipsOnMapBinary`` and ``getSFL`` from
``static.vesselfinder.net/web/vfmap/{map,index}.500107.js``, not a guess from
sniffed bytes. The older browser feeder (``tools/ais-vesselfinder-feeder``)
anchored on the name bytes and scaled by 1e6; that scale was wrong for both the
bbox and the positions.

Two rules this module exists to keep:

  * AGE OF THE DATA. ``mp2`` carries a coarse age per row (minutes, then
    hours). ``Fix.t`` is ``now`` minus the UPPER bound of that bucket, so a
    VesselFinder row can never out-rank a fresher fix from another source by
    rounding. A row with no age is dropped, not stamped "now".
  * A THROTTLED ANSWER IS NOT AN EMPTY SEA. After a burst the endpoint answers
    HTTP 200 with a 4-byte body. A status check cannot see that, so anything
    shorter than a header raises ``Throttled`` instead of parsing to zero rows.
"""

from __future__ import annotations

import asyncio
import logging
import random
import struct
import time
from typing import Any

import httpx

from app.ais_pipeline.providers import _UA, Fix, valid_mmsi

log = logging.getLogger(__name__)

_BASE = "https://www.vesselfinder.com/api/pub"
_HEADERS = {
    "user-agent": _UA,
    "accept": "*/*",
    "referer": "https://www.vesselfinder.com/",
    "origin": "https://www.vesselfinder.com",
}

SCALE = 600_000  # `An` / `CF` in the map script
MIN_BODY = 12  # an empty tile is a 12-16 byte header; a throttled one is 4 bytes
# Above this zoom every record grows a 10-byte hull block (dimensions + heading).
_HULL_ZOOM = 13

# The script's type legend (`lg`), by colour index, mapped to an ITU code family.
# 0 "Other / Auxiliary" and 1 "Unknown" carry no class. 7 is "SAR/Military",
# which is two different ITU codes, so it is left unset rather than guessed.
_CLASS_ITU = {2: 52, 3: 60, 4: 70, 5: 30, 6: 80, 8: 37}
CLASS_LABEL = (
    "Other or auxiliary",
    "Unknown type",
    "Tug",
    "Passenger ship",
    "Cargo ship",
    "Fishing vessel",
    "Tanker",
    "SAR or military",
    "Yacht or sailing vessel",
)


class Throttled(RuntimeError):
    """HTTP 200 with a body too short to be a tile. Back off; do not count it."""


def age_upper_s(td: int) -> float | None:
    """Upper bound, in seconds, of the age bucket the map shows for ``td``.

    The script's ``Nl``: a non-negative value is whole minutes; a negative one
    is ``td & 127`` whole hours. ``-1`` means "no age here, see the timestamp",
    which only the selected vessel carries, so it is unknown to us.
    """
    if td == -1:
        return None
    if td < 0:
        return ((td & 127) + 1) * 3600.0
    return (td + 1) * 60.0


def bbox_param(bbox: tuple[float, float, float, float]) -> str:
    return ",".join(str(int(v * SCALE)) for v in bbox)


def _payload(buf: bytes) -> int:
    """Offset of the first record, or raise ``Throttled``."""
    if len(buf) < MIN_BODY:
        raise Throttled(f"vesselfinder answered {len(buf)} bytes")
    return 4 + int.from_bytes(buf[1:3], "big")


def total_ships(buf: bytes) -> int | None:
    """The site-wide vessel count the header carries when flag p7 is set."""
    if len(buf) >= 12 and int.from_bytes(buf[4:8], "big") & 64:
        return int.from_bytes(buf[8:12], "big")
    return None


def parse_mp2(buf: bytes, *, zoom: int, now: float | None = None) -> list[Fix]:
    """Identified vessels from one ``mp2`` tile. Pure; unit-testable offline."""
    i = _payload(buf)
    n = len(buf)
    wall = time.time() if now is None else now
    hull = zoom > _HULL_ZOOM
    out: list[Fix] = []
    while i + 16 <= n:
        flags, raw_mmsi, lat_i, lon_i, td, name_len = struct.unpack_from(">hiiibb", buf, i)
        i += 16
        if name_len < 0 or i + name_len > n:
            break
        name = buf[i : i + name_len].decode("latin-1").strip() or None
        i += name_len
        heading: float | None = None
        if hull:
            if i + 10 > n:
                break
            q = struct.unpack_from(">h", buf, i + 8)[0]
            i += 10
            if 0 <= q <= 360:
                heading = float(q)
        sar = bool(flags & 2)
        if sar and not hull:
            i += 2  # SAR aircraft altitude
        if sar:
            continue  # an aircraft on a ship map is not a vessel
        icon = (flags & 0x3F00) >> 8
        if heading is None and icon < 32:
            heading = icon * 11.25
        mmsi = valid_mmsi(raw_mmsi)
        age = age_upper_s(td)
        lat, lon = lat_i / SCALE, lon_i / SCALE
        if mmsi is None or age is None:
            continue
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        out.append(
            Fix(
                mmsi=mmsi,
                lat=lat,
                lon=lon,
                t=wall - age,
                source="vesselfinder",
                heading=heading,
                name=name,
                ship_type=_CLASS_ITU.get((flags & 0xF0) >> 4),
            )
        )
    return out


def parse_sfl(buf: bytes) -> list[dict[str, Any]]:
    """Unidentified satellite positions from one ``sfl`` tile.

    11 bytes per row after a 4-byte header. The site shows these as "Satellite
    Position" with a type class and nothing else: no MMSI, no name and no age,
    so none is invented here. ``old`` is the site's own stale flag.
    """
    if len(buf) < 4:
        raise Throttled(f"vesselfinder answered {len(buf)} bytes")
    out: list[dict[str, Any]] = []
    for i in range(4, len(buf) - 10, 11):
        lat_i, lon_i, stamp, icon, cls = struct.unpack_from(">iibbb", buf, i)
        lat, lon = lat_i / SCALE, lon_i / SCALE
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            continue
        icon &= 63
        cls &= 15
        out.append(
            {
                "lat": lat,
                "lon": lon,
                "old": bool(stamp & 128),
                "heading": icon * 11.25 if icon < 32 else None,
                "classIndex": cls,
                "shipType": _CLASS_ITU.get(cls),
            }
        )
    return out


async def fetch_tile(
    client: httpx.AsyncClient,
    kind: str,
    bbox: tuple[float, float, float, float],
    zoom: int,
) -> bytes:
    """One raw tile body for ``kind`` in {"mp2", "sfl"}."""
    params: dict[str, Any] = {
        "bbox": bbox_param(bbox),
        "zoom": zoom,
        "ref": f"{random.random() * 99999:.4f}",
    }
    if kind == "mp2":
        params.update({"mmsi": 0, "mcbe": 1})
    # Short CONNECT timeout on purpose: a block here is the connection never
    # opening, and waiting 25 s per tile to learn that turns one refused sweep
    # into hours of knocking.
    r = await client.get(
        f"{_BASE}/{kind}",
        params=params,
        headers=_HEADERS,
        timeout=httpx.Timeout(25.0, connect=6.0),
    )
    if r.status_code != 200:
        raise RuntimeError(f"vesselfinder {kind} http {r.status_code}")
    return r.content


def tiles(
    tile_deg: float, *, lat0: float = -78.0, lat1: float = 82.0
) -> list[tuple[float, float, float, float]]:
    """World grid of ``(lon0, lat0, lon1, lat1)`` boxes."""
    out: list[tuple[float, float, float, float]] = []
    la = lat0
    while la < lat1:
        lo = -180.0
        while lo < 180.0:
            out.append((lo, la, min(lo + tile_deg, 180.0), min(la + tile_deg, lat1)))
            lo += tile_deg
        la += tile_deg
    return out


async def sweep(
    client: httpx.AsyncClient,
    kind: str,
    boxes: list[tuple[float, float, float, float]],
    zoom: int,
    *,
    concurrency: int = 1,
    pause_s: float = 0.5,
    max_strikes: int = 3,
) -> tuple[list[bytes], dict[str, Any]]:
    """Fetch every box, slowly, and stop the moment the site pushes back.

    A throttled or failed box is counted, never read as empty. ``max_strikes``
    consecutive refusals ABORT the sweep: measured 2026-10-04, about four
    minutes of 2-4 requests a second earned connection timeouts for every
    request from this address, and a sweep that keeps knocking only extends
    that. The caller backs off when ``aborted`` is set.
    """
    sem = asyncio.Semaphore(concurrency)
    failed = throttled = skipped = strikes = 0
    aborted = False

    async def one(box: tuple[float, float, float, float]) -> bytes | None:
        nonlocal failed, throttled, skipped, strikes, aborted
        async with sem:
            if aborted:
                skipped += 1
                return None
            try:
                body = await fetch_tile(client, kind, box, zoom)
                if len(body) < (MIN_BODY if kind == "mp2" else 4):
                    raise Throttled(f"{len(body)} bytes")
            except Throttled:
                throttled += 1
                strikes += 1
            except Exception as e:  # noqa: BLE001 — transient upstream or a block
                log.warning("vesselfinder %s tile %s failed: %r", kind, box, e)
                failed += 1
                strikes += 1
            else:
                strikes = 0
                await asyncio.sleep(pause_s * (0.75 + random.random() / 2))
                return body
            if strikes >= max_strikes:
                aborted = True
            else:
                await asyncio.sleep(4.0 * strikes)
            return None

    bodies = [b for b in await asyncio.gather(*(one(bx) for bx in boxes)) if b is not None]
    return bodies, {
        "tiles": len(boxes),
        "tilesFailed": failed,
        "tilesThrottled": throttled,
        "tilesSkipped": skipped,
        "aborted": aborted,
        "complete": failed == 0 and throttled == 0 and skipped == 0,
    }
