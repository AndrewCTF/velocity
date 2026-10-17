"""Located SAR detection through the georeferenced CDSE path (no network)."""

from __future__ import annotations

import time

import pytest

from app.ais_pipeline import providers, sar
from app.ais_pipeline.store import VesselStore
from app.imagery import cdse
from app.intel import sar_vessels

BOX = (50.0, 25.0, 50.4, 25.4)
CENTER = (25.2, 50.2)  # lat, lon


class _Resp:
    status_code = 200

    @staticmethod
    def json():
        return {
            "features": [
                {
                    "id": "S1A_TEST",
                    "bbox": [49.0, 24.0, 51.0, 26.0],
                    "properties": {"datetime": "2026-10-03T00:00:00Z"},
                    "assets": {"vv": {"href": "s3://sentinel-s1-l1c/x/vv.tiff"}},
                }
            ]
        }


class _Client:
    async def post(self, url, **kw):
        return _Resp()


def _fix(mmsi, lat, lon):
    return providers.Fix(mmsi=mmsi, lat=lat, lon=lon, t=time.time(), source="test")


@pytest.fixture
def cdse_up(monkeypatch):
    """CDSE 'configured', one fake frame, one fake target at the frame centre."""
    calls = {"fetch": 0}

    async def fake_fetch(layer, bbox, w, h, date):
        calls["fetch"] += 1
        calls["size"] = (w, h)
        return b"frame"

    def fake_detect(img, k, max_area):
        w, h = calls["size"]
        return None, [
            {
                "row": h / 2.0,
                "col": w / 2.0,
                "area_px": 12,
                "peak": 250.0,
                "major_px": 5.0,
                "minor_px": 2.0,
                "heading_deg": 90.0,
            }
        ]

    monkeypatch.setattr(cdse, "available", lambda: True)
    monkeypatch.setattr(cdse, "fetch_image", fake_fetch)
    monkeypatch.setattr(sar_vessels, "_decode_and_detect", fake_detect)
    return calls


async def test_unavailable_returns_none_and_scan_keeps_inventory(monkeypatch):
    monkeypatch.setattr(cdse, "available", lambda: False)
    assert await sar.detect_located(VesselStore(), BOX) is None
    r = await sar.scan_aoi(_Client(), VesselStore(), BOX, detect=True)
    assert r["sceneCount"] == 1
    assert r["detections"] == [] and r["candidates"] == []
    assert "credentials" in r["note"]


async def test_oversized_box_errors_without_calling_cdse(cdse_up):
    big = (50.0, 25.0, 51.5, 25.4)
    out = await sar.detect_located(VesselStore(), big)
    assert out == {"error": "box too large for detection", "maxSpanDeg": 1.0}
    assert cdse_up["fetch"] == 0
    r = await sar.scan_aoi(_Client(), VesselStore(), big, detect=True)
    assert cdse_up["fetch"] == 0
    assert r["sceneCount"] == 1 and r["detections"] == []
    assert "too large" in r["note"]


async def test_detection_is_located_inside_the_box(cdse_up):
    out = await sar.detect_located(VesselStore(), BOX, date="2026-10-03")
    assert out["date"] == "2026-10-03"
    assert out["source"] == "cdse S1_GRD_VV"
    assert out["pixelSizeM"] > 0
    (d,) = out["detections"]
    assert d["located"] is True
    assert BOX[1] < d["lat"] < BOX[3] and BOX[0] < d["lon"] < BOX[2]
    assert d["lat"] == pytest.approx(CENTER[0], abs=0.02)
    assert d["lon"] == pytest.approx(CENTER[1], abs=0.02)


async def test_no_imagery(monkeypatch):
    async def none_fetch(*a):
        return None

    monkeypatch.setattr(cdse, "available", lambda: True)
    monkeypatch.setattr(cdse, "fetch_image", none_fetch)
    out = await sar.detect_located(VesselStore(), BOX)
    assert out == {
        "detections": [],
        "candidates": [],
        "note": "no SAR imagery for this box and date",
    }


async def test_candidate_unknown_without_ais_coverage(cdse_up):
    out = await sar.detect_located(VesselStore(), BOX)
    (c,) = out["candidates"]
    assert c["status"] == "unknown" and c["darkCandidate"] is False


async def test_candidate_dark_with_coverage_but_no_match(cdse_up):
    store = VesselStore()
    lat, lon = CENTER
    # ~5-6 km away: inside the 25 km coverage radius, outside the 2 km match radius.
    store.merge([_fix(100000000 + i, lat + 0.05, lon + 0.01 * i) for i in range(3)])
    out = await sar.detect_located(store, BOX)
    (c,) = out["candidates"]
    assert c["status"] == "dark" and c["darkCandidate"] is True
    assert c["aisCoverageN"] == 3


async def test_scan_with_detect_fills_located_results(cdse_up):
    r = await sar.scan_aoi(_Client(), VesselStore(), BOX, detect=True)
    assert r["sceneCount"] == 1
    assert len(r["detections"]) == 1 and len(r["candidates"]) == 1
    assert r["detections"][0]["located"] is True
    assert "located" in r["note"] and "CDSE" in r["note"]


async def test_detect_false_is_unchanged(cdse_up):
    r = await sar.scan_aoi(_Client(), VesselStore(), BOX)
    assert cdse_up["fetch"] == 0
    assert r["detections"] == [] and r["candidates"] == []
    assert r["note"].startswith("scene inventory only")
    assert "date" not in r and "source" not in r
