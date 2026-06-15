import numpy as np

from app.imagery import cdse
from app.intel import sar_vessels


def test_detect_targets_finds_injected_ships():
    rng = np.random.default_rng(0)
    # Calm sea clutter ~ low amplitude; inject 3 bright compact targets.
    img = (rng.random((200, 200)) * 20).astype(np.float32)
    ships = [(40, 50), (120, 160), (170, 30)]
    for r, c in ships:
        img[r - 1 : r + 2, c - 1 : c + 2] = 240
    targets = sar_vessels.detect_targets(img, k=4.0)
    assert len(targets) == 3
    found = {(round(t["row"]), round(t["col"])) for t in targets}
    for r, c in ships:
        assert any(abs(fr - r) <= 1 and abs(fc - c) <= 1 for fr, fc in found)


def test_detect_targets_rejects_pure_clutter():
    rng = np.random.default_rng(1)
    img = (rng.random((200, 200)) * 20).astype(np.float32)
    assert sar_vessels.detect_targets(img, k=5.0) == []


def test_water_context_gate_rejects_bright_background_blob():
    # A bright blob on DARK water is a ship; the same blob on a brighter (land)
    # background is rejected by the water-context gate — the fix for "vessels on
    # land" over coastal chokepoint AOIs. The land patch here is moderately
    # bright (below the detection threshold, so it neither lights up as its own
    # component nor trips the block suppression) — only the gate rejects it.
    rng = np.random.default_rng(3)
    img = (rng.random((200, 200)) * 30 + 5).astype(np.float32)  # dark water, med ~20
    img[0:60, 120:180] = 50 + rng.random((60, 60)) * 5  # moderately bright land patch
    img[40:42, 40:42] = 255  # ship on dark water -> kept
    img[40:42, 150:152] = 255  # "ship" on the bright patch -> rejected by water gate
    targets = sar_vessels.detect_targets(img, k=4.0)
    found = {(round(t["row"]), round(t["col"])) for t in targets}
    assert any(abs(fr - 40) <= 1 and abs(fc - 40) <= 1 for fr, fc in found)
    assert not any(abs(fr - 40) <= 2 and abs(fc - 150) <= 2 for fr, fc in found)


def test_detect_targets_suppresses_large_bright_region():
    rng = np.random.default_rng(2)
    img = (rng.random((200, 200)) * 20).astype(np.float32)
    img[0:96, 0:96] = 240  # land block (16-grid aligned) — suppressed, not a ship
    img[150:153, 150:153] = 240  # a real small ship
    targets = sar_vessels.detect_targets(img, k=4.0)
    assert len(targets) == 1
    assert round(targets[0]["row"]) == 151 and round(targets[0]["col"]) == 151


def test_pixel_lonlat_inverts_forward_projection():
    bbox = cdse.lonlat_bbox_3857(55.9, 26.4, 56.9, 27.1)
    # center pixel of a 100x100 image ~ center of the bbox
    lon, lat = sar_vessels._pixel_lonlat(bbox, 100, 100, 49.5, 49.5)
    assert abs(lon - 56.4) < 0.05
    assert abs(lat - 26.75) < 0.05


def test_epsg3857_roundtrip():
    x, y = cdse.lonlat_to_3857(56.4, 26.75)
    lon, lat = sar_vessels.epsg3857_to_lonlat(x, y)
    assert abs(lon - 56.4) < 1e-6
    assert abs(lat - 26.75) < 1e-6


def test_ais_match_radius():
    vessels = [(56.40, 26.75)]
    assert sar_vessels._ais_match(56.405, 26.752, vessels, 0.02) is True
    assert sar_vessels._ais_match(56.50, 26.95, vessels, 0.02) is False


def test_every_aoi_resolves_to_valid_small_water_box():
    # Hormuz must stay registered and unchanged.
    assert sar_vessels.aoi_bbox("hormuz") == (56.35, 26.50, 56.85, 26.78)
    for key, (label, box) in sar_vessels.AOIS.items():
        assert isinstance(label, str) and label
        assert sar_vessels.aoi_label(key) == label
        bbox = sar_vessels.aoi_bbox(key)
        assert bbox == box
        lon0, lat0, lon1, lat1 = bbox
        # corners in range and ordered min<max
        assert -180.0 <= lon0 < lon1 <= 180.0
        assert -90.0 <= lat0 < lat1 <= 90.0
        # small enough that one Sentinel-1 IW GRD scene covers the box
        assert (lon1 - lon0) <= 0.8
        assert (lat1 - lat0) <= 0.8
        # the 3857 projection used by detect_dark_vessels must accept it
        proj = cdse.lonlat_bbox_3857(*bbox)
        assert proj[0] < proj[2] and proj[1] < proj[3]


def test_aoi_bbox_unknown_raises_keyerror():
    import pytest

    with pytest.raises(KeyError):
        sar_vessels.aoi_bbox("atlantis")


def test_route_rejects_unknown_aoi_with_400(client):
    r = client.get("/api/intel/dark-vessels/sar", params={"aoi": "atlantis"})
    assert r.status_code == 400
    assert "unknown aoi" in r.json()["detail"]


def test_route_rejects_bad_date_with_400(client):
    # A *valid* aoi must clear the registry check (no 400 for the aoi) and fail
    # only on the date format — proving the key resolved through validation,
    # without firing any CDSE network call.
    r = client.get(
        "/api/intel/dark-vessels/sar",
        params={"aoi": "bab-el-mandeb", "date": "06-15-2026"},
    )
    assert r.status_code == 400
    assert "date" in r.json()["detail"]


def test_every_aoi_passes_route_registry_validation(client, monkeypatch):
    # Stub detect_dark_vessels + the creds gate so the route never touches the
    # network: this isolates the registry-validation branch. Every registered
    # key must NOT 400 (it resolves); the route then returns the stub body.
    import app.routes.sar as sar_route

    async def _fake(aoi, date):  # noqa: ANN001
        return {"type": "FeatureCollection", "features": [], "_secret": 1, "ok": aoi}

    monkeypatch.setattr(sar_route.cdse, "available", lambda: True)
    monkeypatch.setattr(sar_route.sar_vessels, "detect_dark_vessels", _fake)
    for key in sar_vessels.AOIS:
        r = client.get("/api/intel/dark-vessels/sar", params={"aoi": key})
        assert r.status_code == 200, key
        body = r.json()
        assert body["ok"] == key
        # internal verification payloads (leading underscore) stay out of the body
        assert "_secret" not in body
