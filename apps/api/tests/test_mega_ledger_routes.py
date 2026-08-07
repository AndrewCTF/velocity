"""Every route of the 2026-08-06 mega-ledger wave is mounted, and the two
viewport feeds answer an empty collection rather than a 422 when the camera is
too high to send a bbox.

The frontend side of this contract lives in
``apps/web/src/osint/SourcesPanel.test.ts``: each path below is either a
registered map layer or a row in the Sources panel. Renaming a path here without
renaming it there is exactly the drift these two guards exist to catch.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

WAVE_PATHS = [
    # civil defense
    "/api/alerts/ukraine",
    "/api/alerts/ukraine-alt",
    "/api/alerts/meteoalarm",
    "/api/alerts/fema",
    "/api/alerts/spc-storms",
    # DeepState
    "/api/conflict/deepstate-firms",
    "/api/conflict/deepstate-radiation",
    "/api/conflict/deepstate-news",
    # SatNOGS / SondeHub
    "/api/space/satnogs/observations",
    "/api/space/satnogs/transmitters",
    "/api/space/satnogs/stations",
    "/api/space/sondes",
    # extended feeds
    "/api/cyber/kev",
    "/api/infra/mines",
    "/api/osm/military",
    "/api/osm/wikimapia",
    "/api/legal/gleif",
    "/api/legal/courtlistener",
    "/api/displacement/unhcr",
    "/api/population/worldpop",
    "/api/humanitarian/hdx",
    "/api/adsb/fr24/search",
    "/api/cyber/shodan/{ip}",
    "/api/cams/insecam",
    "/api/news/telegram",
    "/api/events/gdelt-doc",
    "/api/events/gdelt-summary",
    "/api/imagery/wayback",
    "/api/buildings/microsoft",
    "/api/buildings/overture",
    "/api/space/tinygs",
    "/api/jamming/gpsjam-manifest",
    # source catalog
    "/api/sources/catalog",
    "/api/sdr/kiwisdr",
    "/api/splats/search",
    "/api/splats/huggingface",
    # ADS-B v2 lookups
    "/api/adsb/hex/{icao}",
    "/api/adsb/registration/{reg}",
    "/api/adsb/callsign/{cs}",
    "/api/adsb/type/{type_code}",
    "/api/adsb/ladd",
    "/api/adsb/pia",
    "/api/adsb/history/dates",
    "/api/aviation/airports/full",
    "/api/aviation/airports/openflights",
    "/api/aviation/routes",
]


def test_every_wave_route_is_mounted() -> None:
    # Read the OpenAPI schema rather than walking `app.routes`: FastAPI keeps an
    # included router as one opaque `_IncludedRouter` entry, so the route list
    # shows 8 paths for an app that serves hundreds.
    app = create_app()
    mounted = set(app.openapi().get("paths", {}))
    missing = [p for p in WAVE_PATHS if p not in mounted]
    assert missing == [], f"routes declared by the wave but not mounted: {missing}"


@pytest.mark.parametrize("path", ["/api/osm/military", "/api/osm/wikimapia"])
def test_viewport_feeds_answer_empty_without_a_bbox(path: str) -> None:
    """Above the LOD altitude the map sends no bbox at all. These upstreams need
    one, so the route has to answer an empty FeatureCollection — a 422 would put
    a red error on a layer that is simply zoomed out."""
    app = create_app()
    with TestClient(app) as c:
        r = c.get(path)
        assert r.status_code == 200
        body = r.json()
        assert body["type"] == "FeatureCollection"
        assert body["features"] == []
