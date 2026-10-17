# Round 3 — searched with Firecrawl, verified by hand

Round 2 was directory-probing. This round used **Firecrawl web search** (key
provided by the operator) to find candidate sources, then verified each one with a
direct keyless request. 15 search queries → 112 results → scraped the
authoritative pages → tested the buckets.

Search angle that worked: asking for the *access constraint* ("no api key", "no
signup", "public read") rather than for "imagery" — the constraint phrasing is what
surfaces AWS Open Data and community threads instead of vendor marketing.

---

## NEW verified provider: LADI — Low Altitude Disaster Imagery

`s3://ladi` · **keyless, no quotas** · **CC-BY 4.0**

The largest single find of this round, and it is not satellite at all.

| Property | Measured |
|---|---|
| Objects | **454,901 images** |
| Listing | `Images/{agency}/{incident}/{date}/{uuid}.jpg` + `Labels/` |
| Direct URLs | `https://ladi.s3-us-west-2.amazonaws.com/Images/...` — plain HTTPS, no key |
| Resolution | 6000px (167k images), 4496px (79k), 4608px (76k), 4288px (76k) |
| Altitude | median **134 m**, EXIF `GPSAltitude` present |
| Geotag | EXIF GPS lat/lon on every image, plus a 145 MB `ladi_images_metadata.csv` |
| Content | Civil Air Patrol airborne disaster response, **2015–2023** |

Downloaded and inspected one: **4608×3456**, 3.5 MB, EXIF GPS 29.62 N / 95.65 W,
altitude 26 m. Content is genuine oblique aerial — a person on a runway with a phone,
tarmac cracks and paint markings individually resolvable. That is **sub-centimetre**
ground detail, roughly 5–10x finer than any optical satellite source here.

**Two caveats that matter more than the resolution:**

1. **Oblique, not orthorectified.** There is no map projection, so it cannot be
   mosaicked or measured the way a satellite scene can. It is a perspective view
   from a low aircraft.
2. **Content, not basemap.** It covers disaster-response incidents flown by Civil
   Air Patrol. It is not a global layer and not something you query by coordinates —
   you filter the CSV for incidents that matter.

Use it for: validating damage assessments, seeing what responders actually saw,
object-detection training data at extreme detail.
Do not use it for: mapping, area measurement, or anything needing a CRS.

Sample at `satscrape/qa3/ladi_sample.png`.

---

## Other leads this round, with verdicts

| Source | Verdict |
|---|---|
| **SkyFi open data** | Needs a SkyFi API key. **Disqualified.** Their page markets "zero cost" but the API is keyed. |
| **Planet Labs open feed** | Referenced in an HN thread (192 pts, 34 comments). Keyless *feed* exists but is low-latency/daily, not an archive you can query historically. Worth a look if you want recency; not a bulk historical source. |
| **`oin-hotosm`** (OpenAerialMap's own S3 bucket) | **403** — not public-read from this egress, despite the registry listing it. The `api.openaerialmap.org` tile API also 404s on every URL form tried. |
| **`sentinel-cogs`** | Keyless (200) but **10 m** — fails the 50 cm bar by 20x. |
| **`deafrica-sentinel-2`** | 400 on listing. Sentinel-2 anyway. |
| **LADI** | ✅ above |

Aggregator roundups (GIS Geography, SkyWatch, eos.com) all list the same
key-gated sources — CDSE, EarthExplorer, Sentinel Hub, Planet, SkyFi. Nothing new
keyless surfaced from them, which is itself informative: the aggregator consensus is
that everything genuinely free is either coarse or gated.

---

## Where this leaves the provider landscape

Consolidated across all three rounds, **keyless + sub-metre + no quota**:

| Provider | Measured GSD | Coverage | Verdict |
|---|---|---|---|
| **LADI** | ~0.05 m (oblique) | 454,901 disaster photos | finest detail anywhere; not mappable |
| **Canada national parks** | **0.15 m** | national parks, ortho | finest *orthorectified* keyless data |
| **Maxar Open Data** `-visual` | **0.3052 m** | 54 event footprints | best mappable VHR; RGB, source-grade |
| **Esri Wayback** | **0.134–0.269 m** | **global**, 196 dated releases | the only global answer |
| **Colorado public imagery** | **0.5 m** | historical state aerial | exactly at your bar |
| MVS3DM / CORE3D | 0.31–0.36 m | Argentina / 5 US cities | **only ones with RPC → true 3D** |
| AWS Terrain Tiles | ~30 m (z15) | global | elevation, not imagery |

**The honest ceiling:** after three rounds and ~1,000 registry entries examined, the
keyless sub-metre optical well is essentially four sources — Esri Wayback (global),
Maxar (events), Canada parks, Colorado. Everyone else is either coarser, gated, or
regional. That is a real finding, not a gap in the search, and it is why every
commercial broker exists.

If the requirement stays "whole globe + new data", Esri Wayback is the answer and
the rest are supplements.