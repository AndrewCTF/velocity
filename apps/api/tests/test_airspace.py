"""Pure-function + route-shape tests for app.routes.airspace.

No live network. GRC/CIR parsing is tested against a real FAA XNOTAM detail
fixture (tests/fixtures/tfr_detail_6_4909.xml — Pell City, AL UAS TFR,
FDC 6/4909, fetched live 2026-07-11). The route-shape test builds a standalone
FastAPI app around just this router with the upstream calls monkeypatched, so
it never depends on app.main registering the router.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes import airspace

FIXTURE_XML = (Path(__file__).parent / "fixtures" / "tfr_detail_6_4909.xml").read_bytes()


# ── pure parsing: parse_tfr_detail on the real fixture ──────────────────────


def test_parse_tfr_detail_real_fixture_shape():
    shapes = airspace.parse_tfr_detail(FIXTURE_XML)
    assert len(shapes) == 1
    shape = shapes[0]
    assert len(shape["ring"]) == 37
    # closed ring
    assert shape["ring"][0] == shape["ring"][-1]


def test_parse_tfr_detail_real_vertices_decimal_degrees():
    shapes = airspace.parse_tfr_detail(FIXTURE_XML)
    ring = shapes[0]["ring"]
    # FAA XNOTAM geoLat/geoLong in this feed are plain decimal degrees with a
    # trailing hemisphere letter — verified against live tfr.faa.gov XML.
    # vertex 0: geoLat 33.50390442N, geoLong 086.17944444W
    lon0, lat0 = ring[0]
    assert lat0 == pytest.approx(33.50390442, abs=1e-6)
    assert lon0 == pytest.approx(-86.17944444, abs=1e-6)
    # vertex 1: geoLat 33.50377757N, geoLong 086.17771391W
    lon1, lat1 = ring[1]
    assert lat1 == pytest.approx(33.50377757, abs=1e-6)
    assert lon1 == pytest.approx(-86.17771391, abs=1e-6)
    # vertex 2: geoLat 33.50340087N, geoLong 086.17603598W
    lon2, lat2 = ring[2]
    assert lat2 == pytest.approx(33.50340087, abs=1e-6)
    assert lon2 == pytest.approx(-86.17603598, abs=1e-6)


def test_parse_tfr_detail_altitude_fields():
    shapes = airspace.parse_tfr_detail(FIXTURE_XML)
    shape = shapes[0]
    assert shape["alt_low"] == 0.0
    assert shape["alt_low_uom"] == "FT"
    assert shape["alt_low_code"] == "HEI"
    assert shape["alt_high"] == 400.0
    assert shape["alt_high_uom"] == "FT"
    assert shape["alt_high_code"] == "HEI"
    assert shape["effective"] == "2026-07-11T12:00:00"
    assert shape["expire"] == "2026-07-16T23:59:00"


def test_parse_tfr_detail_malformed_xml_returns_empty():
    assert airspace.parse_tfr_detail(b"<not><valid") == []
    assert airspace.parse_tfr_detail(b"") == []
    assert airspace.parse_tfr_detail(b"<Group></Group>") == []


# ── pure parsing: _parse_geo ─────────────────────────────────────────────────


def test_parse_geo_decimal_with_hemisphere():
    assert airspace._parse_geo("33.50390442N") == pytest.approx(33.50390442)
    assert airspace._parse_geo("086.17944444W") == pytest.approx(-86.17944444)
    assert airspace._parse_geo("111.65W") == pytest.approx(-111.65)
    assert airspace._parse_geo("40.51672387N") == pytest.approx(40.51672387)


def test_parse_geo_rejects_junk():
    with pytest.raises(ValueError):
        airspace._parse_geo("garbage")
    with pytest.raises(ValueError):
        airspace._parse_geo("")
    with pytest.raises(ValueError):
        airspace._parse_geo("12.5")  # no hemisphere letter


# ── pure parsing: CIR tessellation (from the fixture's raw circle def) ──────


def test_tessellate_circle_produces_64_point_closed_ring():
    ring = airspace.tessellate_circle(-86.17944444, 33.49555556, 0.5)
    assert len(ring) == 65  # 64 distinct points + closing point
    assert ring[0] == ring[-1]
    # every point should be roughly 0.5 NM (926 m) from center
    center_lon, center_lat = -86.17944444, 33.49555556
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(center_lat))
    for lon, lat in ring[:-1]:
        dx = (lon - center_lon) * m_per_deg_lon
        dy = (lat - center_lat) * m_per_deg_lat
        dist_m = math.hypot(dx, dy)
        assert dist_m == pytest.approx(0.5 * 1852.0, rel=0.02)


def test_parse_cir_from_real_fixture_element():
    import xml.etree.ElementTree as ET

    root = ET.fromstring(FIXTURE_XML)
    cir_avx = None
    for shp in root.iter("aseShapes"):
        for avx in shp.iter("Avx"):
            if (avx.findtext("codeType") or "").upper() == "CIR":
                cir_avx = avx
                break
    assert cir_avx is not None
    ring = airspace.parse_cir(cir_avx)
    assert ring is not None
    assert len(ring) == 65
    assert ring[0] == ring[-1]


def test_parse_cir_missing_radius_returns_none():
    import xml.etree.ElementTree as ET

    el = ET.fromstring(
        "<Avx><codeType>CIR</codeType><geoLat>33N</geoLat><geoLong>086W</geoLong></Avx>"
    )
    assert airspace.parse_cir(el) is None


# ── pure parsing: parse_grc_chain ────────────────────────────────────────────


def test_parse_grc_chain_closes_open_ring():
    import xml.etree.ElementTree as ET

    avxs = [
        ET.fromstring("<Avx><geoLat>10N</geoLat><geoLong>020W</geoLong></Avx>"),
        ET.fromstring("<Avx><geoLat>11N</geoLat><geoLong>021W</geoLong></Avx>"),
        ET.fromstring("<Avx><geoLat>12N</geoLat><geoLong>022W</geoLong></Avx>"),
    ]
    ring = airspace.parse_grc_chain(avxs)
    assert len(ring) == 4
    assert ring[0] == ring[-1]


def test_parse_grc_chain_skips_bad_vertices():
    import xml.etree.ElementTree as ET

    avxs = [
        ET.fromstring("<Avx><geoLat>10N</geoLat><geoLong>020W</geoLong></Avx>"),
        ET.fromstring("<Avx><geoLat>garbage</geoLat><geoLong>021W</geoLong></Avx>"),
        ET.fromstring("<Avx><geoLat>12N</geoLat><geoLong>022W</geoLong></Avx>"),
    ]
    ring = airspace.parse_grc_chain(avxs)
    assert len(ring) == 3  # bad vertex dropped, ring closed with 2 good + close


# ── route shape: standalone app around just this router ─────────────────────


def _make_app(monkeypatch, list_payload, detail_bytes_by_id):
    app = FastAPI()
    app.include_router(airspace.router)

    async def fake_list_tfrs():
        return list_payload

    async def fake_fetch_detail_bytes(notam_id):
        return detail_bytes_by_id.get(notam_id)

    monkeypatch.setattr(airspace, "list_tfrs", fake_list_tfrs)
    monkeypatch.setattr(airspace, "_fetch_detail_bytes", fake_fetch_detail_bytes)
    return app


def test_route_returns_feature_collection(monkeypatch):
    airspace.cache.invalidate("airspace:tfr:features")
    list_payload = [
        {
            "notam_id": "6/4909",
            "type": "SECURITY",
            "facility": "ZTL",
            "state": "AL",
            "description": "Pell City, AL",
            "creation_date": "07/11/2026",
        }
    ]
    app = _make_app(monkeypatch, list_payload, {"6/4909": FIXTURE_XML})
    client = TestClient(app)
    r = client.get("/api/airspace/tfr")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) == 1
    feat = body["features"][0]
    assert feat["geometry"]["type"] == "Polygon"
    props = feat["properties"]
    assert props["notam_id"] == "6/4909"
    assert props["type"] == "SECURITY"
    assert props["facility"] == "ZTL"
    assert props["state"] == "AL"
    assert props["alt_high"] == 400.0


def test_route_skips_failed_detail_fetch(monkeypatch):
    airspace.cache.invalidate("airspace:tfr:features")
    list_payload = [
        {"notam_id": "6/4909", "type": "SECURITY", "facility": "ZTL", "state": "AL"},
        {"notam_id": "9/9999", "type": "HAZARDS", "facility": "ZLA", "state": "CA"},
    ]
    # 9/9999 has no detail bytes available (simulates a fetch failure) —
    # route must still return the TFR that succeeded.
    app = _make_app(monkeypatch, list_payload, {"6/4909": FIXTURE_XML})
    client = TestClient(app)
    r = client.get("/api/airspace/tfr")
    assert r.status_code == 200
    body = r.json()
    assert len(body["features"]) == 1
    assert body["features"][0]["properties"]["notam_id"] == "6/4909"
