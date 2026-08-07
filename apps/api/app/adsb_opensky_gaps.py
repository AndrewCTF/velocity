"""OpenSky, unauthenticated, spent as bounding boxes on the gaps in our coverage.

The anonymous OpenSky budget is 400 credits a day, and a request's cost depends
on the AREA it asks for. Measured against the live API 2026-08-07 by reading
`x-rate-limit-remaining` either side of each call:

    2 x 2 deg   (4 sq deg)     1 credit    301 -> 300
    10 x 10 deg (100 sq deg)   2 credits   300 -> 298
    the whole world            4 credits   298 -> 294

So the bbox form is FOUR TIMES cheaper than the global pull this backend used to
spend its budget on: ~400 small boxes a day against ~100 world pulls. That is
the whole reason this module exists.

Which boxes is then the question, and the answer is not "a fixed grid" — a grid
spends most of the budget re-observing sky three other tiers already cover at
1 s. It is spent where the union is OLDEST: the snapshot's own stale contacts
are clustered (a patch of ocean, a country with no ground receivers), so the
cells holding them are ranked and the budget goes there, newest gap first.

Two rules this module will not break:

- **The budget is read, never assumed.** Every response states
  `x-rate-limit-remaining`; that number gates the next call. Guessing it is how
  you get locked out at 09:00 for the rest of the day.
- **A state vector's age is its own.** OpenSky reports `time_position`, and it
  is converted to readsb's `seen_pos` so this tier competes honestly in the
  freshest-observation-wins union. A vector with no position time loses.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

STATES_URL = "https://opensky-network.org/api/states/all"

# 2x2 degrees: the largest box that still costs ONE credit (<= 25 sq deg by
# OpenSky's own banding, and measured at 1 credit above). Bigger boxes cover
# more sky per request but cost 2-4x, which is the trade this module exists to
# refuse.
CELL_DEG = 2.0

# Leave the day's last credits alone so an operator-driven lookup elsewhere in
# the app (or a restart re-reading the budget) is not locked out by this filler.
RESERVE_CREDITS = 40

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)


@dataclass
class Budget:
    """What the API last told us is left, and when it said so."""

    remaining: int | None = None
    at: float = 0.0
    # Set when a 429 lands: nothing is attempted again until this passes.
    blocked_until: float = 0.0
    spent: int = 0

    def may_spend(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        if now < self.blocked_until:
            return False
        if self.remaining is None:
            return True  # never asked — one call is how we learn the number
        return self.remaining > RESERVE_CREDITS

    def observe(self, headers: Any, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        raw = None
        try:
            raw = headers.get("x-rate-limit-remaining")
        except AttributeError:
            raw = None
        if raw is not None:
            try:
                self.remaining = int(raw)
                self.at = now
            except (TypeError, ValueError):
                pass
        self.spent += 1

    def block(self, seconds: float, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        self.blocked_until = max(self.blocked_until, now + seconds)


BUDGET = Budget()


@dataclass
class Cell:
    """One 2x2 degree box, and how bad our coverage of it looked."""

    lat: float  # south edge
    lon: float  # west edge
    stale: int = 0
    oldest: float = 0.0
    last_pulled: float = field(default=0.0)

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return (self.lat, self.lon, self.lat + CELL_DEG, self.lon + CELL_DEG)


def _floor_to_cell(v: float) -> float:
    return CELL_DEG * (v // CELL_DEG)


def rank_gaps(
    features: list[dict[str, Any]],
    stale_after_s: float = 120.0,
    limit: int = 12,
) -> list[Cell]:
    """The cells holding the most stale contacts, worst first.

    `features` is the snapshot the app is serving right now, so this reads our
    OWN coverage rather than guessing where the world is thin. A cell with one
    ancient contact ranks below a cell with twenty merely-old ones: the point is
    to buy back the most contacts per credit.
    """
    cells: dict[tuple[float, float], Cell] = {}
    for f in features:
        props = f.get("properties") or {}
        age = props.get("seen_pos_s")
        if not isinstance(age, (int, float)) or age < stale_after_s:
            continue
        coords = (f.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        key = (_floor_to_cell(lat), _floor_to_cell(lon))
        cell = cells.get(key)
        if cell is None:
            cell = cells[key] = Cell(lat=key[0], lon=key[1])
        cell.stale += 1
        cell.oldest = max(cell.oldest, float(age))
    ranked = sorted(cells.values(), key=lambda c: (c.stale, c.oldest), reverse=True)
    return ranked[:limit]


def states_to_readsb(raw: dict[str, Any], now: float | None = None) -> list[dict[str, Any]]:
    """OpenSky state vectors → readsb-shaped dicts for the snapshot union.

    Vector layout: 0 icao24, 1 callsign, 2 origin country, 3 time_position,
    4 last_contact, 5 lon, 6 lat, 7 baro alt m, 8 on_ground, 9 velocity m/s,
    10 true track, 13 geo alt m, 14 squawk.
    """
    now = time.time() if now is None else now
    out: list[dict[str, Any]] = []
    for s in raw.get("states") or []:
        if not s or len(s) < 11 or s[5] is None or s[6] is None:
            continue
        hex_id = str(s[0] or "").strip().lower()
        if len(hex_id) != 6:
            continue
        tp = s[3]
        # No position time means we cannot say how old the fix is, and a tier
        # that cannot say must not win the union.
        seen_pos = max(0.0, now - float(tp)) if isinstance(tp, (int, float)) else 1e9
        on_ground = bool(s[8])
        ac: dict[str, Any] = {
            "hex": hex_id,
            "lat": float(s[6]),
            "lon": float(s[5]),
            "seen_pos": seen_pos,
            "_seen_at": now,
        }
        callsign = (s[1] or "").strip() if isinstance(s[1], str) else ""
        if callsign:
            ac["flight"] = callsign
        if on_ground:
            ac["alt_baro"] = "ground"
        elif isinstance(s[7], (int, float)):
            ac["alt_baro"] = int(float(s[7]) * 3.28084)  # metres → feet, readsb's unit
        if isinstance(s[9], (int, float)):
            ac["gs"] = float(s[9]) * 1.94384  # m/s → knots
        if isinstance(s[10], (int, float)):
            ac["track"] = float(s[10])
        if len(s) > 14 and s[14]:
            ac["squawk"] = str(s[14]).strip()
        out.append(ac)
    return out


async def fetch_cell(client: httpx.AsyncClient, cell: Cell) -> list[dict[str, Any]]:
    """One 1-credit bbox pull. Returns [] and records the block on a 429."""
    if not BUDGET.may_spend():
        return []
    lamin, lomin, lamax, lomax = cell.bbox
    try:
        r = await client.get(
            STATES_URL,
            params={"lamin": lamin, "lomin": lomin, "lamax": lamax, "lomax": lomax},
            headers={"User-Agent": _UA},
            timeout=httpx.Timeout(12.0, connect=5.0),
        )
    except (httpx.HTTPError, OSError):
        return []
    BUDGET.observe(r.headers)
    if r.status_code == 429:
        # Out of credits for the day. The header carries no reset time, so back
        # off an hour rather than hammering a door that is shut.
        BUDGET.block(3600.0)
        return []
    if r.status_code != 200:
        return []
    try:
        raw = r.json()
    except ValueError:
        return []
    cell.last_pulled = time.monotonic()
    return states_to_readsb(raw if isinstance(raw, dict) else {})


async def fill_gaps(
    features: list[dict[str, Any]], max_cells: int = 6
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Spend up to `max_cells` credits on the worst-covered cells.

    Sequential on purpose: this is a metered budget on somebody's research API,
    not a firehose, and six requests spread over a pull is invisible to them.
    """
    cells = rank_gaps(features)
    if not cells or not BUDGET.may_spend():
        return [], {"cells": 0, "remaining": BUDGET.remaining}
    best: dict[str, dict[str, Any]] = {}
    used = 0
    async with httpx.AsyncClient(follow_redirects=True) as client:
        for cell in cells[:max_cells]:
            if not BUDGET.may_spend():
                break
            ac = await fetch_cell(client, cell)
            used += 1
            for a in ac:
                prev = best.get(a["hex"])
                if prev is None or a["seen_pos"] < prev["seen_pos"]:
                    best[a["hex"]] = a
    return list(best.values()), {
        "cells": used,
        "aircraft": len(best),
        "remaining": BUDGET.remaining,
        "targets": [{"lat": c.lat, "lon": c.lon, "stale": c.stale} for c in cells[:max_cells]],
    }
