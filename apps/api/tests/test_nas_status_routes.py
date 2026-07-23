"""GET /api/airspace/nas-status — FAA ground stop/delay/closure feed (task B1c)."""

from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import upstream
from app.routes import nas_status

# nas_status.router is not yet wired into app.main (that's the merge owner's
# job, see MERGE SPEC) — mount it standalone so this file can verify the
# route's behavior without touching main.py.


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(nas_status.router)
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


def _patch_text(body: str):
    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return httpx.Response(200, text=body, request=httpx.Request("GET", "https://x"))

    return patch.object(httpx.AsyncClient, "get", new=fake_get)


POPULATED_XML = """<AIRPORT_STATUS_INFORMATION>
<Update_Time>Tue Jul 21 14:06:15 2026 GMT</Update_Time>
<Delay_type><Name>Ground Stop Programs</Name>
<Ground_Stop_List>
<Program><ARPT>JFK</ARPT><Reason>thunderstorms</Reason><End_Time>11:00 am EDT</End_Time></Program>
<Program><ARPT>ZZZ</ARPT><Reason>unknown</Reason><End_Time>noon</End_Time></Program>
</Ground_Stop_List>
</Delay_type>
<Delay_type><Name>Ground Delay Programs</Name>
<Ground_Delay_List>
<Ground_Delay><ARPT>SFO</ARPT><Reason>other</Reason><Avg>37 minutes</Avg><Max>1 hour and 32 minutes</Max></Ground_Delay>
</Ground_Delay_List>
</Delay_type>
<Delay_type><Name>General Arrival/Departure Delay Info</Name>
<Arrival_Departure_Delay_List>
<Delay><ARPT>JFK</ARPT><Reason>TM Initiatives:SWAP:WX</Reason>
<Arrival_Departure Type="Departure"><Min>46 minutes</Min><Max>1 hour</Max><Trend>Increasing</Trend></Arrival_Departure>
</Delay>
</Arrival_Departure_Delay_List>
</Delay_type>
<Delay_type><Name>Airport Closures</Name>
<Airport_Closure_List>
<Airport><ARPT>SFO</ARPT><Reason>!SFO 07/028 AD AP CLSD</Reason><Start>Jul 07 at 04:30 UTC.</Start><Reopen>Aug 15 at 09:45 UTC.</Reopen></Airport>
</Airport_Closure_List>
</Delay_type>
</AIRPORT_STATUS_INFORMATION>"""

EMPTY_XML = """<AIRPORT_STATUS_INFORMATION>
<Update_Time>Tue Jul 21 14:06:15 2026 GMT</Update_Time>
</AIRPORT_STATUS_INFORMATION>"""


def test_populated_feed_normalises_all_delay_types(client: TestClient) -> None:
    with _patch_text(POPULATED_XML):
        r = client.get("/api/airspace/nas-status")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert body["skipped"] == 1  # ZZZ unknown airport

    by_id = {f["id"]: f for f in body["features"]}

    gs = by_id["groundstop:JFK:ground_stop"]
    assert gs["properties"]["kind"] == "groundstop"
    assert gs["properties"]["airport"] == "JFK"
    assert gs["properties"]["type"] == "ground_stop"
    assert gs["properties"]["reason"] == "thunderstorms"
    assert gs["properties"]["until"] == "11:00 am EDT"
    assert gs["geometry"]["type"] == "Point"
    assert gs["geometry"]["coordinates"] == [-73.779317, 40.639447]

    gd = by_id["groundstop:SFO:ground_delay"]
    assert gd["properties"]["type"] == "ground_delay"
    assert gd["properties"]["avg_delay"] == "37 minutes"

    ad = by_id["groundstop:JFK:arrival_departure_delay"]
    assert ad["properties"]["type"] == "arrival_departure_delay"
    assert ad["properties"]["direction"] == "departure"
    assert ad["properties"]["min_delay"] == "46 minutes"

    cl = by_id["groundstop:SFO:closure"]
    assert cl["properties"]["type"] == "closure"
    assert cl["properties"]["until"] == "Aug 15 at 09:45 UTC."

    assert "groundstop:ZZZ:ground_stop" not in by_id


def test_empty_feed_returns_no_features(client: TestClient) -> None:
    with _patch_text(EMPTY_XML):
        r = client.get("/api/airspace/nas-status")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert body["features"] == []
    assert body["skipped"] == 0


def test_malformed_xml_is_502(client: TestClient) -> None:
    with _patch_text("<not><valid xml"):
        r = client.get("/api/airspace/nas-status")
    assert r.status_code == 502


def test_bad_upstream_status_is_502(client: TestClient) -> None:
    async def bad(self: object, url: str, **_: object) -> httpx.Response:
        return httpx.Response(503, text="down", request=httpx.Request("GET", "https://x"))

    with patch.object(httpx.AsyncClient, "get", new=bad):
        r = client.get("/api/airspace/nas-status")
    assert r.status_code == 502
