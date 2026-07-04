"""Unit tests for the TiTiler COG sub-app (Track B2, app.imagery.tiler).

These MUST pass whether or not ``titiler-core`` / ``rasterio`` is installed:

  * The import-guard / boot tests run unconditionally — they assert the app
    still boots and ``build_tiler_app()`` degrades to ``None`` (never raises)
    when titiler is absent.
  * The live-tile + auth-gating tests are ``skipif`` titiler is absent (no COG
    reader to exercise), and synthesize a tiny in-memory COG with rasterio when
    it IS present — no network, no remote COG, no live creds.

Hermetic: no upstream HTTP, no Supabase. The auth-gating test drives a settings
override with a static API key to prove ``/tiler`` is behind ``ApiKeyMiddleware``
(fail-safe), not fail-open.
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.imagery import tiler as T
from app.main import create_app

# titiler-core pulls rasterio; treat the whole stack as one capability.
_TITILER = importlib.util.find_spec("titiler") is not None and (
    importlib.util.find_spec("rasterio") is not None
)
_need_titiler = pytest.mark.skipif(not _TITILER, reason="titiler-core/rasterio not installed")


# ── always-on: graceful import + boot (titiler present OR absent) ─────────────


def test_build_tiler_app_never_raises_and_sets_flag() -> None:
    """build_tiler_app() resolves to an app or None — never an exception — and
    records the capability in TILER_AVAILABLE."""
    app = T.build_tiler_app()
    assert T.TILER_AVAILABLE in (True, False)
    if _TITILER:
        assert T.TILER_AVAILABLE is True
        assert isinstance(app, FastAPI)
    else:
        assert T.TILER_AVAILABLE is False
        assert app is None


def test_main_app_boots_regardless_of_titiler() -> None:
    """The parent app always constructs; the /tiler mount is present iff titiler
    imported (a missing rasterio must not break boot or any other route)."""
    app = create_app()
    mounted = any(getattr(r, "path", "") == "/tiler" for r in app.routes)
    assert mounted is bool(_TITILER)
    # A core route still answers irrespective of the optional mount.
    app.dependency_overrides[get_settings] = lambda: Settings(
        cdse_client_id="", cdse_client_secret="", tile_cache_dir=tempfile.mkdtemp()
    )
    try:
        with TestClient(app) as c:
            assert c.get("/api/health").status_code == 200
    finally:
        app.dependency_overrides.clear()


# ── live tile rendering (titiler present) ─────────────────────────────────────


def _write_tiny_cog(minx: float, miny: float, maxx: float, maxy: float) -> str:
    """A 64x64 RGB GeoTIFF over the bbox (EPSG:4326). rio-tiler reprojects to
    web-mercator on read, so a plain GTiff is enough for the tile path."""
    import numpy as np  # noqa: PLC0415
    import rasterio  # noqa: PLC0415
    from rasterio.transform import from_bounds  # noqa: PLC0415

    w = h = 64
    arr = (np.random.default_rng(0).random((3, h, w)) * 255).astype("uint8")
    path = os.path.join(tempfile.mkdtemp(prefix="osint-test-cog-"), "cog.tif")
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=h,
        width=w,
        count=3,
        dtype="uint8",
        crs="EPSG:4326",
        transform=from_bounds(minx, miny, maxx, maxy, w, h),
    ) as dst:
        dst.write(arr)
    return path


@pytest.fixture
def tiler_client() -> Iterator[TestClient]:
    """A TestClient over a bare app that ONLY mounts /tiler (no auth, no
    lifespan side effects) — isolates the tile path from the full app."""
    sub = T.build_tiler_app()
    assert sub is not None
    app = FastAPI()
    app.mount("/tiler", sub)
    with TestClient(app) as c:
        yield c


@_need_titiler
def test_tilejson_and_xyz_tile_render(tiler_client: TestClient) -> None:
    minx, miny, maxx, maxy = 96.05, 21.94, 96.11, 22.00
    cog = _write_tiny_cog(minx, miny, maxx, maxy)

    tj = tiler_client.get("/tiler/WebMercatorQuad/tilejson.json", params={"url": cog})
    assert tj.status_code == 200
    body = tj.json()
    # bounds round-trip the COG footprint; a usable zoom is advertised.
    assert body["bounds"][0] == pytest.approx(minx, abs=1e-6)
    z = int(body["maxzoom"])

    import morecantile  # noqa: PLC0415

    t = morecantile.tms.get("WebMercatorQuad").tile((minx + maxx) / 2, (miny + maxy) / 2, z)
    r = tiler_client.get(f"/tiler/tiles/WebMercatorQuad/{z}/{t.x}/{t.y}.png", params={"url": cog})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"  # real PNG, not an error body


@_need_titiler
def test_tile_outside_bounds_is_clean_404(tiler_client: TestClient) -> None:
    """rio-tiler's TileOutsideBounds → a clean 404 via the registered titiler
    exception handlers, NOT a bare 500."""
    cog = _write_tiny_cog(96.05, 21.94, 96.11, 22.00)
    # z=10 tile (0,0) is on the far side of the planet from the COG footprint.
    r = tiler_client.get("/tiler/tiles/WebMercatorQuad/10/0/0.png", params={"url": cog})
    assert r.status_code == 404


@_need_titiler
def test_missing_url_param_is_422(tiler_client: TestClient) -> None:
    """A tile request with no ?url= is a validation error (422), never a 500."""
    r = tiler_client.get("/tiler/tiles/WebMercatorQuad/10/785/447.png")
    assert r.status_code == 422


# ── auth invariant: /tiler is gated by the parent ApiKeyMiddleware ────────────


@_need_titiler
def test_tiler_is_gated_when_auth_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """When auth IS configured, an unauthenticated /tiler request 401s — proving
    the mount sits behind ApiKeyMiddleware (fail-safe), since /tiler is NOT in
    auth.PUBLIC_PREFIXES. (A browser-direct keyless drape would require adding
    '/tiler/' to PUBLIC_PREFIXES — owned by the auth module, intentionally not
    done here; see tiler.py.)

    ApiKeyMiddleware reads ``get_settings()`` directly (the lru_cached real
    Settings, not the dependency override), so the static key is driven via the
    env var + a cache clear, restored on exit so other tests stay hermetic.
    """
    monkeypatch.setenv("API_KEY", "secret-test-key")  # turns auth ON
    get_settings.cache_clear()
    try:
        app = create_app()
        with TestClient(app) as c:
            unauth = c.get("/tiler/healthz")
            assert unauth.status_code == 401  # gated, not fail-open
            ok = c.get("/tiler/healthz", headers={"X-API-Key": "secret-test-key"})
            assert ok.status_code == 200
            assert ok.json() == {"ok": True}
    finally:
        get_settings.cache_clear()  # drop the keyed Settings for the next test
