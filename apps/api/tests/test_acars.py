"""ACARS normalize() tests — the airframes.io message shape (no network)."""

from __future__ import annotations

from app import acars


def test_normalize_flattens_nested_flight_and_station():
    m = {
        "id": 6975599093,
        "timestamp": "2026-06-25T13:16:37.939Z",
        "label": "H1",
        "text": "  POS REPORT  ",
        "tail": "N703AL",
        "flight": {"flight": "AS519", "flightIata": "AS519", "flightIcao": None},
        "latitude": 47.5, "longitude": -122.3,
        "frequency": 131.725,
        "mode": "vdl",
        "station": {"id": 1, "ident": "PhillyRox-ACARS"},
    }
    n = acars.normalize(m)
    assert n["tail"] == "N703AL"
    assert n["flight"] == "AS519"
    assert n["station"] == "PhillyRox-ACARS"
    assert n["lat"] == 47.5 and n["lon"] == -122.3
    assert n["text"] == "POS REPORT"        # trimmed
    assert n["mode"] == "vdl"


def test_to_geojson_keeps_only_positioned_messages():
    msgs = [
        {"id": 1, "lat": 47.5, "lon": -122.3, "tail": "N1", "flight": "AS1", "mode": "vdl"},
        {"id": 2, "lat": None, "lon": None, "tail": "N2"},          # no position → dropped
        {"id": 3, "lat": 26.6, "lon": 56.6, "tail": "N3", "label": "H1"},
    ]
    fc = acars.to_geojson(msgs)
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 2
    f0 = fc["features"][0]
    assert f0["geometry"]["coordinates"] == [-122.3, 47.5, 0]
    assert f0["properties"]["id"] == "acars:1"
    assert f0["properties"]["kind"] == "acars"
    assert {f["properties"]["tail"] for f in fc["features"]} == {"N1", "N3"}


def test_normalize_handles_missing_and_string_flight():
    n = acars.normalize({"id": 1, "flight": "BA117", "text": "  ", "station": "raw-ident"})
    assert n["flight"] == "BA117"
    assert n["station"] == "raw-ident"
    assert n["text"] is None                 # blank → None
    assert n["lat"] is None and n["tail"] is None
