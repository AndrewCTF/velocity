# Round 7 — NAIP keylessly via Planetary Computer, with a 14-year archive

**This is the answer for "the whole globe and new data" as far as free keyless data
goes** — with one honest caveat, stated up front: NAIP is **United States only**.
It is the finest *systematic, national, multi-year* free orthoimagery programme in
existence, and until now it was treated as gated. It is not, via this route.

## The route that works

Microsoft **Planetary Computer** STAC API — keyless, no subscription, no token:

```
https://planetarycomputer.microsoft.com/api/stac/v1/collections   -> 1.5 MB, HTTP 200
```

NAIP assets live in **public Azure blob storage**. A plain unauthenticated GET
returned a **452 MB** TIFF (`magic II*\0`) — no SAS token, no account key, no
signing call. That contradicts the usual assumption that Planetary Computer data
needs `planetarycomputer.microsoft.com/api/sas/v1/sign`.

Verified pull, no whole-scene download (GDAL `/vsicurl` range reads):

```
bbox=-100.0,39.0,-99.9,39.1   gsd=0.3
id      : ks_m_3909957_se_14_030_20230825_20231113
flown   : 2023-08-25
source  : naipeuwest.blob.core.windows.net/naip/v002/ks/2023/ks_030cm_2023/...
          39099/m_3909957_se_14_030_20230825_20231113.tif
scene   : 20262 x 25299 px, EPSG:26914, 4 bands, uint8, 0.3 m
crop    : 2000 x 2000 px = 600 m x 600 m at native resolution
```

Rendered at `satscrape/naip_out/naip_0.3m_2023-08-25.png` — individual cattle,
tilling patterns in the worked field, gravel road, tree shadows. Genuine
orthorectified aerial.

Tooling: `satscrape/grab_naip.py`.

## Correction: NAIP has 0.3 m data, not just 0.6/1.0

The NAIP collection metadata lists `gsd: [0.3, 0.6, 1]`. I had assumed 0.6 m was
the floor (which would fail your 50 cm bar) — that was wrong. 30 cm scenes are real
and present:

| State | items sampled | at 0.3 m | years present |
|---|---|---|---|
| **Kansas** | 63 | **9** | 2012, 2014, 2015, 2017, 2019, 2021, 2023 |
| **Louisiana** | 63 | **18** | 2010, 2013, 2015, 2017, 2019, 2021, 2022, 2023 |
| Texas | 36 | 0 | 2012–2022 |
| Utah | 45 | 0 | 2011–2021 |
| Indiana | 24 | 0 | 2012–2022 |

**14 years of archive, 2010 → 2023.** For agricultural change detection, flood
scour, construction tracking and land-cover history across the US, nothing else
free comes close. And unlike Esri Wayback, NAIP items carry an explicit
`datetime` per scene — the acquisition date is in the metadata, not inferred.

30 cm coverage is patchy (Kansas and Louisiana have it; Texas/Utah/Indiana do not
in the sampled boxes), so **filter on `gsd` per AOI rather than assuming**.

## Planetary Computer also carries Planet NICFI — but read the gsd

`planet-nicfi-visual` / `planet-nicfi-analytic` are on Planetary Computer, global
(`bbox: [-180, -34.16, 180, 30.15]`), and the names suggest sub-metre Planet
basemaps. **They are 4.77 m.** Not imagery for your purpose. Recording it here so
nobody else wastes time on the name.

## Other planetary-scale routes probed this round

| Source | Result |
|---|---|
| Planetary Computer STAC | ✅ keyless, 1.5 MB index |
| **NAIP on PC** | ✅ **keyless, 0.3 m, 2010–2023** |
| planet-nicfi-* on PC | 200 but 4.77 m — disqualified |
| Earth Search (AWS) STAC | 200, Sentinel-2 (10 m) |
| NASA GIBS | 200, **real JPEGs** — VIIRS/MODIS true colour, ~375 m |
| Sentinel-2 COG buckets | 200 / 404 depending on bucket name |
| Digital Earth Africa S1 | 400 |
| `nsidc-cumulus-prod-protected` | 403 (registration) |

GIBS is genuinely keyless with working imagery, but at ~375 m it is a basemap, not
sub-metre.

---

## Where this leaves the global question — honestly

You asked for whole-globe, new, sub-metre, keyless. The measured situation:

| Scope | Best keyless source | Resolution |
|---|---|---|
| **Globe** | Esri Wayback (196 dated releases, verified changing) | 0.134–0.269 m |
| **United States, 14-year archive** | **NAIP via Planetary Computer** | **0.3 m** |
| One US state/city | DC, NC, Brampton, +111 services | 0.08–0.15 m |

There is **no global 0.3 m keyless orthoimagery**, and after seven rounds that is a
settled finding rather than an open question. What NAIP adds is not more globe — it
is a far better *time series* and *fidelity* over one country, with per-scene
acquisition dates and native 4-band radiometry.

So the practical answer:

- **Anywhere on Earth, needs to be recent** → Esri Wayback.
- **US, needs 0.3 m or a multi-year baseline** → NAIP on Planetary Computer.
- **US city, needs the sharpest possible** → the 111 state/municipal services.
- **Global + sub-metre + keyless** → does not exist. The gap is ~2x, and closing it
  requires a commercial licence.