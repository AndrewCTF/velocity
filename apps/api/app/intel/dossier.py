"""Entity pattern-of-life dossiers.

Assembles everything the warm store knows about ONE contact — a vessel (MMSI) or
aircraft (ICAO24) — into a single read: its recent track, AIS/ADS-B gaps, a
derived speed profile (loiter vs transit vs dash), the area it has covered, and
which live incidents it currently appears in. The track FUSES two tiers: the
in-memory observation store (the freshest, richest fix — carries identity attrs,
~1h retention) and the SQLite positions DB (`app.history`, nominally up to
`history_retention_hours` of fixes, but byte-cap-bound in practice — see
`_window_requested_s`/`_effective_window_from`) so pattern-of-life spans hours,
not just the live window — stated honestly (the ACTUAL effective depth, not the
nominal ceiling) in the response rather than implied to be a full history.
"""

from __future__ import annotations

import asyncio
import bisect
import time
from collections.abc import Callable
from typing import Any

from app import history
from app.config import get_settings
from app.correlate.store import store
from app.correlate.types import Observation
from app.intel import incidents
from app.intel.geo import bbox_from_radius, haversine_km, vessel_category

_RETENTION_S = 3600.0
_GAP_S = 600.0          # >10 min between fixes counts as a track gap
_MIN_DT_FOR_SPEED = 30.0  # ignore sub-30s deltas for the displacement avg
# peak floor + PRIMARY desync guard: a <30s cross-source position desync (~3km)
# computes to a bogus >1000kn; a real 30s segment does not
_MIN_SEG_DT_S = 30.0
# teleport/desync ceiling — above any real ground speed (incl supersonic mil dash
# ~700-900kn) but below cross-continent jumps; kept high so genuine fast-jet peaks
# (the high-interest contacts) are NOT clipped to ~600
_MAX_PLAUSIBLE_KN = 1000.0
_KM_S_TO_KN = 1943.84

# Two DB points closer together than this are treated as the same fix when
# merging with the in-memory track (the live store and the DB both sample the
# same upstream, so a 1s-apart pair is one observation, not two).
_MERGE_DEDUP_DT_S = 1.0


def _window_requested_s() -> float:
    """How far back we ASK the SQLite positions DB for, derived from the
    operator's configured retention target (``history_retention_hours``) —
    not a hardcoded ceiling. This is only the request: the store is byte-cap-
    bound (``history_max_bytes``), so what it can actually still answer for a
    given query is frequently much shorter. ``_effective_window_from`` reports
    that real number; never repeat this value alone as if it were a guarantee.
    """
    return float(get_settings().history_retention_hours) * 3600.0


async def _effective_window_from(entity_id: str, t_from: float) -> float:
    """The earliest timestamp the positions DB can honestly promise fixes from
    for THIS entity — the effective floor of the byte-cap-bound store, not the
    nominal retention window.

    Reuses the same `history._connect()` plumbing `_db_track_sync` already
    opens (see its docstring) for a second, equally cheap indexed lookup:
    `MIN(t) WHERE id = ?` hits the covering `idx_id_t` index directly (no
    table/id scan), unlike a global `MIN(t)` which is exactly as cheap but
    conflates "this vessel wasn't transmitting yet" with "the DB dropped
    everything before here" — the id-scoped version answers the question this
    dossier is actually asking: how far back does OUR track go.

    Returns `t_from` (i.e. "no evidence the window is any shorter than asked")
    when history is disabled or the DB errors; an id with no DB rows at all
    returns "now" (the DB tier adds zero depth — see `_oldest_ts_sync`).
    """
    if not history.stats().get("enabled"):
        return t_from
    try:
        return await asyncio.to_thread(_oldest_ts_sync, entity_id, t_from)
    except Exception:  # noqa: BLE001 — a DB hiccup must not break the dossier
        return t_from


def _oldest_ts_sync(entity_id: str, t_from: float) -> float:
    con = history._connect()
    try:
        row = con.execute(
            "SELECT MIN(t) FROM positions WHERE id = ?", (entity_id,)
        ).fetchone()
    finally:
        con.close()
    oldest = row[0] if row else None
    if oldest is None:
        # No DB rows for this id at all: the DB tier adds zero depth beyond
        # the live store, i.e. the effective floor is "now", not the request.
        return time.time()
    # The DB may hold fixes older than we asked for (t_from); we only ever
    # queried down to t_from, so we can't honestly claim coverage further
    # back than that even if the row exists.
    return max(t_from, float(oldest))


def _window_note(closing: str, requested_s: float, available_from_ts: float) -> str:
    """The DB-tier honesty clause: what we asked the positions DB for vs. what
    it can actually still answer for THIS query. Always states the real
    number — the store is byte-cap-bound, not a fixed retention clock, so the
    effective depth is frequently far short of the nominal ask."""
    requested_h = requested_s / 3600.0
    available_h = max(0.0, (time.time() - available_from_ts) / 3600.0)
    return (
        "Track fuses the live store (~1h, freshest) with the positions DB "
        f"(byte-cap-bound; effective depth here is ~{available_h:.1f}h of the "
        f"{requested_h:.0f}h nominally requested); {closing}"
    )


def _db_track_sync(entity_id: str, t_from: float) -> list[Observation]:
    """Read ONE entity's fixes from the positions DB (newest-bounded by t_from).

    `history.query_tracks` can only cap by a distinct-id count (no id filter), so
    for a single-entity lookup we run a tight id-scoped scan over history's own
    connection/schema (`history._connect`, hits the idx_id_t index) — reusing the
    DB plumbing without changing any history signature. Sync; called via
    asyncio.to_thread so SQLite never blocks the event loop.
    """
    con = history._connect()
    try:
        rows = con.execute(
            "SELECT t, lon, lat, kind FROM positions WHERE id = ? AND t >= ? ORDER BY t",
            (entity_id, t_from),
        ).fetchall()
    finally:
        con.close()
    pts: list[Observation] = []
    for t, lon, lat, kind in rows:
        # query_tracks doesn't expose the `extra` blob and neither do we here —
        # DB-only fixes carry no identity attrs. That's fine: the merge keeps any
        # richer in-memory attrs (freshest wins) and _best_identity recovers
        # name/type from the live tier. The DB's value is TRACK DEPTH (hours of
        # fixes), which lifts pattern-of-life off "insufficient track".
        pts.append(
            Observation(
                id=entity_id, source="history.db", t=float(t),
                lon=float(lon), lat=float(lat), emits_kind=kind,
                attrs={},
            )
        )
    return pts


async def _db_track(entity_id: str, kind: str) -> list[Observation]:
    """Pull this entity's historical fixes from the SQLite positions DB.

    Returns [] when history is disabled, empty, or errors — the caller falls
    back to the in-memory store alone, so this can only ever ADD depth.
    """
    if not history.stats().get("enabled"):
        return []
    try:
        return await asyncio.to_thread(
            _db_track_sync, entity_id, time.time() - _window_requested_s()
        )
    except Exception:  # noqa: BLE001 — a DB hiccup must not break the dossier
        return []


def _merge_tracks(
    db_pts: list[Observation], live_pts: list[Observation]
) -> list[Observation]:
    """Union the DB history with the in-memory store, time-ordered + deduped.

    The in-memory store is the freshest/richest tier (it carries name/shipType/
    squawk in attrs); the DB is the long history. We keep BOTH, sorted by time,
    dropping a DB point that lands within _MERGE_DEDUP_DT_S of a live point so
    the same observation isn't counted twice.
    """
    if not db_pts:
        return sorted(live_pts, key=lambda o: o.t)
    if not live_pts:
        return sorted(db_pts, key=lambda o: o.t)
    live_sorted = sorted(live_pts, key=lambda o: o.t)
    live_ts = [o.t for o in live_sorted]
    merged: list[Observation] = list(live_sorted)
    for d in db_pts:
        i = bisect.bisect_left(live_ts, d.t)
        near = False
        for j in (i - 1, i):
            if 0 <= j < len(live_ts) and abs(live_ts[j] - d.t) <= _MERGE_DEDUP_DT_S:
                near = True
                break
        if not near:
            merged.append(d)
    merged.sort(key=lambda o: o.t)
    return merged


def _track(entity_id: str, kind: str) -> list[Observation]:
    pts = [o for o in store.window(_RETENTION_S, {kind}) if o.id == entity_id]
    pts.sort(key=lambda o: o.t)
    return pts


def _best_identity(pts: list[Observation], *keys: str) -> dict[str, Any]:
    """Recover identity fields from anywhere in the track, freshest non-null.

    The freshest fix (pts[-1]) is often a position-only report whose attrs lack
    name/shipType (those ride static AIS messages). query_vessels reads the same
    store but happened to land on a static-bearing fix; the dossier must not
    return name:null/category:other just because the LAST fix was position-only.
    Scans newest→oldest and takes the first non-null value per requested key.
    """
    found: dict[str, Any] = {}
    for o in reversed(pts):
        a = o.attrs or {}
        for k in keys:
            if k not in found and a.get(k) not in (None, ""):
                found[k] = a[k]
        if len(found) == len(keys):
            break
    return found


def _track_stats(pts: list[Observation]) -> dict[str, Any]:
    pts = sorted(pts, key=lambda o: o.t)
    gaps: list[dict[str, Any]] = []
    seg_speeds_kn: list[float] = []
    dist_km = 0.0
    lons = [p.lon for p in pts]
    lats = [p.lat for p in pts]
    for a, b in zip(pts, pts[1:], strict=False):
        dt = b.t - a.t
        d = haversine_km(a.lon, a.lat, b.lon, b.lat)
        dist_km += d
        if dt > _GAP_S:
            gaps.append({
                "start": int(a.t), "end": int(b.t), "minutes": round(dt / 60, 1),
                "lon": round(a.lon, 4), "lat": round(a.lat, 4),
            })
        # Per-segment instantaneous speed (for the max / dash detection): the
        # peak over time-ordered consecutive pairs. Gate on _MIN_SEG_DT_S=30s:
        # a cross-source position desync of ~3 km over a 5s boundary computes
        # to >1000 kn even though both fixes are valid. 30s is the same floor
        # as the displacement avg, so a real fast-jet peak still surfaces. Also
        # drop physically impossible speeds so a single spoof jump can't define
        # the max.
        if dt >= _MIN_SEG_DT_S:
            spd = (d / dt) * _KM_S_TO_KN
            if spd <= _MAX_PLAUSIBLE_KN:
                seg_speeds_kn.append(spd)
    # Net speed = straight-line DISPLACEMENT / total time, not cumulative path:
    # immune to the path-length inflation that per-fix GPS jitter causes under
    # the fast ingest cadence, and it cleanly separates transit (displacement ≈
    # path) from loiter (displacement ≪ path → low net speed even if it wiggled).
    total_t = pts[-1].t - pts[0].t if len(pts) > 1 else 0.0
    disp_km = (
        haversine_km(pts[0].lon, pts[0].lat, pts[-1].lon, pts[-1].lat) if len(pts) > 1 else 0.0
    )
    # Jitter guard lives here, on the displacement avg: a span shorter than
    # _MIN_DT_FOR_SPEED has too little baseline for endpoint jitter not to skew
    # disp_km/total_t (such a track is already "insufficient" below anyway).
    avg_kn = (
        round((disp_km / total_t) * _KM_S_TO_KN, 1) if total_t >= _MIN_DT_FOR_SPEED else None
    )
    # No qualifying segment (all deltas sub-floor or spoof-flagged) → fall back
    # to the displacement avg, or 0 when even that is unavailable/zero.
    max_kn = round(max(seg_speeds_kn), 1) if seg_speeds_kn else (avg_kn or 0)
    # Only label a profile once the track is long enough to be meaningful. The
    # global ADS-B snapshot repeats an aircraft's last position until a fresh
    # upstream fix arrives (~10-30 s for the OpenSky-cached tier), so a track
    # spanning a few seconds has ~zero displacement and must NOT be called
    # "loitering" — it's just too short to judge.
    if total_t < 60 or avg_kn is None:
        profile = "insufficient track"
    elif avg_kn < 2 and (max_kn or 0) < 5:
        profile = "loitering / stationary"
    elif (max_kn or 0) > 25 and avg_kn < (max_kn or 0) * 0.6:
        profile = "loiter-then-dash"
    else:
        profile = "transiting"
    return {
        "fixes": len(pts),
        "track_minutes": round((pts[-1].t - pts[0].t) / 60, 1) if len(pts) > 1 else 0.0,
        "distance_km": round(dist_km, 1),
        "speed_kn": {"avg": avg_kn, "max": max_kn},
        "profile": profile,
        "profile_basis": (
            "inferred from speed/displacement over the observed track, not a "
            "stated mission"
        ),
        "gaps": gaps,
        "gap_count": len(gaps),
        "bbox": (
            {"min_lon": round(min(lons), 4), "min_lat": round(min(lats), 4),
             "max_lon": round(max(lons), 4), "max_lat": round(max(lats), 4)}
            if pts else None
        ),
    }


async def _incident_membership(
    lon: float, lat: float, match: Callable[[dict[str, Any]], bool]
) -> list[dict[str, Any]]:
    b = await incidents.brief(bbox_from_radius(lat, lon, 120.0), link_km=50.0)
    hits: list[dict[str, Any]] = []
    for inc in b.get("incidents", []):
        for e in inc.get("evidence", []):
            if match(e.get("ref") or {}):
                hits.append({
                    "threat_level": inc["threat_level"],
                    "domains": inc["domains"],
                    "narrative": inc["narrative"],
                })
                break
    return hits


def _resolved_identity(mmsi: str) -> dict[str, Any]:
    """The vessel's merged identity from entity resolution (Phase 1).

    A vessel's MMSI changes over its life; resolution fuses every MMSI / IMO /
    name / callsign it has been seen under into one canonical entity. This lets
    the dossier show "also known as" — the whole history under one identity —
    instead of a single, fragmentable MMSI. Degrades to a self-identity when the
    resolver has not seen this vessel yet.
    """
    try:
        from app.intel import resolve  # noqa: PLC0415

        canonical = resolve.canonical_of(f"vessel:{mmsi}")
        aliases = resolve.aliases_of(canonical)
        return {
            "canonical_id": canonical,
            "aliases": aliases,
            "mmsi_history": sorted({a["value"] for a in aliases if a["type"] == "mmsi"}),
            "imo": next((a["value"] for a in aliases if a["type"] == "imo"), None),
        }
    except Exception:  # noqa: BLE001
        return {"canonical_id": f"vessel:{mmsi}", "aliases": [], "mmsi_history": [mmsi]}


async def vessel_dossier(mmsi: str) -> dict[str, Any]:
    eid = f"vessel:{mmsi}"
    live_pts = _track(eid, "vessel")
    db_pts = await _db_track(eid, "vessel")
    pts = _merge_tracks(db_pts, live_pts)
    if not pts:
        return {"found": False, "mmsi": mmsi,
                "note": "No fix in the live store (~1h) or the positions DB."}
    # Freshest fix drives last_fix; prefer the live tier (it carries identity +
    # is never staler than the DB). Fall back to the merged tail when the vessel
    # has aged out of memory but still has DB history.
    last = live_pts[-1] if live_pts else pts[-1]
    a = last.attrs or {}
    # Identity: scan the (live) track newest→oldest for the last non-null name /
    # shipType. The freshest fix is often a position-only report (no static
    # identity); query_vessels happens to read a static-bearing fix from the
    # same store, so the dossier must do the same recovery — otherwise it
    # returns name:null / category:other for a vessel query_vessels can name.
    ident = _best_identity(live_pts or pts, "name", "shipType")
    name = ident.get("name") if ident.get("name") is not None else a.get("name")
    ship_type = ident.get("shipType") if ident.get("shipType") is not None else a.get("shipType")
    stats = _track_stats(pts)
    in_incidents = await _incident_membership(
        last.lon, last.lat, lambda r: str(r.get("mmsi")) == str(mmsi)
    )

    assessment = "nominal"
    if stats["gap_count"] and stats["profile"] == "loiter-then-dash":
        assessment = (
            "loiter-then-dash with AIS gaps. Consistent with (not proof of) a "
            "shadow-fleet / STS pattern (inferred from track)"
        )
    elif stats["gap_count"]:
        assessment = f"{stats['gap_count']} AIS gap(s) in the track window"
    if in_incidents:
        assessment = f"appears in {len(in_incidents)} live incident(s); " + assessment

    window_requested_s = _window_requested_s()
    window_available_from_ts = await _effective_window_from(
        eid, time.time() - window_requested_s
    )

    return {
        "found": True,
        "mmsi": mmsi,
        "identity": _resolved_identity(mmsi),
        "name": name,
        "category": vessel_category(ship_type),
        "ship_type": ship_type,
        "last_fix": {"lon": round(last.lon, 4), "lat": round(last.lat, 4),
                     "t": int(last.t), "age_s": int(time.time() - last.t),
                     "sog": a.get("sog"), "cog": a.get("cog"), "source": last.source},
        "track": stats,
        "in_incidents": in_incidents,
        "assessment": assessment,
        "window_requested_s": window_requested_s,
        "window_available_from_ts": int(window_available_from_ts),
        "window_note": _window_note(
            "older history is not kept server-side.",
            window_requested_s, window_available_from_ts,
        ),
    }


async def aircraft_dossier(ident: str) -> dict[str, Any]:
    needle = ident.strip().lower()
    eid = f"aircraft:{needle}"
    live_pts = _track(eid, "aircraft")
    if not live_pts:
        # callsign? scan the window for a matching callsign. (DB query_tracks
        # can't filter by callsign, so this resolution stays in-memory; once an
        # eid is found we still fold in its DB history below.)
        for o in store.window(_RETENTION_S, {"aircraft"}):
            if needle in str((o.attrs or {}).get("callsign") or "").lower():
                eid = o.id
                live_pts = _track(eid, "aircraft")
                break
    db_pts = await _db_track(eid, "aircraft")
    pts = _merge_tracks(db_pts, live_pts)
    if not pts:
        return {"found": False, "query": ident,
                "note": "No fix in the live store (~1h) or the positions DB."}
    last = live_pts[-1] if live_pts else pts[-1]
    a = last.attrs or {}
    # Recover identity (callsign/squawk/source/GNSS) from anywhere in the live
    # track — the freshest fix can be a position-only update with sparse attrs.
    ident_attrs = _best_identity(
        live_pts or pts, "callsign", "squawk", "source", "icao24", "nac_p", "nic"
    )
    stats = _track_stats(pts)
    icao = (ident_attrs.get("icao24") or a.get("icao24") or eid.split(":", 1)[-1])
    in_incidents = await _incident_membership(
        last.lon, last.lat, lambda r: str(r.get("icao24") or "").lower() == str(icao).lower()
    )

    nac_p = ident_attrs.get("nac_p", a.get("nac_p"))
    nic = ident_attrs.get("nic", a.get("nic"))
    degraded = False
    try:
        degraded = (nac_p is not None and int(nac_p) < 8) or (
            nic is not None and int(nic) < 7
        )
    except (TypeError, ValueError):
        degraded = False
    squawk = ident_attrs.get("squawk", a.get("squawk"))
    src = ident_attrs.get("source", a.get("source"))
    assessment = "nominal"
    if str(squawk) in ("7500", "7600", "7700"):
        assessment = f"EMERGENCY squawk {squawk}"
    elif degraded:
        assessment = "GNSS degraded — possible jamming/spoofing footprint"
    if src == "adsb_mil":
        assessment = (
            "military-tagged source (feed classification, not confirmed "
            "intent); " + assessment
        )
    if in_incidents:
        assessment = f"appears in {len(in_incidents)} live incident(s); " + assessment

    window_requested_s = _window_requested_s()
    window_available_from_ts = await _effective_window_from(
        eid, time.time() - window_requested_s
    )

    return {
        "found": True,
        "icao24": icao,
        "callsign": ident_attrs.get("callsign", a.get("callsign")),
        "squawk": squawk,
        "source": last.source,
        "gnss_degraded": degraded,
        "last_fix": {"lon": round(last.lon, 4), "lat": round(last.lat, 4),
                     "t": int(last.t), "age_s": int(time.time() - last.t)},
        "track": stats,
        "in_incidents": in_incidents,
        "assessment": assessment,
        "window_requested_s": window_requested_s,
        "window_available_from_ts": int(window_available_from_ts),
        "window_note": _window_note(
            "full client-side history is longer still.",
            window_requested_s, window_available_from_ts,
        ),
    }
