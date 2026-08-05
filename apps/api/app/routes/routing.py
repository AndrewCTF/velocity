"""``/api/cyber/routing`` — national routing health from RIPE RIS.

A country going off the internet is normally reported as news, which makes it a
claim, dated whenever a journalist noticed. It is not a claim. The BGP table is
a machine reporting on itself: when a state orders a shutdown, the announced
prefixes for that country stop being announced, and RIPE's route collectors see
it within minutes of it happening and keep a public record of it.

Source: ``stat.ripe.net/data/country-resource-stats``, keyless. Per country per
day it returns ``v4_prefixes_ris`` (IPv4 prefixes seen by RIS), ``v6_prefixes_ris``
and ``asns_ris``. Verified live 2026-08-05 for IR: 8,428 v4 prefixes, 539 ASNs.

What this route adds on top is the only part that is analysis: a **baseline**.
An absolute prefix count says nothing — Iran has 8,400 and Chad has 30, and
neither number is interesting. What is interesting is the count against that
country's own recent normal, so every reading is reported as a percentage of the
median of the preceding days, and the drop is what gets rendered.

Two honesty constraints hold here:

* RIS resolution for this call is DAILY. A shutdown that starts and ends inside
  one day can be invisible, and a drop reported here is at best a day old. The
  route says so in ``resolution`` and the layer inherits it; nothing here claims
  to be live.
* A country with too few days of history has no baseline, and is reported with
  ``baseline: null`` rather than a fabricated one. A percentage against a made-up
  normal is worse than no percentage.

Provenance tier: sensor. The route collectors are machines observing what other
machines announced.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import statistics
from typing import Any

from fastapi import APIRouter, Query

from app.routes import _feedgeo as fg
from app.upstream import cache, get_client

router = APIRouter(tags=["cyber"])

RIPESTAT_URL = "https://stat.ripe.net/data/country-resource-stats/data.json"

# Days of history to ask for. Fourteen gives a stable median while keeping the
# response small; RIS is daily, so this is fourteen points.
_WINDOW_DAYS = 14
# Below this many baseline days a percentage would be noise dressed as a number.
_MIN_BASELINE_DAYS = 5
_TTL_S = 6 * 3600
# RIPEstat is a shared public service. Six at a time is polite and still clears
# the watchlist in a few seconds.
_CONCURRENCY = 6

# Countries where a national routing drop is a plausible event, with rough
# centroids so the reading has somewhere to render. Deliberately a fixed list
# rather than "every country": 250 daily requests to a free public API to watch
# 210 countries that have never had a shutdown is rude and answers nothing.
# ISO-3166-1 alpha-2, because that is what RIPEstat keys on.
WATCHLIST: list[tuple[str, str, float, float]] = [
    ("IR", "Iran", 32.4, 53.7),
    ("RU", "Russia", 61.5, 105.3),
    ("BY", "Belarus", 53.7, 27.9),
    ("UA", "Ukraine", 48.4, 31.2),
    ("SY", "Syria", 34.8, 38.997),
    ("IQ", "Iraq", 33.2, 43.7),
    ("YE", "Yemen", 15.6, 48.5),
    ("PS", "Palestine", 31.95, 35.23),
    ("IL", "Israel", 31.05, 34.85),
    ("LB", "Lebanon", 33.85, 35.86),
    ("JO", "Jordan", 30.6, 36.24),
    ("EG", "Egypt", 26.8, 30.8),
    ("LY", "Libya", 26.34, 17.23),
    ("DZ", "Algeria", 28.03, 1.66),
    ("SD", "Sudan", 12.86, 30.22),
    ("SS", "South Sudan", 6.88, 31.31),
    ("ET", "Ethiopia", 9.15, 40.49),
    ("SO", "Somalia", 5.15, 46.2),
    ("ER", "Eritrea", 15.18, 39.78),
    ("TD", "Chad", 15.45, 18.73),
    ("NE", "Niger", 17.61, 8.08),
    ("ML", "Mali", 17.57, -4.0),
    ("BF", "Burkina Faso", 12.24, -1.56),
    ("GN", "Guinea", 9.95, -9.7),
    ("SN", "Senegal", 14.5, -14.45),
    ("MR", "Mauritania", 21.0, -10.94),
    ("CD", "DR Congo", -4.04, 21.76),
    ("CM", "Cameroon", 7.37, 12.35),
    ("UG", "Uganda", 1.37, 32.29),
    ("TZ", "Tanzania", -6.37, 34.89),
    ("ZW", "Zimbabwe", -19.02, 29.15),
    ("MZ", "Mozambique", -18.67, 35.53),
    ("TR", "Turkey", 38.96, 35.24),
    ("AF", "Afghanistan", 33.94, 67.71),
    ("PK", "Pakistan", 30.38, 69.35),
    ("IN", "India", 20.59, 78.96),
    ("BD", "Bangladesh", 23.68, 90.36),
    ("MM", "Myanmar", 21.91, 95.96),
    ("KP", "North Korea", 40.34, 127.51),
    ("KZ", "Kazakhstan", 48.02, 66.92),
    ("UZ", "Uzbekistan", 41.38, 64.59),
    ("TM", "Turkmenistan", 38.97, 59.56),
    ("TJ", "Tajikistan", 38.86, 71.28),
    ("KG", "Kyrgyzstan", 41.2, 74.77),
    ("AZ", "Azerbaijan", 40.14, 47.58),
    ("AM", "Armenia", 40.07, 45.04),
    ("GE", "Georgia", 42.32, 43.36),
    ("VE", "Venezuela", 6.42, -66.59),
    ("CU", "Cuba", 21.52, -77.78),
    ("NI", "Nicaragua", 12.87, -85.21),
    ("HT", "Haiti", 18.97, -72.29),
]


async def _country(iso2: str) -> dict[str, Any] | None:
    """Prefix and ASN counts for one country, newest last."""
    start = (dt.datetime.now(dt.UTC) - dt.timedelta(days=_WINDOW_DAYS)).date().isoformat()
    try:
        r = await get_client().get(
            RIPESTAT_URL,
            params={"resource": iso2, "starttime": start, "resolution": "1d"},
            timeout=45.0,
        )
        if r.status_code != 200:
            return None
        stats = (r.json().get("data") or {}).get("stats") or []
    except Exception:  # noqa: BLE001 — one country must not fail the sweep
        return None
    series: list[tuple[str, float, float]] = []
    for row in stats:
        v4 = row.get("v4_prefixes_ris")
        if v4 is None or v4 < 0:
            continue
        asns = float(row.get("asns_ris") or 0)
        series.append((str(row.get("stats_date") or ""), float(v4), asns))
    if not series:
        return None
    return {"iso2": iso2, "series": series}


def _assess(series: list[tuple[str, float, float]]) -> dict[str, Any]:
    """Latest reading against the country's own recent median."""
    latest_date, latest_v4, latest_asn = series[-1]
    prior = [v for _, v, _ in series[:-1]]
    if len(prior) < _MIN_BASELINE_DAYS:
        # Not enough history to say what normal is. Say that, do not invent it.
        return {
            "prefixes_v4": latest_v4,
            "asns": latest_asn,
            "baseline_v4": None,
            "drop_pct": None,
            "severity": "unknown",
            "as_of": latest_date,
            "baseline_days": len(prior),
        }
    baseline = statistics.median(prior)
    drop = 0.0 if baseline <= 0 else max(0.0, (baseline - latest_v4) / baseline * 100.0)
    # Thresholds are coarse on purpose. RIS counts wobble a percent or two from
    # collector churn alone, so anything under 5% is not a finding.
    severity = "none" if drop < 5 else "partial" if drop < 30 else "major"
    return {
        "prefixes_v4": latest_v4,
        "asns": latest_asn,
        "baseline_v4": baseline,
        "drop_pct": round(drop, 1),
        "severity": severity,
        "as_of": latest_date,
        "baseline_days": len(prior),
    }


async def _load(min_drop: float) -> dict[str, Any]:
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def one(entry: tuple[str, str, float, float]) -> dict[str, Any] | None:
        iso2, name, lat, lon = entry
        async with sem:
            got = await _country(iso2)
        if not got:
            return None
        a = _assess(got["series"])
        if a["drop_pct"] is not None and a["drop_pct"] < min_drop:
            return None
        return fg.point(
            f"routing:{iso2}",
            lon,
            lat,
            {
                "kind": "routing",
                "style_kind": "routing",
                "iso2": iso2,
                "country": name,
                **a,
            },
        )

    results = await asyncio.gather(*(one(e) for e in WATCHLIST))
    feats = [f for f in results if f]
    reached = sum(1 for f in results if f is not None)
    env = fg.fc(feats)
    env["note"] = (
        f"{len(feats)} of {len(WATCHLIST)} watched countries at or over the reporting "
        f"threshold. RIPE RIS, daily resolution: a drop here is at best a day old and a "
        f"shutdown contained within one day can be invisible. Reached {reached} countries."
    )
    env["resolution"] = "1d"
    return env


@router.get("/api/cyber/routing")
async def routing_health(
    min_drop: float = Query(
        0.0, ge=0.0, le=100.0, description="only report countries at or above this % drop"
    ),
) -> dict[str, Any]:
    """National routing health, as a percentage of each country's own normal."""
    return await cache.get_or_fetch(f"cyber:routing:{min_drop}", _TTL_S, lambda: _load(min_drop))
