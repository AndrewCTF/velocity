"""GET /api/maritime/digitraffic — Finnish Fintraffic open AIS (Baltic).

Per research.md §1 / research_updated.md §2.6: Digitraffic is no-auth, CC BY 4.0,
just identify with the `Digitraffic-User` header. Class-A only. Excellent
default vessel layer for an OSINT console because it requires no setup.

Returns GeoJSON normalized to the same vessel shape as AISStream so the
PollGeoJsonAdapter / MapLibre vessel paint reuse without changes.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query

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


@router.get("/api/maritime/digitraffic")
async def digitraffic_vessels(
    lamin: float | None = Query(None, ge=-90, le=90),
    lomin: float | None = Query(None, ge=-180, le=180),
    lamax: float | None = Query(None, ge=-90, le=90),
    lomax: float | None = Query(None, ge=-180, le=180),
    limit: int | None = Query(None, ge=1, le=20000),
) -> dict[str, Any]:
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
            sog = p.get("sog")
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
    full = await cache.get_or_fetch("digitraffic:locations", 30.0, load)
    if lamin is None and lomin is None and lamax is None and lomax is None and limit is None:
        return full
    return viewport_filter(full, lamin, lomin, lamax, lomax, limit)
