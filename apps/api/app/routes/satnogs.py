"""SatNOGS + SondeHub feeds (2026-08-06 mega-ledger wave).

- ``/api/space/satnogs/observations`` SatNOGS Network — recent sat observations
- ``/api/space/satnogs/transmitters`` SatNOGS DB — known satellite transmitters
- ``/api/space/satnogs/stations``     SatNOGS Network — ground station map
- ``/api/space/sondes``               SondeHub — live weather balloons worldwide
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.routes import _feedgeo as fg

router = APIRouter(tags=["satnogs"])

# ── SatNOGS observations ──────────────────────────────────────────────────
SATNOGS_OBS_URL = "https://network.satnogs.org/api/observations/"


@router.get("/api/space/satnogs/observations")
async def satnogs_observations(
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(SATNOGS_OBS_URL, params={"limit": str(limit)})
        items = raw if isinstance(raw, list) else []
        out: list[fg.Feature] = []
        for obs in items:
            lat = fg.num(obs.get("station_lat"))
            lon = fg.num(obs.get("station_lng"))
            oid = str(obs.get("id") or "")
            if lat is None or lon is None or not oid:
                continue
            out.append(
                fg.point(
                    f"satnogs_obs:{oid}",
                    lon,
                    lat,
                    {
                        "kind": "satnogs_obs",
                        "norad_cat_id": obs.get("norad_cat_id"),
                        "satellite": obs.get("satellite_name") or obs.get("tle0"),
                        "station": obs.get("station_name"),
                        "status": obs.get("vetted_status") or obs.get("status"),
                        "start": obs.get("start"),
                        "end": obs.get("end"),
                        "frequency": fg.num(obs.get("transmitter_downlink_low")),
                        "mode": obs.get("transmitter_mode"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached(f"satnogs:obs:{limit}", 300.0, load)


# ── SatNOGS transmitters ──────────────────────────────────────────────────
SATNOGS_TX_URL = "https://db.satnogs.org/api/transmitters/"


@router.get("/api/space/satnogs/transmitters")
async def satnogs_transmitters(
    satellite: int | None = Query(None, description="NORAD cat ID filter"),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        params: dict[str, str] = {"format": "json"}
        if satellite:
            params["satellite__norad_cat_id"] = str(satellite)
        raw = await fg.fetch_json(SATNOGS_TX_URL, params=params)
        items = raw if isinstance(raw, list) else []
        return {
            "count": len(items),
            "transmitters": [
                {
                    "uuid": t.get("uuid"),
                    "norad_cat_id": t.get("norad_cat_id"),
                    "description": t.get("description"),
                    "downlink_low": t.get("downlink_low"),
                    "downlink_high": t.get("downlink_high"),
                    "uplink_low": t.get("uplink_low"),
                    "mode": t.get("mode"),
                    "baud": t.get("baud"),
                    "status": t.get("status"),
                    "type": t.get("type"),
                }
                for t in items[:500]
            ],
        }

    key = f"satnogs:tx:{satellite or 'all'}"
    return await fg.cached(key, 3600.0, load)


# ── SatNOGS ground stations ───────────────────────────────────────────────
SATNOGS_STATIONS_URL = "https://network.satnogs.org/api/stations/"


@router.get("/api/space/satnogs/stations")
async def satnogs_stations() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(SATNOGS_STATIONS_URL, params={"status": "2"})
        items = raw if isinstance(raw, list) else []
        out: list[fg.Feature] = []
        for st in items:
            lat = fg.num(st.get("lat"))
            lon = fg.num(st.get("lng"))
            sid = str(st.get("id") or "")
            if lat is None or lon is None or not sid:
                continue
            out.append(
                fg.point(
                    f"satnogs_stn:{sid}",
                    lon,
                    lat,
                    {
                        "kind": "satnogs_stn",
                        "name": st.get("name"),
                        "altitude": fg.num(st.get("altitude")),
                        "min_horizon": fg.num(st.get("min_horizon")),
                        "observations": st.get("observations"),
                        "status": st.get("status"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("satnogs:stations", 3600.0, load)


# ── SondeHub — live weather balloons ───────────────────────────────────────
SONDEHUB_URL = "https://api.v2.sondehub.org/sondes"


@router.get("/api/space/sondes")
async def sondes() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(SONDEHUB_URL)
        if isinstance(raw, dict):
            items = list(raw.values())
        elif isinstance(raw, list):
            items = raw
        else:
            items = []
        out: list[fg.Feature] = []
        for s in items:
            if not isinstance(s, dict):
                continue
            lat = fg.num(s.get("lat"))
            lon = fg.num(s.get("lon"))
            sid = str(s.get("serial") or s.get("sonde_id") or "")
            if lat is None or lon is None or not sid:
                continue
            out.append(
                fg.point(
                    f"sonde:{sid}",
                    lon,
                    lat,
                    {
                        "kind": "sonde",
                        "type": s.get("type") or s.get("manufacturer"),
                        "frequency": fg.num(s.get("frequency")),
                        "alt": fg.num(s.get("alt")),
                        "temp": fg.num(s.get("temp")),
                        "humidity": fg.num(s.get("humidity")),
                        "pressure": fg.num(s.get("pressure")),
                        "vel_v": fg.num(s.get("vel_v")),
                        "heading": fg.num(s.get("heading")),
                        "datetime": s.get("datetime"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("space:sondes", 120.0, load)
