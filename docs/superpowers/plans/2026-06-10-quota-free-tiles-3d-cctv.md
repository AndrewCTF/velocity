# Quota-Free Tiles, 3D Photoreal Stack, ADS-B Failover, CCTV Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate upstream rate-limit pain (basemap, imagery, Google 3D, ADS-B) and add a legal public-CCTV layer, per the approved spec at `docs/superpowers/specs/2026-06-10-tiles-3d-cctv-design.md`.

**Architecture:** A disk-backed tile cache turns every tile proxy into fetch-once-per-TTL. New keyless imagery (`/tiles/sat`: EOX Sentinel-2 + Esri World Imagery) and terrain (`/tiles/terrain`: AWS terrarium + cesium-martini client decode) make the `3d-sat` mode token-free. Google Photorealistic 3D Tiles become a session-cached, camera-height-gated, hide-don't-destroy primitive. The ADS-B firehose chain gains an authenticated OpenSky last resort. A new `cams.py` route aggregates owner-published webcams (Digitraffic FI, Caltrans, curated YAML) behind a snapshot proxy.

**Tech Stack:** FastAPI + httpx (API), CesiumJS 1.123 + React 18 + zustand (web), `@macrostrat/cesium-martini@1.6.0`, `hls.js`, `pyyaml`, pytest + httpx.MockTransport, vitest.

**Sacred invariants (CLAUDE.md — verify after every task):** SVG icons never dots; upsert-by-id (no removeAll); `SampledPositionProperty` interpolation; `requestRenderMode: true`; ADS-B grid densify-only; labels via `labelStyle.ts`; `apiFetch`/`withWsKey` for all browser→backend calls; `pnpm -r typecheck` green; pytest ≥ 25 passed.

---

### Task 0: Initialize git repository (baseline)

The repo is not under version control; the plan's commit cadence needs it.

**Files:** none created in-repo except `.gitignore` check.

- [ ] **Step 0.1: Verify .gitignore exists and covers build/cache dirs**

Run: `cat /home/andrew/Projects/OSINT/.gitignore`
If missing entries, ensure it contains at least:

```
node_modules/
.venv/
__pycache__/
.ruff_cache/
.pytest_cache/
dist/
data/tilecache/
.env
.playwright-mcp/
```

(`.env` holds real keys — MUST be ignored before the first commit. `data/tilecache/` is the new disk cache.)

- [ ] **Step 0.2: Init + baseline commit**

```bash
cd /home/andrew/Projects/OSINT
git init
git add -A
git status   # MUST NOT list .env — abort and fix .gitignore if it does
git commit -m "chore: baseline before quota-free tiles/3D/CCTV work"
```

---

### Task 1: Disk tile cache

**Files:**
- Create: `apps/api/app/tilecache.py`
- Test: `apps/api/tests/test_tilecache.py`
- Modify: `apps/api/app/config.py` (add `tile_cache_dir` setting)
- Modify: `apps/api/tests/conftest.py` (test tile dir)

- [ ] **Step 1.1: Write failing tests**

Create `apps/api/tests/test_tilecache.py`:

```python
"""TileCache unit tests — hit/miss, coalescing, stale-on-failure."""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.tilecache import TileCache


def test_miss_fetches_once_then_disk_hit(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)
    calls = 0

    async def loader() -> bytes | None:
        nonlocal calls
        calls += 1
        return b"PNG"

    async def run() -> None:
        assert await tc.get("carto", 3, 1, 2, "png", 60, loader) == b"PNG"
        assert await tc.get("carto", 3, 1, 2, "png", 60, loader) == b"PNG"

    asyncio.run(run())
    assert calls == 1
    assert (tmp_path / "carto" / "3" / "1" / "2.png").read_bytes() == b"PNG"


def test_concurrent_requests_coalesce(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)
    calls = 0

    async def loader() -> bytes | None:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return b"X"

    async def run() -> list[bytes | None]:
        return list(
            await asyncio.gather(
                *(tc.get("s", 1, 0, 0, "png", 60, loader) for _ in range(10))
            )
        )

    results = asyncio.run(run())
    assert all(r == b"X" for r in results)
    assert calls == 1


def test_stale_served_on_upstream_failure(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)

    async def good() -> bytes | None:
        return b"OLD"

    async def bad() -> bytes | None:
        return None

    async def run() -> bytes | None:
        await tc.get("s", 1, 0, 0, "png", 60, good)
        # ttl 0 → entry counts as expired → loader runs → fails → stale served
        return await tc.get("s", 1, 0, 0, "png", 0, bad)

    assert asyncio.run(run()) == b"OLD"


def test_failure_without_stale_returns_none(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)

    async def bad() -> bytes | None:
        return None

    assert asyncio.run(tc.get("s", 1, 0, 0, "png", 60, bad)) is None
```

- [ ] **Step 1.2: Run tests — verify they fail**

Run: `cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest tests/test_tilecache.py -q`
Expected: 4 errors — `ModuleNotFoundError: No module named 'app.tilecache'`

- [ ] **Step 1.3: Implement TileCache**

Create `apps/api/app/tilecache.py`:

```python
"""Disk-backed tile cache with per-key coalescing and stale-on-failure.

Tiles are near-immutable (basemap restyles monthly at most, satellite
mosaics yearly, terrain never), so a long-TTL disk cache means each tile is
fetched from upstream at most once per TTL window — regardless of how many
browser sessions request it. Upstream sees O(unique tiles), not
O(users x tiles). This is the rate-limit fix.

File IO is synchronous on purpose: tiles are ~10-100 KB local-disk reads on
a single-analyst deployment; a thread hop per tile would cost more than the
read. Writes are atomic (tmp + os.replace) so a crashed write never leaves
a truncated tile to be served later.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from pathlib import Path

# Bounded per-key lock table — same eviction idea as upstream.TtlCache.
_MAX_LOCKS = 4096


class TileCache:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self._locks: OrderedDict[str, asyncio.Lock] = OrderedDict()

    def _path(self, source: str, z: int, x: int, y: int, ext: str) -> Path:
        return self.root / source / str(z) / str(x) / f"{y}.{ext}"

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        self._locks.move_to_end(key)
        while len(self._locks) > _MAX_LOCKS:
            self._locks.popitem(last=False)
        return lock

    @staticmethod
    def _fresh(path: Path, ttl_sec: float) -> bool:
        try:
            return (time.time() - path.stat().st_mtime) < ttl_sec
        except OSError:
            return False

    async def get(
        self,
        source: str,
        z: int,
        x: int,
        y: int,
        ext: str,
        ttl_sec: float,
        loader: Callable[[], Awaitable[bytes | None]],
    ) -> bytes | None:
        """Return tile bytes, or None when upstream failed and no copy exists.

        Fresh disk hit short-circuits without locking. On miss, a per-key
        lock coalesces concurrent fetches into one upstream call. When the
        loader fails (returns None), any stale copy — regardless of age —
        is served instead, so a dead upstream degrades to "frozen tiles",
        never to "blank map".
        """
        path = self._path(source, z, x, y, ext)
        if self._fresh(path, ttl_sec):
            try:
                return path.read_bytes()
            except OSError:
                pass
        async with self._lock_for(f"{source}/{z}/{x}/{y}"):
            # Double-check: another waiter may have written it while we queued.
            if self._fresh(path, ttl_sec):
                try:
                    return path.read_bytes()
                except OSError:
                    pass
            data = await loader()
            if data:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(path.suffix + ".tmp")
                tmp.write_bytes(data)
                os.replace(tmp, path)
                return data
            try:
                return path.read_bytes()
            except OSError:
                return None
```

- [ ] **Step 1.4: Run tests — verify they pass**

Run: `cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest tests/test_tilecache.py -q`
Expected: `4 passed`

- [ ] **Step 1.5: Add the setting + test fixture dir**

In `apps/api/app/config.py`, inside `class Settings`, after the `# ── infra ──` block's `redis_url` line, add:

```python
    # Disk tile cache root (basemap / sat / terrain proxies). Grows with use;
    # safe to delete at any time — it refills on demand.
    tile_cache_dir: str = "./data/tilecache"
```

In `apps/api/tests/conftest.py`, add at top with the other imports:

```python
import tempfile
```

Add a module-level constant after the imports (one shared dir per test session so repeated `_test_settings()` calls agree):

```python
# One tile-cache dir per test session — _test_settings() is called per
# request via dependency_overrides, and a fresh mkdtemp per call would
# defeat the disk cache the tile tests assert on.
_TEST_TILE_DIR = tempfile.mkdtemp(prefix="osint-test-tiles-")
```

In `_test_settings()`, add the kwarg:

```python
        tile_cache_dir=_TEST_TILE_DIR,
```

- [ ] **Step 1.6: Full API suite + commit**

Run: `cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest -q`
Expected: previous count + 4 passed, 0 failed.

```bash
cd /home/andrew/Projects/OSINT
git add apps/api/app/tilecache.py apps/api/tests/test_tilecache.py apps/api/app/config.py apps/api/tests/conftest.py
git commit -m "feat(api): disk tile cache with coalescing and stale-on-failure"
```

---

### Task 2: Cache-wrap basemap + new /tiles/sat + /tiles/terrain routes

**Files:**
- Modify: `apps/api/app/routes/tiles.py` (full rewrite below)
- Test: `apps/api/tests/test_tiles_route.py`

- [ ] **Step 2.1: Write failing tests**

Create `apps/api/tests/test_tiles_route.py`:

```python
"""Tile proxy routes — cache-wrapped, mocked upstreams."""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest

import app.upstream as upstream


@pytest.fixture
def mock_upstream(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Install an httpx MockTransport; yields the list of upstream URLs hit."""
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        host = request.url.host
        if "cartocdn" in host:
            return httpx.Response(200, content=b"\x89PNG-carto")
        if "eox.at" in host:
            return httpx.Response(200, content=b"\xff\xd8-eox")
        if "arcgisonline" in host:
            return httpx.Response(200, content=b"\xff\xd8-esri")
        if "s3.amazonaws.com" in host:
            return httpx.Response(200, content=b"\x89PNG-terrain")
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(upstream, "_CLIENT", client)
    yield urls
    monkeypatch.setattr(upstream, "_CLIENT", None)


def test_basemap_second_call_is_disk_hit(client, mock_upstream: list[str]) -> None:
    r1 = client.get("/tiles/basemap/7/41/53.png")
    assert r1.status_code == 200
    assert r1.content == b"\x89PNG-carto"
    n = len(mock_upstream)
    assert n >= 1
    r2 = client.get("/tiles/basemap/7/41/53.png")
    assert r2.status_code == 200
    assert len(mock_upstream) == n  # served from disk — no new upstream call


def test_sat_z_split_eox_low_esri_high(client, mock_upstream: list[str]) -> None:
    r_low = client.get("/tiles/sat/5/10/12.jpg")
    assert r_low.status_code == 200
    assert r_low.headers["x-sat-source"] == "eox"
    assert r_low.content == b"\xff\xd8-eox"
    r_high = client.get("/tiles/sat/15/100/200.jpg")
    assert r_high.status_code == 200
    assert r_high.headers["x-sat-source"] == "esri"
    assert r_high.content == b"\xff\xd8-esri"


def test_terrain_proxies_terrarium_and_caps_z(client, mock_upstream: list[str]) -> None:
    assert client.get("/tiles/terrain/16/0/0.png").status_code == 400
    r = client.get("/tiles/terrain/10/163/357.png")
    assert r.status_code == 200
    assert r.content == b"\x89PNG-terrain"
    assert any("elevation-tiles-prod" in u for u in mock_upstream)
```

- [ ] **Step 2.2: Run tests — verify they fail**

Run: `cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest tests/test_tiles_route.py -q`
Expected: failures — `/tiles/sat` 404 (route missing), x-sat-source KeyError.
(`test_basemap_second_call_is_disk_hit` may pass the 200 assertions but fail the no-new-upstream assertion — the current route has no disk cache.)

- [ ] **Step 2.3: Rewrite tiles.py**

Replace the entire contents of `apps/api/app/routes/tiles.py` with:

```python
"""Tile proxies — basemap, satellite imagery, terrain.

All routes share one pattern: typed-int z/x/y (no path traversal), disk
TileCache (fetch-once-per-TTL semantics, per-key coalescing), and
stale-on-upstream-failure so a dead provider degrades to frozen tiles, not
a blank globe. The browser only ever sees /tiles/* — providers are
swappable here in one place.

Sources (all keyless):
- basemap: Carto Dark Matter — (c) OpenStreetMap contributors, (c) CARTO.
- sat z<=13: EOX Sentinel-2 cloudless (s2maps.eu) — CC BY-NC-SA 4.0,
  attribution: "Sentinel-2 cloudless by EOX (Contains modified Copernicus
  Sentinel data)". Rendered in the frontend attribution footer.
- sat z>=14: Esri World Imagery legacy tile endpoint — attribution
  "(c) Esri"; high-zoom complement to the 10 m Sentinel mosaic.
- terrain: AWS Open Data Mapzen terrarium elevation tiles (z 0-15).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from app.config import Settings, get_settings
from app.tilecache import TileCache
from app.upstream import get_client

router = APIRouter(tags=["tiles"])

# Carto's basemap CDN. `dark_all` = dark with English labels everywhere.
CARTO_HOSTS = [
    "https://a.basemaps.cartocdn.com",
    "https://b.basemaps.cartocdn.com",
    "https://c.basemaps.cartocdn.com",
    "https://d.basemaps.cartocdn.com",
]

_EOX_LAYER = "s2cloudless-2024_3857"
# z <= split → EOX Sentinel-2 (10 m source res tops out ~z13);
# z > split → Esri World Imagery (sub-meter in cities).
_SAT_SPLIT_Z = 13

_TTL_BASEMAP = 30 * 86400.0
_TTL_SAT = 365 * 86400.0
_TTL_TERRAIN = 10 * 365 * 86400.0  # elevation doesn't change

# One TileCache per configured root. Keyed by root (not a singleton) so
# tests overriding tile_cache_dir get their own isolated cache.
_caches: dict[str, TileCache] = {}


def _cache_for(root: str) -> TileCache:
    tc = _caches.get(root)
    if tc is None:
        tc = TileCache(root)
        _caches[root] = tc
    return tc


async def _fetch_bytes(url: str) -> bytes | None:
    try:
        r = await get_client().get(url)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    return r.content


@router.get("/tiles/basemap/{z}/{x}/{y}.png")
async def basemap_tile(
    z: int, x: int, y: int, settings: Settings = Depends(get_settings)
) -> Response:
    if not (0 <= z <= 22):
        raise HTTPException(400, "z out of range")
    # round-robin shard for parallelism
    host = CARTO_HOSTS[(x + y) % len(CARTO_HOSTS)]

    async def load() -> bytes | None:
        return await _fetch_bytes(f"{host}/dark_all/{z}/{x}/{y}@2x.png")

    data = await _cache_for(settings.tile_cache_dir).get(
        "carto", z, x, y, "png", _TTL_BASEMAP, load
    )
    if data is None:
        raise HTTPException(502, "basemap upstream failed")
    return Response(
        content=data,
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=86400",
            "X-Basemap": "carto-dark-matter",
        },
    )


@router.get("/tiles/sat/{z}/{x}/{y}.jpg")
async def sat_tile(
    z: int, x: int, y: int, settings: Settings = Depends(get_settings)
) -> Response:
    if not (0 <= z <= 19):
        raise HTTPException(400, "z out of range")
    if z <= _SAT_SPLIT_Z:
        source = "eox"
        url = (
            f"https://tiles.maps.eox.at/wmts/1.0.0/{_EOX_LAYER}/default"
            f"/GoogleMapsCompatible/{z}/{y}/{x}.jpg"
        )
    else:
        source = "esri"
        url = (
            "https://services.arcgisonline.com/arcgis/rest/services"
            f"/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        )

    async def load() -> bytes | None:
        return await _fetch_bytes(url)

    data = await _cache_for(settings.tile_cache_dir).get(
        source, z, x, y, "jpg", _TTL_SAT, load
    )
    if data is None:
        raise HTTPException(502, "sat upstream failed")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=604800",
            "X-Sat-Source": source,
        },
    )


@router.get("/tiles/terrain/{z}/{x}/{y}.png")
async def terrain_tile(
    z: int, x: int, y: int, settings: Settings = Depends(get_settings)
) -> Response:
    if not (0 <= z <= 15):
        raise HTTPException(400, "z out of range (terrarium max 15)")

    async def load() -> bytes | None:
        return await _fetch_bytes(
            f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
        )

    data = await _cache_for(settings.tile_cache_dir).get(
        "terrarium", z, x, y, "png", _TTL_TERRAIN, load
    )
    if data is None:
        raise HTTPException(502, "terrain upstream failed")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=2592000"},
    )
```

- [ ] **Step 2.4: Verify the EOX layer id against live capabilities (one-time)**

Run: `curl -s "https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml" | grep -o "s2cloudless-2024_3857" | head -1`
Expected: `s2cloudless-2024_3857`. If empty, run without the year filter (`grep -o 's2cloudless[^<"]*_3857' | sort -u`) and set `_EOX_LAYER` to the newest listed layer.

- [ ] **Step 2.5: Run tests — verify pass + full suite**

Run: `cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest tests/test_tiles_route.py -q`
Expected: `3 passed`
Run: `.venv/bin/pytest -q` — expected: all passed (≥ 25 + 7 new).

- [ ] **Step 2.6: Commit**

```bash
cd /home/andrew/Projects/OSINT
git add apps/api/app/routes/tiles.py apps/api/tests/test_tiles_route.py
git commit -m "feat(api): cache-wrapped basemap + keyless /tiles/sat and /tiles/terrain proxies"
```

---

### Task 3: Token-free 3d-sat stack in the frontend

**Files:**
- Modify: `apps/web/package.json` (via pnpm add)
- Modify: `apps/web/src/globe/GlobeCanvas.tsx`
- Create: `apps/web/src/shell/Attribution.tsx`
- Modify: `apps/web/src/App.tsx` (mount Attribution)

- [ ] **Step 3.1: Add cesium-martini**

```bash
cd /home/andrew/Projects/OSINT/apps/web
pnpm add @macrostrat/cesium-martini
```

- [ ] **Step 3.2: Verify the package's export surface**

Run: `ls node_modules/@macrostrat/cesium-martini/dist/ && grep -n "export" node_modules/@macrostrat/cesium-martini/dist/*.d.ts | head -20`
Expected: a `MartiniTerrainProvider` (or default) export taking `{ url | resource, ... }` constructor options. Adapt the import in Step 3.3 to the actual export name/options if they differ — the rest of the wiring is identical.

- [ ] **Step 3.3: Rewire GlobeCanvas 3d-sat branch to the free stack**

In `apps/web/src/globe/GlobeCanvas.tsx`:

(a) Add import after the existing Cesium import:

```ts
import { MartiniTerrainProvider } from '@macrostrat/cesium-martini';
```

(b) Add builders next to `buildDarkBasemap()`:

```ts
// Keyless satellite stack: EOX Sentinel-2 (z≤13) + Esri World Imagery
// (z≥14), proxied + disk-cached by the backend. No ion token involved.
function buildSatImagery(): Cesium.ImageryLayer {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/sat/{z}/{x}/{y}.jpg',
    maximumLevel: 19,
    credit: 'Sentinel-2 cloudless by EOX · © Esri',
  });
  return Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider), {});
}

// Terrarium elevation tiles decoded client-side into quantized-mesh by
// cesium-martini. Replaces ion World Terrain — keyless, cached on disk.
function buildFreeTerrain(): Cesium.TerrainProvider {
  return new MartiniTerrainProvider({
    url: '/tiles/terrain/{z}/{x}/{y}.png',
  }) as unknown as Cesium.TerrainProvider;
}
```

(c) In the swap effect, change:

```ts
    const hasIon = Boolean(ionToken);
    const wantSat = imageryMode === '3d-sat' && hasIon;
```

to:

```ts
    const hasIon = Boolean(ionToken);
    // 3d-sat no longer requires ion: imagery + terrain come from our own
    // keyless proxies. ion remains an optional bonus (OSM Buildings).
    const wantSat = imageryMode === '3d-sat';
```

(d) In the `if (wantSat)` branch, replace the ion imagery + terrain lines:

```ts
      scene.imageryLayers.add(
        Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(2), {}),
      );

      Cesium.CesiumTerrainProvider.fromIonAssetId(1)
        .then((tp) => {
          if (stale()) return;
          viewer.terrainProvider = tp;
          scene.requestRender();
        })
        .catch((e: unknown) => console.warn('World Terrain failed:', e));
```

with:

```ts
      scene.imageryLayers.add(buildSatImagery());

      try {
        viewer.terrainProvider = buildFreeTerrain();
      } catch (e) {
        console.warn('martini terrain failed, staying on ellipsoid:', e);
      }
      scene.requestRender();
```

(e) Wrap the OSM Buildings load in an ion guard (it is the only remaining ion consumer):

```ts
      if (hasIon) {
        Cesium.createOsmBuildingsAsync()
          .then((tileset) => {
            if (stale()) {
              tileset.destroy();
              return;
            }
            scene.primitives.add(tileset);
            osmBuildingsRef.current = tileset;
            scene.requestRender();
          })
          .catch((e: unknown) => console.warn('OSM buildings failed:', e));
      }
```

(Keep the pre-existing "drop any prior ion-stack tilesets" block above it unchanged. Keep the Google block unchanged — Task 4 rewrites it.)

- [ ] **Step 3.4: Attribution footer (license requirement)**

Create `apps/web/src/shell/Attribution.tsx`:

```tsx
// Imagery/terrain licenses require visible attribution (EOX CC BY-NC-SA,
// Carto/OSM, Esri, Mapzen/AWS). The Cesium credit container is hidden for
// dark-chrome reasons, so this fixed footer is the attribution surface.
export function Attribution(): JSX.Element {
  return (
    <div className="pointer-events-none fixed bottom-1 right-2 z-40 text-[10px] leading-none text-slate-500">
      © OpenStreetMap · © CARTO · Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0,
      contains modified Copernicus Sentinel data) · Imagery © Esri · Terrain ©
      Mapzen/AWS Open Data
    </div>
  );
}
```

In `apps/web/src/App.tsx`: import `{ Attribution } from './shell/Attribution.js';` and render `<Attribution />` once, as a sibling immediately after the globe container element (locate the JSX wrapping `<GlobeCanvas …/>` and add it at the same level, inside the root layout div).

- [ ] **Step 3.5: Typecheck + visual verification**

Run: `cd /home/andrew/Projects/OSINT && pnpm -r typecheck`
Expected: green. If `MartiniTerrainProvider` types clash with the app's Cesium version, keep the `as unknown as Cesium.TerrainProvider` cast (already in the builder) and re-run.

Boot the app (api + web dev servers), switch imagery mode to `3d-sat` **with `CESIUM_ION_TOKEN` empty**: satellite imagery and terrain relief must render; aircraft/vessel SVG icons must persist (no dots); no console errors from `/tiles/sat` or `/tiles/terrain`.

- [ ] **Step 3.6: Commit**

```bash
cd /home/andrew/Projects/OSINT
git add apps/web/package.json pnpm-lock.yaml apps/web/src/globe/GlobeCanvas.tsx apps/web/src/shell/Attribution.tsx apps/web/src/App.tsx
git commit -m "feat(web): token-free 3d-sat stack — proxied sat imagery + martini terrain + attribution footer"
```

---

### Task 4: Google 3D quota diet

**Files:**
- Modify: `apps/web/src/globe/GlobeCanvas.tsx`

- [ ] **Step 4.1: Session-cached, gated Google tileset**

In `GlobeCanvas.tsx`:

(a) Add refs next to `googleTilesetRef`:

```ts
  // Google tileset is created at most once per session and toggled via
  // .show — re-enabling must never re-fetch the root tileset (quota diet).
  const googleCreatingRef = useRef(false);
  const googleWantedRef = useRef(false);
```

(b) Add module-scope constant + helper above the component:

```ts
// Above this camera altitude the photogrammetry is sub-pixel — hide it and
// show the (free) sat globe instead so orbit panning burns zero Google quota.
const GOOGLE_3D_MAX_CAMERA_HEIGHT_M = 30_000;

function applyGoogleGate(viewer: Cesium.Viewer, tileset: Cesium.Cesium3DTileset, wanted: boolean): void {
  const h = viewer.camera.positionCartographic.height;
  const visible = wanted && h < GOOGLE_3D_MAX_CAMERA_HEIGHT_M;
  if (tileset.show !== visible) {
    tileset.show = visible;
    viewer.scene.globe.show = !visible;
    // Google ToS requires visible attribution while their tiles render.
    const credit = viewer.cesiumWidget.creditContainer as HTMLElement;
    credit.style.display = visible ? '' : 'none';
    viewer.scene.requestRender();
  }
}
```

(c) In the one-time construction effect, after `installSelectionTrack(viewer)`, add the camera listener:

```ts
    // Height gate for Google photogrammetry — only flips state on threshold
    // crossings (applyGoogleGate no-ops when nothing changed), so this stays
    // requestRenderMode-friendly.
    const onCameraChanged = (): void => {
      const ts = googleTilesetRef.current;
      if (ts) applyGoogleGate(viewer, ts, googleWantedRef.current);
    };
    viewer.camera.changed.addEventListener(onCameraChanged);
```

and in that effect's cleanup, before `viewer.destroy()`:

```ts
      viewer.camera.changed.removeEventListener(onCameraChanged);
```

(d) In the swap effect, replace the whole `if (enableGoogle3D) { … } else { scene.globe.show = true; }` block inside `wantSat` with:

```ts
      googleWantedRef.current = enableGoogle3D;
      if (enableGoogle3D) {
        if (googleTilesetRef.current) {
          applyGoogleGate(viewer, googleTilesetRef.current, true);
        } else if (!googleCreatingRef.current) {
          googleCreatingRef.current = true;
          Cesium.createGooglePhotorealistic3DTileset(undefined, {
            // 24 (vs default 16) ≈ half the tile fetches for slightly softer
            // detail; big cache so revisiting a city reuses tiles.
            maximumScreenSpaceError: 24,
            cacheBytes: 512 * 1024 * 1024,
            maximumCacheOverflowBytes: 1024 * 1024 * 1024,
          })
            .then((tileset) => {
              googleCreatingRef.current = false;
              if (!viewerRef.current) {
                tileset.destroy();
                return;
              }
              scene.primitives.add(tileset);
              googleTilesetRef.current = tileset;
              applyGoogleGate(viewer, tileset, googleWantedRef.current);
            })
            .catch((e: unknown) => {
              googleCreatingRef.current = false;
              console.warn('Google Photorealistic 3D failed:', e);
            });
        }
      } else if (googleTilesetRef.current) {
        applyGoogleGate(viewer, googleTilesetRef.current, false);
      } else {
        scene.globe.show = true;
      }
```

(e) In `teardownIonStack` (runs on the `2d-dark` path), replace the Google removal:

```ts
      if (googleTilesetRef.current) {
        scene.primitives.remove(googleTilesetRef.current);
        googleTilesetRef.current = null;
      }
```

with hide-don't-destroy:

```ts
      // Hide — never destroy — the Google tileset: re-enabling later must
      // not re-fetch the root tileset (quota). Viewer.destroy() reaps it
      // at unmount via scene.primitives.
      googleWantedRef.current = false;
      if (googleTilesetRef.current) {
        applyGoogleGate(viewer, googleTilesetRef.current, false);
      }
```

(f) Likewise in the `wantSat` branch, delete the now-redundant "Drop any prior ion-stack tilesets" lines for `googleTilesetRef` (keep the OSM-buildings drop). The generation counter (`stale()`) continues to protect the OSM tileset only.

- [ ] **Step 4.2: Typecheck + behavior check**

Run: `cd /home/andrew/Projects/OSINT && pnpm -r typecheck` — green.
With `ENABLE_GOOGLE_3D=true` + `GMAPS_KEY`/ion configured: enable 3d-sat, zoom to a city below ~30 km → photogrammetry appears + credit strip shows; zoom out above 30 km → sat globe returns, credit hides; toggle mode 2d-dark → 3d-sat → photogrammetry returns **without** new root-tileset network fetches (check the network panel for `root.json`-style requests on re-toggle: there must be none).

- [ ] **Step 4.3: Commit**

```bash
cd /home/andrew/Projects/OSINT
git add apps/web/src/globe/GlobeCanvas.tsx
git commit -m "feat(web): Google 3D quota diet — session-cached tileset, 30km camera gate, SSE 24"
```

---

### Task 5: OpenSky last-resort firehose for ADS-B

**Files:**
- Modify: `apps/api/app/routes/adsb.py`
- Test: `apps/api/tests/test_adsb_failover.py`

- [ ] **Step 5.1: Write failing tests**

Create `apps/api/tests/test_adsb_failover.py`:

```python
"""ADS-B degradation ladder: firehoses 429 → OpenSky authed fallback."""

from __future__ import annotations

import asyncio

import httpx
import pytest

import app.routes.adsb as adsb
import app.upstream as upstream


def test_try_firehose_all_429_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(upstream, "_CLIENT", client)
    try:
        assert asyncio.run(adsb._try_firehose()) is None
    finally:
        monkeypatch.setattr(upstream, "_CLIENT", None)


def test_fanout_falls_back_to_opensky(monkeypatch: pytest.MonkeyPatch) -> None:
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "aircraft:abc123",
                "geometry": {"type": "Point", "coordinates": [1.0, 2.0, 1000]},
                "properties": {"icao24": "abc123", "kind": "aircraft"},
            }
        ],
    }

    async def no_firehose() -> None:
        return None

    async def fake_opensky() -> dict:
        return fc

    monkeypatch.setattr(adsb, "_try_firehose", no_firehose)
    monkeypatch.setattr(adsb, "_try_opensky_global", fake_opensky)
    assert asyncio.run(adsb._do_global_fanout()) == fc


def test_opensky_skipped_without_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import Settings

    monkeypatch.setattr(
        adsb,
        "get_settings",
        lambda: Settings(opensky_client_id="", opensky_client_secret=""),
    )
    assert asyncio.run(adsb._try_opensky_global()) is None
```

- [ ] **Step 5.2: Run tests — verify they fail**

Run: `cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest tests/test_adsb_failover.py -q`
Expected: `AttributeError: module 'app.routes.adsb' has no attribute '_try_opensky_global'` (first test may already pass — `_try_firehose` exists).

- [ ] **Step 5.3: Implement the fallback**

In `apps/api/app/routes/adsb.py`:

(a) Extend imports:

```python
from app.config import get_settings
from app.ingest.opensky import fetch_states, states_to_geojson
from app.routes.aviation import _token_manager
```

(b) Add after `_try_firehose`:

```python
async def _try_opensky_global() -> dict[str, Any] | None:
    """Authed OpenSky /states/all — the last firehose resort.

    Only fires when every anonymous aggregator refused us. OpenSky's authed
    quota is a finite daily credit budget, so it's the safety net, not the
    primary. Returns a ready GeoJSON FeatureCollection (states_to_geojson
    emits the same aircraft schema the frontend adapter consumes) or None
    when creds are missing / the call failed / the sky came back empty."""
    settings = get_settings()
    if not (settings.opensky_client_id and settings.opensky_client_secret):
        return None
    try:
        tm = _token_manager(settings)
        raw = await fetch_states(tm, None)
        fc = states_to_geojson(raw)
    except Exception:
        return None
    return fc if fc.get("features") else None
```

(c) In `_do_global_fanout`, between the firehose block and the grid fallback comment, add:

```python
    # Authed OpenSky firehose — fires only when all anonymous hosts refused.
    opensky_fc = await _try_opensky_global()
    if opensky_fc:
        return opensky_fc
```

(d) Update the module docstring's design-notes block: append one line — `- OpenSky (authed, env creds) sits between the anonymous firehoses and the per-cell grid in the degradation ladder.`

- [ ] **Step 5.4: Run tests — verify pass + full suite**

Run: `cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest tests/test_adsb_failover.py -q` → `3 passed`
Run: `.venv/bin/pytest -q` → all passed.

- [ ] **Step 5.5: Commit**

```bash
cd /home/andrew/Projects/OSINT
git add apps/api/app/routes/adsb.py apps/api/tests/test_adsb_failover.py
git commit -m "feat(api): authed OpenSky firehose fallback in ADS-B degradation ladder"
```

---

### Task 6: CCTV backend — catalog + snapshot proxy

**Files:**
- Create: `apps/api/app/routes/cams.py`
- Create: `apps/api/app/data/cams.yaml`
- Modify: `apps/api/pyproject.toml` (add pyyaml)
- Modify: `apps/api/app/main.py` (register router)
- Test: `apps/api/tests/test_cams_route.py`

- [ ] **Step 6.1: Add pyyaml**

In `apps/api/pyproject.toml` `dependencies`, append `"pyyaml>=6.0",` after the `"orjson>=3.10.7",` line. Then:

```bash
cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pip install "pyyaml>=6.0"
```

- [ ] **Step 6.2: Curated catalog file**

Create `apps/api/app/data/cams.yaml`:

```yaml
# Hand-curated public webcams — OWNER-PUBLISHED feeds ONLY.
# Legality policy: a cam belongs here only when its operator intentionally
# publishes the URL (gov portals, tourism boards, harbor authorities).
# Aggregators of unsecured private cams (Insecam-style) are banned.
#
# Schema per entry:
#   id:            unique slug (used in /api/cams/{id}/snapshot)
#   name:          display name (map label)
#   lat, lon:      WGS84
#   snapshot_url:  direct still-image URL (jpg/png)
#   hls_url:       OPTIONAL live HLS stream (.m3u8)
#   attribution:   license/owner line shown in the entity panel
cams: []
```

- [ ] **Step 6.3: Write failing tests**

Create `apps/api/tests/test_cams_route.py`:

```python
"""CCTV catalog + snapshot proxy tests with mocked upstreams."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

import app.routes.cams as cams
import app.upstream as upstream

_DIGITRAFFIC_FIXTURE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "id": "C01502",
            "geometry": {"type": "Point", "coordinates": [24.95, 60.17]},
            "properties": {
                "id": "C01502",
                "name": "vt1_Helsinki",
                "presets": [{"id": "C0150201"}, {"id": "C0150202"}],
            },
        }
    ],
}

_CALTRANS_FIXTURE = {
    "data": [
        {
            "cctv": {
                "index": "1",
                "recordTimestamp": {"recordDate": "2026-06-10"},
                "location": {
                    "district": "4",
                    "locationName": "US-101 : North of Market",
                    "latitude": "37.775",
                    "longitude": "-122.419",
                },
                "imageData": {
                    "static": {
                        "currentImageURL": "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv101.jpg"
                    }
                },
            }
        }
    ]
}


@pytest.fixture
def mock_upstream(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        urls.append(url)
        if "tie.digitraffic.fi" in url:
            return httpx.Response(200, content=json.dumps(_DIGITRAFFIC_FIXTURE).encode())
        if "cwwp2.dot.ca.gov" in url and url.endswith(".json"):
            return httpx.Response(200, content=json.dumps(_CALTRANS_FIXTURE).encode())
        if url.endswith(".jpg"):
            return httpx.Response(200, content=b"\xff\xd8jpegbytes")
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(upstream, "_CLIENT", client)
    upstream.cache.invalidate("cams:catalog")
    yield urls
    upstream.cache.invalidate("cams:catalog")
    monkeypatch.setattr(upstream, "_CLIENT", None)


def test_cams_geojson_merges_sources(client, mock_upstream: list[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    yaml_file = tmp_path / "cams.yaml"
    yaml_file.write_text(
        "cams:\n"
        "  - id: test-harbor\n"
        "    name: Test Harbor\n"
        "    lat: 60.0\n"
        "    lon: 25.0\n"
        "    snapshot_url: https://example.org/harbor.jpg\n"
        "    attribution: Test City\n"
    )
    monkeypatch.setattr(cams, "_CAMS_YAML", yaml_file)
    r = client.get("/api/cams")
    assert r.status_code == 200
    fc = r.json()
    ids = {f["id"] for f in fc["features"]}
    assert any(i.startswith("cam:digitraffic:") for i in ids)
    assert any(i.startswith("cam:caltrans:") for i in ids)
    assert "cam:yaml:test-harbor" in ids
    for f in fc["features"]:
        assert f["properties"]["kind"] == "camera"
        assert f["properties"]["name"]


def test_snapshot_proxy_and_unknown_404(client, mock_upstream: list[str]) -> None:
    fc = client.get("/api/cams").json()
    cam_id = next(
        f["id"] for f in fc["features"] if f["id"].startswith("cam:digitraffic:")
    )
    short = cam_id.removeprefix("cam:")
    r = client.get(f"/api/cams/{short}/snapshot")
    assert r.status_code == 200
    assert r.content == b"\xff\xd8jpegbytes"
    assert r.headers["content-type"] == "image/jpeg"
    assert client.get("/api/cams/nope:missing/snapshot").status_code == 404
```

- [ ] **Step 6.4: Run tests — verify they fail**

Run: `cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest tests/test_cams_route.py -q`
Expected: `ModuleNotFoundError: No module named 'app.routes.cams'`

- [ ] **Step 6.5: Implement cams.py**

Create `apps/api/app/routes/cams.py`:

```python
"""GET /api/cams — public webcam catalog + snapshot proxy.

Sources (all owner-published, keyless):
- Fintraffic Digitraffic weathercams (CC BY 4.0) — same API family as the
  Digitraffic AIS feed we already consume.
- Caltrans district CCTV JSON (public CA traffic cams). District list is a
  tuple constant — extend it to add coverage; the per-state-adapter pattern
  is _load_caltrans, copy it for other DOTs.
- app/data/cams.yaml — hand-curated additions (owner-published only; see
  the policy header in that file).

Why a snapshot proxy instead of direct image URLs in the browser:
1. CORS — most DOT image hosts send no ACAO headers.
2. Politeness — the 60 s TtlCache caps upstream fetches at one per minute
   per cam regardless of how many panels are open.
3. SSRF safety — cam_id → catalog lookup is the only path to a fetch; the
   browser can never make this proxy fetch an arbitrary URL.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException, Response

from app.upstream import cache, get_client

router = APIRouter(tags=["cams"])

_CATALOG_TTL = 3600.0
_SNAPSHOT_TTL = 60.0

_DIGITRAFFIC_STATIONS = "https://tie.digitraffic.fi/api/weathercam/v1/stations"
_DIGITRAFFIC_IMG = "https://weathercam.digitraffic.fi/{preset}.jpg"
_CALTRANS_DISTRICTS = (3, 4)  # Sacramento, Bay Area — extend freely
_CALTRANS_URL = "https://cwwp2.dot.ca.gov/data/d{n}/cctv/cctvStatusD{n:02d}.json"
_CAMS_YAML = Path(__file__).resolve().parent.parent / "data" / "cams.yaml"


@dataclass(frozen=True)
class Cam:
    id: str  # "{source}:{key}" — unique across sources
    name: str
    lat: float
    lon: float
    snapshot_url: str
    source: str
    attribution: str
    hls_url: str | None = None


async def _get_json(url: str) -> Any | None:
    try:
        r = await get_client().get(url)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None


async def _load_digitraffic() -> list[Cam]:
    j = await _get_json(_DIGITRAFFIC_STATIONS)
    if not isinstance(j, dict):
        return []
    out: list[Cam] = []
    for f in j.get("features") or []:
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or []
        presets = props.get("presets") or []
        if len(coords) < 2 or not presets:
            continue
        preset_id = (presets[0] or {}).get("id")
        if not preset_id:
            continue
        station_id = str(props.get("id") or f.get("id") or preset_id)
        out.append(
            Cam(
                id=f"digitraffic:{station_id}",
                name=str(props.get("name") or station_id).replace("_", " "),
                lat=float(coords[1]),
                lon=float(coords[0]),
                snapshot_url=_DIGITRAFFIC_IMG.format(preset=preset_id),
                source="digitraffic",
                attribution="Fintraffic / digitraffic.fi (CC BY 4.0)",
            )
        )
    return out


async def _load_caltrans() -> list[Cam]:
    out: list[Cam] = []
    for n in _CALTRANS_DISTRICTS:
        j = await _get_json(_CALTRANS_URL.format(n=n))
        if not isinstance(j, dict):
            continue
        for i, row in enumerate(j.get("data") or []):
            cctv = (row or {}).get("cctv") or {}
            loc = cctv.get("location") or {}
            img = ((cctv.get("imageData") or {}).get("static") or {}).get(
                "currentImageURL"
            )
            try:
                lat = float(loc.get("latitude"))
                lon = float(loc.get("longitude"))
            except (TypeError, ValueError):
                continue
            if not img:
                continue
            key = cctv.get("index") or str(i)
            out.append(
                Cam(
                    id=f"caltrans:d{n}-{key}",
                    name=str(loc.get("locationName") or f"Caltrans D{n} #{key}"),
                    lat=lat,
                    lon=lon,
                    snapshot_url=str(img),
                    source="caltrans",
                    attribution="Caltrans (public)",
                )
            )
    return out


def _load_yaml() -> list[Cam]:
    try:
        doc = yaml.safe_load(_CAMS_YAML.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return []
    out: list[Cam] = []
    for c in doc.get("cams") or []:
        try:
            out.append(
                Cam(
                    id=f"yaml:{c['id']}",
                    name=str(c["name"]),
                    lat=float(c["lat"]),
                    lon=float(c["lon"]),
                    snapshot_url=str(c["snapshot_url"]),
                    source="curated",
                    attribution=str(c.get("attribution") or "curated"),
                    hls_url=c.get("hls_url"),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


async def _get_catalog() -> dict[str, Cam]:
    async def load() -> dict[str, Cam]:
        digitraffic = await _load_digitraffic()
        caltrans = await _load_caltrans()
        curated = _load_yaml()
        return {c.id: c for c in (*digitraffic, *caltrans, *curated)}

    return await cache.get_or_fetch("cams:catalog", _CATALOG_TTL, load)


@router.get("/api/cams")
async def cams_geojson() -> dict[str, Any]:
    catalog = await _get_catalog()
    features = [
        {
            "type": "Feature",
            "id": f"cam:{c.id}",
            "geometry": {"type": "Point", "coordinates": [c.lon, c.lat, 0]},
            "properties": {
                "kind": "camera",
                "name": c.name,
                "source": c.source,
                "attribution": c.attribution,
                "has_hls": c.hls_url is not None,
                "hls_url": c.hls_url,
                "cam_id": c.id,
            },
        }
        for c in catalog.values()
    ]
    fc: dict[str, Any] = {"type": "FeatureCollection", "features": features}
    if not features:
        fc["note"] = "no cam sources reachable"
    return fc


@router.get("/api/cams/{cam_id:path}/snapshot")
async def cam_snapshot(cam_id: str) -> Response:
    catalog = await _get_catalog()
    cam = catalog.get(cam_id)
    if cam is None:
        raise HTTPException(404, "unknown cam")

    async def load() -> bytes:
        r = await get_client().get(cam.snapshot_url)
        if r.status_code != 200:
            raise HTTPException(502, f"cam upstream {r.status_code}")
        return r.content

    data = await cache.get_or_fetch(f"cams:snap:{cam_id}", _SNAPSHOT_TTL, load)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=60"},
    )
```

- [ ] **Step 6.6: Register the router**

In `apps/api/app/main.py`: add `from app.routes import cams as cams_routes` beside the other route imports (match the existing import style — check how `tiles_routes` is imported and mirror it), and `app.include_router(cams_routes.router)` after the `jamming_routes` line.

- [ ] **Step 6.7: Run tests — verify pass + full suite**

Run: `cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest tests/test_cams_route.py -q` → `2 passed`
Run: `.venv/bin/pytest -q` → all passed.

- [ ] **Step 6.8: Commit**

```bash
cd /home/andrew/Projects/OSINT
git add apps/api/app/routes/cams.py apps/api/app/data/cams.yaml apps/api/tests/test_cams_route.py apps/api/app/main.py apps/api/pyproject.toml
git commit -m "feat(api): public CCTV catalog (Digitraffic FI + Caltrans + curated YAML) with snapshot proxy"
```

---

### Task 7: CCTV frontend — layer, icon, entity-panel viewer

**Files:**
- Modify: `packages/shared/src/layer.ts` (EmitsKind + 'camera')
- Modify: `apps/web/src/globe/icons.ts` (camera SVG)
- Modify: `apps/web/src/globe/adapters/styles.ts` (cameraStyle)
- Modify: `apps/web/src/globe/adapters/PollGeoJsonAdapter.ts` (StyleKind + camera case)
- Modify: `apps/web/src/globe/LayerCompositor.ts` (styleFromEmits)
- Modify: `apps/web/src/registry/defaults.ts` (layer descriptor)
- Create: `apps/web/src/entity-panel/CameraCard.tsx`
- Modify: `apps/web/src/entity-panel/EntityPanel.tsx` (mount CameraCard)
- Modify: `apps/web/package.json` (hls.js)

- [ ] **Step 7.1: Shared type**

In `packages/shared/src/layer.ts`, extend the union:

```ts
export type EmitsKind =
  | 'vessel'
  | 'aircraft'
  | 'satellite'
  | 'emitter'
  | 'event'
  | 'outage'
  | 'detection'
  | 'quake'
  | 'fire'
  | 'camera';
```

- [ ] **Step 7.2: Icon**

In `apps/web/src/globe/icons.ts`, add beside the other SVG factories:

```ts
// CCTV camera — housing + mount arm + dark lens.
function cameraSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <rect x="3" y="6" width="13" height="8" rx="2" fill="${color}" stroke="#000" stroke-width="0.75"/>
    <path d="M16 8.5 L21 6.5 L21 13.5 L16 11.5 Z" fill="${color}" stroke="#000" stroke-width="0.75"/>
    <circle cx="8" cy="10" r="2.2" fill="#0b0e14"/>
    <rect x="8.5" y="14" width="2" height="4" fill="${color}" stroke="#000" stroke-width="0.5"/>
  </svg>`;
}
```

and register it in the `icons` map:

```ts
  camera: (color: string) => dataUri(cameraSvg(color)),
```

- [ ] **Step 7.3: Style**

In `apps/web/src/globe/adapters/styles.ts`, add (mirroring `satelliteStyle`'s shape; reuse the file's existing `icons`/`cachedIcon` imports):

```ts
// Public CCTV cams — neutral slate so they read as infrastructure, not as a
// contact. Static points: no rotation, no per-poll restyle.
export function cameraStyle(): { imageUri: string; scale: number } {
  return {
    imageUri: cachedIcon('camera:#e2e8f0', () => icons.camera('#e2e8f0')),
    scale: 1.0,
  };
}
```

- [ ] **Step 7.4: Adapter wiring**

In `apps/web/src/globe/adapters/PollGeoJsonAdapter.ts`:

(a) Import `cameraStyle` alongside the other style imports.

(b) Extend the kind union:

```ts
export type StyleKind = 'quake' | 'aircraft' | 'fire' | 'vessel' | 'jamming' | 'camera' | 'generic';
```

(c) In `applyStyle`'s switch, add before `default:`:

```ts
      case 'camera': {
        const s = cameraStyle();
        opts.billboard = {
          image: s.imageUri,
          scale: s.scale,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          // Cams are dense city furniture — only paint below ~4,000 km.
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4_000_000),
        };
        const name = props['name'];
        if (typeof name === 'string' && name.length > 0) {
          opts.label = labelFor(name);
          opts.name = name;
        }
        break;
      }
```

(`refreshStyle` needs no camera case — cams are static; position/properties upsert is enough.)

- [ ] **Step 7.5: Compositor mapping**

In `apps/web/src/globe/LayerCompositor.ts` `styleFromEmits`, add:

```ts
  if (e === 'camera') return 'camera';
```

- [ ] **Step 7.6: Layer descriptor**

In `apps/web/src/registry/defaults.ts`, append to the `── INFRASTRUCTURE ──` section:

```ts
  {
    id: 'infra.cams.public',
    group: 'infra',
    title: 'CCTV — public road/weather cams',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/cams',
    refresh: { mode: 'pull', ttlSec: 3600 },
    time: { temporal: false },
    crs: 'EPSG:4326',
    license: 'Fintraffic CC BY 4.0 / Caltrans public / curated',
    opacity: 1,
    visibleByDefault: false,
    emits: ['camera'],
  },
```

- [ ] **Step 7.7: hls.js + CameraCard**

```bash
cd /home/andrew/Projects/OSINT/apps/web && pnpm add hls.js
```

Create `apps/web/src/entity-panel/CameraCard.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../transport/http.js';

// Snapshot viewer for a selected CCTV cam. Fetches through apiFetch (the
// sanctioned transport — auth headers ride along; a bare <img src> would
// bypass the API key) into an object URL, refreshed every 60 s to match the
// backend's snapshot cache TTL. On fetch failure the last frame stays up.
const REFRESH_MS = 60_000;

export function CameraCard({
  camId,
  hlsUrl,
  attribution,
}: {
  camId: string;
  hlsUrl: string | null;
  attribution: string;
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let current: string | null = null;

    const fetchSnap = async (): Promise<void> => {
      try {
        const r = await apiFetch(`/api/cams/${encodeURIComponent(camId)}/snapshot`);
        if (!r.ok || cancelled) return;
        const blob = await r.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        current = url;
      } catch {
        /* keep last frame */
      }
    };

    void fetchSnap();
    const t = window.setInterval(() => void fetchSnap(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      if (current) URL.revokeObjectURL(current);
    };
  }, [camId]);

  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-slate-400">
        live cam
      </div>
      {hlsUrl ? (
        <HlsPlayer url={hlsUrl} />
      ) : src ? (
        <img src={src} alt="cam snapshot" className="w-full rounded" />
      ) : (
        <div className="flex h-24 items-center justify-center text-xs text-slate-500">
          loading snapshot…
        </div>
      )}
      <div className="mt-1 text-[10px] text-slate-500">{attribution}</div>
    </div>
  );
}

// Lazy hls.js so the chunk only loads when an HLS cam is actually opened.
function HlsPlayer({ url }: { url: string }): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let hls: { destroy: () => void } | null = null;
    let cancelled = false;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
    } else {
      void import('hls.js').then(({ default: Hls }) => {
        if (cancelled || !Hls.isSupported()) return;
        const h = new Hls();
        h.loadSource(url);
        h.attachMedia(video);
        hls = h;
      });
    }
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [url]);

  return <video ref={ref} className="w-full rounded" controls muted autoPlay playsInline />;
}
```

- [ ] **Step 7.8: Mount in EntityPanel**

In `apps/web/src/entity-panel/EntityPanel.tsx`: import `{ CameraCard } from './CameraCard.js';` and, in the panel body where `TrackCard` is rendered, add directly above it:

```tsx
      {snap?.kind === 'camera' && (
        <CameraCard
          camId={String(snap.properties['cam_id'] ?? '')}
          hlsUrl={(snap.properties['hls_url'] as string | null) ?? null}
          attribution={String(snap.properties['attribution'] ?? '')}
        />
      )}
```

- [ ] **Step 7.9: Typecheck + visual verification**

Run: `cd /home/andrew/Projects/OSINT && pnpm -r typecheck` — green.
Boot the app, enable "CCTV — public road/weather cams" in the LayerRail: camera icons over Finland + California, labels visible, click one → EntityPanel shows a refreshing snapshot + attribution. Aircraft/vessels unaffected.

- [ ] **Step 7.10: Commit**

```bash
cd /home/andrew/Projects/OSINT
git add packages/shared/src/layer.ts apps/web/src/globe/icons.ts apps/web/src/globe/adapters/styles.ts apps/web/src/globe/adapters/PollGeoJsonAdapter.ts apps/web/src/globe/LayerCompositor.ts apps/web/src/registry/defaults.ts apps/web/src/entity-panel/CameraCard.tsx apps/web/src/entity-panel/EntityPanel.tsx apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): CCTV layer — camera icons, layer descriptor, entity-panel snapshot/HLS viewer"
```

---

### Task 8: Full verification (CLAUDE.md ritual)

- [ ] **Step 8.1: Suites**

```bash
cd /home/andrew/Projects/OSINT && pnpm -r typecheck
cd apps/api && .venv/bin/pytest -q
```

Expected: typecheck green; pytest ≥ 25 + 12 new passed, 0 failed.

- [ ] **Step 8.2: Live ritual**

Boot api + web. Then:
1. Drag camera to Europe — hundreds of yellow airliner + orange military SVG icons (NOT dots).
2. Click an aircraft — EntityPanel populates AND magenta track polyline within 4 s.
3. Click empty area — polyline + reticle clear.
4. Stay 30 s — icons never blink off-then-on.
5. Toggle `3d-sat` with empty ion token — satellite imagery + terrain render.
6. Watch the api logs while panning the basemap: repeated views of the same area produce no new Carto fetch lines (disk cache hits).
7. Enable CCTV layer — icons in FI/CA, click → live snapshot.

- [ ] **Step 8.3: Final commit (any verification fixes) + summary**

```bash
cd /home/andrew/Projects/OSINT && git add -A && git commit -m "fix: post-verification adjustments" # only if fixes were needed
```

---

## Self-review notes

- Spec coverage: tile cache (T1), sat/terrain routes (T2), free 3d-sat + attribution (T3), Google gating (T4), ADS-B OpenSky fallback (T5 — circuit breaker/token bucket dropped intentionally: the codebase already replaced breakers with fall-through + sticky snapshot, and CLAUDE.md forbids regressing that), CCTV backend (T6) + frontend (T7), verification (T8). Spec's "3–5 DOT states" trimmed to Digitraffic + Caltrans(d3,d4) with an explicit adapter pattern for growth — noted deviation.
- External-shape risk is quarantined: EOX layer id (Step 2.4 verify), martini export name (Step 3.2 verify), Digitraffic/Caltrans JSON shapes (defensive parsing + fixtures).
- Type consistency: `Cam.id` is `source:key`; GeoJSON feature id is `cam:{Cam.id}`; snapshot route takes `{cam_id:path}` = `Cam.id`; CameraCard reads `properties.cam_id`. Consistent.
