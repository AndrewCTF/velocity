"""Unit tests for multi-temporal change detection (GET /api/imagery/change, B4).

Pure logic + mocked CDSE — NO network, NO live creds (conftest sets
cdse_client_id/secret = ""). Covers: the two-window Process body shape, the
change cache key (drift reuse + date namespacing), the keyless-route contract,
the HONEST 503 when CDSE creds are absent (never a faked diff), date validation,
and the rendered-bytes path with a mocked ``cdse.fetch_change_image``.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import tempfile
from io import BytesIO

from PIL import Image

from app.config import Settings
from app.imagery import cdse
from app.routes import imagery as I

# ── two-window Process body (cdse) ────────────────────────────────────────────


def test_change_body_has_two_named_windows() -> None:
    body = cdse.build_change_process_body(
        "S2_CHANGE", [0.0, 0.0, 1000.0, 1000.0], 512, 256, "2026-06-01", "2026-06-20"
    )
    data = body["input"]["data"]
    assert [d["id"] for d in data] == ["before", "after"]
    # both windows target the same collection, each with its own timeRange
    assert {d["type"] for d in data} == {"sentinel-2-l2a"}
    assert data[0]["dataFilter"]["timeRange"]["to"].startswith("2026-06-01")
    assert data[1]["dataFilter"]["timeRange"]["to"].startswith("2026-06-20")
    # optical → least-cloud mosaicking on each window
    assert data[0]["dataFilter"]["mosaickingOrder"] == "leastCC"
    assert body["output"]["width"] == 512 and body["output"]["height"] == 256
    # the evalscript references both datasources so it can difference them
    assert "before" in body["evalscript"] and "after" in body["evalscript"]


def test_change_body_radar_has_no_cloud_filter() -> None:
    body = cdse.build_change_process_body(
        "S1_CHANGE", [0.0, 0.0, 1000.0, 1000.0], 256, 256, "2026-06-01", "2026-06-20"
    )
    data = body["input"]["data"]
    assert {d["type"] for d in data} == {"sentinel-1-grd"}
    # SAR is all-weather — no leastCC mosaicking order
    assert "mosaickingOrder" not in data[0]["dataFilter"]
    assert "mosaickingOrder" not in data[1]["dataFilter"]


# ── change cache key (moving-entity reuse + date namespacing) ─────────────────


def test_change_cache_key_shape() -> None:
    b = I.ondemand.aoi_bbox(lat=21.97, lon=96.08, radius_km=4)
    key = I.change_cache_key("optical", b, "2026-06-01", "2026-06-20")
    assert key.startswith("change/optical/")
    assert key.endswith("/2026-06-01_2026-06-20")


def test_change_cache_key_stable_under_subgrid_jitter() -> None:
    base = I.ondemand.aoi_bbox(lat=21.970, lon=96.080, radius_km=4)
    jit = I.ondemand.aoi_bbox(lat=21.9705, lon=96.0805, radius_km=4)
    assert I.change_cache_key("optical", base, "2026-06-01", "2026-06-20") == (
        I.change_cache_key("optical", jit, "2026-06-01", "2026-06-20")
    )


def test_change_cache_key_changes_with_dates_and_mode() -> None:
    a = I.ondemand.aoi_bbox(lat=21.97, lon=96.08, radius_km=4)
    base = I.change_cache_key("optical", a, "2026-06-01", "2026-06-20")
    assert base != I.change_cache_key("optical", a, "2026-06-02", "2026-06-20")
    assert base != I.change_cache_key("optical", a, "2026-06-01", "2026-06-21")
    assert base != I.change_cache_key("radar", a, "2026-06-01", "2026-06-20")


# ── route: keyless contract ───────────────────────────────────────────────────


def test_change_is_keyless_no_auth_dependency() -> None:
    """The change handler must NOT carry require_api_key/commercial_request — the
    browser SingleTileImageryProvider fetches it with no header (mirrors chip)."""
    sig = inspect.signature(I.imagery_change)
    names = set(sig.parameters)
    assert "settings" in names
    assert "commercial" not in names
    src = inspect.getsource(I.imagery_change)
    assert "require_api_key" not in src
    assert "commercial_request" not in src


# ── route: validation ─────────────────────────────────────────────────────────


def test_change_bad_date_400(client) -> None:
    r = client.get(
        "/api/imagery/change?lat=21.97&lon=96.08&before=June&after=2026-06-20"
    )
    assert r.status_code == 400


def test_change_before_after_ordering_400(client) -> None:
    r = client.get(
        "/api/imagery/change?lat=21.97&lon=96.08&before=2026-06-20&after=2026-06-01"
    )
    assert r.status_code == 400
    assert "earlier" in r.json()["detail"].lower()


def test_change_bad_mode_400(client, monkeypatch) -> None:
    # mode is validated BEFORE the creds check, so this is 400 even without CDSE
    monkeypatch.setattr(I.cdse, "available", lambda: True)
    r = client.get(
        "/api/imagery/change?lat=21.97&lon=96.08&before=2026-06-01&after=2026-06-20&mode=x"
    )
    assert r.status_code == 400


def test_change_out_of_range_lat_422(client) -> None:
    r = client.get(
        "/api/imagery/change?lat=99&lon=96.08&before=2026-06-01&after=2026-06-20"
    )
    assert r.status_code == 422


# ── route: HONEST 503 with no CDSE creds (never a faked diff) ─────────────────


def test_change_without_cdse_creds_503_not_faked(client, monkeypatch) -> None:
    """With CDSE unavailable the route returns an honest 503 ('requires CDSE
    credentials'). It must NOT fabricate a difference image from the coarse GIBS
    mosaic. ``cdse.available()`` reads the GLOBAL settings (not the route's
    Depends override) — and the dev env may carry real creds — so stub it False
    explicitly to keep this hermetic (mirrors test_imagery_chip)."""
    monkeypatch.setattr(I.cdse, "available", lambda: False)
    r = client.get(
        "/api/imagery/change?lat=21.97&lon=96.08&before=2026-06-01&after=2026-06-20"
    )
    assert r.status_code == 503
    assert "cdse" in r.json()["detail"].lower()


# ── render_change_chip: rendered bytes path (mocked Process API) ──────────────


def _solid_png() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (64, 64), (180, 40, 40)).save(buf, format="PNG")
    return buf.getvalue()


def test_render_change_chip_optical(monkeypatch) -> None:
    """With CDSE 'available', the optical change render returns Sentinel bytes
    labeled 10 m, both windows in the meta, and the diverging-palette legend."""

    async def run() -> None:
        monkeypatch.setattr(I.cdse, "available", lambda: True)

        captured: dict[str, object] = {}

        async def fake_change(layer_id, bbox, w, h, before, after):
            captured.update(
                layer_id=layer_id, before=before, after=after, w=w, h=h
            )
            return _solid_png()

        monkeypatch.setattr(I.cdse, "fetch_change_image", fake_change)

        with tempfile.TemporaryDirectory() as td:
            settings = Settings(
                cdse_client_id="x", cdse_client_secret="y", tile_cache_dir=td
            )
            aoi = I.ondemand.aoi_bbox(lat=21.97, lon=96.08, radius_km=4)
            out = await I.render_change_chip(
                aoi, "2026-06-01", "2026-06-20", "optical", settings
            )
            assert out is not None
            assert captured["layer_id"] == "S2_CHANGE"
            assert captured["before"] == "2026-06-01"
            assert captured["after"] == "2026-06-20"
            m = out["meta"]
            assert m["provider"] == "sentinel"
            assert m["gsd_m"] == 10.0
            assert m["before"] == "2026-06-01" and m["after"] == "2026-06-20"
            assert m["legend"]["red"].startswith("loss")
            assert out["bytes"]

    asyncio.run(run())


def test_render_change_chip_none_without_creds(monkeypatch) -> None:
    """render_change_chip short-circuits to None when CDSE is unavailable — the
    route turns that into a 503 (no fake diff)."""

    async def run() -> None:
        monkeypatch.setattr(I.cdse, "available", lambda: False)
        with tempfile.TemporaryDirectory() as td:
            settings = Settings(tile_cache_dir=td)
            aoi = I.ondemand.aoi_bbox(lat=21.97, lon=96.08, radius_km=4)
            out = await I.render_change_chip(
                aoi, "2026-06-01", "2026-06-20", "optical", settings
            )
            assert out is None

    asyncio.run(run())


def test_change_route_renders_when_cdse_present(client, monkeypatch) -> None:
    """End-to-end through the keyless route: CDSE available + mocked change
    bytes → 200 PNG with the honest X-Chip sidecar (provider sentinel, 10 m)."""
    monkeypatch.setattr(I.cdse, "available", lambda: True)

    async def fake_change(layer_id, bbox, w, h, before, after):
        return _solid_png()

    monkeypatch.setattr(I.cdse, "fetch_change_image", fake_change)

    r = client.get(
        "/api/imagery/change?lat=21.97&lon=96.08&radius_km=4"
        "&before=2026-06-01&after=2026-06-20"
    )
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    meta = json.loads(r.headers["X-Chip"])
    assert meta["provider"] == "sentinel"
    assert meta["gsd_m"] == 10.0
    assert meta["before"] == "2026-06-01" and meta["after"] == "2026-06-20"
    assert r.headers["X-Imagery-Provider"] == "sentinel"
    img = Image.open(BytesIO(r.content))
    assert img.width > 0 and img.height > 0
