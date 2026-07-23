"""Country Instability Index (CII) — Phase C of the worldmonitor-gaps plan.

Fuses seven independently-degrading signals into one 0-100 per-country
instability score. This module is the SCORER only: ``score_all()`` computes
rows, ``score_and_store()`` persists them via ``instability_local.py``. The
``/api/instability`` route and ``country_stats`` integration are a later
task — nothing here imports a route handler for its HTTP surface, only the
lifted ``load_*``/``*_summary`` callables those route modules expose for
in-process reuse (mirrors the ``global_snapshot()`` pattern in ``adsb.py``).

## Signals and weights

Weights sum to 1.0 over the FULL set (``COMPONENT_WEIGHTS`` below); a run
where a component's source is unavailable drops that component and
renormalizes the remaining weights to sum to 1 (see ``_score_country``).

| component          | weight | source(s)                                   |
|--------------------|--------|----------------------------------------------|
| armed_conflict     | 0.30   | GDELT + UCDP event counts (mixed matching — see below) |
| news_pressure      | 0.15   | latest edition's country-tagged stories (verified 2x) |
| unrest_advisories  | 0.10   | ``advisories_summary()`` max level 1-4 (linear) |
| displacement       | 0.10   | ``displacement_summary()`` idps+refugees (log scale) |
| infra_disruption   | 0.15   | ``load_ioda()`` outage counts (jamming skipped, see below) |
| natural_hazard     | 0.10   | ``load_gdacs()`` alert-weighted events + ``load_quakes()`` M>=5.5 |
| market_risk_off    | 0.10   | ``market_stress()`` composite score, same value for every country |

``armed_conflict``'s two sources are matched differently: GDELT features carry
a ``properties.iso3`` but it is unreliable (FIPS-geocoded, frequently wrong),
so they count only on a word-boundary match of the country's name against
either CAMEO actor (``app.intel.gdelt_match``); UCDP's curated ``country``
field is trustworthy and counts straight on ``iso3``, unchanged.

## Normalization

Count-based components use ``100 * (1 - exp(-count/k))`` (self-normalizing,
no cross-country percentile needed at cold start — simpler than a trailing
z-score, which is a deliberate simplification to revisit once
``instability_snapshots`` has enough history to compute one per component).
Each component's ``k`` is documented at its computation site below.

## Renormalization clamp

A country missing components renormalizes the survivors' weights to sum to
1 (``weight / weight_sum``) — but for a country with only the 4 baseline
components present (armed_conflict + unrest_advisories + displacement +
market_risk_off, the common case when neither natural_hazard nor
news_pressure has signal that week), armed_conflict's base 0.30 renormalizes
to 0.30/0.60 = 0.50, letting the single noisiest, least-attributable
component swing half the score. Each renormalized weight is therefore
clamped to ``_MAX_COMPONENT_WEIGHT`` (0.40); the clamped-off excess is
DROPPED, never redistributed to the other components, so a thin candidate's
weights can sum to < 1. The final score is a plain weighted sum of these
already-clamped weights — it is NEVER re-divided by their (possibly
under-1) sum — so a country with fewer live signals can only score LOWER
than a fuller one, never get inflated back up by a second renormalization.

## Jamming attribution — deliberately skipped

``jamming_nacp()`` (``routes/jamming.py``) buckets aircraft into 1 deg^2 hex
cells with no country attribution at all — the hex lattice is a pure
lon/lat grid, and ``geo/adminshapes.py`` only exposes NAME/FIPS-code lookups
(``country_name_to_iso3``, ``fips_to_iso3``), not a point-in-country test.
Bolting on a rough "is this hex centroid inside country X's bbox" heuristic
would be exactly the unverified-geo shortcut CLAUDE.md warns against for a
layer that's already coarse (1 deg cells, percent-bad heuristic). So
``infra_disruption`` is IODA outages only; jamming is out of scope for this
component until a real point-in-country test exists in ``geo/``.

## IODA event shape — best-effort, degrades on drift

This sandbox's egress could not reach ``api.ioda.caida.org`` to verify the
`/v2/outages/events` response shape live (no network egress at all from
this environment, a different failure than the documented per-host quirks
in CLAUDE.md). Extraction is written defensively against IODA's documented
schema (an ``entity`` object with ``type``/``code``/``name``) and against a
few plausible flat-field fallbacks; any event that doesn't match degrades to
"unattributed" and is dropped rather than guessed, per the never-guess rule.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

from app.geo.adminshapes import country_name_to_iso3
from app.intel import instability_local
from app.intel.conflict import conflict_events
from app.intel.gdelt_match import actor_matches_country
from app.intel.ucdp import ucdp_events
from app.markets import market_stress
from app.news.history_local import latest as news_latest
from app.routes.advisories import advisories_summary
from app.routes.country_stats import countries_iso
from app.routes.cyber import load_ioda
from app.routes.displacement import displacement_summary
from app.routes.eq import load_quakes
from app.routes.hazards import load_gdacs

# Weights sum to 1.0 over the full component set; a missing component's
# weight is redistributed proportionally over whatever remains present for
# that country (see `_score_country`). Guarded by
# tests/test_invariants.py::test_cii_weights_sum_to_one.
COMPONENT_WEIGHTS: dict[str, float] = {
    "armed_conflict": 0.30,
    "news_pressure": 0.15,
    "unrest_advisories": 0.10,
    "displacement": 0.10,
    "infra_disruption": 0.15,
    "natural_hazard": 0.10,
    "market_risk_off": 0.10,
}

# k for the exp-decay count normalization `100 * (1 - exp(-count/k))`, one
# per count-based component. Chosen so a handful of strongly-diagnostic
# events already reads as "high" without a single stray event maxing the
# score; documented per-component rather than a single global constant
# because the source event rates differ by an order of magnitude.
_K_ARMED_CONFLICT = 15.0  # combined GDELT(72h)+UCDP events attributed to the country
_K_NEWS_PRESSURE = 8.0  # weighted (verified/contested=2x) country-tagged stories
_K_INFRA_DISRUPTION = 5.0  # IODA outage events attributed to the country
_K_NATURAL_HAZARD = 6.0  # alert-weighted GDACS events + M>=5.5 quakes

# Displacement uses a LOG scale rather than exp-decay (spec deliberately
# calls this out): idp/refugee totals span 5+ orders of magnitude (a few
# thousand to multiple millions), where exp-decay's single-k shape either
# saturates instantly or barely moves. `_DISPLACEMENT_CAP` is the total at
# which the component reads as fully saturated (100); worked examples:
# 10k -> ~44, 100k -> ~59, 1M -> ~80, 2M+ -> 100.
_DISPLACEMENT_CAP = 2_000_000.0

# GDACS alert-level -> severity weight for the natural_hazard raw count.
_GDACS_ALERT_WEIGHT = {"green": 1.0, "orange": 2.0, "red": 3.0}

# Verification statuses (app/news/verify.py) that count double toward
# news_pressure: a story the ensemble actually corroborated (any status
# starting "verified") or flagged as unresolved between models ("contested")
# is a stronger signal than a merely "reviewed"/"unverified" one.
_NEWS_DOUBLE_WEIGHT_STATUSES_PREFIX = "verified"
_NEWS_DOUBLE_WEIGHT_STATUS_EXACT = "contested"

# quake magnitude floor + USGS feed range for the natural_hazard component.
_QUAKE_MIN_MAG = 5.5
_QUAKE_RANGE = "week"

# GDELT conflict window for the armed_conflict component.
_CONFLICT_HOURS = 72

# Minimum number of non-global (i.e. not market_risk_off) present components
# a country needs to be scored at all — otherwise a country with only, say,
# a travel advisory on file would get a whole-cloth score off one weak
# signal, and the whole world would get scored off market_risk_off alone
# (the one truly global component) if nothing else were available.
_MIN_NON_GLOBAL_COMPONENTS = 2

# Cap on a single component's post-renormalization weight — see "##
# Renormalization clamp" in the module docstring. The clamped-off excess is
# dropped, never redistributed, so a thin candidate's weights can sum to <1.
_MAX_COMPONENT_WEIGHT = 0.40


def _decay(count: float, k: float) -> float:
    """`100 * (1 - exp(-count/k))`, clamped to [0, 100]."""
    if count <= 0:
        return 0.0
    return max(0.0, min(100.0, 100.0 * (1.0 - math.exp(-count / k))))


async def _safe(coro: Any) -> Any:
    """Await `coro`, returning None on ANY exception so one dead source
    never takes the whole scorer down — the "independent try/except" rule."""
    try:
        return await coro
    except Exception:  # noqa: BLE001 — deliberately broad: any signal may degrade
        return None


def _country_from_place(place: str | None) -> str | None:
    """Best-effort ISO3 from a USGS earthquake `place` string (e.g. "20km SE
    of Test City, Chile"). Tries the whole string first (handles bare
    country-name places like "South Sandwich Islands region" only if that
    exact phrase is in the alias/ISO table, which it usually isn't), then
    falls back to substring matching against every known country name and
    keeps the longest match to avoid short-name false positives (mirrors
    `app.news.verify.country_tags`). None when nothing resolves — never
    guessed."""
    if not place:
        return None
    direct = country_name_to_iso3(place)
    if direct:
        return direct
    text = place.casefold()
    try:
        from app.geo.adminshapes import _name_index  # noqa: PLC0415
    except Exception:  # noqa: BLE001 — best-effort only
        return None
    best_name = ""
    best_iso3: str | None = None
    for name, iso3 in _name_index().items():
        if len(name) >= 4 and name in text and len(name) > len(best_name):
            best_name, best_iso3 = name, iso3
    return best_iso3


def _ioda_country(event: dict[str, Any]) -> str | None:
    """Best-effort ISO3 from one IODA outage event. The live API (probed
    2026-07-21) emits ``location: "country/XX"`` / ``"asn/123"`` /
    ``"region/..."`` strings in codf format; the documented ``entity`` shape
    and flat name fields are kept as fallbacks for other formats."""
    location = event.get("location")
    if isinstance(location, str) and location.startswith("country/"):
        code = location.split("/", 1)[1].strip()
        if len(code) == 2:
            iso3 = _alpha2_to_iso3(code)
            if iso3:
                return iso3
    entity = event.get("entity")
    if isinstance(entity, dict):
        etype = str(entity.get("type") or "").lower()
        code = entity.get("code")
        name = entity.get("name")
        if etype in ("", "country") and isinstance(code, str) and len(code) == 2:
            iso3 = _alpha2_to_iso3(code)
            if iso3:
                return iso3
        if isinstance(name, str):
            iso3 = country_name_to_iso3(name)
            if iso3:
                return iso3
    for key in ("locationName", "location_name", "country", "countryName"):
        val = event.get(key)
        if isinstance(val, str):
            iso3 = country_name_to_iso3(val)
            if iso3:
                return iso3
    for key in ("location", "country_code", "code"):
        val = event.get(key)
        if isinstance(val, str) and len(val) == 2:
            iso3 = _alpha2_to_iso3(val)
            if iso3:
                return iso3
    return None


_ALPHA2_TO_ALPHA3: dict[str, str] | None = None


def _alpha2_to_iso3(alpha2: str) -> str | None:
    """ISO 3166-1 alpha-2 -> alpha-3, built once from the same bundled
    `countries_iso.json` `country_name_to_iso3` reads (not itself exported
    from `adminshapes.py` — it only ships a name index)."""
    global _ALPHA2_TO_ALPHA3
    if _ALPHA2_TO_ALPHA3 is None:
        import json
        from pathlib import Path

        path = (
            Path(__file__).resolve().parent.parent / "data" / "countries_iso.json"
        )
        table: dict[str, str] = {}
        try:
            with path.open(encoding="utf-8") as fh:
                rows = json.load(fh)
            for row in rows:
                a2, a3 = row.get("alpha-2"), row.get("alpha-3")
                if a2 and a3:
                    table[str(a2).upper()] = str(a3).upper()
        except (OSError, ValueError):
            pass
        _ALPHA2_TO_ALPHA3 = table
    return _ALPHA2_TO_ALPHA3.get(alpha2.upper())


def _iso3_name_pairs() -> list[tuple[str, str]]:
    """(iso3, name) for every ISO-3166 country — reuses the exact iso3->name
    resolution the Country app already uses (``country_stats.countries_iso()``,
    the same bundled ``countries_iso.json`` ``_alpha2_to_iso3`` above reads)
    rather than vendoring a second country-name list."""
    return [
        (str(row["alpha-3"]).upper(), str(row["name"]))
        for row in countries_iso()
        if row.get("alpha-3") and row.get("name")
    ]


async def _armed_conflict_counts() -> dict[str, float] | None:
    """armed_conflict raw count per iso3.

    GDELT half: ``conflict_events`` features carry a ``properties.iso3`` but
    it is frequently wrong (FIPS-geocoded, mistags e.g. UK-hosted tech and
    entertainment articles as UK conflict events — see docs/decisions.md), so
    a feature counts for a country only when its actor1/actor2 text
    word-boundary-matches that country's name — the same
    ``gdelt_match.actor_matches_country`` heuristic
    ``country_profile.country_security()`` uses, generalized across every
    ISO-3166 country instead of one at a time. Reporting intensity, not
    verified ground truth.

    UCDP half: unchanged straight ``properties.iso3`` tally — UCDP's
    ``country`` field is curated upstream and trustworthy, unlike GDELT's
    free-text actors.
    """
    conflict_fc = await _safe(conflict_events(hours=_CONFLICT_HOURS))
    ucdp_fc = await _safe(ucdp_events())
    if conflict_fc is None and ucdp_fc is None:
        return None
    counts: dict[str, float] = defaultdict(float)

    if conflict_fc:
        pairs = _iso3_name_pairs()
        for feat in conflict_fc.get("features") or []:
            props = feat.get("properties") or {}
            actor1, actor2 = props.get("actor1"), props.get("actor2")
            if not actor1 and not actor2:
                continue
            for iso3, name in pairs:
                if actor_matches_country(actor1, name) or actor_matches_country(actor2, name):
                    counts[iso3] += 1.0

    if ucdp_fc:
        for feat in ucdp_fc.get("features") or []:
            iso3 = (feat.get("properties") or {}).get("iso3")
            if iso3:
                counts[str(iso3)] += 1.0

    return dict(counts)


async def _news_pressure_counts() -> dict[str, float] | None:
    snap = await _safe(news_latest("edition"))
    if snap is None:
        return None
    stories = ((snap.get("payload") or {}).get("stories")) or []
    counts: dict[str, float] = defaultdict(float)
    for story in stories:
        countries = story.get("countries") or []
        if not countries:
            continue
        status = str((story.get("verification") or {}).get("status") or "")
        weight = (
            2.0
            if status.startswith(_NEWS_DOUBLE_WEIGHT_STATUSES_PREFIX)
            or status == _NEWS_DOUBLE_WEIGHT_STATUS_EXACT
            else 1.0
        )
        for iso3 in countries:
            counts[str(iso3)] += weight
    return dict(counts)


async def _infra_disruption_counts() -> dict[str, float] | None:
    ioda = await _safe(load_ioda(days=7))
    if ioda is None or ioda.get("unavailable"):
        return None
    counts: dict[str, float] = defaultdict(float)
    for event in ioda.get("items") or []:
        if not isinstance(event, dict):
            continue
        iso3 = _ioda_country(event)
        if iso3:
            counts[iso3] += 1.0
    return dict(counts)


async def _natural_hazard_counts() -> dict[str, float] | None:
    gdacs_fc = await _safe(load_gdacs())
    quakes_fc = await _safe(load_quakes(_QUAKE_RANGE))
    if gdacs_fc is None and quakes_fc is None:
        return None
    counts: dict[str, float] = defaultdict(float)
    for feat in (gdacs_fc or {}).get("features") or []:
        props = feat.get("properties") or {}
        iso3 = country_name_to_iso3(props.get("country"))
        if not iso3:
            continue
        weight = _GDACS_ALERT_WEIGHT.get(str(props.get("alert") or "").lower(), 1.0)
        counts[iso3] += weight
    for feat in (quakes_fc or {}).get("features") or []:
        props = feat.get("properties") or {}
        mag = props.get("mag")
        try:
            mag_v = float(mag)
        except (TypeError, ValueError):
            continue
        if mag_v < _QUAKE_MIN_MAG:
            continue
        iso3 = _country_from_place(props.get("place"))
        if iso3:
            counts[iso3] += 1.0
    return dict(counts)


async def score_all() -> list[dict[str, Any]]:
    """Score every country with enough signal to score honestly.

    Returns rows `{iso3, score, components}` where `components` is a list of
    `{key, raw, normalized, weight, inputs}` dicts (weight already
    renormalized over what's present for THIS country) and `score` is the
    weighted sum rounded to one decimal. `components_present` on each row
    lists which component keys contributed. Countries with fewer than
    `_MIN_NON_GLOBAL_COMPONENTS` non-market components are dropped entirely.
    """
    (
        conflict_counts,
        news_counts,
        adv_levels,
        disp_counts,
        infra_counts,
        hazard_counts,
        stress,
    ) = [
        await coro
        for coro in (
            _armed_conflict_counts(),
            _news_pressure_counts(),
            _safe(advisories_summary()),
            _safe(displacement_summary()),
            _infra_disruption_counts(),
            _natural_hazard_counts(),
            _safe(market_stress()),
        )
    ]

    market_available = stress is not None and not (
        stress.get("degraded") and stress.get("score") == 0
    )
    market_score = float(stress["score"]) if market_available else 0.0

    # Candidate set: every iso3 that shows up with real signal in ANY local
    # (non-global) component — never every country in the world, or a dead
    # market_risk_off-only run would score nobody, and a live one would score
    # everybody off one global number.
    candidates: set[str] = set()
    for counts in (
        conflict_counts, news_counts, adv_levels, disp_counts, infra_counts, hazard_counts,
    ):
        if counts:
            candidates |= set(counts)

    rows: list[dict[str, Any]] = []
    for iso3 in sorted(candidates):
        components: list[dict[str, Any]] = []

        # iso3/components bound as defaults so this closure captures the current
        # iteration's values (it's invoked immediately below, but the binding
        # keeps ruff's B023 happy and stays correct if a call is ever deferred).
        def _add_count(
            key: str,
            counts: dict[str, float] | None,
            k: float,
            iso3: str = iso3,
            components: list[dict[str, Any]] = components,
        ) -> None:
            if counts is None or iso3 not in counts:
                return
            raw = counts[iso3]
            components.append(
                {
                    "key": key,
                    "raw": raw,
                    "normalized": round(_decay(raw, k), 2),
                    "weight": COMPONENT_WEIGHTS[key],
                    "inputs": {"count": raw},
                }
            )

        _add_count("armed_conflict", conflict_counts, _K_ARMED_CONFLICT)
        _add_count("news_pressure", news_counts, _K_NEWS_PRESSURE)
        _add_count("infra_disruption", infra_counts, _K_INFRA_DISRUPTION)
        _add_count("natural_hazard", hazard_counts, _K_NATURAL_HAZARD)

        if adv_levels is not None and iso3 in adv_levels:
            level = int(adv_levels[iso3])
            normalized = max(0.0, min(100.0, (level - 1) / 3.0 * 100.0))
            components.append(
                {
                    "key": "unrest_advisories",
                    "raw": level,
                    "normalized": round(normalized, 2),
                    "weight": COMPONENT_WEIGHTS["unrest_advisories"],
                    "inputs": {"level": level},
                }
            )

        if disp_counts is not None and iso3 in disp_counts:
            total = float(disp_counts[iso3])
            normalized = 0.0
            if total > 0:
                normalized = max(
                    0.0,
                    min(
                        100.0,
                        100.0 * math.log10(total + 1.0) / math.log10(_DISPLACEMENT_CAP + 1.0),
                    ),
                )
            components.append(
                {
                    "key": "displacement",
                    "raw": total,
                    "normalized": round(normalized, 2),
                    "weight": COMPONENT_WEIGHTS["displacement"],
                    "inputs": {"displaced": total},
                }
            )

        non_global_present = len(components)
        if non_global_present < _MIN_NON_GLOBAL_COMPONENTS:
            continue

        if market_available:
            components.append(
                {
                    "key": "market_risk_off",
                    "raw": market_score,
                    "normalized": round(market_score, 2),
                    "weight": COMPONENT_WEIGHTS["market_risk_off"],
                    "inputs": {"market_stress_score": market_score},
                }
            )

        # Renormalize each component's weight to what it would contribute
        # over the components actually present for this country, then CLAMP
        # to `_MAX_COMPONENT_WEIGHT` WITHOUT redistributing the clamped-off
        # excess (see "## Renormalization clamp" in the module docstring): a
        # thin candidate's clamped weights can sum to < 1. The score below is
        # a plain weighted sum of these already-clamped weights — it is
        # NEVER re-divided by their (possibly under-1) sum, so a country with
        # fewer live signals can only score LOWER, never get inflated back up
        # by a second renormalization.
        weight_sum = sum(c["weight"] for c in components)
        for c in components:
            c["weight"] = round(min(c["weight"] / weight_sum, _MAX_COMPONENT_WEIGHT), 4)
        score = sum(c["normalized"] * c["weight"] for c in components)

        rows.append(
            {
                "iso3": iso3,
                "score": round(score, 1),
                "components": components,
                "components_present": [c["key"] for c in components],
            }
        )

    return rows


async def score_and_store() -> int:
    """Score every country and persist the snapshot batch.

    Returns the number of rows written (0 if nothing scored this run — e.g.
    every source degraded at once). A later background loop wires this to a
    recurring task; not done here."""
    rows = await score_all()
    return await instability_local.append_snapshots(
        [{"iso3": r["iso3"], "score": r["score"], "components": r["components"]} for r in rows]
    )
