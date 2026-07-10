#!/usr/bin/env python3
"""Keyless georeferenced reference-photo fetch for cross-view matching.

Mirrors `apps/api/app/intel/ground.py` (Panoramax STAC + KartaView nearby) but as
a standalone, synchronous, dependency-light module usable from the CLIP retrieval
stage (Stage C1) and from CI. Returns georeferenced street-level thumbnails for an
AOI and caches the pixels to a scratch dir so re-runs are offline.

Honest coverage note (same as ground.py): Panoramax is strongest in France / West
Europe and thin elsewhere; KartaView is broader but stale and its response shape
has drifted (parsing is best-effort → a shape mismatch just yields [] from that
source). Do NOT claim "global". These are the natural reference set for cross-view
matching in rural Europe, which is exactly where the pipeline needs them.

Keyless. Uses only urllib (stdlib) + a browser UA (a few hosts 451/403 a bot UA).

Usage:
  python reference_photos.py --lat 43.61 --lon 1.45 --radius-km 0.4 --limit 40 \
      --cache /tmp/refs --out refs.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import ssl
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass

_BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)
_PANORAMAX_SEARCH = "https://api.panoramax.xyz/api/search"
_KARTAVIEW_NEARBY = "https://kartaview.org/1.0/map/list/nearby"
_SSL = ssl.create_default_context()


@dataclass
class ReferencePhoto:
    id: str
    source: str          # 'panoramax' | 'kartaview'
    lat: float
    lon: float
    heading: float | None
    captured_at: str | None
    thumb_url: str
    photo_url: str
    local_path: str | None = None


def _bbox(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    dlat = radius_km / 111.32
    cos = max(0.2, abs(math.cos(math.radians(lat))))
    dlon = radius_km / (111.32 * cos)
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def _get_json(url: str, params: dict | None = None, timeout: float = 20.0):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": _BROWSER_UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as r:
            if r.status != 200:
                return None
            return json.load(r)
    except Exception:
        return None


def _post_json(url: str, data: dict, timeout: float = 20.0):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"User-Agent": _BROWSER_UA,
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as r:
            if r.status != 200:
                return None
            return json.load(r)
    except Exception:
        return None


def load_panoramax(lat: float, lon: float, radius_km: float, limit: int = 40) -> list[ReferencePhoto]:
    """Panoramax bbox STAC search → ReferencePhoto[]. Defensive: shape mismatch → []."""
    w, s, e, n = _bbox(lat, lon, radius_km)
    j = _get_json(_PANORAMAX_SEARCH, {"bbox": f"{w},{s},{e},{n}", "limit": str(limit)})
    if not isinstance(j, dict):
        return []
    out: list[ReferencePhoto] = []
    for f in j.get("features") or []:
        try:
            geom = f.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            lon_f, lat_f = float(geom["coordinates"][0]), float(geom["coordinates"][1])
            pid = str(f.get("id") or (f.get("properties") or {}).get("id") or "")
            if not pid:
                continue
            props = f.get("properties") or {}
            heading = props.get("camera:heading", props.get("heading"))
            captured = props.get("datetime") or props.get("capture_date")
            assets = f.get("assets") or {}
            def href(k):
                a = assets.get(k)
                return str(a.get("href")) if isinstance(a, dict) and a.get("href") else ""
            hd = href("hd") or href("sd")
            thumb = href("thumb") or href("sd") or hd
            if not hd:
                continue
            out.append(ReferencePhoto(
                id=pid, source="panoramax", lat=lat_f, lon=lon_f,
                heading=float(heading) if heading is not None else None,
                captured_at=str(captured) if captured else None,
                thumb_url=thumb, photo_url=hd,
            ))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def load_kartaview(lat: float, lon: float, radius_km: float, limit: int = 40) -> list[ReferencePhoto]:
    """KartaView nearby (POST). Best-effort; shape has drifted across API versions."""
    radius_m = int(max(100, radius_km * 1000))
    j = _post_json(_KARTAVIEW_NEARBY,
                   {"lat": str(lat), "lng": str(lon), "distance": str(radius_m), "limit": str(limit)})
    if not isinstance(j, dict):
        return []
    rows = (j.get("currentPageItems") or (j.get("result") or {}).get("data")
            or j.get("data") or [])
    if not isinstance(rows, list):
        return []
    out: list[ReferencePhoto] = []
    for row in rows:
        try:
            rlat, rlon = float(row.get("latitude")), float(row.get("longitude"))
        except (TypeError, ValueError):
            continue
        kid = str(row.get("id") or "")
        if not kid:
            continue
        seq = str(row.get("sequence_id") or row.get("sequenceId") or "")
        fn = str(row.get("fileLTH") or row.get("name") or "")
        base = row.get("storage") or (f"https://cdn.kartaview.com/{seq}" if seq else "")
        photo = f"{base}/{fn}" if (base and fn) else ""
        if not photo:
            continue
        out.append(ReferencePhoto(
            id=f"{seq}_{kid}" if seq else kid, source="kartaview", lat=rlat, lon=rlon,
            heading=float(row["compass"]) if row.get("compass") is not None else None,
            captured_at=str(row.get("shot_date") or row.get("date_added") or "") or None,
            thumb_url=str(row.get("thumbnail") or photo), photo_url=photo,
        ))
    return out


def _download(url: str, path: str, timeout: float = 25.0) -> bool:
    req = urllib.request.Request(url, headers={"User-Agent": _BROWSER_UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as r:
            if r.status != 200:
                return False
            data = r.read()
        if len(data) < 512:  # too small to be a real image
            return False
        with open(path, "wb") as f:
            f.write(data)
        return True
    except Exception:
        return False


def fetch_reference_photos(lat: float, lon: float, radius_km: float, cache_dir: str,
                           limit: int = 40, download: bool = True) -> list[ReferencePhoto]:
    """Fan out Panoramax + KartaView, dedup by ~11 m grid, sort by distance to
    centre, and (optionally) cache thumbnail pixels to cache_dir."""
    os.makedirs(cache_dir, exist_ok=True)
    photos = load_panoramax(lat, lon, radius_km, limit) + load_kartaview(lat, lon, radius_km, limit)
    seen: set[tuple[float, float]] = set()
    deduped: list[ReferencePhoto] = []
    for p in photos:
        key = (round(p.lat, 4), round(p.lon, 4))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(p)

    def dist_km(p: ReferencePhoto) -> float:
        dlat = (p.lat - lat) * 111.32
        cos = max(0.2, abs(math.cos(math.radians(lat))))
        return math.hypot(dlat, (p.lon - lon) * 111.32 * cos)

    deduped.sort(key=dist_km)
    if download:
        kept: list[ReferencePhoto] = []
        for p in deduped:
            path = os.path.join(cache_dir, f"{p.source}_{p.id.replace('/', '_')}.jpg")
            if os.path.exists(path) and os.path.getsize(path) > 512:
                p.local_path = path
                kept.append(p)
                continue
            if _download(p.thumb_url, path) or _download(p.photo_url, path):
                p.local_path = path
                kept.append(p)
        return kept
    return deduped


def main() -> None:
    ap = argparse.ArgumentParser(description="Keyless reference-photo fetch (Panoramax + KartaView)")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--radius-km", type=float, default=0.4)
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--cache", default="/tmp/geolocate_refs")
    ap.add_argument("--out", help="write JSON manifest here")
    ap.add_argument("--no-download", action="store_true")
    a = ap.parse_args()
    photos = fetch_reference_photos(a.lat, a.lon, a.radius_km, a.cache, a.limit,
                                    download=not a.no_download)
    by_src: dict[str, int] = {}
    for p in photos:
        by_src[p.source] = by_src.get(p.source, 0) + 1
    print(f"fetched {len(photos)} reference photos "
          f"({', '.join(f'{k}:{v}' for k, v in by_src.items()) or 'none'}) "
          f"within {a.radius_km} km of ({a.lat},{a.lon})")
    if a.out:
        with open(a.out, "w") as f:
            json.dump([asdict(p) for p in photos], f, indent=2)
        print(f"manifest -> {a.out}")


if __name__ == "__main__":
    main()
