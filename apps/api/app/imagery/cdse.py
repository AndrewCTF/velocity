"""Copernicus Data Space Ecosystem (Sentinel Hub) Process-API adapter.

Keyed (OAuth client-credentials). Serves Sentinel-1/2/3 as XYZ tiles by
converting z/x/y -> EPSG:3857 bbox and POSTing an evalscript to the Process
API per tile. No dashboard configuration instance required — the OAuth client
(cdse_client_id / cdse_client_secret) is enough.

Token: client-credentials, cached in-process, refreshed on expiry/401 (mirrors
the OpenSky token-manager pattern). Absent creds -> adapter reports unavailable
and contributes no catalog layers (keyless GIBS still works).
"""

from __future__ import annotations

import asyncio
import math
import time
from typing import Any

from app.config import get_settings
from app.upstream import get_client

_TOKEN_URL = (
    "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/"
    "protocol/openid-connect/token"
)
_PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"

_R = 6378137.0
_ORIGIN = math.pi * _R  # web-mercator half-extent (m)

_MEDIA = {"jpg": "image/jpeg", "png": "image/png"}

# Evalscripts kept inline — small, and colocating them with the catalog keeps
# one source of truth per layer.
_S2_TRUECOLOR = (
    "//VERSION=3\n"
    'function setup(){return{input:["B02","B03","B04"],output:{bands:3}};}\n'
    "function evaluatePixel(s){return [2.5*s.B04,2.5*s.B03,2.5*s.B02];}"
)
_S2_FALSECOLOR = (
    "//VERSION=3\n"
    'function setup(){return{input:["B03","B04","B08"],output:{bands:3}};}\n'
    "function evaluatePixel(s){return [2.5*s.B08,2.5*s.B04,2.5*s.B03];}"
)
_S1_VV = (
    "//VERSION=3\n"
    'function setup(){return{input:["VV"],output:{bands:1}};}\n'
    "function evaluatePixel(s){return [2*Math.sqrt(s.VV)];}"
)
_S3_TRUECOLOR = (
    "//VERSION=3\n"
    'function setup(){return{input:["B04","B06","B08"],output:{bands:3}};}\n'
    "function evaluatePixel(s){return [2.5*s.B08,2.5*s.B06,2.5*s.B04];}"
)

# id -> {title, group, collection, evalscript, ext, lookback_days, max_z}
_LAYERS: dict[str, dict[str, Any]] = {
    "S2_L2A_TRUECOLOR": {
        "title": "Sentinel-2 — True Color (10 m)", "group": "Optical (10 m)",
        "collection": "sentinel-2-l2a", "evalscript": _S2_TRUECOLOR,
        "ext": "jpg", "lookback_days": 10, "max_z": 14, "optical": True,
    },
    "S2_L2A_FALSECOLOR": {
        "title": "Sentinel-2 — False Color NIR (10 m)", "group": "Optical (10 m)",
        "collection": "sentinel-2-l2a", "evalscript": _S2_FALSECOLOR,
        "ext": "jpg", "lookback_days": 10, "max_z": 14, "optical": True,
    },
    "S1_GRD_VV": {
        "title": "Sentinel-1 — SAR VV (C-band)", "group": "Radar (SAR)",
        "collection": "sentinel-1-grd", "evalscript": _S1_VV,
        "ext": "png", "lookback_days": 12, "max_z": 14, "optical": False,
    },
    "S3_OLCI_TRUECOLOR": {
        "title": "Sentinel-3 — OLCI True Color (300 m)", "group": "Optical (300 m)",
        "collection": "sentinel-3-olci", "evalscript": _S3_TRUECOLOR,
        "ext": "jpg", "lookback_days": 4, "max_z": 9, "optical": True,
    },
}

_token_value: str | None = None
_token_exp: float = 0.0  # monotonic seconds
_token_lock = asyncio.Lock()


def available() -> bool:
    s = get_settings()
    return bool(s.cdse_client_id and s.cdse_client_secret)


def catalog() -> list[dict[str, Any]]:
    if not available():
        return []
    return [
        {"id": k, "title": v["title"], "group": v["group"], "max_z": v["max_z"]}
        for k, v in _LAYERS.items()
    ]


def layer(layer_id: str) -> dict[str, Any]:
    return _LAYERS[layer_id]


def tile_bbox_3857(z: int, x: int, y: int) -> list[float]:
    """XYZ tile -> [minx, miny, maxx, maxy] in EPSG:3857 metres."""
    n = 2**z
    span = 2 * _ORIGIN / n
    minx = -_ORIGIN + x * span
    maxy = _ORIGIN - y * span
    return [minx, maxy - span, minx + span, maxy]


def lonlat_to_3857(lon: float, lat: float) -> tuple[float, float]:
    """WGS84 lon/lat (deg) -> EPSG:3857 metres (spherical web mercator)."""
    x = math.radians(lon) * _R
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * _R
    return x, y


def lonlat_bbox_3857(
    lon0: float, lat0: float, lon1: float, lat1: float
) -> list[float]:
    """Lon/lat corners -> [minx, miny, maxx, maxy] in EPSG:3857 metres."""
    x0, y0 = lonlat_to_3857(lon0, lat0)
    x1, y1 = lonlat_to_3857(lon1, lat1)
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


async def _token(force: bool = False) -> str | None:
    global _token_value, _token_exp
    if not available():
        return None
    async with _token_lock:
        if not force and _token_value and time.monotonic() < _token_exp:
            return _token_value
        s = get_settings()
        try:
            r = await get_client().post(
                _TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": s.cdse_client_id,
                    "client_secret": s.cdse_client_secret,
                },
            )
        except Exception:
            return None
        if r.status_code != 200:
            return None
        body = r.json()
        _token_value = body.get("access_token")
        # refresh 60s before the stated expiry
        _token_exp = time.monotonic() + max(60.0, float(body.get("expires_in", 600)) - 60)
        return _token_value


def _iso_range(date: str, lookback_days: int) -> tuple[str, str]:
    import datetime as dt

    end = dt.datetime.fromisoformat(date).replace(tzinfo=dt.UTC)
    start = end - dt.timedelta(days=lookback_days)
    return (
        start.strftime("%Y-%m-%dT00:00:00Z"),
        end.strftime("%Y-%m-%dT23:59:59Z"),
    )


def build_process_body(
    layer_id: str, bbox: list[float], width: int, height: int, date: str
) -> dict[str, Any]:
    meta = _LAYERS[layer_id]
    data_filter: dict[str, Any] = {
        "timeRange": dict(
            zip(("from", "to"), _iso_range(date, meta["lookback_days"]), strict=True)
        )
    }
    if meta["optical"]:
        data_filter["mosaickingOrder"] = "leastCC"
    fmt = _MEDIA[meta["ext"]]
    return {
        "input": {
            "bounds": {
                "bbox": bbox,
                "properties": {"crs": "http://www.opengis.net/def/crs/EPSG/0/3857"},
            },
            "data": [{"type": meta["collection"], "dataFilter": data_filter}],
        },
        "output": {
            "width": width,
            "height": height,
            "responses": [{"identifier": "default", "format": {"type": fmt}}],
        },
        "evalscript": meta["evalscript"],
    }


async def fetch_image(
    layer_id: str, bbox: list[float], width: int, height: int, date: str
) -> bytes | None:
    """POST one Process-API request for an arbitrary bbox/size. Reused by the
    tile route (256x256) and the dark-vessel scene grab (larger)."""
    token = await _token()
    if token is None:
        return None
    body = build_process_body(layer_id, bbox, width, height, date)
    for attempt in (0, 1):
        try:
            r = await get_client().post(
                _PROCESS_URL,
                headers={"Authorization": f"Bearer {token}"},
                json=body,
                timeout=30.0,
            )
        except Exception:
            return None
        if r.status_code == 200:
            return r.content
        if r.status_code == 401 and attempt == 0:
            token = await _token(force=True)
            if token is None:
                return None
            continue
        return None
    return None


async def fetch_tile(layer_id: str, date: str, z: int, x: int, y: int) -> bytes | None:
    return await fetch_image(layer_id, tile_bbox_3857(z, x, y), 256, 256, date)
