"""GET /api/cams — public webcam catalog + snapshot proxy.

Sources (all owner-published, keyless):
- Fintraffic Digitraffic weathercams (CC BY 4.0) — same API family as the
  Digitraffic AIS feed we already consume.
- Caltrans district CCTV JSON (public CA traffic cams). District list is a
  tuple constant — extend it to add coverage; the per-state-adapter pattern
  is _load_caltrans, copy it for other DOTs.
- app/data/cams.yaml — hand-curated additions (owner-published only; see
  the policy header in that file).

Why a snapshot proxy instead of direct image URLs in the browser:
1. CORS — most DOT image hosts send no ACAO headers.
2. Politeness — the 60 s TtlCache caps upstream fetches at one per minute
   per cam regardless of how many panels are open.
3. SSRF safety — cam_id → catalog lookup is the only path to a fetch; the
   browser can never make this proxy fetch an arbitrary URL.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException, Response

from app.upstream import cache, get_client

router = APIRouter(tags=["cams"])

_CATALOG_TTL = 3600.0
_SNAPSHOT_TTL = 60.0

_DIGITRAFFIC_STATIONS = "https://tie.digitraffic.fi/api/weathercam/v1/stations"
_DIGITRAFFIC_IMG = "https://weathercam.digitraffic.fi/{preset}.jpg"
_CALTRANS_DISTRICTS = (3, 4)  # Sacramento, Bay Area — extend freely
_CALTRANS_URL = "https://cwwp2.dot.ca.gov/data/d{n}/cctv/cctvStatusD{n:02d}.json"
_CAMS_YAML = Path(__file__).resolve().parent.parent / "data" / "cams.yaml"


@dataclass(frozen=True)
class Cam:
    id: str  # "{source}:{key}" — unique across sources
    name: str
    lat: float
    lon: float
    snapshot_url: str
    source: str
    attribution: str
    hls_url: str | None = None


async def _get_json(url: str) -> Any | None:
    try:
        r = await get_client().get(url)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None


async def _load_digitraffic() -> list[Cam]:
    j = await _get_json(_DIGITRAFFIC_STATIONS)
    if not isinstance(j, dict):
        return []
    out: list[Cam] = []
    for f in j.get("features") or []:
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or []
        presets = props.get("presets") or []
        if len(coords) < 2 or not presets:
            continue
        preset_id = (presets[0] or {}).get("id")
        if not preset_id:
            continue
        try:
            lat, lon = float(coords[1]), float(coords[0])
        except (TypeError, ValueError):
            continue  # a station pending geolocation (null coords) must not 500 /api/cams
        station_id = str(props.get("id") or f.get("id") or preset_id)
        out.append(
            Cam(
                id=f"digitraffic:{station_id}",
                name=str(props.get("name") or station_id).replace("_", " "),
                lat=lat,
                lon=lon,
                snapshot_url=_DIGITRAFFIC_IMG.format(preset=preset_id),
                source="digitraffic",
                attribution="Fintraffic / digitraffic.fi (CC BY 4.0)",
            )
        )
    return out


async def _load_caltrans_district(n: int) -> list[Cam]:
    out: list[Cam] = []
    j = await _get_json(_CALTRANS_URL.format(n=n))
    if not isinstance(j, dict):
        return out
    for i, row in enumerate(j.get("data") or []):
        cctv = (row or {}).get("cctv") or {}
        loc = cctv.get("location") or {}
        img = ((cctv.get("imageData") or {}).get("static") or {}).get(
            "currentImageURL"
        )
        try:
            lat = float(loc.get("latitude"))
            lon = float(loc.get("longitude"))
        except (TypeError, ValueError):
            continue
        if not img:
            continue
        key = cctv.get("index") or str(i)
        out.append(
            Cam(
                id=f"caltrans:d{n}-{key}",
                name=str(loc.get("locationName") or f"Caltrans D{n} #{key}"),
                lat=lat,
                lon=lon,
                snapshot_url=str(img),
                source="caltrans",
                attribution="Caltrans (public)",
            )
        )
    return out


async def _load_caltrans() -> list[Cam]:
    # Fetch every district CCTV JSON concurrently — a serial loop over the
    # district list made a cold catalog wait on each upstream back-to-back.
    per_district = await asyncio.gather(
        *(_load_caltrans_district(n) for n in _CALTRANS_DISTRICTS)
    )
    return [cam for cams in per_district for cam in cams]


def _load_yaml() -> list[Cam]:
    try:
        doc = yaml.safe_load(_CAMS_YAML.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return []
    out: list[Cam] = []
    for c in doc.get("cams") or []:
        try:
            out.append(
                Cam(
                    id=f"yaml:{c['id']}",
                    name=str(c["name"]),
                    lat=float(c["lat"]),
                    lon=float(c["lon"]),
                    snapshot_url=str(c["snapshot_url"]),
                    source="curated",
                    attribution=str(c.get("attribution") or "curated"),
                    hls_url=c.get("hls_url"),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


async def _get_catalog() -> dict[str, Cam]:
    async def load() -> dict[str, Cam]:
        # The three sources are independent — fan them out concurrently so a
        # cold catalog is bounded by the slowest source, not their sum. The
        # YAML read is sync file I/O, so it runs off the event loop thread.
        digitraffic, caltrans, curated = await asyncio.gather(
            _load_digitraffic(),
            _load_caltrans(),
            asyncio.to_thread(_load_yaml),
        )
        return {c.id: c for c in (*digitraffic, *caltrans, *curated)}

    return await cache.get_or_fetch("cams:catalog", _CATALOG_TTL, load)


@router.get("/api/cams")
async def cams_geojson() -> dict[str, Any]:
    catalog = await _get_catalog()
    features = [
        {
            "type": "Feature",
            "id": f"cam:{c.id}",
            "geometry": {"type": "Point", "coordinates": [c.lon, c.lat, 0]},
            "properties": {
                "kind": "camera",
                "name": c.name,
                "source": c.source,
                "attribution": c.attribution,
                "has_hls": c.hls_url is not None,
                "hls_url": c.hls_url,
                "cam_id": c.id,
            },
        }
        for c in catalog.values()
    ]
    fc: dict[str, Any] = {"type": "FeatureCollection", "features": features}
    if not features:
        fc["note"] = "no cam sources reachable"
    return fc


@router.get("/api/cams/{cam_id:path}/snapshot")
async def cam_snapshot(cam_id: str) -> Response:
    catalog = await _get_catalog()
    cam = catalog.get(cam_id)
    if cam is None:
        raise HTTPException(404, "unknown cam")

    async def load() -> bytes:
        r = await get_client().get(cam.snapshot_url)
        if r.status_code != 200:
            raise HTTPException(502, f"cam upstream {r.status_code}")
        return r.content

    data = await cache.get_or_fetch(f"cams:snap:{cam_id}", _SNAPSHOT_TTL, load)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=60"},
    )
