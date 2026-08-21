"""GET /api/space/* — orbital catalogues.

CelesTrak GP (free, no auth, 2h refresh ceiling) returns TLE/3LE/JSON groups
of satellites. We expose 'active', 'starlink', 'visual', 'iss', 'noaa', etc.

We don't propagate orbits server-side — propagation belongs on the client
via satellite.js per the plan. So this route just hands TLE+name out and
the frontend computes positions.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app import upstream
from app.upstream import cache, get_client

router = APIRouter(tags=["space"])

log = logging.getLogger("space")

# The body CelesTrak returns with its conditional-GET 403. Matched as a
# substring because the rest of the sentence carries the group and a timestamp.
_NOT_MODIFIED = "GP data has not updated"


def _disk_path(group: str) -> Path:
    """Where the last good TLE text for a group lives.

    Deliberately NOT app.tilecache: that class is an LRU under a byte budget
    shared with imagery, and these files are ~7 MB total, must not be evicted by
    a map pan, and are keyed by a name rather than a tile coordinate. One caller
    is not an abstraction — if a second reference-class feed wants this (the EEZ
    polygons are the obvious candidate), generalise it then, not now.
    """
    from app.config import get_settings  # noqa: PLC0415 — avoids an import cycle

    root = Path(get_settings().tile_cache_dir).parent / "celestrak"
    # ALLOWED_GROUPS gates `group` before we get here, so it cannot traverse.
    return root / f"{group}.tle"


def _write_disk(group: str, text: str) -> None:
    """Persist the last good pull. Best-effort: a full disk must not kill a feed."""
    try:
        path = _disk_path(group)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tle.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)  # atomic, so a reader never sees a half file
    except OSError as exc:  # noqa: BLE001 — cache write is never load-bearing
        log.warning("celestrak: could not cache %s to disk (%s)", group, exc)


def _read_disk(group: str) -> tuple[str, float] | None:
    """Last good text plus the epoch it was fetched, or None."""
    try:
        path = _disk_path(group)
        return path.read_text(encoding="utf-8"), path.stat().st_mtime
    except OSError:
        return None


ALLOWED_GROUPS = {
    "active",
    "starlink",
    "visual",
    "stations",
    "iridium-NEXT",
    "globalstar",
    "oneweb",
    "noaa",
    "goes",
    "weather",
    "gps-ops",
    "glo-ops",
    "galileo",
    "beidou",
    "military",
    "geo",
    "intelsat",
    "ses",
    "planet",
    "spire",
}


def _parse_tle(text: str) -> list[dict[str, Any]]:
    """Parse CelesTrak FORMAT=tle (name line + 2 element lines per object).

    NORAD_CAT_ID is the catalogue number from line 1 columns 3-7, kept as a
    STRING so Alpha-5 ids (catalogue numbers > 99999, e.g. newer Starlink)
    survive instead of overflowing an int parse. A missing name line falls back
    to the catalogue number.
    """
    items: list[dict[str, Any]] = []
    name = ""
    line1: str | None = None
    for raw in text.splitlines():
        ln = raw.rstrip()
        if not ln.strip():
            continue
        if ln.startswith("1 "):
            line1 = ln
        elif ln.startswith("2 ") and line1 is not None:
            satnum = line1[2:7].strip()
            items.append(
                {
                    "OBJECT_NAME": name or satnum,
                    "NORAD_CAT_ID": satnum,
                    "TLE_LINE1": line1,
                    "TLE_LINE2": ln,
                }
            )
            line1 = None
            name = ""
        else:
            name = ln.strip()
    return items


@router.get("/api/space/gp")
async def gp(
    group: str = Query("active"),
    limit: int = Query(2000, ge=1, le=20000),
) -> dict[str, Any]:
    if group not in ALLOWED_GROUPS:
        raise HTTPException(400, f"unknown group {group}")
    key = f"celestrak:{group}"

    async def load() -> dict[str, Any]:
        url = "https://celestrak.org/NORAD/elements/gp.php"
        # FORMAT=tle, not json: the JSON/OMM variant omits the TLE_LINE1/2 line
        # strings the client's SGP4 parser (satellite.js twoline2satrec) needs.
        # We pull the 3-line text and parse it into the
        # {OBJECT_NAME, NORAD_CAT_ID, TLE_LINE1, TLE_LINE2} shape the frontend
        # consumes.
        # The browser User-Agent is kept but NOT for the reason once written
        # here. Measured 2026-08-21: celestrak answers our own UA and a Chrome UA
        # identically, including for the 403 below. Left in place because
        # changing two things at once is how you learn nothing.
        r = await get_client().get(
            url,
            params={"GROUP": group, "FORMAT": "tle"},
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
                )
            },
        )
        if r.status_code == 403 and _NOT_MODIFIED in r.text:
            # NOT a block. CelesTrak answers a repeat request inside its 2h
            # publish window with 403 and the body
            #   "GP data has not updated since your last successful download
            #    of GROUP=<g> at <ts>. Data is updated once every 2 hours."
            # keyed by (source IP, GROUP). That is a conditional GET wearing a
            # 403, and treating it as an outage is what emptied the satellite
            # layer: the in-process TTL cache dies with the process, so every
            # restart re-pulled into a guaranteed 403 for the rest of the window.
            # That — not "bursts" — is the mechanism behind the documented
            # "restart the backend ONCE and wait".
            cached = _read_disk(group)
            if cached is not None:
                text, fetched_at = cached
                # Report it as the 304 it actually is, so /api/status/sources
                # explains itself. send() already booked a failure a moment ago;
                # source_health() compares last_error_at against last_success, so
                # this flips the state back to ok while the fail count stays
                # honest about the wire.
                upstream.record_success("celestrak.org", 0.0, 304)
                return {
                    "group": group,
                    "items": _parse_tle(text),
                    "fetched_at": fetched_at,
                    "stale": True,
                }
            raise HTTPException(502, f"celestrak upstream {r.status_code}")
        if r.status_code != 200:
            # Any other 403 is a real refusal and must still surface as one.
            raise HTTPException(502, f"celestrak upstream {r.status_code}")
        _write_disk(group, r.text)
        return {"group": group, "items": _parse_tle(r.text), "stale": False}

    # CelesTrak update ceiling is 2h; respect it. The FULL set is cached, but we
    # truncate per request: a default 'active' pull is ~16k sats / ~6.5 MB, and
    # satellite.js propagates every one on the client main thread — uncapped that
    # janks the globe. Power users can raise `limit` up to 20000.
    data = await cache.get_or_fetch(key, 2 * 3600.0, load)
    items = data.get("items", []) if isinstance(data, dict) else []
    out: dict[str, Any] = {
        "group": group,
        "count": len(items),
        "returned": min(len(items), limit),
        "items": items[:limit],
    }
    # A tier that can serve a CACHE publishes the age of the DATA, not of the
    # response (docs/decisions.md 2026-07-15). A TLE carries its own epoch in
    # TLE_LINE1 cols 19-32 and the client propagates from it, so a 4h-old
    # element set is the input SGP4 expects rather than a stale reading — but
    # the consumer still gets told.
    if isinstance(data, dict) and data.get("stale"):
        out["stale"] = True
        fetched = data.get("fetched_at")
        if isinstance(fetched, (int, float)):
            out["fetched_at"] = fetched
            out["age_s"] = round(time.time() - fetched, 1)
    return out
