"""GET /tiles/basemap/{z}/{x}/{y}.png — basemap tile proxy.

Default basemap is Carto's free Dark Matter (English labels, dark substrate,
no API key for low-volume usage). The proxy:
- Hides any provider from the browser's network panel.
- Caches with a long TTL because basemap tiles are static.
- Lets us switch providers in one place if Carto deprecates the path.

License: Carto Dark Matter is © OpenStreetMap contributors + © CARTO,
free under their attribution terms (no key required for non-commercial /
limited usage).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from app.upstream import get_client

router = APIRouter(tags=["tiles"])

# Carto's basemap CDN. `dark_all` = dark with English labels everywhere.
CARTO_HOSTS = [
    "https://a.basemaps.cartocdn.com",
    "https://b.basemaps.cartocdn.com",
    "https://c.basemaps.cartocdn.com",
    "https://d.basemaps.cartocdn.com",
]


@router.get("/tiles/basemap/{z}/{x}/{y}.png")
async def basemap_tile(z: int, x: int, y: int) -> Response:
    if not (0 <= z <= 22):
        raise HTTPException(400, "z out of range")
    # round-robin shard for parallelism
    host = CARTO_HOSTS[(x + y) % len(CARTO_HOSTS)]
    url = f"{host}/dark_all/{z}/{x}/{y}@2x.png"
    r = await get_client().get(url)
    if r.status_code != 200:
        raise HTTPException(502, f"basemap upstream {r.status_code}")
    return Response(
        content=r.content,
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=86400",
            "X-Basemap": "carto-dark-matter",
        },
    )
