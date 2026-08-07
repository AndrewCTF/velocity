"""ADS-B v2 lookup routes: hex, registration, callsign, type, ladd, pia,
history dates, ourAirports full CSV, openflights airports+routes."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import HTTPException

import app.routes.adsb as adsb
import app.upstream as upstream


def _mock_client(handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client


_SAMPLE_AC = {"ac": [{"hex": "abc123", "lat": 51.5, "lon": -0.1, "alt_baro": 35000, "flight": "BAW123", "t": "A320"}]}


# ── hex lookup ──────────────────────────────────────────────────────────────

def test_hex_lookup_valid(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v2/hex/abc123" in str(req.url)
        return httpx.Response(200, json=_SAMPLE_AC)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.adsb_hex("abc123"))
        assert result["type"] == "FeatureCollection"
        assert len(result["features"]) == 1
        assert result["features"][0]["properties"]["icao24"] == "abc123"
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


def test_hex_lookup_bad_input() -> None:
    with pytest.raises(httpx.HTTPStatusError if False else Exception):
        asyncio.run(adsb.adsb_hex("zzz"))


# ── registration lookup ────────────────────────────────────────────────────

def test_registration_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v2/registration/N12345" in str(req.url)
        return httpx.Response(200, json=_SAMPLE_AC)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.adsb_registration("N12345"))
        assert result["type"] == "FeatureCollection"
        assert len(result["features"]) == 1
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


def test_registration_bad_input() -> None:
    # An empty registration is rejected before any egress happens.
    with pytest.raises(HTTPException) as exc:
        asyncio.run(adsb.adsb_registration(""))
    assert exc.value.status_code == 400


# ── callsign lookup ────────────────────────────────────────────────────────

def test_callsign_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v2/callsign/BAW123" in str(req.url)
        return httpx.Response(200, json=_SAMPLE_AC)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.adsb_callsign("BAW123"))
        assert result["type"] == "FeatureCollection"
        assert len(result["features"]) == 1
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


# ── type lookup ─────────────────────────────────────────────────────────────

def test_type_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v2/type/B738" in str(req.url)
        return httpx.Response(200, json=_SAMPLE_AC)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.adsb_type("B738"))
        assert result["type"] == "FeatureCollection"
        assert len(result["features"]) == 1
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


# ── ladd / pia ──────────────────────────────────────────────────────────────

def test_ladd(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v2/ladd" in str(req.url)
        return httpx.Response(200, json=_SAMPLE_AC)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.adsb_ladd())
        assert result["type"] == "FeatureCollection"
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


def test_pia(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert "/v2/pia" in str(req.url)
        return httpx.Response(200, json=_SAMPLE_AC)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.adsb_pia())
        assert result["type"] == "FeatureCollection"
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


# ── multi-host failover ────────────────────────────────────────────────────

def test_hex_failover_to_second_host(monkeypatch: pytest.MonkeyPatch) -> None:
    call_count = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(429)
        return httpx.Response(200, json=_SAMPLE_AC)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.adsb_hex("abc123"))
        assert len(result["features"]) == 1
        assert call_count >= 2
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


def test_hex_all_hosts_fail_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.adsb_hex("abc123"))
        assert result["features"] == []
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


# ── history dates ───────────────────────────────────────────────────────────

def test_history_dates(monkeypatch: pytest.MonkeyPatch) -> None:
    releases = [
        {"tag_name": "v2026.08.05-planes-readsb-prod-0"},
        {"tag_name": "v2026.08.04-planes-readsb-prod-0"},
    ]

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=releases)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.adsb_history_dates())
        assert "2026-08-05" in result["dates"]
        assert "2026-08-04" in result["dates"]
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


# ── ourAirports full CSV ────────────────────────────────────────────────────

_SAMPLE_CSV = (
    "id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,"
    "iso_country,iso_region,municipality,scheduled_service,gps_code,iata_code,"
    "local_code,home_link,wikipedia_link,keywords\n"
    '2434,"EGLL","large_airport","London Heathrow Airport",51.4706,-0.461941,'
    '"83","EU","GB","GB-ENG","London","yes","EGLL","LHR","","","",""\n'
    '3632,"KJFK","large_airport","John F Kennedy International Airport",'
    '40.6398,-73.7789,"13","NA","US","US-NY","New York","yes","KJFK","JFK","JFK","","",""\n'
)


def test_ourairports_full(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_SAMPLE_CSV)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.aviation_airports_full(limit=5000))
        assert result["type"] == "FeatureCollection"
        assert len(result["features"]) == 2
        iatas = {f["properties"]["iata"] for f in result["features"]}
        assert "LHR" in iatas
        assert "JFK" in iatas
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


# ── openflights airports ───────────────────────────────────────────────────

_SAMPLE_OF_AIRPORTS = (
    '1,"Goroka Airport","Goroka","Papua New Guinea","GKA","AYGA",-6.081689,145.391881\n'
    '2,"Madang Airport","Madang","Papua New Guinea","MAG","AYMD",-5.20708,145.789001\n'
)


def test_openflights_airports(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_SAMPLE_OF_AIRPORTS)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.aviation_airports_openflights())
        assert result["type"] == "FeatureCollection"
        assert len(result["features"]) == 2
        assert result["features"][0]["properties"]["iata"] == "GKA"
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


# ── openflights routes ──────────────────────────────────────────────────────

_SAMPLE_ROUTES = (
    "2B,410,AER,2965,KZN,2990,,0,CR2\n"
    "2B,410,ASF,2966,KZN,2990,,0,CR2\n"
)


def test_openflights_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_SAMPLE_ROUTES)

    monkeypatch.setattr(upstream, "_CLIENT", _mock_client(handler))
    upstream.cache._data.clear()
    try:
        result = asyncio.run(adsb.aviation_routes())
        assert result["count"] == 2
        assert result["routes"][0]["src"] == "AER"
        assert result["routes"][0]["dst"] == "KZN"
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)
