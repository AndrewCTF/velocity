"""Cross-domain incident fusion — the brief.

The rest of the intel API surfaces SIGNALS (aircraft, jamming cells, dark
vessels, alerts, geocoded events). This module CHAINS them: signals that are
co-located and co-temporal across MORE THAN ONE domain become a single ranked
INCIDENT with a deterministic narrative, the contributing evidence (IDs), a
confidence-scaled threat level, and recommended follow-up queries.

Design rules that keep this intelligence rather than a gimmick:

- **An incident is a CONVERGENCE.** A cluster is only promoted to an incident
  when it spans >=2 distinct domains OR contains a single critical/high signal
  (an emergency squawk, a major quake, a high-severity jamming cluster). One
  lone civilian dark vessel or one lone GDELT headline is a signal, not an
  incident — that is what stops the brief from being noise.
- **Every claim is cited.** The narrative is built from rule-based templates
  over the domain SET present; each incident carries the IDs of its
  contributing signals. Nothing is invented. (An LLM may reason ON TOP of this
  via deep_analyze, but the incident itself is deterministic and traceable.)
- **It reuses the warm in-process data** the globe + MCP already share
  (``analytics`` snapshot, ``correlate.store``/``bus``, the events loaders) —
  no new steady-state upstream load.
"""

from __future__ import annotations

import time
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from app.correlate.bus import bus, jamming_recent
from app.correlate.store import store
from app.intel import analytics
from app.intel.geo import BBox, aircraft_category, feature_lonlat, haversine_km

# Domains the fusion engine reasons over. The narrative + scoring key off these.
DOMAINS = (
    "air-emergency",
    "gps-jamming",
    "dark-vessel",
    "military",
    "ais-gap",
    "event",
    "quake",
)

_SEV_WEIGHT = {"critical": 5, "high": 3, "medium": 2, "low": 1}

# Per-domain hard caps so a flood in one domain can't dominate the O(N^2)
# clustering or the token budget.
_MAX_PER_DOMAIN = 200
_MAX_INCIDENTS = 25
_MAX_EVIDENCE = 12

# Default convergence link distance (km): a signal joins an incident when within
# this of the incident's SEED. Seed (canopy) clustering bounds an incident's
# diameter to ~2*link_km so a dense field can't chain into one giant blob.
_DEFAULT_LINK_KM = 50.0
# Only consider signals at most this old (s). Keeps the brief about NOW.
_DEFAULT_WINDOW_S = 6 * 3600.0


@dataclass
class Signal:
    domain: str
    severity: str
    t: float
    lon: float
    lat: float
    summary: str
    ref: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])


# ── signal gathering ──────────────────────────────────────────────────────────


def _squawk_sev(sq: str | None) -> str:
    return {"7500": "critical", "7600": "high", "7700": "high"}.get(str(sq), "high")


async def _gather(bbox: BBox | None, window_s: float) -> list[Signal]:
    """Collect cross-domain signals (bbox-scoped, recent) as comparable points."""
    now = time.time()
    cutoff = now - window_s
    out: list[Signal] = []

    def add(sigs: list[Signal], cap: int = _MAX_PER_DOMAIN) -> None:
        out.extend(sigs[:cap])

    # 1) aircraft snapshot → emergencies + military (one scan, no extra fetch).
    feats = await analytics._snapshot()
    emerg: list[Signal] = []
    mil: list[Signal] = []
    for f in feats:
        ll = feature_lonlat(f)
        if ll is None or (bbox is not None and not bbox.contains(ll[0], ll[1])):
            continue
        p = f.get("properties") or {}
        cat = aircraft_category(p)
        ident = p.get("callsign") or p.get("icao24") or "?"
        if cat == "emergency":
            sq = p.get("squawk")
            emerg.append(
                Signal("air-emergency", _squawk_sev(sq), now, ll[0], ll[1],
                       f"{ident} squawking {sq}", {"icao24": p.get("icao24"), "squawk": sq})
            )
        elif cat == "military" or p.get("source") == "adsb_mil":
            mil.append(
                Signal("military", "medium", now, ll[0], ll[1],
                       f"military contact {ident}",
                       {"icao24": p.get("icao24"), "callsign": p.get("callsign")})
            )
    add(emerg)
    add(mil)

    # 2) GPS-jamming cells (high/medium only — a flagged convergence point).
    jam = await analytics.jamming(bbox)
    jam_sigs = [
        Signal("gps-jamming", c["severity"], now, c["lon"], c["lat"],
               f"GPS jamming cell {c.get('bad')}/{c.get('total')} aircraft degraded "
               f"({c.get('percent_bad')}%)",
               {"cell": [c["lon"], c["lat"]], "percent_bad": c.get("percent_bad")})
        for c in jam["cells"] if c["severity"] in ("high", "medium")
    ]
    add(jam_sigs)

    # 3) Dark / AIS-off vessel candidates.
    dark = await analytics.query_vessels(bbox, dark_only=True, limit=_MAX_PER_DOMAIN)
    dark_sigs = [
        Signal("dark-vessel", "medium", now - (v.get("age_s") or 0), v["lon"], v["lat"],
               f"dark/AIS-off vessel {v.get('mmsi') or '?'}",
               {"mmsi": v.get("mmsi"), "category": v.get("category")})
        for v in dark["vessels"]
    ]
    add(dark_sigs)

    # 4) Quakes from the fusion store.
    q_sigs: list[Signal] = []
    for o in store.latest("quake"):
        if o.t < cutoff:
            continue
        if bbox is not None and not bbox.contains(o.lon, o.lat):
            continue
        try:
            mag = float((o.attrs or {}).get("mag"))
        except (TypeError, ValueError):
            continue
        if mag < 4.0:
            continue
        place = (o.attrs or {}).get("place") or "unknown"
        q_sigs.append(
            Signal("quake", "high" if mag >= 6 else "medium", o.t, o.lon, o.lat,
                   f"M{mag:.1f} earthquake — {place}", {"mag": mag})
        )
    add(q_sigs)

    # 5) Fusion alerts already emitted by the rule engine (proximity_mil_vessel,
    #    ais_gap_in_aoi, mil_in_aoi, …). Map each rule to a domain so it clusters
    #    with the raw signals it relates to.
    rule_domain = {
        "ais_gap_in_aoi": "ais-gap",
        "proximity_mil_vessel": "military",
        "mil_in_aoi": "military",
        "gps_jam_cluster": "gps-jamming",
        "emergency_squawk": "air-emergency",
        "major_quake": "quake",
    }
    seen: set[str] = set()
    alert_sigs: list[Signal] = []
    for al in bus.recent(200) + jamming_recent(100):
        if al.id in seen or al.t < cutoff:
            continue
        seen.add(al.id)
        if bbox is not None and not bbox.contains(al.lon, al.lat):
            continue
        alert_sigs.append(
            Signal(rule_domain.get(al.rule_id, "ais-gap"), al.severity, al.t, al.lon, al.lat,
                   al.message, {"alert_id": al.id, "rule": al.rule_id})
        )
    add(alert_sigs)

    # 6) Geocoded events (EONET natural + GDELT news + ACLED conflict). These are
    #    only ever promoted into an incident when they CONVERGE with a GEOINT
    #    signal — a lone headline is not actionable on its own.
    add(await _event_signals(bbox, cutoff))

    return out


async def _event_signals(bbox: BBox | None, cutoff: float) -> list[Signal]:
    import asyncio  # noqa: PLC0415

    from app.config import get_settings  # noqa: PLC0415
    from app.routes import events as ev  # noqa: PLC0415

    settings = get_settings()
    results = await asyncio.gather(
        ev._load_eonet(status="open", category=None, limit=500),
        ev._load_gdelt(timespan="24h", maxrecords=250),
        ev._load_acled(settings, 7),
        return_exceptions=True,
    )
    out: list[Signal] = []
    for res in results:
        if isinstance(res, BaseException):
            continue
        for f in (res or {}).get("features") or []:
            ll = feature_lonlat(f)
            if ll is None or (bbox is not None and not bbox.contains(ll[0], ll[1])):
                continue
            p = f.get("properties") or {}
            src = p.get("source") or "event"
            # ACLED with fatalities is the only event class that rates "high".
            try:
                fatal = int(p.get("fatalities") or 0)
            except (TypeError, ValueError):
                fatal = 0
            sev = "high" if fatal > 0 else "low"
            label = p.get("title") or p.get("event_type") or p.get("name") or "event"
            out.append(
                Signal("event", sev, time.time(), ll[0], ll[1],
                       f"{label} ({src})", {"source": src, "id": f.get("id")})
            )
    return out


# ── clustering (union-find over the convergence graph) ───────────────────────


def _cluster(signals: list[Signal], link_km: float) -> list[list[Signal]]:
    """Seed (canopy) clustering: each signal joins the nearest existing SEED
    within link_km, else becomes a new seed.

    Unlike single-link, seeds do NOT move and members are only ever tested
    against seeds — so an incident's diameter is bounded to ~2*link_km and a
    dense field (e.g. hundreds of Baltic AIS contacts) can't chain end-to-end
    into one 300 km 'incident'. Signals are processed strongest-first so the
    most significant signal seeds each incident.
    """
    seeds: list[dict[str, Any]] = []  # {lon, lat, members}
    order = sorted(
        range(len(signals)),
        key=lambda i: _SEV_WEIGHT.get(signals[i].severity, 1),
        reverse=True,
    )
    for i in order:
        s = signals[i]
        best: dict[str, Any] | None = None
        best_d = link_km
        for seed in seeds:
            d = haversine_km(s.lon, s.lat, seed["lon"], seed["lat"])
            if d <= best_d:
                best_d = d
                best = seed
        if best is None:
            seeds.append({"lon": s.lon, "lat": s.lat, "members": [s]})
        else:
            best["members"].append(s)
    return [seed["members"] for seed in seeds]


# ── scoring + narrative ──────────────────────────────────────────────────────


def _score(cluster: list[Signal]) -> tuple[int, str]:
    domains = {s.domain for s in cluster}
    sev_total = sum(_SEV_WEIGHT.get(s.severity, 1) for s in cluster)
    cross = 4 * (len(domains) - 1)  # fusion is the value: reward multi-domain
    newest = max(s.t for s in cluster)
    age = time.time() - newest
    recency = 2 if age < 3600 else (1 if age < 6 * 3600 else 0)
    score = sev_total + cross + recency
    has_crit = any(s.severity == "critical" for s in cluster)
    has_high = any(s.severity == "high" for s in cluster)
    if has_crit or score >= 12:
        level = "high"
    elif has_high or score >= 6:
        level = "elevated"
    else:
        level = "low"
    return score, level


# Narrative templates keyed by a frozenset of domains present. The richest
# matching pattern wins; everything falls back to a generic convergence line.
def _narrate(cluster: list[Signal]) -> str:
    d = {s.domain for s in cluster}
    n = len(cluster)

    def cnt(dom: str) -> int:
        return sum(1 for s in cluster if s.domain == dom)

    # Emergency always leads.
    if "air-emergency" in d:
        emg = next(s for s in cluster if s.domain == "air-emergency")
        extra = sorted(d - {"air-emergency"})
        tail = f" co-located with {', '.join(extra)} signals" if extra else ""
        return f"Aircraft emergency — {emg.summary}{tail}."
    if "quake" in d and len(d) > 1:
        qk = next(s for s in cluster if s.domain == "quake")
        return f"{qk.summary}, co-located with {', '.join(sorted(d - {'quake'}))} activity."
    if {"dark-vessel", "gps-jamming"} <= d:
        return (f"{cnt('dark-vessel')} dark/AIS-off vessel(s) inside a GPS-jamming footprint "
                "— possible deliberate AIS concealment under electronic-warfare cover.")
    if {"dark-vessel", "military"} <= d:
        return (f"{cnt('dark-vessel')} dark/AIS-off vessel(s) with military air interest nearby "
                "— possible interdiction or shadowing.")
    if {"gps-jamming", "military"} <= d:
        return ("GPS jamming co-located with military air activity — possible active "
                "electronic warfare.")
    if "event" in d and (d & {"dark-vessel", "ais-gap", "military", "gps-jamming"}):
        geo = sorted(d - {"event"})
        return (f"Reported event corroborated by live {', '.join(geo)} signal(s) — "
                "open-source reporting and sensor data converge.")
    if {"ais-gap", "event"} <= d or {"dark-vessel", "ais-gap"} <= d:
        return "Vessel(s) went silent / dark near reported activity."
    if len(d) >= 2:
        return f"Convergence of {n} signals across {', '.join(sorted(d))}."
    # Single-domain incident (only reached for a high/critical lone signal).
    return cluster[0].summary


def _follow_up(domains: set[str], lat: float, lon: float) -> list[str]:
    fu: list[str] = []
    r = "radius_nm=80"
    if "dark-vessel" in domains or "ais-gap" in domains:
        fu.append(f"query_vessels(lat={lat:.3f}, lon={lon:.3f}, {r}, dark_only=True)")
    if "gps-jamming" in domains:
        fu.append(f"gps_jamming(lat={lat:.3f}, lon={lon:.3f}, {r})")
    if "military" in domains or "air-emergency" in domains:
        fu.append(f"query_aircraft(lat={lat:.3f}, lon={lon:.3f}, {r}, category='military')")
    fu.append(f"deep_analyze('assess this incident', lat={lat:.3f}, lon={lon:.3f})")
    return fu[:4]


# ── public: the brief ─────────────────────────────────────────────────────────


async def brief(
    bbox: BBox | None = None,
    link_km: float = _DEFAULT_LINK_KM,
    window_s: float = _DEFAULT_WINDOW_S,
    limit: int = _MAX_INCIDENTS,
) -> dict[str, Any]:
    """Ranked cross-domain incidents for an area (or global).

    Returns incidents (each: narrative, threat_level, score, domains, evidence
    IDs, centroid, follow-up) plus a top-line assessment. An incident is a
    convergence of >=2 domains or a single critical/high signal — lone
    low-severity signals are intentionally excluded.
    """
    signals = await _gather(bbox, window_s)
    clusters = _cluster(signals, link_km)

    incidents: list[dict[str, Any]] = []
    for cl in clusters:
        domains = {s.domain for s in cl}
        score, level = _score(cl)
        # Promotion rule: convergence (>=2 domains) OR a lone critical/high signal.
        if len(domains) < 2 and not any(s.severity in ("critical", "high") for s in cl):
            continue
        clon = sum(s.lon for s in cl) / len(cl)
        clat = sum(s.lat for s in cl) / len(cl)
        span = max((haversine_km(clon, clat, s.lon, s.lat) for s in cl), default=0.0)
        newest = max(s.t for s in cl)
        evidence = [
            {"domain": s.domain, "severity": s.severity, "summary": s.summary,
             "lon": round(s.lon, 4), "lat": round(s.lat, 4), "ref": s.ref}
            for s in sorted(cl, key=lambda s: _SEV_WEIGHT.get(s.severity, 1), reverse=True)
        ][:_MAX_EVIDENCE]
        incidents.append({
            "id": uuid.uuid4().hex[:10],
            "threat_level": level,
            "score": score,
            "domains": sorted(domains),
            "signal_count": len(cl),
            "centroid": {"lon": round(clon, 4), "lat": round(clat, 4)},
            "span_km": round(span, 1),
            "newest_age_s": int(time.time() - newest),
            "narrative": _narrate(cl),
            "evidence": evidence,
            "evidence_truncated": len(cl) > len(evidence),
            "follow_up": _follow_up(domains, clat, clon),
        })

    order = {"high": 3, "elevated": 2, "low": 1}
    incidents.sort(key=lambda i: (order.get(i["threat_level"], 0), i["score"]), reverse=True)
    incidents = incidents[:limit]

    lvl_counts: Counter[str] = Counter(i["threat_level"] for i in incidents)
    top = "low"
    if lvl_counts.get("high"):
        top = "high"
    elif lvl_counts.get("elevated"):
        top = "elevated"

    return {
        "generated_at": int(time.time()),
        "bbox": bbox.as_dict() if bbox else None,
        "scope": "area" if bbox else "global",
        "window_hours": round(window_s / 3600, 1),
        "link_km": link_km,
        "top_threat_level": top,
        "incident_count": len(incidents),
        "by_level": dict(lvl_counts),
        "signals_considered": len(signals),
        "incidents": incidents,
        "method": "cross-domain convergence: signals within link_km fused; promoted "
        "to an incident on >=2 domains or a critical/high signal. Narrative is "
        "rule-based; every claim cites its contributing signals.",
    }
