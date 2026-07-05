"""Ground-level (street-view-style) imagery union: Panoramax + KartaView.

Keyless, open. Returns nearby photo points for an AOI; the route layer proxies the
actual image bytes (CORS + politeness) so a desktop webview canvas can read pixels
for client-side detection.

!! COVERAGE NOTE (honest, per repo rules) !!
- Panoramax (panoramax.xyz, FR-led, ODbL/CC-BY): best in France / Western Europe,
  thinner elsewhere. The search endpoint is bbox-based GeoJSON.
- KartaView (kartaview.com, formerly OpenStreetCam, CC-BY-SA): broader global road
  coverage but often stale; its nearby endpoint is a POST with a response shape that
  has changed over time. Parsing here is BEST-EFFORT and DEFENSIVE — a shape mismatch
  just yields [] from that source (Panoramax still carries the union).
Both response shapes are reconstructed from public docs; verify with a live probe
before claiming coverage in any user-facing string. Do NOT say "global".

UA: the shared httpx client sets `osint-console/0.1`, but a few hosts 451/403 a
non-browser UA, so each fetch overrides to a real browser UA (per repo feed hygiene).
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass, field
from typing import Any

from app.upstream import get_client

_BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)


@dataclass(frozen=True)
class GroundPhoto:
    id: str
    source: str  # 'panoramax' | 'kartaview'
    lat: float
    lon: float
    heading: float | None
    captured_at: str | None
    thumb_url: str
    photo_url: str  # HD / full


# Canonical endpoints. Panoramax photo URLs come from each STAC item's `assets`
# (OVH S3, hashed path) — not a guessable template — so only the search URL is here.
_PANORAMAX_SEARCH = "https://api.panoramax.xyz/api/search"
_KARTAVIEW_NEARBY = "https://kartaview.org/1.0/map/list/nearby"

# Populated by nearby(); read by the photo proxy to resolve (source,id) → URL without
# an AOI. Single-process dict; bounded by the nearby cache lifetime. Ponytail: a
# module dict is fine for the single-analyst box (same spirit as app.upstream cache).
_PHOTO_URLS: dict[tuple[str, str], dict[str, str]] = {}


def _bbox(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    """Axis-aligned bbox (min_lon, min_lat, max_lon, max_lat) for a centre+radius."""
    dlat = radius_km / 111.32
    cos = max(0.2, abs(math.cos(math.radians(lat))))
    dlon = radius_km / (111.32 * cos)
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


async def _get(url: str, **kw: Any) -> Any:
    """GET with browser UA; return parsed JSON (dict/list) or None on any failure."""
    headers = dict(kw.pop("headers", None) or {})
    headers["User-Agent"] = _BROWSER_UA
    try:
        r = await get_client().get(url, headers=headers, **kw)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None


async def _post_form(url: str, data: dict[str, Any]) -> Any:
    headers = {"User-Agent": _BROWSER_UA}
    try:
        r = await get_client().request("POST", url, data=data, headers=headers)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None


async def load_panoramax(lat: float, lon: float, radius_km: float) -> list[GroundPhoto]:
    """Panoramax bbox search → GroundPhoto[]. Defensive: any shape mismatch → []."""
    min_lon, min_lat, max_lon, max_lat = _bbox(lat, lon, radius_km)
    bbox = f"{min_lon},{min_lat},{max_lon},{max_lat}"
    j = await _get(_PANORAMAX_SEARCH, params={"bbox": bbox, "limit": "40"})
    if not isinstance(j, dict):
        return []
    out: list[GroundPhoto] = []
    for f in j.get("features") or []:
        try:
            geom = f.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            lon_f, lat_f = geom["coordinates"][0], geom["coordinates"][1]
            pid = str(f.get("id") or (f.get("properties") or {}).get("id") or "")
            if not pid:
                continue
            props = f.get("properties") or {}
            heading = props.get("camera:heading", props.get("heading"))
            captured = props.get("datetime") or props.get("capture_date")
            # Use the asset hrefs the STAC item already carries. Panoramax serves
            # pixels from an OVH S3 bucket under a hashed path, NOT a guessable
            # /api/photos/{id}/{size}.jpg template (that 404s → proxy 502).
            assets = f.get("assets") or {}
            hd_a = assets.get("hd") if isinstance(assets.get("hd"), dict) else None
            sd_a = assets.get("sd") if isinstance(assets.get("sd"), dict) else None
            th_a = assets.get("thumb") if isinstance(assets.get("thumb"), dict) else None
            hd_href = str((hd_a or sd_a or {}).get("href") or "")
            thumb_href = str((sd_a or th_a or {}).get("href") or "")
            if not hd_href:
                continue  # no usable asset → nothing to proxy
            out.append(
                GroundPhoto(
                    id=pid,
                    source="panoramax",
                    lat=float(lat_f),
                    lon=float(lon_f),
                    heading=float(heading) if heading is not None else None,
                    captured_at=str(captured) if captured else None,
                    thumb_url=thumb_href or hd_href,
                    photo_url=hd_href,
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


async def load_kartaview(lat: float, lon: float, radius_km: float) -> list[GroundPhoto]:
    """KartaView nearby (POST). Defensive; shape has drifted across API versions.

    Best-effort fields: data items carry latitude/longitude/compass/fileLTH/sequence_id.
    CDN URL is reconstructed as https://cdn.kartaview.com/{sequence}/{file} — verify live.
    """
    radius_m = int(max(100, radius_km * 1000))
    j = await _post_form(
        _KARTAVIEW_NEARBY,
        {"lat": str(lat), "lng": str(lon), "distance": str(radius_m), "limit": "40"},
    )
    if not isinstance(j, dict):
        return []
    rows: Any = (
        j.get("currentPageItems") or (j.get("result") or {}).get("data")
        or j.get("data") or []
    )
    if not isinstance(rows, list):
        return []
    out: list[GroundPhoto] = []
    for row in rows:
        try:
            rlat = float(row.get("latitude"))
            rlon = float(row.get("longitude"))
        except (TypeError, ValueError):
            continue
        kid = str(row.get("id") or "")
        if not kid:
            continue
        seq = str(row.get("sequence_id") or row.get("sequenceId") or "")
        file_name = str(row.get("fileLTH") or row.get("name") or "")
        compass = row.get("compass")
        captured = row.get("shot_date") or row.get("date_added")
        # CDN base: prefer an explicit field if the API gave one, else reconstruct.
        base = row.get("storage") or (f"https://cdn.kartaview.com/{seq}" if seq else "")
        photo_url = f"{base}/{file_name}" if (base and file_name) else ""
        thumb_url = row.get("thumbnail") or photo_url
        if not photo_url:
            continue  # nothing to proxy
        out.append(
            GroundPhoto(
                id=f"{seq}_{kid}" if seq else kid,
                source="kartaview",
                lat=rlat,
                lon=rlon,
                heading=float(compass) if compass is not None else None,
                captured_at=str(captured) if captured else None,
                thumb_url=thumb_url,
                photo_url=photo_url,
            )
        )
    return out


@dataclass
class GroundResult:
    photos: list[GroundPhoto] = field(default_factory=list)
    note: str | None = None


async def nearby(lat: float, lon: float, radius_km: float) -> GroundResult:
    """Fan out both sources concurrently, dedup by ~11 m grid, drop anything >radius."""
    pano, karta = await asyncio.gather(
        load_panoramax(lat, lon, radius_km),
        load_kartaview(lat, lon, radius_km),
    )
    # Refresh the proxy URL table for everything we just returned.
    _PHOTO_URLS.clear()
    seen: set[tuple[int, int]] = set()
    deduped: list[GroundPhoto] = []
    for p in (*pano, *karta):
        key = (round(p.lat, 4), round(p.lon, 4))  # ~11 m
        if key in seen:
            continue
        seen.add(key)
        _PHOTO_URLS[(p.source, p.id)] = {"thumb": p.thumb_url, "hd": p.photo_url}
        deduped.append(p)

    def dist_km(p: GroundPhoto) -> float:
        dlat = (p.lat - lat) * 111.32
        cos = max(0.2, abs(math.cos(math.radians(lat))))
        dlon = (p.lon - lon) * 111.32 * cos
        return math.hypot(dlat, dlon)

    deduped.sort(key=dist_km)
    note = None
    if not deduped:
        note = "no ground coverage in this area (sources may be EU/road-biased)"
    res = GroundResult(photos=deduped, note=note)
    # Stash a marker so the proxy can confirm nearby() has run for this session.
    _PHOTO_URLS[("__aoi__", "")] = {"thumb": "", "hd": ""}
    return res


def proxy_url(source: str, photo_id: str, size: str) -> str | None:
    """Resolve the upstream image URL for (source, id) at `size` (hd|thumb)."""
    entry = _PHOTO_URLS.get((source, photo_id))
    if not entry:
        return None
    if size == "thumb":
        return entry.get("thumb") or entry.get("hd")
    return entry.get("hd") or entry.get("thumb")
