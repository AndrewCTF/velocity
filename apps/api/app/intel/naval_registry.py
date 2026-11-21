"""MMSIs of navy / coast-guard ships, from Wikidata (keyless).

AIS is self-reported: any hull can declare ship type 35 or call itself
"HMS ...". This list is the independent half — an MMSI that Wikidata records
on a ship whose class is a naval ship (or a direct subclass) or whose operator
is a navy / coast guard. Measured 2026-10-22: 941 MMSIs; in a 76k-vessel live
snapshot it confirmed 47 of 288 heuristic hits and found 138 the heuristics
missed (Norwegian KV cutters, USCGC hulls). It can still be stale: a sold or
museum hull keeps its old MMSI entry. Two rules cut that, both measured
against the 2026-10-22 snapshot: an operator statement with an end date
(``pq:P582``) does not count — that alone dropped Ukkopekka (a WWII-era Finnish
Navy steamer, now a cruise boat), Pax and Arca — and a hull with a service
retirement date (``P730``) is excluded. A ship whose old naval CLASS is undated
(MS Sunnhordland) still slips through; that residue is why this is a confidence
tier and not a verdict.

One query per day (cached), and a failure degrades to an empty set: the layer
then falls back to the AIS-declared tiers instead of going dark.
"""

from __future__ import annotations

from app.intel.country_profile import _cell, _sparql
from app.upstream import cache

_TTL = 86400.0

# naval ship Q177597 and common classes; navy Q4508, coast guard Q1353040.
# One-hop P279 only: a P279* walk with a non-constant class 504s
# (country_profile.py documents the trap).
_QUERY = """
SELECT DISTINCT ?mmsi ?sLabel WHERE {
 { ?s wdt:P587 ?mmsi ; wdt:P31 ?c . ?c wdt:P279 wd:Q177597 . }
 UNION { ?s wdt:P587 ?mmsi ; wdt:P31 ?c .
   VALUES ?c { wd:Q177597 wd:Q161705 wd:Q174736 wd:Q170013 wd:Q17205 wd:Q2811
               wd:Q331795 wd:Q683570 wd:Q2607934 wd:Q1286790 wd:Q2300236 } }
 UNION { ?s wdt:P587 ?mmsi ; p:P137 ?st . ?st ps:P137 ?op ; wikibase:rank ?rk .
   FILTER(?rk != wikibase:DeprecatedRank)
   FILTER NOT EXISTS { ?st pq:P582 ?end }
   ?op wdt:P31 ?ot . VALUES ?ot { wd:Q4508 wd:Q1353040 } }
 FILTER NOT EXISTS { ?s wdt:P730 ?retired }
 SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""


def parse(body: dict | None) -> dict[int, str]:
    out: dict[int, str] = {}
    for row in ((body or {}).get("results") or {}).get("bindings") or []:
        mmsi = str(_cell(row, "mmsi") or "").strip()
        if mmsi.isdigit() and len(mmsi) == 9:
            out[int(mmsi)] = str(_cell(row, "sLabel") or "")
    return out


async def naval_mmsis() -> dict[int, str]:
    """MMSI → Wikidata ship label."""

    async def load() -> dict[int, str]:
        return parse(await _sparql(_QUERY))

    got = await cache.get_or_fetch("naval_registry:wikidata", _TTL, load)
    if not got:
        cache.shorten("naval_registry:wikidata", 600.0)  # retry a failed pull soon
    return got
