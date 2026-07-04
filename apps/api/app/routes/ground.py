"""GET /api/ground/nearby — Panoramax + KartaView union (keyless, open).
GET /api/ground/photo/{source}/{id} — image proxy (CORS + politeness).

Why a proxy (same reasoning as /api/cams/{id}/snapshot):
1. CORS — both image hosts send no ACAO, so a webview canvas can't read pixels
   directly (which the desktop-side detection needs).
2. Politeness — a per-photo 60 s cache caps upstream fetches regardless of viewers.
3. SSRF — the URL table is populated ONLY by nearby()'s catalog fetch; the browser
   can never make this proxy fetch an arbitrary URL.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response

from app.intel import ground as ground_lib
from app.upstream import cache, get_client

router = APIRouter(tags=["ground"])

_NEARBY_TTL = 3600.0
_PHOTO_TTL = 60.0
_BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)


@router.get("/api/ground/nearby")
async def ground_nearby(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_km: float = Query(2.0, ge=0.1, le=50),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        res = await ground_lib.nearby(lat, lon, radius_km)
        features = [
            {
                "type": "Feature",
                "id": f"ground:{p.source}:{p.id}",
                "geometry": {"type": "Point", "coordinates": [p.lon, p.lat, 0]},
                "properties": {
                    "kind": "ground_photo",
                    "source": p.source,
                    "photo_id": p.id,
                    "name": f"{p.source} {p.id[:12]}",
                    "heading": p.heading,
                    "captured_at": p.captured_at,
                    "thumb_url": f"/api/ground/photo/{p.source}/{p.id}?size=thumb",
                    "photo_url": f"/api/ground/photo/{p.source}/{p.id}?size=hd",
                },
            }
            for p in res.photos
        ]
        fc: dict[str, Any] = {"type": "FeatureCollection", "features": features}
        if res.note:
            fc["note"] = res.note
        return fc

    key = f"ground:nearby:{lat:.4f}:{lon:.4f}:{radius_km:.2f}"
    return await cache.get_or_fetch(key, _NEARBY_TTL, load)


@router.get("/api/ground/photo/{source}/{photo_id}")
async def ground_photo(source: str, photo_id: str, size: str = Query("hd", pattern="^(hd|thumb)$")) -> Response:
    url = ground_lib.proxy_url(source, photo_id, size)
    if not url:
        raise HTTPException(404, "photo not in catalog — run /api/ground/nearby first")

    async def load() -> bytes:
        r = await get_client().get(url, headers={"User-Agent": _BROWSER_UA})
        if r.status_code != 200:
            raise HTTPException(502, f"ground upstream {r.status_code}")
        ctype = r.headers.get("content-type", "image/jpeg")
        # Stash the content type on the loader via a closure attr so the route can
        # return it (httpx already validated a non-empty body here).
        load.ctype = ctype  # type: ignore[attr-defined]
        return r.content

    data = await cache.get_or_fetch(f"ground:photo:{source}:{photo_id}:{size}", _PHOTO_TTL, load)
    ctype = getattr(load, "ctype", "image/jpeg")
    return Response(
        content=data,
        media_type=ctype if ctype.startswith("image/") else "image/jpeg",
        headers={"Cache-Control": "public, max-age=60"},
    )
