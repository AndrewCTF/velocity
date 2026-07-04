"""Unit tests for the focused-chip endpoint (GET /api/imagery/chip).

Pure logic + mocked upstreams — NO network, NO live CDSE creds (conftest sets
cdse_client_id/secret = ""). Covers: bbox/grid math, source-ladder selection,
cache-key stability for a drifting entity, keyless reachability, and the
graceful no-CDSE-creds fallback to the keyless GIBS mosaic.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from io import BytesIO

from PIL import Image

from app.config import Settings
from app.intel.geo import BBox
from app.routes import imagery as I

# ── bbox / grid math ─────────────────────────────────────────────────────────


def test_round_bbox_contains_and_snaps() -> None:
    b = BBox(96.083, 21.967, 96.117, 22.001)
    rb = I._round_bbox(b)
    # rounded box must CONTAIN the requested AOI (never clip it)
    assert rb.min_lon <= b.min_lon and rb.min_lat <= b.min_lat
    assert rb.max_lon >= b.max_lon and rb.max_lat >= b.max_lat
    # corners land on the grid
    grid = I._CHIP_GRID_DEG
    for v in (rb.min_lon, rb.min_lat, rb.max_lon, rb.max_lat):
        assert abs((v / grid) - round(v / grid)) < 1e-9


def test_chip_px_preserves_aspect_and_bounds() -> None:
    wide = I._chip_px(BBox(0, 0, 4, 1))  # 4:1 → width pinned to the cap
    assert wide[0] == I._CHIP_MAX_PX and wide[1] < I._CHIP_MAX_PX
    tall = I._chip_px(BBox(0, 0, 1, 4))  # 1:4 → height pinned
    assert tall[1] == I._CHIP_MAX_PX and tall[0] < I._CHIP_MAX_PX
    # long edge never drops below the floor
    assert min(I._chip_px(BBox(0, 0, 0.0001, 0.0001))) >= I._CHIP_MIN_PX


# ── cache key (moving-entity reuse) ──────────────────────────────────────────


def test_cache_key_shape() -> None:
    b = I.ondemand.aoi_bbox(lat=21.97, lon=96.08, radius_km=4)
    key = I.chip_cache_key("sentinel", b, "2026-06-20")
    assert key.startswith("chip/sentinel/")
    assert key.endswith("/2026-06-20")


def test_cache_key_stable_under_subgrid_jitter() -> None:
    # A drifting entity within the same grid cell must reuse the SAME chip,
    # else the upsert-by-id frontend re-requests every poll.
    base = I.ondemand.aoi_bbox(lat=21.970, lon=96.080, radius_km=4)
    jit = I.ondemand.aoi_bbox(lat=21.9705, lon=96.0805, radius_km=4)
    assert I.chip_cache_key("auto", base, "2026-06-20") == I.chip_cache_key(
        "auto", jit, "2026-06-20"
    )


def test_cache_key_changes_across_grid_cell() -> None:
    a = I.ondemand.aoi_bbox(lat=21.97, lon=96.08, radius_km=4)
    far = I.ondemand.aoi_bbox(lat=48.85, lon=2.35, radius_km=4)
    assert I.chip_cache_key("auto", a, "2026-06-20") != I.chip_cache_key(
        "auto", far, "2026-06-20"
    )
    # date also namespaces
    assert I.chip_cache_key("auto", a, "2026-06-20") != I.chip_cache_key(
        "auto", a, "2026-06-21"
    )


# ── source-ladder selection (pure) ───────────────────────────────────────────


def test_select_source_auto() -> None:
    assert I.select_chip_source("auto", maxar_hit=True, cdse_ok=True) == "maxar"
    assert I.select_chip_source("auto", maxar_hit=True, cdse_ok=False) == "maxar"
    assert I.select_chip_source("auto", maxar_hit=False, cdse_ok=True) == "sentinel"
    assert I.select_chip_source("auto", maxar_hit=False, cdse_ok=False) == "gibs"


def test_select_source_explicit_falls_through_honestly() -> None:
    # explicit maxar but no event → sentinel if creds, else gibs
    assert I.select_chip_source("maxar", maxar_hit=False, cdse_ok=True) == "sentinel"
    assert I.select_chip_source("maxar", maxar_hit=False, cdse_ok=False) == "gibs"
    # explicit sentinel without creds → gibs (never a hard fail)
    assert I.select_chip_source("sentinel", maxar_hit=False, cdse_ok=False) == "gibs"
    assert I.select_chip_source("sentinel", maxar_hit=False, cdse_ok=True) == "sentinel"
    # explicit gibs always gibs
    assert I.select_chip_source("gibs", maxar_hit=True, cdse_ok=True) == "gibs"


# ── GIBS mosaic zoom bound ───────────────────────────────────────────────────


def test_gibs_chip_zoom_bounded() -> None:
    rb = I._round_bbox(I.ondemand.aoi_bbox(lat=21.97, lon=96.08, radius_km=4))
    z = I._gibs_chip_zoom(rb, 9)
    x0 = int(I._lon_to_tile_x(rb.min_lon, z) // 1)
    x1 = int(I._lon_to_tile_x(rb.max_lon, z) // 1)
    y0 = int(I._lat_to_tile_y(rb.max_lat, z) // 1)
    y1 = int(I._lat_to_tile_y(rb.min_lat, z) // 1)
    assert (x1 - x0 + 1) <= I._GIBS_MAX_TILES_PER_AXIS
    assert (y1 - y0 + 1) <= I._GIBS_MAX_TILES_PER_AXIS


# ── route: validation ────────────────────────────────────────────────────────


def test_chip_bad_date_400(client) -> None:
    r = client.get("/api/imagery/chip?lat=21.97&lon=96.08&date=June")
    assert r.status_code == 400


def test_chip_bad_source_400(client) -> None:
    r = client.get("/api/imagery/chip?lat=21.97&lon=96.08&date=2026-06-20&source=nope")
    assert r.status_code == 400


def test_chip_out_of_range_lat_422(client) -> None:
    # FastAPI Query(ge/le) → 422 before our handler runs
    r = client.get("/api/imagery/chip?lat=99&lon=96.08&date=2026-06-20")
    assert r.status_code == 422


# ── route: keyless + graceful no-CDSE fallback to GIBS mosaic ────────────────


def _solid_jpeg_tile() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (256, 256), (40, 80, 120)).save(buf, format="JPEG")
    return buf.getvalue()


def test_chip_no_cdse_falls_back_to_gibs_mosaic(client, monkeypatch) -> None:
    """No CDSE creds + no Maxar event → auto resolves to the keyless GIBS
    mosaic. Mock the GIBS tile fetch (and force CDSE-unavailable + no Maxar so
    nothing touches the network); assert a real cropped JPEG, labeled 375 m."""
    fetched: list[str] = []

    async def fake_fetch(url: str) -> bytes:
        fetched.append(url)
        assert url.startswith("https://gibs.earthdata.nasa.gov/wmts/")
        return _solid_jpeg_tile()

    async def no_maxar(b, date):
        return []

    # Hermetic: cdse.available() + ondemand.maxar_search read the GLOBAL
    # settings (not the route's Depends override), so stub them directly.
    monkeypatch.setattr(I, "_fetch_bytes", fake_fetch)
    monkeypatch.setattr(I.cdse, "available", lambda: False)
    monkeypatch.setattr(I.ondemand, "maxar_search", no_maxar)

    r = client.get("/api/imagery/chip?lat=21.97&lon=96.08&radius_km=4&date=2026-06-20")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert fetched, "GIBS mosaic should have fetched at least one tile"
    # honest metadata sidecar
    meta = json.loads(r.headers["X-Chip"])
    assert meta["provider"] == "gibs"
    assert meta["gsd_m"] == 375.0
    assert r.headers["X-Imagery-Provider"] == "gibs"
    # the returned bytes are a decodable image cropped to the AOI
    img = Image.open(BytesIO(r.content))
    assert img.width > 0 and img.height > 0


def test_chip_is_keyless_no_auth_dependency() -> None:
    """The handler must NOT carry require_api_key/commercial_request deps — the
    browser SingleTileImageryProvider fetches it with no header. Guards against
    a future edit silently gating the chip behind auth."""
    import inspect

    sig = inspect.signature(I.imagery_chip)
    names = set(sig.parameters)
    # only data params + Settings; no auth/commercial dependency params
    assert "settings" in names
    assert "commercial" not in names
    src = inspect.getsource(I.imagery_chip)
    assert "require_api_key" not in src
    assert "commercial_request" not in src


def test_chip_sentinel_path_when_creds_present(monkeypatch) -> None:
    """With CDSE 'available', auto (no Maxar) selects Sentinel and renders the
    Process-API bytes — labeled 10 m. Uses render_chip directly with a stub
    Settings + mocked cdse.fetch_image (no network)."""

    async def run() -> None:
        monkeypatch.setattr(I.cdse, "available", lambda: True)

        async def no_maxar(b, date):  # ondemand.maxar_search stub
            return []

        monkeypatch.setattr(I.ondemand, "maxar_search", no_maxar)

        async def fake_fetch_image(layer_id, bbox, w, h, date):
            assert layer_id == "S2_L2A_TRUECOLOR"
            return _solid_jpeg_tile()

        monkeypatch.setattr(I.cdse, "fetch_image", fake_fetch_image)

        with tempfile.TemporaryDirectory() as td:
            settings = Settings(
                cdse_client_id="x", cdse_client_secret="y", tile_cache_dir=td
            )
            aoi = I.ondemand.aoi_bbox(lat=21.97, lon=96.08, radius_km=4)
            out = await I.render_chip(aoi, "2026-06-20", "auto", settings)
            assert out is not None
            assert out["meta"]["provider"] == "sentinel"
            assert out["meta"]["gsd_m"] == 10.0
            assert out["meta"]["layer"] == "S2_L2A_TRUECOLOR"
            assert out["bytes"]

    asyncio.run(run())


def test_chip_maxar_overlap_records_vhr_but_renders_coarser(monkeypatch) -> None:
    """When a Maxar event acquisition overlaps, the chip surfaces the VHR
    acquisition datetime + an honest note, but renders pixels from Sentinel
    (no rasterio/tiler to clip the COG) — never labels Sentinel pixels as
    0.5 m VHR."""

    async def run() -> None:
        monkeypatch.setattr(I.cdse, "available", lambda: True)

        async def one_acq(b, date):
            return [
                {
                    "id": "maxar-scene-1",
                    "datetime": "2026-06-19T03:00:00Z",
                    "epoch": 0.0,
                    "bbox": [96.0, 21.9, 96.3, 22.2],
                    "collection": "https://x/col.json",
                }
            ]

        monkeypatch.setattr(I.ondemand, "maxar_search", one_acq)

        async def fake_fetch_image(layer_id, bbox, w, h, date):
            return _solid_jpeg_tile()

        monkeypatch.setattr(I.cdse, "fetch_image", fake_fetch_image)

        with tempfile.TemporaryDirectory() as td:
            settings = Settings(
                cdse_client_id="x", cdse_client_secret="y", tile_cache_dir=td
            )
            aoi = I.ondemand.aoi_bbox(lat=22.0, lon=96.1, radius_km=4)
            out = await I.render_chip(aoi, "2026-06-20", "auto", settings)
            assert out is not None
            # VHR acquisition is surfaced...
            assert out["meta"]["datetime"] == "2026-06-19T03:00:00Z"
            assert out["meta"]["note"]
            # ...but the rendered pixels + gsd are honest (Sentinel, not 0.5 m)
            assert out["meta"]["provider"] == "sentinel"
            assert out["meta"]["gsd_m"] == 10.0

    asyncio.run(run())
