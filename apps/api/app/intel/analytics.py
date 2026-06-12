"""Distilled analytics over the live feeds — the body of the intel API.

Every public coroutine returns bounded, JSON-serialisable Python (counts,
grids, small samples). Nothing here ever returns the raw 15k-feature
snapshot; that is the whole point — an AI agent can ask broad questions
("how dense is the air over the Baltic", "where is GPS jamming worst") and
get an answer that costs a few hundred tokens, not a few hundred thousand.

Sources, all already warm in-process (no new steady-state upstream load):
- aircraft  → ``app.routes.adsb.adsb_global`` sticky snapshot (+ AOI focus)
- jamming   → ``app.routes.jamming`` NACp/NIC aggregation, reused verbatim
- vessels   → ``app.correlate.store`` observation store (AIS feeds)
- fusion    → ``app.correlate.bus`` recent alerts (dark vessel, jamming, …)
"""

from __future__ import annotations

import time
from collections import Counter
from typing import Any

from app.correlate.bus import bus, jamming_recent
from app.correlate.store import store
from app.intel import aoi
from app.intel.geo import (
    BBox,
    aircraft_category,
    bbox_from_radius,
    feature_lonlat,
    vessel_category,
)

# Bounds that keep responses context-safe.
_MAX_LIST = 50
_MAX_LIST_HARD = 200
_MAX_CELLS = 200
_MAX_SAMPLE = 25


# ── snapshot access ──────────────────────────────────────────────────────────


async def _snapshot() -> list[dict[str, Any]]:
    from app.routes.adsb import adsb_global  # noqa: PLC0415

    fc = await adsb_global()
    return list(fc.get("features") or [])


def _snapshot_age_s() -> float | None:
    from app.routes import adsb  # noqa: PLC0415

    if not adsb._LATEST_SNAPSHOT_AT:
        return None
    return round(time.monotonic() - adsb._LATEST_SNAPSHOT_AT, 1)


def _gnss_degraded(props: dict[str, Any]) -> bool:
    """nac_p<8 or nic<7 — the GPSJam 'bad fix' rule (jamming.NACP_GOOD/NIC_GOOD)."""
    nac_p, nic = props.get("nac_p"), props.get("nic")
    try:
        if nac_p is not None and int(nac_p) < 8:
            return True
    except (TypeError, ValueError):
        pass
    try:
        if nic is not None and int(nic) < 7:
            return True
    except (TypeError, ValueError):
        pass
    return False


def _compact_aircraft(f: dict[str, Any]) -> dict[str, Any] | None:
    ll = feature_lonlat(f)
    if ll is None:
        return None
    p = f.get("properties") or {}
    vel = p.get("velocity_ms")
    alt = p.get("geo_alt_m")
    if alt is None:
        alt = p.get("baro_alt_m")
    return {
        "icao24": p.get("icao24"),
        "callsign": p.get("callsign"),
        "category": aircraft_category(p),
        "type": p.get("type"),
        "lon": round(ll[0], 4),
        "lat": round(ll[1], 4),
        "alt_m": round(float(alt)) if isinstance(alt, (int, float)) else None,
        "speed_ms": round(float(vel), 1) if isinstance(vel, (int, float)) else None,
        "track_deg": p.get("track_deg"),
        "squawk": p.get("squawk"),
        "on_ground": bool(p.get("on_ground")),
        "nac_p": p.get("nac_p"),
        "nic": p.get("nic"),
        "gnss_degraded": _gnss_degraded(p),
    }


def _in_bbox(f: dict[str, Any], bbox: BBox | None) -> bool:
    if bbox is None:
        return True
    ll = feature_lonlat(f)
    return ll is not None and bbox.contains(ll[0], ll[1])


# ── situation (global orienting summary — the cheap first call) ───────────────


async def situation() -> dict[str, Any]:
    feats = await _snapshot()
    by_cat: Counter[str] = Counter()
    emerg: list[dict[str, Any]] = []
    gnss_bad = 0
    on_ground = 0
    for f in feats:
        p = f.get("properties") or {}
        cat = aircraft_category(p)
        by_cat[cat] += 1
        if _gnss_degraded(p):
            gnss_bad += 1
        if p.get("on_ground"):
            on_ground += 1
        if cat == "emergency" and len(emerg) < _MAX_SAMPLE:
            c = _compact_aircraft(f)
            if c:
                emerg.append(c)

    jam = await jamming(None)
    vessels = store.latest("vessel")
    ves_cat: Counter[str] = Counter(
        vessel_category((o.attrs or {}).get("shipType")) for o in vessels
    )
    alerts = bus.recent(200)
    sev: Counter[str] = Counter(a.severity for a in alerts)

    return {
        "generated_at": int(time.time()),
        "aircraft": {
            "total": len(feats),
            "airborne": len(feats) - on_ground,
            "on_ground": on_ground,
            "by_category": dict(by_cat),
            "gnss_degraded": gnss_bad,
            "emergencies": emerg,
            "snapshot_age_s": _snapshot_age_s(),
        },
        "gps_jamming": {
            "cells_flagged": jam["summary"]["cells_flagged"],
            "high": jam["summary"]["high"],
            "medium": jam["summary"]["medium"],
            "worst": jam["cells"][:5],
        },
        "vessels": {
            "tracked": len(vessels),
            "by_category": dict(ves_cat),
        },
        "fusion_alerts": {
            "recent": len(alerts),
            "by_severity": dict(sev),
        },
        "hint": "Call focus_area(lat,lon,radius_nm) to load a region PRIMARY, "
        "then density/jamming/anomalies for detail.",
    }


# ── density ───────────────────────────────────────────────────────────────────


async def density(
    bbox: BBox | None, cell_deg: float = 1.0, features: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    cell_deg = max(0.1, min(10.0, cell_deg))
    feats = features if features is not None else await _snapshot()
    buckets: dict[tuple[int, int], dict[str, Any]] = {}
    total = 0
    cat_totals: Counter[str] = Counter()
    for f in feats:
        ll = feature_lonlat(f)
        if ll is None:
            continue
        lon, lat = ll
        if bbox is not None and not bbox.contains(lon, lat):
            continue
        total += 1
        p = f.get("properties") or {}
        cat = aircraft_category(p)
        cat_totals[cat] += 1
        gx = int(lon // cell_deg)
        gy = int(lat // cell_deg)
        slot = buckets.setdefault(
            (gx, gy), {"count": 0, "gnss_degraded": 0, "by_category": Counter()}
        )
        slot["count"] += 1
        slot["by_category"][cat] += 1
        if _gnss_degraded(p):
            slot["gnss_degraded"] += 1

    cells = [
        {
            "lon": round(gx * cell_deg + cell_deg / 2, 3),
            "lat": round(gy * cell_deg + cell_deg / 2, 3),
            "count": v["count"],
            "gnss_degraded": v["gnss_degraded"],
            "by_category": dict(v["by_category"]),
        }
        for (gx, gy), v in buckets.items()
    ]
    cells.sort(key=lambda c: c["count"], reverse=True)
    truncated = len(cells) > _MAX_CELLS
    peak = cells[0] if cells else None

    # rough area for a vessel count in-region
    vessels_in_area = 0
    for o in store.latest("vessel"):
        if bbox is None or bbox.contains(o.lon, o.lat):
            vessels_in_area += 1

    return {
        "bbox": bbox.as_dict() if bbox else None,
        "cell_deg": cell_deg,
        "aircraft": {
            "total": total,
            "by_category": dict(cat_totals),
            "occupied_cells": len(buckets),
            "peak_cell": peak,
            "cells": cells[:_MAX_CELLS],
            "cells_truncated": truncated,
        },
        "vessels_in_area": vessels_in_area,
    }


# ── GPS jamming ────────────────────────────────────────────────────────────────


async def jamming(
    bbox: BBox | None, features: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    from app.routes.jamming import _aggregate_jamming  # noqa: PLC0415

    feats = features if features is not None else await _snapshot()
    agg = _aggregate_jamming(feats)
    raw_cells = agg.get("features") or []

    cells: list[dict[str, Any]] = []
    sev_counts: Counter[str] = Counter()
    for c in raw_cells:
        geom = c.get("geometry") or {}
        ring = (geom.get("coordinates") or [[]])[0]
        if not ring:
            continue
        # polygon ring centroid ≈ vertex mean; first vertex is the +x point at
        # the cell centre+0.5, so average the ring instead.
        cx = sum(pt[0] for pt in ring[:-1]) / max(1, len(ring) - 1)
        cy = sum(pt[1] for pt in ring[:-1]) / max(1, len(ring) - 1)
        if bbox is not None and not bbox.contains(cx, cy):
            continue
        pr = c.get("properties") or {}
        sev_counts[pr.get("severity", "none")] += 1
        cells.append(
            {
                "lon": round(cx, 3),
                "lat": round(cy, 3),
                "total": pr.get("total"),
                "bad": pr.get("bad"),
                "percent_bad": pr.get("percent_bad"),
                "severity": pr.get("severity"),
            }
        )

    # rank: high → medium → low, then by bad count
    rank = {"high": 3, "medium": 2, "low": 1, "none": 0}
    cells.sort(key=lambda c: (rank.get(c["severity"], 0), c.get("bad") or 0), reverse=True)

    # affected-aircraft sample inside flagged cells (≤_MAX_SAMPLE)
    flagged_pts = {(round(c["lon"]), round(c["lat"])) for c in cells if c["severity"] != "none"}
    affected: list[dict[str, Any]] = []
    if flagged_pts:
        for f in feats:
            if len(affected) >= _MAX_SAMPLE:
                break
            p = f.get("properties") or {}
            if not _gnss_degraded(p):
                continue
            ll = feature_lonlat(f)
            if ll is None:
                continue
            if bbox is not None and not bbox.contains(ll[0], ll[1]):
                continue
            ca = _compact_aircraft(f)
            if ca:
                affected.append(ca)

    return {
        "bbox": bbox.as_dict() if bbox else None,
        "summary": {
            "cells_flagged": len([c for c in cells if c["severity"] != "none"]),
            "high": sev_counts.get("high", 0),
            "medium": sev_counts.get("medium", 0),
            "low": sev_counts.get("low", 0),
            "method": "GPSJam NACp<8 / NIC<7, 1° bins (research.md §5)",
        },
        "cells": cells[:_MAX_CELLS],
        "affected_aircraft_sample": affected,
    }


# ── aircraft query / lookup ──────────────────────────────────────────────────


async def query_aircraft(
    bbox: BBox | None = None,
    category: str | None = None,
    squawk: str | None = None,
    callsign_contains: str | None = None,
    min_alt_m: float | None = None,
    max_alt_m: float | None = None,
    emergency: bool | None = None,
    gnss_degraded: bool | None = None,
    on_ground: bool | None = None,
    limit: int = _MAX_LIST,
) -> dict[str, Any]:
    limit = max(1, min(_MAX_LIST_HARD, limit))
    feats = await _snapshot()
    matched: list[dict[str, Any]] = []
    total = 0
    cs_needle = callsign_contains.upper() if callsign_contains else None
    for f in feats:
        if not _in_bbox(f, bbox):
            continue
        p = f.get("properties") or {}
        cat = aircraft_category(p)
        if category and cat != category:
            continue
        if squawk and str(p.get("squawk")) != str(squawk):
            continue
        if cs_needle and cs_needle not in (p.get("callsign") or "").upper():
            continue
        if emergency is not None and (cat == "emergency") != emergency:
            continue
        if gnss_degraded is not None and _gnss_degraded(p) != gnss_degraded:
            continue
        if on_ground is not None and bool(p.get("on_ground")) != on_ground:
            continue
        alt = p.get("geo_alt_m")
        if alt is None:
            alt = p.get("baro_alt_m")
        if min_alt_m is not None and not (isinstance(alt, (int, float)) and alt >= min_alt_m):
            continue
        if max_alt_m is not None and not (isinstance(alt, (int, float)) and alt <= max_alt_m):
            continue
        total += 1
        if len(matched) < limit:
            c = _compact_aircraft(f)
            if c:
                matched.append(c)
    return {
        "matched_total": total,
        "returned": len(matched),
        "truncated": total > len(matched),
        "aircraft": matched,
    }


async def lookup_aircraft(ident: str) -> dict[str, Any]:
    needle = ident.strip().lower()
    feats = await _snapshot()
    hit: dict[str, Any] | None = None
    for f in feats:
        p = f.get("properties") or {}
        if (p.get("icao24") or "").lower() == needle:
            hit = f
            break
        cs = (p.get("callsign") or "").lower()
        if cs and needle in cs:
            hit = hit or f  # first callsign match, but keep scanning for exact icao
    if hit is None:
        return {"found": False, "query": ident}
    c = _compact_aircraft(hit)
    p = hit.get("properties") or {}
    obs = store.latest_for(f"aircraft:{(p.get('icao24') or '').lower()}")
    assessment = "nominal"
    if c and c["gnss_degraded"]:
        assessment = "GNSS degraded — possible jamming/spoofing footprint"
    if c and c["category"] == "emergency":
        assessment = f"EMERGENCY squawk {c['squawk']}"
    return {
        "found": True,
        "aircraft": c,
        "registration": p.get("registration"),
        "source": p.get("source"),
        "assessment": assessment,
        "server_track_point": (
            {"lon": obs.lon, "lat": obs.lat, "t": int(obs.t)} if obs else None
        ),
        "note": "Full track history is reconstructed client-side; server keeps "
        "only the latest fix per entity.",
    }


# ── vessels ────────────────────────────────────────────────────────────────────


async def query_vessels(
    bbox: BBox | None = None, dark_only: bool = False, limit: int = _MAX_LIST
) -> dict[str, Any]:
    limit = max(1, min(_MAX_LIST_HARD, limit))
    obs = store.latest("vessel")
    by_cat: Counter[str] = Counter()
    out: list[dict[str, Any]] = []
    total = 0
    for o in obs:
        if bbox is not None and not bbox.contains(o.lon, o.lat):
            continue
        a = o.attrs or {}
        cat = vessel_category(a.get("shipType"))
        # dark-candidate heuristic: moving but no static identity (name+type).
        dark = (a.get("name") in (None, "")) and (a.get("shipType") is None)
        if dark_only and not dark:
            continue
        by_cat[cat] += 1
        total += 1
        if len(out) < limit:
            out.append(
                {
                    "mmsi": a.get("mmsi"),
                    "name": a.get("name"),
                    "category": cat,
                    "lon": round(o.lon, 4),
                    "lat": round(o.lat, 4),
                    "sog": a.get("sog"),
                    "cog": a.get("cog"),
                    "ship_type": a.get("shipType"),
                    "dark_candidate": dark,
                    "age_s": int(time.time() - o.t),
                }
            )
    return {
        "matched_total": total,
        "returned": len(out),
        "truncated": total > len(out),
        "by_category": dict(by_cat),
        "vessels": out,
    }


# ── anomalies (fusion) ─────────────────────────────────────────────────────────


async def anomalies(
    bbox: BBox | None = None, features: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    feats = features if features is not None else await _snapshot()
    emergencies = [
        c
        for f in feats
        if _in_bbox(f, bbox)
        and aircraft_category(f.get("properties") or {}) == "emergency"
        and (c := _compact_aircraft(f)) is not None
    ][:_MAX_SAMPLE]

    jam = await jamming(bbox, features=features)
    jam_hot = [c for c in jam["cells"] if c["severity"] in ("high", "medium")][:_MAX_SAMPLE]

    alerts_raw = bus.recent(200) + jamming_recent(100)
    seen: set[str] = set()
    alerts: list[dict[str, Any]] = []
    for al in alerts_raw:
        if al.id in seen:
            continue
        seen.add(al.id)
        if bbox is not None and not bbox.contains(al.lon, al.lat):
            continue
        alerts.append(al.to_json())
    alerts.sort(key=lambda a: a["t"], reverse=True)
    alerts = alerts[:_MAX_SAMPLE]

    dark = await query_vessels(bbox, dark_only=True, limit=_MAX_SAMPLE)

    # crude threat scalar so an agent can triage at a glance
    score = (
        len(emergencies) * 3
        + jam["summary"]["high"] * 3
        + jam["summary"]["medium"]
        + len(dark["vessels"])
        + sum(1 for a in alerts if a["severity"] in ("high", "critical")) * 2
    )
    level = "low"
    if score >= 12:
        level = "high"
    elif score >= 4:
        level = "elevated"

    return {
        "bbox": bbox.as_dict() if bbox else None,
        "threat_level": level,
        "score": score,
        "emergency_aircraft": emergencies,
        "jamming_hotspots": jam_hot,
        "jamming_summary": jam["summary"],
        "dark_vessel_candidates": dark["vessels"],
        "fusion_alerts": alerts,
    }


# ── area bundle (the focus_area one-shot) ────────────────────────────────────


async def area_intel(
    lat: float,
    lon: float,
    radius_nm: float = 200.0,
    label: str | None = None,
    set_primary: bool = True,
    cell_deg: float = 1.0,
) -> dict[str, Any]:
    """Load an area PRIMARY and return a full intel bundle for it in one call:
    fresh aircraft summary + density + jamming + vessels + anomalies."""
    if set_primary:
        focus = await aoi.focus(lat, lon, radius_nm, label)
        bbox = bbox_from_radius(lat, lon, radius_nm)
        area_fc = focus["fc"]
        load_mode = focus["mode"]
        host = focus.get("host")
        aoi_desc = focus["aoi"]
    else:
        bbox = bbox_from_radius(lat, lon, radius_nm)
        res = await aoi.fetch_area(lat, lon, radius_nm)
        area_fc = res["fc"]
        load_mode = res["mode"]
        host = res.get("host")
        aoi_desc = None

    # Aircraft summary from the FRESH focused fetch (not the global snapshot).
    area_feats = list(area_fc.get("features") or [])
    by_cat: Counter[str] = Counter()
    samples: list[dict[str, Any]] = []
    gnss_bad = 0
    for f in area_feats:
        p = f.get("properties") or {}
        cat = aircraft_category(p)
        by_cat[cat] += 1
        if _gnss_degraded(p):
            gnss_bad += 1
        if len(samples) < _MAX_LIST and (c := _compact_aircraft(f)) is not None:
            samples.append(c)

    # Derive aircraft signals from the FRESH focused fetch (consistent + works
    # even before the global snapshot has warmed). Vessels/alerts stay global.
    dens = await density(bbox, cell_deg, features=area_feats)
    jam = await jamming(bbox, features=area_feats)
    ves = await query_vessels(bbox)
    anom = await anomalies(bbox, features=area_feats)

    return {
        "loaded_primary": set_primary,
        "load_mode": load_mode,  # 'direct' = dedicated fetch, 'snapshot' = degraded
        "upstream_host": host,
        "aoi": aoi_desc,
        "area": bbox.as_dict(),
        "aircraft": {
            "count": len(area_feats),
            "by_category": dict(by_cat),
            "gnss_degraded": gnss_bad,
            "sample": samples,
        },
        "density": dens["aircraft"],
        "gps_jamming": jam,
        "vessels": ves,
        "anomalies": {
            "threat_level": anom["threat_level"],
            "score": anom["score"],
            "emergency_aircraft": anom["emergency_aircraft"],
            "jamming_hotspots": anom["jamming_hotspots"],
            "dark_vessel_candidates": anom["dark_vessel_candidates"],
            "fusion_alerts": anom["fusion_alerts"],
        },
    }
