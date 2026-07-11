# Free / keyless 3D-of-the-world sources — findings + what we shipped

_Investigated 2026-07-11. Goal: "Gaussian splatting of the city, no API keys,
free sources for the whole world."_

## The blunt finding

**There is no free, keyless, whole-planet Gaussian-splat stream. It does not
exist in July 2026 — from anyone, at any price for the "keyless" part.**

The only planet-scale photoreal 3D that exists is **textured mesh, not splats**,
and it is locked behind keys + terms:

| Source | What it is | Key? | Whole world? | Splats? |
|---|---|---|---|---|
| **Google Photorealistic 3D Tiles** | textured mesh (glTF/3D Tiles), ~49 countries | **API key + billing acct** (≈1k free loads/mo) | ~most cities | ❌ mesh |
| **Apple Maps** 3D / Look Around | proprietary mesh + imagery | **no public API at all** | wide | ❌ mesh |
| **Cesium ion 3DGS LOD** (Apr 2026) | real 3DGS, streamed with LOD | free **ion token** + you host the scene | ❌ your uploads | ✅ |
| **MapTiler GeoSplats** | 3DGS SDK | **key** | ❌ per-scene | ✅ |
| Community splats (SuperSplat, HF, Luma, Polycam) | per-scene 3DGS, direct URLs | **none** | ❌ a few dozen places | ✅ |

Google's [Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies)
**explicitly forbid** extracting/caching/deriving 3D objects from the tiles:
_"you may not have 3D objects extracted, traced, or otherwise derived by hand or
machine from Photorealistic 3D Tiles."_ So "grab the gaussian file out of Google
Earth / Apple Maps" is (a) not even splats — it's keyed, watermarked mesh — and
(b) a direct ToS + access-control violation. We do not do that.

## You can only have two of {keyless, whole-world, splats}

- **Drop keyless** → Google 3D Tiles photoreal mesh into the Cesium globe
  (`createGooglePhotorealistic3DTileset`, already wired behind `enableGoogle3D`).
- **Drop photoreal/splats** → OpenStreetMap building extrusions. Whole planet,
  genuinely no key. **← shipped: keyless OSM buildings + pan auto-fill.**
- **Drop whole-world** → keyless per-scene splats (verified list below), the
  Reconstruction Studio self-recon flow, or the City 3D app's URL loader.

## …but you CAN get real Gaussian splats of any city, keyless — by generating them

A pre-built global splat *stream* doesn't exist. But the whole-world keyless
splat answer is **on-demand generation**: the keyless split of the trilemma is to
trade *instant* for *a few seconds of compute*. City 3D's **"Splat this city
(keyless satellite)"** button (`apps/web/src/city/satToSplat.ts`) stitches a
satellite chip for any lat/lon from the backend's **keyless** `/tiles/sat` proxy
(EOX Sentinel-2 + Esri World Imagery, no key) and runs it through the existing
feed-forward recon engine (`POST /api/recon/jobs mode=mapany` → MapAnything
Apache model → INRIA `.ply`), then loads the result in the Spark viewer.

**Proven live 2026-07-11** (in-browser, City 3D): AOI = Manhattan → click →
`sfm 20%` → `Done — 268,324 Gaussians` in ~6 s → a real splat of the Manhattan
grid rendered (screenshot). Backend-direct: 267,318 Gaussians, valid INRIA `.ply`.

Coverage = anywhere the keyless satellite tiles cover ≈ the whole world.
Single-view feed-forward yields a **2.5D relief** splat (true multi-view towers
need per-city imagery that isn't keyless/global — use Reconstruction Studio
multi-view or `POST /api/recon/sat` for that). Real Gaussians, honest geometry.

**Env note:** recon is a compute endpoint that **fails closed unauthenticated**
(503: _"configure API_KEY / Supabase, or set `ALLOW_UNAUTHENTICATED=1`"_). For
trusted local use boot the API with `ALLOW_UNAUTHENTICATED=1`; it also needs the
GPU lab (`apps/ml/fusion/.venv`, else 503 "no recon GPU lab").

## What we shipped: keyless whole-world OSM 3D buildings (auto-fill)

The platform **already had** a keyless "Load 3D buildings here" button:
`/api/intel/lod1?bbox=…` → public **Overpass** mirrors (no key) → real OSM
footprints with `height` / `building:levels` → extruded + terrain-clamped in the
Cesium globe, cached 12 h (`apps/api/app/intel/lod1.py`, `apps/web/src/lod1/`).

The only gap vs "the whole world, not manual labour" was that it loaded one
district per click. Added an **`Auto-fill as I pan (keyless)`** toggle
(`useImagery.lod1Auto`): while on, GlobeCanvas re-extrudes the current viewport
every time the camera settles below 100 km, debounced + move-gated
(`LOD1_AUTO_MIN_MOVE_DEG`) so the public mirrors aren't hammered. Reuses the
existing replace-in-place loader → one district shown at a time, bounded memory,
revisits hit the 12 h cache.

**Proven live 2026-07-11** (Vite :5173 + API :8000):
- Overpass direct, Midtown Manhattan district: **1,213 buildings, 85% with real
  OSM heights**, no key.
- `/api/intel/lod1?bbox=` Midtown: **1,213 extrudable features, 1,036 OSM
  heights**, 490 KB GeoJSON.
- In-app: enabling auto-fill + flying to Manhattan extruded a **9,000-building**
  datasource with zero clicks; panning to Lower Manhattan refreshed it to the
  new district automatically (screenshots showed full 3D Midtown w/ Central Park
  and Lower Manhattan w/ Holland Tunnel + live AIS vessels compositing on top).

Coverage = anywhere OpenStreetMap has building footprints ≈ every city on Earth.
Fidelity = flat-shaded extruded boxes (LOD1), **not** photoreal, **not** splats —
the honest cost of "keyless + whole-world".

## Verified keyless splat scene sources (for the per-scene option)

All probed 2026-07-11 for HTTP 200/206 + a CORS header a browser fetch accepts
(`access-control-allow-origin: *`, or HF reflecting the request Origin). Paste
into City 3D → "LOAD FROM URL":

- `https://sparkjs.dev/assets/splats/butterfly.spz` — 4 MB, ACAO `*`.
- `https://antimatter15.com/splat-data/train.splat` — 32 MB, ACAO `*`.
- `https://media.reshot.ai/models/nike_next/model.splat` — 9 MB, ACAO `*`.
- `https://huggingface.co/datasets/dylanebert/3dgs/resolve/main/<scene>/<scene>-7k.splat`
  — Mip-NeRF 360 scenes (`bonsai` 35, `room` 35, `counter` 31, `kitchen` 51,
  `garden` 134, `bicycle` 110, `stump` 116 MB); HF reflects Origin → CORS-ok.
- Browse for more: [SuperSplat library](https://superspl.at/) (splats tagged
  *Downloadable* are CC — use the `.ply`/`.sog` URL) and
  [Hugging Face splat datasets](https://huggingface.co/datasets?search=gaussian+splatting)
  (use the file's `resolve/main/…` direct URL).

These are research/demo scenes (Mip-NeRF 360, Tanks & Temples), not cities —
because compact, browser-loadable, keyless *city-scale* splats basically don't
exist yet; city 3DGS (CityGaussian, MatrixCity) ships as multi-GB aerial
captures that need LOD streaming (Cesium/PlayCanvas), which needs a token.
