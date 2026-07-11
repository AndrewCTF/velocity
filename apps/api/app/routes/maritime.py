"""GET /api/maritime/digitraffic — Finnish Fintraffic open AIS (Baltic).

Per research.md §1 / research_updated.md §2.6: Digitraffic is no-auth, CC BY 4.0,
just identify with the `Digitraffic-User` header. Class-A only. Excellent
default vessel layer for an OSINT console because it requires no setup.

Returns GeoJSON normalized to the same vessel shape as AISStream so the
PollGeoJsonAdapter / MapLibre vessel paint reuse without changes.

Also: GET /api/maritime/warnings — NGA active navigational (broadcast)
warnings, see the dedicated section near the bottom of this file (kept in the
same module/router because `router` here is already registered in
`main.py`; a second brand-new `maritime.py` would collide).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app import maritime_keyless
from app.config import get_settings
from app.correlate.store import store
from app.correlate.types import Observation
from app.routes.adsb import viewport_filter
from app.upstream import cache, get_client

router = APIRouter(tags=["maritime"])
log = logging.getLogger(__name__)

LOCATIONS_URL = "https://meri.digitraffic.fi/api/ais/v1/locations"
METADATA_URL = "https://meri.digitraffic.fi/api/ais/v1/vessels"


async def _load_vessel_metadata() -> dict[int, dict[str, Any]]:
    """Fetch Digitraffic's per-vessel metadata table (name, shipType, callSign,
    IMO, …) and index it by MMSI. Cached 12h — the metadata feed is much
    larger than `/locations` and the names change rarely (mostly on rename
    or new builds), so we don't want to repull it every position tick. A
    fetch failure returns an empty dict so position rendering still works,
    just without names."""

    async def load() -> dict[int, dict[str, Any]]:
        try:
            headers = {"Digitraffic-User": "osint-console/0.1"}
            r = await get_client().get(METADATA_URL, headers=headers)
        except Exception:
            return {}
        if r.status_code != 200:
            return {}
        try:
            j = r.json()
        except Exception:
            return {}
        out: dict[int, dict[str, Any]] = {}
        # Digitraffic returns a flat list of vessel objects with `mmsi`
        # alongside identity fields. We keep the whole object so future
        # callers can pull callSign/IMO/etc without another roundtrip.
        rows = j if isinstance(j, list) else (j.get("vessels") or [])
        for row in rows:
            if not isinstance(row, dict):
                continue
            mmsi = row.get("mmsi")
            if mmsi is None:
                continue
            try:
                out[int(mmsi)] = row
            except (TypeError, ValueError):
                continue
        return out

    return await cache.get_or_fetch("digitraffic:metadata", 12 * 3600.0, load)


def _fix_epoch_s(timestamp: Any) -> float | None:
    """Digitraffic position timestamps (`timestampExternal`/`timestamp`) are
    epoch MILLISECONDS. Return epoch seconds, or None if missing/unparseable."""
    if isinstance(timestamp, (int, float)):
        return float(timestamp) / 1000.0
    if isinstance(timestamp, str):
        try:
            return float(timestamp) / 1000.0
        except ValueError:
            return None
    return None


async def digitraffic_snapshot() -> dict[str, Any]:
    """Full in-commission Digitraffic vessel FeatureCollection (no viewport
    filter), cached 30 s and feeding the correlation store.

    Plain helper so INTERNAL callers (the consolidated ``/api/maritime/keyless``
    endpoint) read it directly — calling the ``digitraffic_vessels`` route
    handler in-process would pass its unresolved ``Query(...)`` defaults into
    ``viewport_filter`` (the same bug that 500'd the ADS-B jamming layer)."""

    async def load() -> dict[str, Any]:
        headers = {"Digitraffic-User": "osint-console/0.1"}
        r = await get_client().get(LOCATIONS_URL, headers=headers)
        if r.status_code != 200:
            raise HTTPException(502, f"digitraffic upstream {r.status_code}")
        j = r.json()
        # Pull identity table (name, shipType, …) keyed by MMSI. Best-effort —
        # failures degrade to no-name positions, never to a 502 on /locations.
        meta_by_mmsi = await _load_vessel_metadata()
        feats: list[dict[str, Any]] = []
        now = time.time()
        max_fix_age = get_settings().digitraffic_max_fix_age_s
        dropped_stale = 0
        batch: list[Observation] = []
        for f in j.get("features", []) or []:
            mmsi = f.get("mmsi") or (f.get("properties") or {}).get("mmsi")
            geom = f.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            coords = geom.get("coordinates") or []
            if len(coords) < 2:
                continue
            lon = float(coords[0])
            lat = float(coords[1])
            p = f.get("properties") or {}
            # Digitraffic `sog` is already KNOTS; mask the AIS 102.3-kn "not
            # available" sentinel so it doesn't paint as a 102-knot ghost and
            # so the knots normalization holds across every keyless source
            # (NIT N5). cog/heading sentinels are left as-is here — the
            # frontend ITU/heading paint already tolerates them.
            sog = maritime_keyless._clean_sog_kn(p.get("sog"))
            cog = p.get("cog")
            heading = p.get("heading")
            timestamp = p.get("timestampExternal") or p.get("timestamp")
            # "Still in commission" gate. An active vessel keeps its AIS
            # transponder reporting every few minutes even parked at anchor, so a
            # last fix older than the window is a decommissioned / scrapped /
            # long-gone ghost (Digitraffic serves last-known for every MMSI it
            # ever saw — ~86% are years stale). Drop it AND its correlation
            # observation so the map shows only vessels actually present and
            # transmitting. max_fix_age == 0 disables the gate.
            sample_t = _fix_epoch_s(timestamp)
            if max_fix_age > 0 and (sample_t is None or now - sample_t > max_fix_age):
                dropped_stale += 1
                continue
            # ITU-R M.1371 ship type (0-99). Digitraffic exposes it as
            # `shipType`; keep the camelCase the frontend already reads.
            ship_type = p.get("shipType")
            # Merge identity from the metadata table — `/locations` carries
            # MMSI + kinematics only, the name lives in `/vessels`.
            mmsi_int: int | None
            try:
                mmsi_int = int(mmsi) if mmsi is not None else None
            except (TypeError, ValueError):
                mmsi_int = None
            meta = meta_by_mmsi.get(mmsi_int) if mmsi_int is not None else None
            name = meta.get("name") if meta else None
            if meta and meta.get("shipType") is not None and ship_type is None:
                # Locations sometimes omits shipType; backfill from /vessels so
                # the frontend's ITU classifier always has a category to work
                # with. Position-stream value wins when both are present (more
                # current than the static identity record).
                ship_type = meta.get("shipType")
            call_sign = meta.get("callSign") if meta else None
            imo = meta.get("imo") if meta else None
            eid = f"vessel:{mmsi}" if mmsi else f"vessel:fi:{lon},{lat}"
            feats.append(
                {
                    "type": "Feature",
                    "id": eid,
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        "mmsi": mmsi,
                        "name": name,
                        "callSign": call_sign,
                        "imo": imo,
                        "sog": sog,
                        "cog": cog,
                        "heading": heading,
                        "shipType": ship_type,
                        "timestamp": timestamp,
                        # epoch seconds of the upstream fix (parsed above) so the
                        # consolidated keyless feed can pick the freshest report
                        # when a vessel is seen by more than one source.
                        "t": sample_t,
                        "kind": "vessel",
                        "source": "digitraffic",
                    },
                }
            )
            if mmsi is not None:
                # Prefer the upstream sample timestamp (parsed above from
                # `timestampExternal`, epoch ms per Digitraffic AIS spec) so
                # correlation rules see when the position was actually reported,
                # not when we ingested it. Fall back to `now` only when the gate
                # is disabled and the fix has no parseable timestamp.
                batch.append(
                    Observation(
                        id=eid,
                        source="digitraffic",
                        t=sample_t if sample_t is not None else now,
                        lon=lon,
                        lat=lat,
                        emits_kind="vessel",
                        attrs={
                            "mmsi": mmsi,
                            # name/callSign/imo come from the cached identity
                            # table — surface them on the correlation record
                            # so dark-vessel rules and the entity panel see
                            # the same data the GeoJSON layer does.
                            "name": name,
                            "callSign": call_sign,
                            "imo": imo,
                            "sog": sog,
                            "cog": cog,
                            "heading": heading,
                            "shipType": ship_type,
                        },
                    )
                )
        if batch:
            store.add_many(batch)
        if dropped_stale:
            log.info(
                "digitraffic: kept %d in-commission vessels, dropped %d stale "
                "(fix > %.0fh) of %d",
                len(feats),
                dropped_stale,
                max_fix_age / 3600.0,
                len(feats) + dropped_stale,
            )
        return {"type": "FeatureCollection", "features": feats}

    # Digitraffic positions update every ~minute; cache aligns. The full FC is
    # cached once; each request filters it to the caller's viewport so the
    # frontend only instantiates on-screen vessels (the ~18.5k full set is the
    # web UI's bottleneck).
    return await cache.get_or_fetch("digitraffic:locations", 30.0, load)


@router.get("/api/maritime/digitraffic")
async def digitraffic_vessels(
    lamin: float | None = Query(None, ge=-90, le=90),
    lomin: float | None = Query(None, ge=-180, le=180),
    lamax: float | None = Query(None, ge=-90, le=90),
    lomax: float | None = Query(None, ge=-180, le=180),
    limit: int | None = Query(None, ge=1, le=20000),
) -> dict[str, Any]:
    full = await digitraffic_snapshot()
    if lamin is None and lomin is None and lamax is None and lomax is None and limit is None:
        return full
    return viewport_filter(full, lamin, lomin, lamax, lomax, limit)


# ── unified live vessel snapshot (all sources, accumulated 24/7) ─────────────
# store.latest("vessel") is the freshest fix per MMSI across EVERY AIS source
# (Digitraffic, Kystverket/Kystdatahuset, AISStream) within the store's retention
# window. Because it ACCUMULATES, a rate-limited keyed stream still builds a large
# deduped set over time — this is the "more data, 24/7" feed. The background
# poller below keeps the keyless REST sources flowing into the store even with no
# browser connected, so the snapshot stays warm and grows.


def _obs_to_vessel_feature(o: Observation) -> dict[str, Any]:
    a = o.attrs or {}
    sog = a.get("sog")
    parked = isinstance(sog, (int, float)) and sog < get_settings().parked_sog_kn
    return {
        "type": "Feature",
        "id": o.id,
        "geometry": {"type": "Point", "coordinates": [o.lon, o.lat]},
        "properties": {
            "mmsi": a.get("mmsi"),
            "name": a.get("name"),
            "callSign": a.get("callSign"),
            "imo": a.get("imo"),
            "sog": a.get("sog"),
            "cog": a.get("cog"),
            "heading": a.get("heading"),
            "shipType": a.get("shipType"),
            "t": o.t,
            "kind": "vessel",
            "source": o.source,
            "parked": bool(parked),
        },
    }


# Parked-vessel cache: stationary ships (SOG < parked_sog_kn) retained far longer
# than the 1h live store, because a parked ship's old fix is still its current
# position. Refreshed each poll from the live store; a vessel that moves again is
# dropped (it departed the anchorage). This is what makes "parking mode" carry a
# lot more stationary vessels than the live snapshot alone.
_PARKED: dict[str, dict[str, Any]] = {}


def _update_parked() -> None:
    s = get_settings()
    for o in store.latest("vessel"):
        sog = (o.attrs or {}).get("sog")
        if isinstance(sog, (int, float)) and sog < s.parked_sog_kn:
            _PARKED[o.id] = _obs_to_vessel_feature(o)
        else:
            _PARKED.pop(o.id, None)  # moving again → left the anchorage
    cutoff = time.time() - s.parked_ttl_s
    for k in [k for k, v in _PARKED.items() if (v["properties"].get("t") or 0) < cutoff]:
        _PARKED.pop(k, None)


def parked_count() -> int:
    return len(_PARKED)


def vessel_snapshot(parked_only: bool = False) -> dict[str, Any]:
    """Latest fix per MMSI across all AIS sources.

    Default: the live store (within retention) UNIONED with the long-retained
    parked cache (live wins on conflict) — strictly more vessels. parked_only:
    just the stationary set (parking mode).
    """
    if parked_only:
        return {"type": "FeatureCollection", "features": list(_PARKED.values())}
    by_id = {o.id: _obs_to_vessel_feature(o) for o in store.latest("vessel")}
    for vid, feat in _PARKED.items():
        by_id.setdefault(vid, feat)  # add parked ships the live store has aged out
    return {"type": "FeatureCollection", "features": list(by_id.values())}


@router.get("/api/maritime/snapshot")
async def maritime_snapshot(
    lamin: float | None = Query(None, ge=-90, le=90),
    lomin: float | None = Query(None, ge=-180, le=180),
    lamax: float | None = Query(None, ge=-90, le=90),
    lomax: float | None = Query(None, ge=-180, le=180),
    limit: int | None = Query(None, ge=1, le=20000),
    parked: int | None = Query(None, description="1 = parking mode: stationary vessels only"),
) -> dict[str, Any]:
    full = vessel_snapshot(parked_only=bool(parked))
    if lamin is None and lomin is None and lamax is None and lomax is None and limit is None:
        return full
    return viewport_filter(full, lamin, lomin, lamax, lomax, limit)


# ── 24/7 background AIS poller ───────────────────────────────────────────────
# Continuously poll the keyless REST sources into the store so the unified
# snapshot stays warm + accumulates even when no browser is on the map. The
# always-on firehoses (Kystverket NMEA, Kystdatahuset, Digitraffic MQTT) and the
# optional AISStream upstream feed the same store; this loop adds the Digitraffic
# REST /locations set on a fixed cadence.
_POLL_TASK: asyncio.Task[None] | None = None


async def _poll_forever() -> None:
    interval = get_settings().ais_poll_interval_s
    while True:
        try:
            await digitraffic_snapshot()  # store.add_many runs inside load()
            _update_parked()  # refresh the long-retained parked cache from the store
        except Exception:  # noqa: BLE001 — one bad poll must not kill the loop
            pass
        await asyncio.sleep(interval)


def start_background_poll() -> None:
    global _POLL_TASK
    if _POLL_TASK is None or _POLL_TASK.done():
        _POLL_TASK = asyncio.create_task(_poll_forever())


async def stop_background_poll() -> None:
    global _POLL_TASK
    t = _POLL_TASK
    _POLL_TASK = None
    if t and not t.done():
        t.cancel()
        try:
            await t
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


@router.get("/api/maritime/keyless")
async def keyless_vessels(
    lamin: float | None = Query(None, ge=-90, le=90),
    lomin: float | None = Query(None, ge=-180, le=180),
    lamax: float | None = Query(None, ge=-90, le=90),
    lomax: float | None = Query(None, ge=-180, le=180),
    limit: int | None = Query(None, ge=1, le=20000),
) -> dict[str, Any]:
    """Consolidated no-key vessel feed: Digitraffic (Baltic / Gulf of Finland)
    ∪ Kystdatahuset (Norwegian coast / North Sea / Arctic), deduped by MMSI
    with the freshest fix winning.

    Freshest-wins compares each feature's ``properties.t`` (the upstream per-fix
    timestamp — Kystdatahuset ``date_time_utc``, Digitraffic
    ``timestampExternal`` — falling back to ingest time only when absent), so a
    real-timestamped source is no longer clobbered by one that stamps now()
    (NIT N4). SOG is normalized to knots with the 102.3-kn AIS sentinel masked
    on every source (NIT N5).

    Each source degrades independently — a failure of one returns its features
    as empty and the other still renders; a total double-failure serves the
    last good union from cache (stale-on-failure). Coverage is REGIONAL
    Northern Europe (~4.5k distinct vessels measured this run over bbox
    lon[-8.4, 34.0] lat[55.3, 80.6]); the Med, Black Sea, Americas, and APAC
    have no keyless live point feed reachable from this egress and still need
    AISStream (key, on-demand). Same GeoJSON vessel shape as
    ``/api/maritime/digitraffic`` so the frontend paint reuses unchanged.
    """

    async def load() -> dict[str, Any]:
        # Digitraffic comes pre-built (+ correlation-store fed) from its own
        # cached loader; pull the full FC and reuse its already-normalized,
        # in-commission features. Kystverket is fetched + normalized here.
        try:
            dig_fc = await digitraffic_snapshot()
            dig_feats = dig_fc.get("features") or []
        except Exception as e:  # noqa: BLE001
            log.warning("keyless: digitraffic source failed: %s", e)
            dig_feats = []
        kyst_feats = await maritime_keyless.fetch_kystdatahuset()

        # Feed the fusion store with the Kystdatahuset fixes so correlation
        # rules (and the SAR dark-vessel cross-ref) see Norwegian vessels too.
        # Digitraffic features are already stored by its own loader.
        if kyst_feats:
            now = time.time()
            batch: list[Observation] = []
            for f in kyst_feats:
                p = f["properties"]
                lon, lat = f["geometry"]["coordinates"]
                # Use the per-fix timestamp the parser resolved from
                # date_time_utc (epoch s); fall back to ingest time only when
                # the upstream omitted it — same fairness rule as the dedup so
                # the store and the layer agree on a fix's age (NIT N4).
                fix_t = p.get("t")
                batch.append(
                    Observation(
                        id=f["id"],
                        source="kystdatahuset",
                        t=fix_t if isinstance(fix_t, (int, float)) else now,
                        lon=lon,
                        lat=lat,
                        emits_kind="vessel",
                        attrs={
                            "mmsi": p.get("mmsi"),
                            "name": p.get("name"),
                            "sog": p.get("sog"),
                            "cog": p.get("cog"),
                            "heading": p.get("heading"),
                            "shipType": p.get("shipType"),
                        },
                    )
                )
            if batch:
                store.add_many(batch)

        feats = maritime_keyless.merge_vessel_features(dig_feats, kyst_feats)
        return {"type": "FeatureCollection", "features": feats}

    # 30 s aligns with Digitraffic's own cache; Kystdatahuset realtime updates
    # at a similar cadence. The union is cached once and viewport-filtered per
    # request so the frontend only instantiates on-screen vessels.
    full = await cache.get_or_fetch("maritime:keyless", 30.0, load)
    if lamin is None and lomin is None and lamax is None and lomax is None and limit is None:
        return full
    return viewport_filter(full, lamin, lomin, lamax, lomax, limit)


# ── NGA navigational (broadcast) warnings ────────────────────────────────────
# Source: https://msi.nga.mil/api/publications/broadcast-warn?status=active&output=json
# Bare requests 503; the endpoint 200s when sent browser-like headers
# (User-Agent, Accept, Referer) — control-tested per
# docs/places-airspace-plan.md §3. It also occasionally 503s transiently and
# self-clears in well under 30s, so we retry a few times with a short backoff
# before giving up.
#
# Warning `text` is free-form NAVTEX-style prose; coordinates appear inline as
# either `DD-MM.mmH DDD-MM.mmH` (decimal minutes) or `DD-MM-SSH DDD-MM-SSH`
# (minutes+seconds), space-separated lat/lon pairs, with no structured
# geometry field anywhere in the payload. `parse_warning_coords` extracts
# every pair it can find; warnings with none (in-force summaries,
# cancellations, admin notices — verified against a real 386-warning pull,
# ~17/386 have no embedded coordinate) legitimately yield zero coordinates
# and are dropped from the FeatureCollection (nothing fabricated).
#
# ASAM is NOT built here (Akamai WAF blocks even full browser headers — see
# plan §7); this route is broadcast-warn only.

MARITIME_WARNINGS_UPSTREAM = "https://msi.nga.mil/api/publications/broadcast-warn"

_WARN_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://msi.nga.mil/home",
}

_WARN_RETRIES = 3
_WARN_BACKOFF_SEC = 2.0

# Matches "DD-MM.mmmH" or "DD-MM-SSH" (H = N/S), followed by whitespace and a
# matching longitude "DDD-MM.mmmH"/"DDD-MM-SSH" (H = E/W). Minutes may carry a
# decimal fraction (decimal-minutes format) OR a dash-separated seconds group
# (DMS format) — never both in the same pair.
_COORD_RE = re.compile(
    r"(?P<latd>\d{1,3})-(?P<latm>\d{1,2}(?:\.\d+)?)(?:-(?P<lats>\d{1,2}(?:\.\d+)?))?"
    r"(?P<lath>[NS])\s+"
    r"(?P<lond>\d{1,3})-(?P<lonm>\d{1,2}(?:\.\d+)?)(?:-(?P<lons>\d{1,2}(?:\.\d+)?))?"
    r"(?P<lonh>[EW])"
)

_MINE_RE = re.compile(r"\bMINES?\b", re.IGNORECASE)

MAX_COORDS_PER_WARNING = 25
WARNING_TEXT_TRUNCATE = 500


def _dms_to_decimal(deg: str, minutes: str, seconds: str | None, hemi: str) -> float:
    d = float(deg)
    m = float(minutes)
    s = float(seconds) if seconds is not None else 0.0
    value = d + m / 60.0 + s / 3600.0
    if hemi in ("S", "W"):
        value = -value
    return value


def parse_warning_coords(text: str) -> list[tuple[float, float]]:
    """Pure function: extract (lon, lat) pairs from NGA warning free text.

    Handles `DD-MM.mmH DDD-MM.mmH` and `DD-MM-SSH DDD-MM-SSH`. Tolerant of
    junk / no-coordinate text (returns an empty list, never raises). Caps at
    `MAX_COORDS_PER_WARNING` to bound huge multi-position warnings (e.g. a
    50-rig MODU roster) into a sane number of point features.
    """
    if not text:
        return []
    out: list[tuple[float, float]] = []
    for m in _COORD_RE.finditer(text):
        try:
            lat = _dms_to_decimal(
                m.group("latd"), m.group("latm"), m.group("lats"), m.group("lath")
            )
            lon = _dms_to_decimal(
                m.group("lond"), m.group("lonm"), m.group("lons"), m.group("lonh")
            )
        except (TypeError, ValueError):
            continue
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            continue
        out.append((lon, lat))
        if len(out) >= MAX_COORDS_PER_WARNING:
            break
    return out


def warning_to_features(warning: dict[str, Any]) -> list[dict[str, Any]]:
    """Pure function: one NGA broadcast-warn record -> 0..N GeoJSON Point features."""
    text = warning.get("text") or ""
    coords = parse_warning_coords(text)
    if not coords:
        return []
    is_mine = bool(_MINE_RE.search(text))
    msg_number = warning.get("msgNumber")
    msg_year = warning.get("msgYear")
    truncated = text[:WARNING_TEXT_TRUNCATE]
    props_base = {
        "msgNumber": msg_number,
        "msgYear": msg_year,
        "navArea": warning.get("navArea"),
        "subregion": warning.get("subregion"),
        "text": truncated,
        "mine": is_mine,
        "issueDate": warning.get("issueDate"),
        "authority": warning.get("authority"),
        "kind": "warning",
        "source": "nga-broadcast-warn",
    }
    feats: list[dict[str, Any]] = []
    for idx, (lon, lat) in enumerate(coords):
        feats.append(
            {
                "type": "Feature",
                "id": f"warn:{msg_year}-{msg_number}-{idx}",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": dict(props_base),
            }
        )
    return feats


def parse_broadcast_warn(payload: dict[str, Any]) -> dict[str, Any]:
    """Pure function: raw NGA JSON payload -> GeoJSON FeatureCollection."""
    warnings = payload.get("broadcast-warn") or []
    feats: list[dict[str, Any]] = []
    for w in warnings:
        feats.extend(warning_to_features(w))
    return {"type": "FeatureCollection", "features": feats}


@router.get("/api/maritime/warnings")
async def maritime_warnings() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        client = get_client()
        last_status: int | None = None
        for attempt in range(_WARN_RETRIES):
            r = await client.get(
                MARITIME_WARNINGS_UPSTREAM,
                params={"status": "active", "output": "json"},
                headers=_WARN_HEADERS,
            )
            if r.status_code == 200:
                try:
                    payload = r.json()
                except ValueError as exc:
                    raise HTTPException(502, "nga broadcast-warn: non-JSON body") from exc
                return parse_broadcast_warn(payload)
            last_status = r.status_code
            if r.status_code != 503 or attempt == _WARN_RETRIES - 1:
                break
            await asyncio.sleep(_WARN_BACKOFF_SEC)
        raise HTTPException(502, f"nga broadcast-warn upstream {last_status}")

    return await cache.get_or_fetch("maritime:warnings", 900.0, load)
