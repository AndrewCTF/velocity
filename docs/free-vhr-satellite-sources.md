# Free / keyless VHR optical satellite imagery — sources for satellite-3D

Compiled 2026-06-27. Goal context: feeding a 3D Gaussian Splatting / MVS pipeline.
For true building-3D you need **multiple off-nadir views of the same ground + the
camera model (RPC/RPB)**. A rendered ortho tile with no RPC can only ever texture a
flat surface ("hills"), no matter how high its resolution.

Verification legend:
- `[live]` = URL/HTTP outcome I (main) confirmed this turn.
- `[sub]` = verified by research subagent (fetched the page); not independently re-checked.
- `[fact]` = established attribute (GSD/license), not a fresh fetch.

## The only sources that unlock true 3D (multi-view + RPC)

| Source | URL | GSD | Access | Region | Stereo? | RPC? | License |
|---|---|---|---|---|---|---|---|
| IARPA **MVS3DM** | `s3://spacenet-dataset/Hosted-Datasets/MVS_dataset/` · info `spacenet.ai/iarpa-multi-view-stereo-3d-mapping/` `[sub]` | 0.3 m WV-3 | keyless S3 (no-sign) `[live: WV3/PAN .NTF 590-895MB, multi-date]` | Argentina ~100 km² | **YES (47 views/14 mo)** | **YES (NITF RPC00B + .rm sidecar) + 20cm lidar** | **MIT** (JHU/APL) `[live: license.txt]` |
| IARPA **CORE3D** | `s3://spacenet-dataset/Hosted-Datasets/CORE3D-Public-Data/` · `spacenet.ai/core3d/` `[sub]` | ~0.31 m PAN | keyless S3 `[live: Satellite-Images/{Jacksonville,Omaha,Richmond,Tampa,UCSD}]` | Jacksonville/Omaha/Richmond/Tampa | **YES (many WV-3 collects)** | **YES (NITF RPC00B)** | IARPA public, research |
| **DFC2019 / US3D** | `ieee-dataport.org/open-access/data-fusion-contest-2019-dfc2019` · `github.com/pubgeo/dfc2019` `[sub]` | 0.3 m WV-3 | free + IEEE login | JAX + OMA | **YES (epipolar + N-view)** | **YES (lidar-adj + RPC)** | research only, no redistribution, cite |
| **ESA TPM full archive + tasking** | `earth.esa.int/eogateway/catalog/pleiades-neo-full-archive-and-tasking` `[sub]` | 0.3–1.5 m | free but proposal-gated (~9wk); ESA states + Canada only | global | **YES (task stereo/tri-stereo)** | **YES (DIMAP/Maxar)** | non-commercial research |

## RPC-bearing but mono (geometry-grade, one look — combine or pay for the 2nd view)

| Source | URL | GSD | Access | RPC? | License |
|---|---|---|---|---|---|
| ESA TPM — Pléiades Neo sample | `earth.esa.int/eogateway/missions/pleiades-neo/sample-data` `[sub]` | 0.3 m PAN | keyless .zip | YES (DIMAP) | ESA TPM eval |
| ESA TPM — WorldView-3 sample | `earth.esa.int/eogateway/missions/worldview-3/sample-data` `[sub]` | 0.31 m PAN | keyless .zip | YES (.RPB/RPC) | ESA TPM |
| ESA TPM — Pléiades sample | `earth.esa.int/eogateway/missions/pleiades/sample-data` `[sub]` | 0.5 m PAN | keyless .zip | YES (DIMAP) | ESA TPM |
| ESA TPM — SkySat sample | `earth.esa.int/eogateway/missions/skysat/sample-data` `[sub]` | 0.5–0.6 m | keyless .zip | YES (Basic RPC) | © Planet eval |
| ESA TPM — SPOT-6 / Vision-1 | `earth.esa.int/eogateway/missions/spot/sample-data` · `.../vision-1/sample-data` `[sub]` | 1.5 m / 0.87 m | keyless .zip | YES (DIMAP) | ESA TPM |
| Airbus sample imagery | `space-solutions.airbus.com/imagery/sample-imagery/` `[sub]` | 0.3–1.5 m | free (reg for trial) | YES (DIMAP→RPC) | © Airbus eval |

## ⭐ Esri Wayback — keyless 30 cm DATED VHR tiles (added 2026-06-27, proven-live)
- Config: `https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json`
  → 194 time-stamped releases; each has `itemURL` =
  `https://wayback.maptiles.arcgis.com/.../MapServer/tile/{releaseNum}/{z}/{y}/{x}` (row=y,col=x).
  **Tiles 301-redirect → fetch with `follow_redirects=True` + browser UA.** WorldView-3 0.31 m
  in cities, z18+. KEYLESS. Per-tile acquisition date/sensor via the per-release `metadataLayerUrl`
  `/identify?geometry=lon,lat&...` (`SRC_DATE`,`SRC_RES`,`SRC_DESC`).
- **Caveat: release date ≠ tile acquisition date.** Esri mosaics pull best-available; a 2025-12
  release can still serve 2024 imagery. ALWAYS query the metadata layer for the real `SRC_DATE`.
- **⚠️ ToS:** World Imagery is licensed for use *within Esri/ArcGIS apps*; bulk tile scraping is
  ToS-gray. Fine for one-off OSINT research; don't productionize without checking terms.
- **Iran post-strike = NOT available:** all 12 of 2025's Wayback releases over Natanz serve
  `SRC_DATE` 2024-04-28 or 2025-03-26 — both PRE the June-2025 strikes. Free post-strike VHR of
  the site does not exist (EUSI/commercial paywalled; Maxar Open Data has no conflict events).
  Best free post-strike view = Sentinel-2 10 m before/after (CDSE, [[cdse-creds-wired]]).

## Flat ortho texture only — NO RPC, cannot derive 3D geometry

| Source | URL | GSD | Access | Notes |
|---|---|---|---|---|
| Maxar / Vantor Open Data | `registry.opendata.aws/maxar-open-data/` · STAC `maxar-opendata.s3.amazonaws.com/events/catalog.json` `[sub]` | 0.3–0.5 m | keyless, **event/disaster-gated** | single ortho COG (pre/post); CC-BY-NC 4.0 |
| EU Space Imaging — Samples | `euspaceimaging.com/samples/` `[live: 200]` | 0.3 m WV-3 (+DSM/tri-stereo *products*) | free-registration (email form); full archive **paid** | samples mono; tri-stereo is a paid order |
| SpaceNet (incl. SN4 off-nadir) | `registry.opendata.aws/spacenet/` `[sub]` | 0.5 m WV-2 | keyless S3 | SN4 = 27 angles **but orthorectified** → multi-view in look only, no RPC; CC-BY-SA |
| NAIP (EarthExplorer) | `earthexplorer.usgs.gov/` `[sub]` | 0.6 m | free-registration | US only, ortho, public domain |
| NAIP on AWS | `registry.opendata.aws/naip/` · `s3://naip-source` `[sub]` | 0.6 m | keyless/requester-pays | US, ortho |
| NAIP on GEE | `developers.google.com/earth-engine/datasets/catalog/USDA_NAIP_DOQQ` `[sub]` | 0.6 m | free w/ GEE acct | US, ortho |
| Copernicus VHR Image Mosaics | `land.copernicus.eu/en/products/european-image-mosaic` `[sub]` | ~2–2.5 m | free-registration (CLMS) | pan-EU ortho mosaic |
| OpenAerialMap | `map.openaerialmap.org/` `[sub]` | sub-m (drone) | keyless API | crowd, patchy, ortho COG; CC-BY |
| ISPRS Vaihingen/Potsdam | `isprs.org/resources/datasets/benchmarks/UrbanSemLab/2d-sem-label-vaihingen.aspx` `[sub]` | 5–9 cm aerial | free-registration | ships DSM/nDSM (not raw stereo); research |
| xView | `xviewdataset.org/` `[sub]` | ~0.3 m | free | ortho chips; CC-BY-NC-SA |
| xView2 / xBD | `xview2.org/` `[sub]` | ~0.3 m | free | pre/post pairs (not stereo); CC-BY-NC-SA |
| USGS declassified (CORONA/KH) | `earthexplorer.usgs.gov/` `[sub]` | 1.8 m+ film | free-registration | some KH film stereo, no RPC (own bundle-adjust); public domain |
| Umbra Open Data (**SAR**) | `registry.opendata.aws/umbra-open-data/` `[sub]` | to 0.16 m | keyless S3 | radar, not optical; CC-BY 4.0 |
| Capella Open Data (**SAR**) | `registry.opendata.aws/capella_opendata/` `[sub]` | ~0.5 m | keyless S3 | radar, not optical; CC-BY 4.0 |

## EU Space Imaging — the exact links you asked for
- **Free samples (gallery):** `https://www.euspaceimaging.com/samples/` `[live: 200]` — 30 cm WorldView samples, email-form gated, links to 3D/DSM/tri-stereo *product* samples (`/products/3d-products/`).
- **Open-data gateway:** `https://www.euspaceimaging.com/open-access-data/` `[sub]` — routes to ESA TPM + Copernicus CCM, not an EUSI keyless feed.
- **Archive browser:** `https://apps.euspaceimaging.com/atom/` `[sub: 200]`.
- ⚠️ **Repo dependency dead:** `apps.euspaceimaging.com/atom/api/tara/library/search/ogc` now returns `ROUTE_NOT_FOUND` `[live]`. The current backend is AWS-Cognito-authed; full-res requires a paid quote. `apps/api/app/eusi.py` (`_SEARCH`, `_EXPORT`) targets the dead route → `source=eusi` splat path is broken from this egress.

## Bottom line for satellite-3D
- **Real building-3D needs stereo + RPC. Three keyless sets give it:** IARPA **MVS3DM**, IARPA **CORE3D**, **DFC2019/US3D** — all 0.3 m WV-3 over JAX/OMA/Argentina. Start here. (S3 access subagent-claimed; install `awscli` and `aws s3 ls --no-sign-request s3://spacenet-dataset/` to confirm.)
- **ESA TPM tasking** can task fresh stereo with RPC, but proposal-gated + ESA-states/Canada only.
- **Keyless ESA TPM samples + Airbus samples** are RPC-grade but single-look — good as inputs, not a stereo set by themselves.
- **Everything else (Maxar Open Data, EUSI samples, NAIP, Copernicus, OAM, ISPRS, xView, SpaceNet) is ortho-only** → flat texture, never true geometry. SAR (Umbra/Capella) is keyless but radar.
