# Free keyless satellite imagery — measured, with the coverage question answered

Every number here was measured this session from live HTTP responses. Method and
raw output are in `satscrape/`.

Constraint: **no API key, no credit-metered quota.** That rules out CDSE/Copernicus,
ESA TPM, USGS EarthExplorer, Google Earth Engine, and every commercial broker.

---

## The short answer

**Esri "Wayback" is the only source that is global, current, sub-metre, keyless
and quota-free at the same time.** 196 dated world releases spanning
**2014-02-20 → 2026-08-05**, refreshed roughly every 4 weeks.

Measured native resolution **0.134–0.269 m/px** (see the method section — this is
measured from the pixels, not quoted from marketing).

### Verified global reach, 2026-08-05 release

Six cities, all HTTP 200, none of which has any Maxar Open Data event footprint:

| Place           | Tile (z19)    | HTTP | Bytes |
| --------------- | ------------- | ---- | ----- |
| Nairobi, KE     | 315767/264022 | 200  | 17750 |
| Lhasa, Tibet    | 394817/216895 | 200  | 11676 |
| Reykjavik, IS   | 230191/139324 | 200  | 15449 |
| Ulaanbaatar, MG | 417828/182467 | 200  | 15564 |
| Perth, AU       | 430877/311292 | 200  | 18074 |
| Manaus, BR      | 174733/266690 | 200  | 17458 |

The Nairobi mosaic (`global_check/nairobi_z19.png`) resolves individual cars in
car parks, rooftop HVAC units, road markings and shadows. That is genuine 0.24 m/px
urban imagery.

**Freshness caveat, measured not assumed:** a release _date_ is not an _acquisition_
date. Esri mosaics pull best-available imagery per tile, so a 2026 release can
still serve 2024 photography. The 2026-08-05 metadata layer returned
`SRC_DATE=None` for both Nairobi probes, so treat the release date as an upper
bound on freshness, not the acquisition date. Querying per-tile `SRC_DATE` is the
only way to know, and it did not answer here.

---

## What I got wrong, and why it matters

I spent most of this session building toward **Maxar Open Data** as "the best
provider". It is the best _quality_ source — genuinely 0.3052 m/px RGB, uint16
PAN at 0.45–0.60 m/px, un-JPEGed source bands — but it is **event-scoped**:

- 55 events, of which 54 publish PAN. Verified scene counts: Hurricane-Melissa
  6167, Morocco-Earthquake 6000, Hurricane-Ian 4207, … Idalia 677.
- Coverage is per-disaster footprints. **Nairobi, Lhasa, Reykjavik, Ulaanbaatar,
  Perth and Manaus have no Maxar footprint at all.**

So it is excellent for before/after on a specific event and useless as a global
layer. If your requirement is "whole globe + new data", Maxar is the wrong answer
and Esri Wayback is the right one. That distinction is the main finding here.

### Measured Maxar quality (for event work)

| Product       | Measured                              | Notes                                   |
| ------------- | ------------------------------------- | --------------------------------------- |
| `-visual.tif` | **0.3052 m/px**, 3-band RGB uint8     | Maxar's own pansharpen, needs no fusion |
| `-pan.tif`    | **0.4468–0.5964 m/px**, 1-band uint16 | true 16-bit radiometry, no JPEG         |
| `-ms.tif`     | **1.74–2.19 m/px**, 8-band uint16     | BGR + SWIR                              |

`global_check/` aside, the pulled PAN is at
`satscrape/src_out/*_pan_*.png` (greyscale, unprocessed) and the colour at
`satscrape/src_out/*_visual_*.png`. Coverage is partial — `tile:data_area` runs as
low as **19–28%** on some scenes, so a point can be geometrically inside a scene
and still be empty. `source_grab.py` handles this by locating real pixels via the
COG overviews rather than trusting the requested point.

---

## Why the imagery looks soft (correction)

Not satellite motion. WorldView-2/3 are three-axis stabilised; motion blur is not
the cause at this GSD. The softness is:

1. **Pansharpening** — 0.3 m PAN fused with 1.2–2.2 m multispectral to make colour.
2. **JPEG in the tile pyramid** — Esri ignores `?f=png`, `?quality=100` and
   `?format=tiff`; every variant returned byte-identical 14727-byte `image/jpeg`
   (measured, `ffd8ffe0` magic). There is no lossless tile path.

That second point is the hard ceiling: **to get above the basemap you must leave
the tile pyramid** and read source COGs off S3. That is exactly what
`source_grab.py` does.

---

## The pipeline

`satscrape/` — keyless throughout, browser UA, 6 req/s cap.

| Script              | Purpose                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `scrape_imagery.py` | bbox+zoom → tiles → georeferenced GeoTIFF. Rate-limited, blank-tile detection, `grid.json` sidecar.                   |
| `stitch_mosaic.py`  | Tiles → GeoTIFF (EPSG:3857). `nodata=0` + mask band so a dropped tile is never mistaken for dark imagery.             |
| `native_gsd.py`     | Pyramid-consistency native-resolution measurement.                                                                    |
| `source_grab.py`    | Pulls **source** bands (`pan`/`ms`/`visual`) from Maxar COGs over HTTP ranges, auto-locating real data via overviews. |
| `make_preview.py`   | Overview + 1:1 native crop PNGs, nodata painted magenta.                                                              |

### Verified runs

```
Gaza City, Esri Wayback 2025-12-18, z19
  3120 requested, 3119 saved, 1 failed, 50.4 MB, 552 s
  mosaic 15360x13312 px, EPSG:3857, 0.2986 m/px, coverage 99.97%
  -> 1 hole NAMED (tile 312354,213741) and masked, not silently black

Florida, Maxar -visual.tif (keyless S3)
  0.3052 m/px, 3-band RGB uint8, 68.2% data coverage
```

### Tests

`satscrape/test_stitch_mosaic.py` — 5 passed. Covers Web Mercator georeferencing,
tile placement (not transposed), hole detection + masking, and the coverage gate.

---

## Licensing

- **Esri** — `server.arcgisonline.com/robots.txt` returns 200 with
  `User-agent: *` / `Disallow:` (empty = permitted). Terms still restrict use to
  Esri/ArcGIS products and forbid bulk redistribution. Fine for one-off research
  reads; do not ship as a basemap product.
- **Maxar Open Data** — CC-BY-NC-4.0 on the STAC catalog. Non-commercial.
- **Google / Bing tiles** — implemented and measured (both keyless; Google 0.134
  m/px, Bing 0.905 m/px), but both ToS forbid automated bulk downloading. Opt-in
  only, do not productionise.

---

## If you need true 3D, not just ortho

Ortho tiles can only ever texture a flat surface. Real 3D needs multi-view
stereo + RPC. The only keyless sets that provide it:

- **IARPA MVS3DM** — `spacenet-dataset/Hosted-Datasets/MVS_dataset/`, keyless.
  Measured from the NITF `IMD`: PAN `meanCollectedGSD` **0.36 m**, 47 WV-3 views
  over Argentina, `RPC00B` on every scene. MIT (JHU/APL).
- **IARPA CORE3D** — `Hosted-Datasets/CORE3D-Public-Data/`, keyless, ~0.31 m,
  Jacksonville/Omaha/Richmond/Tampa/UCSD, RPC-bearing NITF + VRT.

Both are single-region, but they are the only free keyless data with a camera
model attached.
