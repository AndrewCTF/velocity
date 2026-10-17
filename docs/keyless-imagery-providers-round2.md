# Keyless imagery & elevation providers — round 2

Continuation of the round-1 findings. Everything here was **measured this session
with live requests**. Web search was unavailable (no Firecrawl key) and Reddit's
public JSON API returns 403 from this egress, so discovery was done by probing
registries, service directories and bucket listings directly, then verifying each
hit with a real fetch.

Searched: 16 Q&A threads across 7 Stack Exchange sites (their API works keylessly),
the AWS Open Data registry (1,000 entries, 64 EO candidates filtered), and 25 direct
service probes. Reddit was attempted across 6 subreddits and blocked.

---

## Newly verified, keyless

### AWS Terrain Tiles — global, no key, no quota

`https://s3.amazonaws.com/elevation-tiles-prod/`

| Product               | Path                      | Measured                   |
| --------------------- | ------------------------- | -------------------------- |
| Terrarium (elevation) | `{layer}/{z}/{X}/{Y}.png` | decodes to **real metres** |
| Normal (hillshade)    | same                      | PNG                        |
| GeoTIFF               | `{layer}/{z}/{X}/{Y}.tif` | z14 and below only         |

**X comes before Y** — verified against a real listing (`terrarium/10/301/0.png`
exists; `terrarium/10/0/301.png` does not).

Elevation decoded from the Terrarium formula `(R*256 + G + B/256) - 32768`:

| Place         | z15 decoded elevation | Reality check                    |
| ------------- | --------------------- | -------------------------------- |
| Denver, CO    | **1596 m**            | correct for the Mile High City   |
| Mount Everest | **8364 m**            | plausible summit-region value    |
| Dead Sea      | **−412 m**            | correctly below sea level        |
| Nairobi, KE   | 1664 m                | correct for the Kenyan highlands |
| Amazon, BR    | 42 m                  | correct for lowland rainforest   |

These are not placeholders. Dead Sea reading negative is the clearest proof the
radiometry is real.

**Coverage ceiling, measured:** the pyramid stops at **z15**. Bucket listing returns
zero keys at z16/z17, so z18 probes 404 legitimately — not a malformed URL. At z15
one tile is ~1.2 km at the equator, so this is a global _coarse_ elevation layer, not
a DEM for detailed terrain work.

### Ordnance Survey Open Data — catalogue keyless, downloads are NOT

`https://api.os.uk/downloads/v1/products` returns **200, 13,987 bytes, 26 products**
with no credentials (GeoTIFF/GeoPackage/MBTiles, current version 2026-06).

But the actual file endpoint returns a timestamped **404** JSON error — downloads
require an API key. So: **discovery is free, bulk data is not.** Metadata and
structure only. Listed here so nobody burns time on it.

---

## Probed and rejected, with the reason

| Candidate                                                   | Result                                                | Verdict                                      |
| ----------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| `naip-source` / `naip-analytic` / `naip-visualization`      | **403**                                               | registration-gated; also 0.6 m fails the bar |
| USGS nationalmap WMTS                                       | capabilities 200, every tile form **400 Invalid URL** | advertises WMTS, serves no imagery           |
| BC Geo `BC_Ortho`                                           | 200 but `Service not found`                           | wrong service name                           |
| NLS Scotland, NSW, WA Landgate, QLD, MDPI Malta, IGN France | 404 / URLError                                        | unreachable or retired from here             |
| Wikimedia tiles                                             | **403**                                               | UA-gated                                     |
| Versatiles, openfreemap, AWS terrain z18                    | 404 / empty                                           | wrong path or beyond coverage                |
| NASA Planetary Computer `/api/v1/collections/naip`          | 404                                                   | needs the item-search route, no tiles        |
| Sentinel-2 / Landsat / Umbra / Capella                      | 10 m / 30 m                                           | fail the resolution bar regardless           |

---

## Live ArcGIS services that DID answer (200 + valid JSON)

Usable as discovery or as extra basemap layers, though not sub-metre imagery:

| Service                        | Endpoint                                                               |
| ------------------------------ | ---------------------------------------------------------------------- |
| ArcGIS Light Gray Canvas       | `services.arcgisonline.com/.../Canvas/World_Light_Gray_Base/MapServer` |
| ArcGIS World Topo              | `server.arcgisonline.com/.../World_Topo_Map/MapServer`                 |
| ArcGIS Ocean Base              | `services.arcgisonline.com/.../Ocean/World_Ocean_Base/MapServer`       |
| **WorldElevation3D Terrain3D** | `elevation3d.arcgis.com/.../WorldElevation3D/Terrain3D/ImageServer`    |
| ArcGIS World Imagery           | `services.arcgisonline.com/.../World_Imagery/MapServer`                |

`basemap.arcgis.com` (World_Basemap_v2) did not resolve from this egress.

---

## Standing conclusion (unchanged by round 2)

For **global + current + sub-metre + keyless + unlimited**, only **Esri Wayback**
qualifies: 196 dated world releases (2014-02-20 → 2026-08-05), measured native
**0.134–0.269 m/px**, verified live at Nairobi / Lhasa / Reykjavik / Ulaanbaatar /
Perth / Manaus.

Round 2 adds two genuinely useful things and no new optical provider:

1. **AWS Terrain Tiles** — a global elevation/bathymetry layer, keyless, verified by
   decoded elevations that match reality. Pairs with any optical source for 3D work.
2. **Confirmation that the free sub-metre optical well is largely tapped out.**
   Everything else keyless is either coarser than 0.5 m, event-scoped (Maxar), or
   regionally tiny (Colorado, Canada parks). That is a real ceiling, and it is why
   commercial brokers exist.

The 0.15 m Canada and 0.5 m Colorado finds from round 1 remain the finest keyless
optical data available — both **regional**, both on AWS Open Data, both OGL/open.
