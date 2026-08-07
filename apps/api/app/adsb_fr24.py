"""Flightradar24's own map feed as a keyless ADS-B tier.

`data-cloud.flightradar24.com/zones/fcgi/feed.js` is what the FR24 web map calls.
It takes a bbox and needs no key, no account and no token, and it answers with
FR24's fused picture: ADS-B, MLAT, satellite and FLARM, which is a wider net than
the readsb mirrors we already union — they only carry what a ground receiver
heard.

Two constraints shape everything here:

1. **1500 aircraft per response, whatever the bbox.** Measured 2026-08-07: one
   call over Europe returned exactly 1500 with `full_count: 20683`. So the world
   is walked as a GRID of boxes small enough that no single box saturates, and a
   box that comes back at the cap is reported so the grid can be tightened.
2. **The rows are positional arrays, not objects.** Field 10 is the position's
   epoch second, which is the only honest freshness signal in the payload, and it
   is converted to readsb's `seen_pos` (age in seconds at pull time) so the
   snapshot's freshest-observation-wins union can compare it against every other
   tier. Never stamp it 0: that would make an hour-old satellite fix beat a live
   transponder return.

Output is readsb-shaped (`hex`/`lat`/`lon`/`flight`/`alt_baro`/`gs`/`track`/
`seen_pos`) so it drops into the same slice store as the aircraft.json mirrors
with no special case downstream.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

FEED_URL = "https://data-cloud.flightradar24.com/zones/fcgi/feed.js"

# The map's own client sends a browser UA; a bare one gets a challenge page.
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)

# Per-response cap the upstream applies, measured. A box that returns this many
# is truncated — the grid below is sized so that is rare, and `saturated` counts
# the ones that still hit it rather than pretending the picture is complete.
ROW_CAP = 1500

# The world in 30x30 degree boxes, skipping the polar caps (no traffic worth a
# request above 75 degrees). 12 x 5 = 60 boxes; the busiest of them (Europe, the
# US east coast) is what the cap bites on, and those are split again.
_BUSY = (
    (60.0, -15.0, 35.0, 20.0),  # western Europe
    (60.0, 20.0, 35.0, 45.0),  # eastern Europe
    (50.0, -100.0, 25.0, -65.0),  # US east + midwest
    (50.0, -130.0, 25.0, -100.0),  # US west
    (40.0, 100.0, 15.0, 135.0),  # east Asia
)


def world_grid(step: float = 30.0) -> list[tuple[float, float, float, float]]:
    """(north, west, south, east) boxes covering the world, busy areas split.

    Returned in the order FR24 wants them: `bounds=north,south,west,east`.
    """
    boxes: list[tuple[float, float, float, float]] = []
    lat = 75.0
    while lat > -75.0:
        lon = -180.0
        while lon < 180.0:
            box = (lat, lon, lat - step, lon + step)
            # A busy box is subdivided into quarters rather than pulled whole.
            if any(_overlaps(box, b) for b in _BUSY):
                half = step / 2
                for dlat in (0.0, half):
                    for dlon in (0.0, half):
                        boxes.append((lat - dlat, lon + dlon, lat - dlat - half, lon + dlon + half))
            else:
                boxes.append(box)
            lon += step
        lat -= step
    return boxes


def _overlaps(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float]
) -> bool:
    an, aw, as_, ae = a
    bn, bw, bs, be = b
    return not (as_ >= bn or an <= bs or aw >= be or ae <= bw)


def parse_feed(payload: dict[str, Any], now: float | None = None) -> list[dict[str, Any]]:
    """FR24 rows → readsb-shaped aircraft dicts.

    Row layout (positional, verified against a live response 2026-08-07):
    0 icao24 hex, 1 lat, 2 lon, 3 track, 4 altitude ft, 5 ground speed kt,
    6 squawk, 7 radar id, 8 type, 9 registration, 10 position epoch,
    11 origin, 12 destination, 13 flight number, 14 on-ground, 15 vertical rate,
    16 callsign.
    """
    now = time.time() if now is None else now
    out: list[dict[str, Any]] = []
    for key, row in payload.items():
        if key in ("full_count", "version", "stats") or not isinstance(row, list):
            continue
        if len(row) < 12:
            continue
        hex_id = str(row[0] or "").strip().lower()
        lat, lon = row[1], row[2]
        if not hex_id or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        # An FR24 key is its own session id, not an ICAO address; row[0] is the
        # address and it is what every other tier dedupes on. A row without one
        # (some satellite/estimated tracks) cannot be unioned, so it is dropped
        # rather than minted under an id nothing else would match.
        if len(hex_id) != 6:
            continue
        ts = row[10] if isinstance(row[10], (int, float)) else None
        seen_pos = max(0.0, now - float(ts)) if ts else 1e9
        on_ground = bool(row[14]) if len(row) > 14 else False
        ac: dict[str, Any] = {
            "hex": hex_id,
            "lat": float(lat),
            "lon": float(lon),
            "seen_pos": seen_pos,
            "_seen_at": now,
        }
        callsign = str(row[16] or "").strip() if len(row) > 16 else ""
        if not callsign and len(row) > 13:
            callsign = str(row[13] or "").strip()
        if callsign:
            ac["flight"] = callsign
        if len(row) > 9 and row[9]:
            ac["r"] = str(row[9]).strip()
        if len(row) > 8 and row[8]:
            ac["t"] = str(row[8]).strip()
        if len(row) > 4 and isinstance(row[4], (int, float)):
            ac["alt_baro"] = "ground" if on_ground else int(row[4])
        if len(row) > 5 and isinstance(row[5], (int, float)):
            ac["gs"] = float(row[5])
        if len(row) > 3 and isinstance(row[3], (int, float)):
            ac["track"] = float(row[3])
        if len(row) > 6 and row[6]:
            ac["squawk"] = str(row[6]).strip()
        out.append(ac)
    return out


async def fetch_box(
    client: httpx.AsyncClient, box: tuple[float, float, float, float]
) -> tuple[list[dict[str, Any]], bool]:
    """(aircraft, saturated) for one bbox. Saturated = the response hit ROW_CAP."""
    north, west, south, east = box
    try:
        r = await client.get(
            FEED_URL,
            params={
                "bounds": f"{north},{south},{west},{east}",
                "faa": "1",
                "satellite": "1",
                "mlat": "1",
                "flarm": "1",
                "adsb": "1",
                "gnd": "1",
                "air": "1",
                "vehicles": "0",
                "estimated": "0",
                "stats": "0",
            },
            headers={"User-Agent": _UA},
            timeout=httpx.Timeout(12.0, connect=5.0),
        )
    except (httpx.HTTPError, OSError):
        return [], False
    if r.status_code != 200:
        return [], False
    try:
        payload = r.json()
    except ValueError:
        return [], False
    if not isinstance(payload, dict):
        return [], False
    rows = sum(1 for k, v in payload.items() if k not in ("full_count", "version", "stats"))
    return parse_feed(payload), rows >= ROW_CAP


async def fetch_world(concurrency: int = 6) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Every box, deduped by ICAO address, freshest position winning.

    Concurrency is deliberately modest: this is somebody's map backend, not an
    API sold to us, and 60-ish sequential-ish requests once per cadence is the
    same load a few open browser tabs make.
    """
    boxes = world_grid()
    sem = asyncio.Semaphore(concurrency)
    best: dict[str, dict[str, Any]] = {}
    saturated = 0

    async with httpx.AsyncClient(follow_redirects=True) as client:

        async def one(box: tuple[float, float, float, float]) -> None:
            nonlocal saturated
            async with sem:
                ac, sat = await fetch_box(client, box)
            if sat:
                saturated += 1
            for a in ac:
                prev = best.get(a["hex"])
                if prev is None or a["seen_pos"] < prev["seen_pos"]:
                    best[a["hex"]] = a

        await asyncio.gather(*(one(b) for b in boxes))

    return list(best.values()), {"boxes": len(boxes), "saturated": saturated}
