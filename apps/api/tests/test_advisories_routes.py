"""GET /api/advisories — keyless country-level travel advisories (task B1a)."""

from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import upstream
from app.routes import advisories as adv_route

# The advisories router isn't wired into app.main yet (merge-owner task, see
# this branch's B1a MERGE SPEC), so — unlike the other route test modules —
# this file builds its own minimal app instead of using the shared `client`
# fixture from conftest.py (which only sees routers `create_app()` includes).


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(adv_route.router)
    with TestClient(app) as c:
        yield c

US_XML = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item>
  <title>Bhutan - Level 1: Exercise Normal Precautions</title>
  <link>https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories/bhutan-travel-advisory.html</link>
  <pubDate>Tue, 21 Jul 2026 03:42:04 GMT</pubDate>
</item>
<item>
  <title>Mali - Level 4: Do Not Travel</title>
  <link>https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories/mali-travel-advisory.html</link>
  <pubDate>Tue, 21 Jul 2026 03:42:04 GMT</pubDate>
</item>
</channel></rss>
"""

UK_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
<updated>2026-07-21T10:00:09+01:00</updated>
<entry>
  <id>https://www.gov.uk/foreign-travel-advice/libya</id>
  <updated>2026-07-21T10:00:09+01:00</updated>
  <link rel="alternate" type="text/html" href="https://www.gov.uk/foreign-travel-advice/libya"/>
  <title>Libya</title>
  <summary type="xhtml">
    <div xmlns="http://www.w3.org/1999/xhtml">
      <p>FCDO advises against all travel to Libya.</p>
    </div>
  </summary>
</entry>
<entry>
  <id>https://www.gov.uk/foreign-travel-advice/france</id>
  <updated>2026-07-20T09:58:23+01:00</updated>
  <link rel="alternate" type="text/html" href="https://www.gov.uk/foreign-travel-advice/france"/>
  <title>France</title>
  <summary type="xhtml">
    <div xmlns="http://www.w3.org/1999/xhtml">
      <p>This travel advice was reviewed for accuracy and there are no significant updates.</p>
    </div>
  </summary>
</entry>
<entry>
  <id>https://www.gov.uk/foreign-travel-advice/mexico</id>
  <updated>2026-07-19T09:58:23+01:00</updated>
  <link rel="alternate" type="text/html" href="https://www.gov.uk/foreign-travel-advice/mexico"/>
  <title>Mexico</title>
  <summary type="xhtml">
    <div xmlns="http://www.w3.org/1999/xhtml">
      <p>FCDO advise against all but essential travel to the border regions of Mexico.</p>
    </div>
  </summary>
</entry>
</feed>
"""

AU_XML = """<?xml version="1.0"?>
<rss xmlns:ta="http://www.smartraveller.gov.au/schema/rss/travel_advisories/" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
<channel>
<item>
  <title>Iran</title>
  <link>https://www.smartraveller.gov.au/destinations/middle-east/iran</link>
  <pubDate>21 Jul 2026 22:00:00 AEST</pubDate>
  <ta:warnings>
    <dc:coverage>Iran</dc:coverage>
    <ta:level>5/5</ta:level>
    <dc:description>Do not travel</dc:description>
  </ta:warnings>
</item>
<item>
  <title>Japan</title>
  <link>https://www.smartraveller.gov.au/destinations/asia/japan</link>
  <pubDate>21 Jul 2026 22:00:00 AEST</pubDate>
  <ta:warnings>
    <dc:coverage>Japan</dc:coverage>
    <ta:level>2/5</ta:level>
    <dc:description>Exercise normal safety precautions</dc:description>
  </ta:warnings>
</item>
</channel></rss>
"""


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


def _patch_by_url(mapping: dict[str, str]):
    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        for needle, body in mapping.items():
            if needle in url:
                return httpx.Response(200, text=body, request=httpx.Request("GET", url))
        return httpx.Response(404, text="not found", request=httpx.Request("GET", url))

    return patch.object(httpx.AsyncClient, "get", new=fake_get)


_ALL_OK = {
    "travel.state.gov": US_XML,
    "gov.uk": UK_XML,
    "smartraveller": AU_XML,
}


def test_advisories_merges_all_sources(client: TestClient) -> None:
    with _patch_by_url(_ALL_OK):
        r = client.get("/api/advisories")
    assert r.status_code == 200
    body = r.json()
    assert body["unavailable"] is False
    assert set(body["sources"]) == {"us-state", "uk-fcdo", "au-smartraveller"}
    by_source = {}
    for it in body["items"]:
        by_source.setdefault(it["source"], []).append(it)
    assert len(by_source["us-state"]) == 2
    assert len(by_source["uk-fcdo"]) == 3
    assert len(by_source["au-smartraveller"]) == 2


def test_us_state_level_parsed_from_title(client: TestClient) -> None:
    with _patch_by_url(_ALL_OK):
        r = client.get("/api/advisories")
    items = [it for it in r.json()["items"] if it["source"] == "us-state"]
    bhutan = next(it for it in items if it["country"] == "Bhutan")
    mali = next(it for it in items if it["country"] == "Mali")
    assert bhutan["level"] == 1
    assert mali["level"] == 4
    assert bhutan["iso3"] == "BTN"
    assert mali["iso3"] == "MLI"


def test_uk_fcdo_level_normalised_from_phrasing(client: TestClient) -> None:
    with _patch_by_url(_ALL_OK):
        r = client.get("/api/advisories")
    items = [it for it in r.json()["items"] if it["source"] == "uk-fcdo"]
    libya = next(it for it in items if it["country"] == "Libya")
    france = next(it for it in items if it["country"] == "France")
    mexico = next(it for it in items if it["country"] == "Mexico")
    assert libya["level"] == 4  # advise against ALL travel, no partial qualifier
    assert france["level"] == 2  # no "advise against" language at all
    assert mexico["level"] == 3  # "advise against ... the border regions" = partial
    assert libya["iso3"] == "LBY"


def test_au_smartraveller_level_from_description(client: TestClient) -> None:
    with _patch_by_url(_ALL_OK):
        r = client.get("/api/advisories")
    items = [it for it in r.json()["items"] if it["source"] == "au-smartraveller"]
    iran = next(it for it in items if it["country"] == "Iran")
    japan = next(it for it in items if it["country"] == "Japan")
    assert iran["level"] == 4
    assert japan["level"] == 1
    assert iran["iso3"] == "IRN"


def test_iso3_null_when_unmapped(client: TestClient) -> None:
    bogus_us = US_XML.replace("Bhutan", "Not A Real Country")
    with _patch_by_url({**_ALL_OK, "travel.state.gov": bogus_us}):
        r = client.get("/api/advisories")
    items = [it for it in r.json()["items"] if it["source"] == "us-state"]
    row = next(it for it in items if it["country"] == "Not A Real Country")
    assert row["iso3"] is None


def test_one_source_down_degrades_gracefully(client: TestClient) -> None:
    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        if "gov.uk" in url:
            return httpx.Response(503, text="down", request=httpx.Request("GET", url))
        for needle, body in _ALL_OK.items():
            if needle in url:
                return httpx.Response(200, text=body, request=httpx.Request("GET", url))
        return httpx.Response(404, request=httpx.Request("GET", url))

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/advisories")
    assert r.status_code == 200
    body = r.json()
    assert body["unavailable"] is False
    sources_present = {it["source"] for it in body["items"]}
    assert sources_present == {"us-state", "au-smartraveller"}


def test_all_sources_down_is_unavailable(client: TestClient) -> None:
    async def bad(self: object, url: str, **_: object) -> httpx.Response:
        return httpx.Response(503, text="down", request=httpx.Request("GET", url))

    with patch.object(httpx.AsyncClient, "get", new=bad):
        r = client.get("/api/advisories")
    assert r.status_code == 200
    body = r.json()
    assert body["unavailable"] is True
    assert body["items"] == []


@pytest.mark.asyncio
async def test_advisories_summary_max_level_per_iso3() -> None:
    with _patch_by_url(_ALL_OK):
        summary = await adv_route.advisories_summary()
    assert summary["MLI"] == 4
    assert summary["BTN"] == 1
    assert "iso3" not in summary  # sanity: keys are iso3 codes, not the literal field name
