"""Per-country intelligence enrichment — leadership + military structure from
Wikidata, a fused per-country security picture, and an LLM all-source brief.

Everything here is keyless and generic across all ~249 ISO-3166 countries:

- :func:`fetch_profile` — head of state / head of government / defence & foreign
  ministers / commander-in-chief + armed-forces service branches, from the
  keyless Wikidata SPARQL endpoint (``query.wikidata.org/sparql``). Wikidata
  REQUIRES a descriptive ``User-Agent``; anonymous bursts get 403/429.
- :func:`country_security` — counts + recent events fused from the existing
  GDELT conflict layer, the (token-gated) UCDP GED layer, and the military
  installation reference dataset, filtered to one country on a best-effort
  basis (see the honesty notes each call returns).
- :func:`country_brief` — a senior-analyst markdown assessment grounded ONLY in
  the numbers/leadership/security passed to it, degrading to ``{ok: False}``
  when no LLM backend answers (never a 500, never fabricated).

TRAP (verified live 2026-07-13): Wikidata role statements are frequently missing
an end-date (``P582``), so "no P582" does NOT mean the holder is current — e.g.
Nigeria's Minister of Defence returns Sani Abacha (died 1998) with no dates
alongside Christopher Gwabin Musa (start 2025-12-04). We therefore pick the
holder with the LATEST start (``P580``) per role, dropping undated holders when
any dated holder exists. See :func:`_latest_per_role`.

All upstream HTTP goes through the shared IPv4-pinned client
(``app.upstream.get_client``); this host's IPv6 egress is broken, so a raw
client would hang.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from app.upstream import cache, get_client

# Wikidata asks every client to identify itself; anonymous SPARQL bursts are
# throttled hard. A contact URL is the documented courtesy.
_UA = "VelocityOSINT/0.9 (+https://github.com/AndrewCTF)"
_SPARQL = "https://query.wikidata.org/sparql"

_PROFILE_TTL = 86400.0  # 24h — leadership/structure changes are rare
_SECURITY_TTL = 900.0  # 15 min — matches the GDELT/UCDP layer cadence
_BRIEF_TTL = 600.0  # 10 min
# Total wall-clock cap on the brief ladder, under Cloudflare's 100 s edge limit —
# the per-backend timeout_s below bounds each rung, this bounds their sum.
_BRIEF_LLM_BUDGET_S = 90.0

_MAX_BRANCHES = 12
_MAX_EVENTS = 25

# Combined leadership query: heads of state (P35) / government (P6) plus role
# holders whose position class is a defence minister (Q2518691), foreign
# minister (Q7330070) or commander-in-chief (Q380782). Each UNION arm BINDs a
# semantic ?cat slug — grouping by the role-item LABEL double-counts countries
# that carry several Wikidata role items for the same office (Germany has both
# a historical "German Foreign Minister" and the current "Federal Minister for
# Foreign Affairs", which surfaced a 1945 minister as current).
#
# Query-shape traps, all measured live 2026-07-13 (each alone → WDQS 504):
# - a global `?person rdfs:label ?plabel` join outside the UNION (Blazegraph
#   runs it first, across every label in the graph);
# - `wdt:P279* ?cls` with the class coming from VALUES (the path index needs a
#   constant object). Keep the three constant-object P279* arms.
# BIND(?cat) inside the arms is free (measured 1.6 s). Person names use the
# label SERVICE with a language fallback chain — with plain "en" a holder with
# no English label (Johann Wadephul, Q1696501, de/fr only) degrades to the bare
# QID string.
_LEADERSHIP_Q = """
SELECT ?cat ?person ?personLabel ?roleItemLabel
       (MAX(?start) AS ?since) (SAMPLE(?img) AS ?image) WHERE {{
  ?country wdt:P298 "{iso3}" .
  {{
    ?country p:P35 ?st . ?st ps:P35 ?person . BIND("head_of_state" AS ?cat)
    OPTIONAL {{ ?st pq:P580 ?start }}
  }} UNION {{
    ?country p:P6 ?st . ?st ps:P6 ?person . BIND("head_of_government" AS ?cat)
    OPTIONAL {{ ?st pq:P580 ?start }}
  }} UNION {{
    ?roleItem wdt:P1001 ?country .
    {{ ?roleItem wdt:P279* wd:Q2518691 . BIND("defence_minister" AS ?cat) }}
      UNION {{ ?roleItem wdt:P279* wd:Q7330070 . BIND("foreign_minister" AS ?cat) }}
      UNION {{ ?roleItem wdt:P279* wd:Q380782 . BIND("commander_in_chief" AS ?cat) }}
    ?person p:P39 ?ps . ?ps ps:P39 ?roleItem .
    OPTIONAL {{ ?ps pq:P580 ?start }}
  }}
  OPTIONAL {{ ?person wdt:P18 ?img }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,de,fr,es,ru,ar,zh,tr,fa". }}
}}
GROUP BY ?cat ?person ?personLabel ?roleItemLabel
"""

# Human-readable defaults for arms that carry no role item.
_CAT_LABEL = {
    "head_of_state": "Head of state",
    "head_of_government": "Head of government",
    "defence_minister": "Defence minister",
    "foreign_minister": "Foreign minister",
    "commander_in_chief": "Commander-in-chief",
}

# Display order for the collapsed leadership list.
_ROLE_ORDER = (
    "head_of_state",
    "head_of_government",
    "defence_minister",
    "foreign_minister",
    "commander_in_chief",
)

# Armed-forces service branches = the parts (P527) of the country's armed-forces
# entity (P31 = armed forces, Q772547) UNION items typed directly as a military
# branch (Q781132) of the country. The obvious ``wdt:P31/wdt:P279*
# wd:Q772547`` form was measured to TIME OUT on query.wikidata.org (the
# transitive class walk over every P31 is too broad); these two arms are cheap
# and return the real services (Army / Navy / Air Force / …). The English
# rdfs:label is REQUIRED (label-service fallback floods unlabeled QIDs), and
# dissolved entities are excluded (Waffen-SS is typed as a German military
# branch; observed live 2026-07-13).
_BRANCHES_Q = """
SELECT DISTINCT ?branchLabel WHERE {{
  ?country wdt:P298 "{iso3}" .
  {{ ?af wdt:P17 ?country ; wdt:P31 wd:Q772547 ; wdt:P527 ?branch . }}
  UNION
  {{ ?branch wdt:P17 ?country ; wdt:P31 wd:Q781132 . }}
  ?branch rdfs:label ?branchLabel . FILTER(LANG(?branchLabel) = "en")
  FILTER NOT EXISTS {{ ?branch wdt:P576 ?dissolved }}
}}
LIMIT 15
"""


async def _sparql(query: str) -> dict[str, Any] | None:
    """Run one SPARQL query, returning the parsed JSON or ``None`` on any
    failure (timeout, 429, malformed body). Callers degrade — never 500."""
    try:
        r = await get_client().get(
            _SPARQL,
            params={"query": query, "format": "json"},
            headers={"User-Agent": _UA, "Accept": "application/sparql-results+json"},
        )
        if r.status_code != 200:
            return None
        body = r.json()
    except Exception:  # noqa: BLE001 — any upstream fault → degrade
        return None
    return body if isinstance(body, dict) else None


def _cell(row: dict[str, Any], key: str) -> Any:
    """Value of a SPARQL result cell, or ``None`` when the var is unbound."""
    v = row.get(key)
    return v.get("value") if isinstance(v, dict) else None


def _latest_per_role(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse SPARQL leadership bindings to the CURRENT holder per role.

    latest-start-wins: for each role keep the holder with the greatest ``since``
    (ISO date string, lexically sortable). Undated holders are kept ONLY when a
    role has no dated holder at all — otherwise they are dropped, because a
    missing end-date does not mean the person is still in post (the Sani Abacha
    trap). Output is ordered by role name for stable rendering.
    """
    best: dict[str, dict[str, Any]] = {}
    for row in rows:
        cat = _cell(row, "cat")
        person = _cell(row, "personLabel") or _cell(row, "plabel")
        if not cat or not person:
            continue
        # Even with the language fallback chain the label service can degrade
        # to the bare QID (entity labelled in none of the chain's languages);
        # a QID is not a name — drop the row rather than render junk.
        if re.fullmatch(r"Q\d+", str(person)):
            continue
        since = _cell(row, "since")
        cand = {
            "role": cat,
            "person": person,
            "position": _cell(row, "roleItemLabel")
            or _cell(row, "roleLabel")
            or _CAT_LABEL.get(str(cat), cat),
            "start": (since or "")[:10] or None,
            "image": _cell(row, "image"),
        }
        cur = best.get(cat)
        if cur is None:
            best[cat] = cand
            continue
        cur_start = cur.get("start") or ""
        new_start = cand.get("start") or ""
        # A dated candidate always beats an undated incumbent; between two dated
        # holders the later start wins; two undated → keep the first seen.
        if (new_start and not cur_start) or (new_start and cur_start and new_start > cur_start):
            best[cat] = cand
    rank = {r: i for i, r in enumerate(_ROLE_ORDER)}
    return sorted(best.values(), key=lambda d: (rank.get(str(d["role"]), 99), str(d["role"])))


async def fetch_profile(iso3: str, name: str | None = None) -> dict[str, Any]:
    """Leadership + military branches for one country from Wikidata (24h cache).

    Shape: ``{iso3, name, source: "wikidata", leadership: [{role, person,
    position, start, image}], military_branches: [str, …], unavailable?: bool}``.
    Degrades to ``unavailable: True`` (empty lists) when SPARQL times out / 429s;
    a degraded result is cached only briefly so the next request retries.
    """
    iso3u = iso3.strip().upper()
    key = f"country:profile:{iso3u}"

    async def load() -> dict[str, Any]:
        # Serialized on purpose: WDQS rejects per-IP query bursts (observed
        # live 2026-07-13 — two concurrent queries during a busy window came
        # back empty/429 while the same queries spaced out returned 200).
        lead_body = await _sparql(_LEADERSHIP_Q.format(iso3=iso3u))
        branch_body = await _sparql(_BRANCHES_Q.format(iso3=iso3u))
        if lead_body is None and branch_body is None:
            return {
                "iso3": iso3u,
                "name": name,
                "source": "wikidata",
                "leadership": [],
                "military_branches": [],
                "unavailable": True,
                "note": "wikidata sparql unavailable (timeout/429)",
            }
        lead_rows = (
            (lead_body.get("results") or {}).get("bindings") or [] if lead_body else []
        )
        leadership = _latest_per_role(lead_rows)
        branches: list[str] = []
        if branch_body:
            for b in (branch_body.get("results") or {}).get("bindings") or []:
                lbl = _cell(b, "branchLabel")
                if lbl and lbl not in branches:
                    branches.append(lbl)
        return {
            "iso3": iso3u,
            "name": name,
            "source": "wikidata",
            "leadership": leadership,
            "military_branches": branches[:_MAX_BRANCHES],
        }

    out = await cache.get_or_fetch(key, _PROFILE_TTL, load)
    if out.get("unavailable"):
        cache.shorten(key, 60.0)
    return out


def _norm(s: Any) -> str:
    return str(s or "").strip().casefold()


async def country_security(
    iso3: str, name: str | None = None, hours: int = 24
) -> dict[str, Any]:
    """Per-country security picture fused from the existing conflict layers +
    military installation reference data (15 min cache).

    Honesty (returned in ``notes``): GDELT conflict features carry no country
    property, so they are filtered heuristically by whether the country NAME
    appears in either CAMEO actor — reporting-intensity, not verified ground
    truth. UCDP GED features carry a ``country`` name property and filter
    exactly, but the UCDP API is token-gated so the layer is usually empty
    without ``OSINT_UCDP_TOKEN``. Installations come from the military reference
    dataset, whose ``country`` field is only populated for US (MIRTA) rows.

    Shape: ``{iso3, name, counts: {conflict, ucdp, installations}, events:
    [{label, date, actors, deaths?, lat, lon, source}], sources: {conflict,
    ucdp, installations: {unavailable?, note?}}, notes: [str, …]}``.
    """
    from app import places
    from app.intel import conflict as conflict_mod
    from app.intel import ucdp as ucdp_mod

    iso3u = iso3.strip().upper()
    name_n = _norm(name)
    key = f"country:security:{iso3u}:{hours}"

    async def load() -> dict[str, Any]:
        import asyncio

        notes: list[str] = []
        events: list[dict[str, Any]] = []
        sources: dict[str, Any] = {}

        conflict_fc, ucdp_fc = await asyncio.gather(
            conflict_mod.conflict_events(hours=hours),
            ucdp_mod.ucdp_events(),
        )

        # --- GDELT: no country prop → heuristic actor-name match, flagged. ---
        conflict_feats = conflict_fc.get("features") or []
        c_unavail = bool(conflict_fc.get("unavailable"))
        sources["conflict"] = {
            "unavailable": c_unavail,
            "note": conflict_fc.get("note"),
            "match": "heuristic actor-name substring (GDELT carries no country field)",
        }
        conflict_hits = 0
        if name_n:
            for f in conflict_feats:
                p = f.get("properties") or {}
                if name_n in _norm(p.get("actor1")) or name_n in _norm(p.get("actor2")):
                    conflict_hits += 1
                    geom = (f.get("geometry") or {}).get("coordinates") or [None, None]
                    events.append(
                        {
                            "label": p.get("event") or p.get("label"),
                            "date": p.get("day"),
                            "actors": [p.get("actor1"), p.get("actor2")],
                            "lat": geom[1],
                            "lon": geom[0],
                            "source": "gdelt",
                        }
                    )
        notes.append(
            "GDELT conflict events are matched to this country only by actor "
            "name (no country field); treat as reporting intensity, not "
            "verified ground truth."
        )

        # --- UCDP: exact country-name prop match (empty without a token). ---
        ucdp_feats = ucdp_fc.get("features") or []
        u_unavail = bool(ucdp_fc.get("unavailable"))
        sources["ucdp"] = {"unavailable": u_unavail, "note": ucdp_fc.get("note")}
        ucdp_hits = 0
        for f in ucdp_feats:
            p = f.get("properties") or {}
            if name_n and _norm(p.get("country")) == name_n:
                ucdp_hits += 1
                geom = (f.get("geometry") or {}).get("coordinates") or [None, None]
                events.append(
                    {
                        "label": p.get("label")
                        or p.get("type_of_violence")
                        or "armed violence",
                        "date": p.get("date_start"),
                        "actors": [p.get("side_a"), p.get("side_b")],
                        "deaths": p.get("deaths_best"),
                        "lat": geom[1],
                        "lon": geom[0],
                        "source": "ucdp",
                    }
                )
        if u_unavail:
            notes.append(
                "UCDP GED is token-gated (set OSINT_UCDP_TOKEN); without it there "
                "are no research-grade named-actor events."
            )

        # --- Installations: military reference dataset (US-only country field). ---
        try:
            mil_rows = places.military()
        except Exception:  # noqa: BLE001 — reference file optional
            mil_rows = []
        inst = [r for r in mil_rows if _norm(r.get("country")) == iso3u.casefold()]
        sources["installations"] = {
            "unavailable": not inst,
            "note": (
                "military installation reference coverage is currently US-only "
                "(MIRTA); other countries return 0 here"
                if not inst
                else None
            ),
        }
        if not inst:
            notes.append(
                "Military installation coverage in the reference dataset is "
                "US-only; a 0 here is a data-coverage gap, not an assessment."
            )

        # Most-recent first; dates are heterogeneous strings, sort lexically desc.
        events.sort(key=lambda e: str(e.get("date") or ""), reverse=True)
        return {
            "iso3": iso3u,
            "name": name,
            "window_hours": hours,
            "counts": {
                "conflict": conflict_hits,
                "ucdp": ucdp_hits,
                "installations": len(inst),
            },
            "events": events[:_MAX_EVENTS],
            "sources": sources,
            "notes": notes,
        }

    return await cache.get_or_fetch(key, _SECURITY_TTL, load)


_BRIEF_SYS = (
    "You are a senior all-source intelligence analyst. Produce a concise, "
    "structured COUNTRY BRIEF in Markdown with exactly these sections, each an "
    "H2 heading: ## Overview, ## Political leadership, ## Military posture, "
    "## Recent security events, ## Watch items. Ground EVERY statement ONLY in "
    "the JSON data provided. Do not add outside knowledge, do not speculate, "
    "do not invent names, numbers, or events. Cite figures exactly as given "
    "(with their units). If a section has no supporting data, say so plainly in "
    "one line rather than guessing. Keep it tight and factual."
)


def _wb_digest(wb: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Latest value per World Bank indicator, for the model prompt."""
    out: list[dict[str, Any]] = []
    for ind in (wb or {}).get("indicators") or []:
        series = ind.get("series") or []
        latest = series[-1] if series else None
        if latest is None:
            continue
        out.append(
            {
                "indicator": ind.get("label") or ind.get("id"),
                "unit": ind.get("unit"),
                "year": latest.get("year"),
                "value": latest.get("value"),
            }
        )
    return out


async def country_brief(
    iso3: str,
    name: str | None,
    wb: dict[str, Any] | None,
    profile: dict[str, Any] | None,
    security: dict[str, Any] | None,
) -> dict[str, Any]:
    """LLM all-source brief fusing WB indicators + leadership + security counts.

    Returns ``{ok: True, markdown, backend, model, usage}`` on success, or
    ``{ok: False, reason}`` when no LLM backend answers — never a 500, never a
    fabricated brief. Cached 10 min per country.
    """
    from app import llm

    iso3u = iso3.strip().upper()
    key = f"country:brief:{iso3u}"

    async def load() -> dict[str, Any]:
        payload = {
            "country": name or iso3u,
            "iso3": iso3u,
            "worldbank_latest": _wb_digest(wb),
            "leadership": (profile or {}).get("leadership") or [],
            "military_branches": (profile or {}).get("military_branches") or [],
            "security_counts": (security or {}).get("counts") or {},
            "recent_security_events": ((security or {}).get("events") or [])[:12],
            "data_notes": (security or {}).get("notes") or [],
        }
        import json as _json

        try:
            res = await asyncio.wait_for(
                llm.chat(
                    [
                        {"role": "system", "content": llm.with_prose_style(_BRIEF_SYS)},
                        {"role": "user", "content": _json.dumps(payload, ensure_ascii=False)},
                    ],
                    tier="fast",
                    max_tokens=900,
                    timeout_s=60.0,
                    label="country.brief",
                ),
                timeout=_BRIEF_LLM_BUDGET_S,
            )
        except TimeoutError:
            return {"ok": False, "reason": "no LLM backend configured", "iso3": iso3u, "name": name}
        if not res.ok:
            return {
                "ok": False,
                "reason": "no LLM backend configured",
                "iso3": iso3u,
                "name": name,
            }
        return {
            "ok": True,
            "iso3": iso3u,
            "name": name,
            "markdown": res.text,
            "backend": res.backend,
            "model": res.model,
            "usage": res.usage,
        }

    out = await cache.get_or_fetch(key, _BRIEF_TTL, load)
    if not out.get("ok"):
        cache.shorten(key, 30.0)
    return out
