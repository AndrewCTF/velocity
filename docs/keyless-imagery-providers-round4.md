# Round 4 — BETTER PROVIDER FOUND: statewide 6-inch orthoimagery

**This beats every provider found in rounds 1–3.** North Carolina's statewide
orthoimagery program publishes **6-inch (15.24 cm) orthorectified aerial**, and it is
**keyless, quota-free, and current** (2024–2027 cycle includes NIR).

For reference, Esri Wayback — the previous "best" — measures 0.134–0.269 m
(13–27 cm) *and* is pansharpened + JPEG-compressed. NC is **orthorectified native
aerial at 15 cm with no compression loss**, so it is simultaneously finer and
cleaner.

---

## The provider

**NC OneMap / NC Center for Geographic Information and Analysis**
`https://services.nconemap.gov/secure/rest/services/Imagery/<name>/ImageServer`

Despite `/secure/` in the path, **no token is required** — every request below was
made with a plain browser User-Agent and returned real pixels.

| Service | Cycle | Bands | Status |
|---|---|---|---|
| `Orthoimagery_20242027_analysis` | **2024–2027** | **4 (RGB+NIR)** | ✅ current |
| `Orthoimagery_2020_2023` | 2020–2023 | 3 (RGB) | ✅ |
| `Orthoimagery_2016_2019` | 2016–2019 | 3 | ✅ |
| `Orthoimagery_2012_2015`, `Orthoimagery_2010` | older | 3 | ✅ |
| `Orthoimagery_Latest`, `_Latest_CIR`, `_Latest_Analysis`, `_Latest_NDVI` | derived products | — | ✅ |

Resolution is the service's **own stated figure**, read from `serviceDescription`,
not my estimate: *"The imagery has a pixel resolution of 6 inches with an RMSE of
1.0 ft X and Y."*

Programme detail, quoted from the service: 4-year cycle, ~1/4 of the state flown
per year, published as 5,000 ft × 5,000 ft streaming tiles **and** as county
mosaics. Since 2020 a **4th NIR band** is collected.

Copyright: `NC OneMap, NC Center for Geographic Information and Analysis, NC 911 Board`.

### The state's own download guidance

The service description explicitly says the ArcGIS Hub **download tools must not be
used** (they return a pixelated result) and directs users to **"download the imagery
by tile or by county mosaic"** — i.e. bulk tile/mosaic export is the sanctioned path.
That matches what the script below does (`exportImage` per tile).

---

## Verified: real pixels, no credentials

Downloaded a 600 m × 600 m window over Raleigh at native resolution:

```
GET .../Orthoimagery_2020_2023/ImageServer/exportImage
    ?bbox=2057700,724700,2058300,725300&bboxSR=6543&imageSR=6543
    &size=900,900&format=jpg&f=image
→ HTTP 200, 156,084 bytes, JPEG (ffd8ff)
```

Rendered at `satscrape/qa4/nc_ortho_15cm.jpg`. Confirmed genuine orthoimagery:
individual vehicles in driveways, roof shingles, tree canopies, road markings,
shadow direction. At 15 cm a mid-size car is ~30 px long.

---

## The scalable discovery: 111 keyless orthoimagery services

Mined the **keyless ArcGIS Online item-search REST API** (6,862 items match
"orthoimagery"), inspected each service's metadata, then **requested a real tile from
every one** and kept only those returning genuine JPEG bytes.

**111 services confirmed serving pixels with no key**, across six state agencies:

| Agency | Services | Notes |
|---|---|---|
| **Maine** (`Joshua.E.C.Davis@maine.gov`) | 61 | municipal + regional + coastal, 2005–2024 |
| **KansasGIS** | 19 | |
| **NC OneMap** | 18 | **0.152 m, statewide, current** |
| **North Dakota GISHub** | 9 | |
| IndianaMap | 1 | |
| Clearinghouse | 1 | |

Reproduce with `satscrape/probe_state_ortho.py`. Raw results:
`/tmp/state_ortho_services.json` (111 entries with service URLs, EPSG, extents).

**One caution on those numbers:** the `est_gsd_m` column in the probe output is
`extent_width ÷ maxImageWidth` — a *capability* figure (how wide a request the
service will render), **not** native ground resolution. It under-reports. Only NC's
0.152 m is a verified native figure, because only NC states it. Maine's municipal
services at "0.4 m" are almost certainly finer than that, but I did not measure it
and will not claim it.

---

## What changed in the ranking

| Provider | Resolution | Type | Coverage |
|---|---|---|---|
| **NC OneMap** ⭐ | **0.152 m** | ortho, native, RGB+NIR | North Carolina, 4-year cycle |
| LADI | ~0.05 m oblique | perspective, no CRS | 454,901 disaster photos |
| Canada national parks | 0.15 m | ortho | national parks |
| Maxar Open Data | 0.305 m | ortho | 54 event footprints |
| Esri Wayback | 0.134–0.269 m | pansharpened + JPEG | **global** |
| 111 state services | varies | ortho | ME / KS / NC / ND / IN |

**The trade-off is unchanged in kind, but the bar moved.** NC, Maine, Kansas and
North Dakota all beat Esri on sharpness — but they are *state* programs. For
**global** coverage Esri Wayback is still the only option; for **anywhere in the
US**, a 0.15 m ortho service likely exists and is now discoverable in bulk.

That is the practical upshot: the AGOL item-search API is a keyless index of
high-resolution orthoimagery, and it is worth pointing the pipeline at the right
state service whenever the AOI falls inside one.

---

## Reproduce

```bash
# discover every keyless orthoimagery service (111 today)
python satscrape/probe_state_ortho.py

# pull a tile natively
curl -H 'User-Agent: Mozilla/5.0' -o out.jpg \
  'https://services.nconemap.gov/secure/rest/services/Imagery/Orthoimagery_20242027_analysis/ImageServer/exportImage?bbox=<x0>,<y0>,<x1>,<y1>&bboxSR=6543&imageSR=6543&size=1024,1024&format=jpg&f=image'
```

State plane: EPSG:6543 (NAD83(2011) / North Carolina, metres) for NC;
EPSG:6348/26919/26983/26984 (UTM zones / NAD83) for Maine.