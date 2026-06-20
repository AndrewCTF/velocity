"""GET /api/space/* — orbital catalogues.

CelesTrak GP (free, no auth, 2h refresh ceiling) returns TLE/3LE/JSON groups
of satellites. We expose 'active', 'starlink', 'visual', 'iss', 'noaa', etc.

We don't propagate orbits server-side — propagation belongs on the client
via satellite.js per the plan. So this route just hands TLE+name out and
the frontend computes positions.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.upstream import cache, get_client

router = APIRouter(tags=["space"])

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
        # Browser User-Agent: CelesTrak (like several feeds in this app) is more
        # willing to serve a browser UA than the default client UA, especially
        # for large groups under load. Per-request header overrides the shared
        # client default.
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
        if r.status_code != 200:
            raise HTTPException(502, f"celestrak upstream {r.status_code}")
        return {"group": group, "items": _parse_tle(r.text)}

    # CelesTrak update ceiling is 2h; respect it. The FULL set is cached, but we
    # truncate per request: a default 'active' pull is ~16k sats / ~6.5 MB, and
    # satellite.js propagates every one on the client main thread — uncapped that
    # janks the globe. Power users can raise `limit` up to 20000.
    data = await cache.get_or_fetch(key, 2 * 3600.0, load)
    items = data.get("items", []) if isinstance(data, dict) else []
    return {
        "group": group,
        "count": len(items),
        "returned": min(len(items), limit),
        "items": items[:limit],
    }
