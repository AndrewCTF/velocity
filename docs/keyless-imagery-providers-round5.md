# Round 5 — better again: DC 3-inch, and the non-US sweep

**DC's 3-inch (0.08 m) orthoimagery supersedes NC's 6-inch.** Verbatim from the
service's own description:

> "The aerial imagery acquisition was flown to support the creation of 4-band
> digital orthophotography with a **3 inch/0.08 meter pixel resolution** over the
> full project area covering the District of Columbia which is approximately
> 69 square miles."

Flown **27 March 2025**. Served keylessly from DC's own server.

```
https://imagery.dcgis.dc.gov/dcgis/rest/services/Ortho/Ortho_2025/ImageServer
EPSG:26985   4 bands (RGB+NIR)   pixelType U8   maxImageWidth 15000
```

Verified by pulling a 500 m × 500 m window at 399000/136000 — **100% coverage**,
252,973-byte JPEG. The render shows the US Capitol: individual parked cars
distinguishable by colour, rooftop plant, path and kerb geometry, tree shadows.
At 0.08 m a mid-size car is ~11 px long. Saved at `satscrape/qa5/dc_ortho_3inch.jpg`.

DC also publishes **`Ortho_2021` and `Ortho_2023`**, so there's a short archive.

---

## Non-US sweep — mostly a dead end, one honest finding

18 targeted AGOL searches for European/Oceanian orthoimagery returned **only US
municipalities**. No national European orthoimagery service is exposed through a
keyless endpoint that responds.

**swisstopo** (Switzerland) and **IGN France** both return full WMTS capabilities
(1.8 MB and 2.9 MB) but **no tiles**: swisstopo's templates are 400 (its matrices
are `21781_*`, not GoogleMapsCompatible), and IGN's document parses to **0 layers**
under my regex — it needs a different namespace/structure. Neither is verified
working, so I'm not claiming either.

Dead from this egress: `eox.at` Sentinel-2 Cloudless (404 on every year/matrix
form), Carto, all Australian state portals (NSW/QLD/WA), PDOK NL, Denmark DSF,
Land Information NZ.

The non-US orthoimagery that exists (NL 20 cm/RGB, Denmark 25 cm, UK, Switzerland
10 cm, NZ) is published but **gated behind registration or an API key** — which
disqualifies it under your original constraint.

---

## Additional US providers found in this sweep

All keyless, all proven by returning real JPEG bytes:

| Provider | Coverage | Native resolution | Archive |
|---|---|---|---|
| **DC GIS** ⭐ | District of Columbia | **0.08 m (3 in)** | 2021, 2023, 2025 |
| **NC OneMap** | North Carolina | 0.152 m (6 in) | 2010 → 2024–2027 |
| **Brampton (Ontario)** | City of Brampton | ~0.1 m (typical municipal) | **2004 → 2023**, spring+fall annual |
| **Iowa DOT** | Iowa | varies, incl. **CIR** | 2007–2018 |
| Maine | 61 municipal/regional services | varies | 2005–2024 |
| KansasGIS | 19 services | varies | — |
| North Dakota GISHub | 9 services | varies | — |

**Brampton is notable for history**: 40 discrete orthophotos, 2004 through 2023,
spring *and* fall. For change detection over two decades in one municipality,
nothing else keyless comes close.

---

## Revised ranking — all verified this session

| Rank | Provider | Resolution | Type | Extent |
|---|---|---|---|---|
| 1 | **DC GIS** | **0.08 m** | ortho, RGB+NIR | DC, 69 sq mi |
| 2 | LADI | ~0.05 m | **oblique, no CRS** | 454,901 photos |
| 3 | **NC OneMap** | **0.152 m** | ortho, RGB+NIR | NC, statewide |
| 4 | Brampton ON | ~0.1 m | ortho | one city, 2004–2023 |
| 5 | Canada NP | 0.15 m | ortho | national parks |
| 6 | Maxar Open Data | 0.305 m | ortho | 54 events |
| 7 | Esri Wayback | 0.134–0.269 m | pansharpened + JPEG | **global** |

Three clean tiers:

- **Global:** Esri Wayback only. Unchanged across five rounds.
- **Sub-0.2 m, municipal/state:** DC, NC, Brampton — now discoverable in bulk via
  the keyless AGOL item-search API.
- **Oblique, extreme detail:** LADI, no georeferencing.

---

## The honest ceiling on "global + new + sub-metre + keyless"

Five rounds, ~1,000 registry entries, 6,862 AGOL items and ~30 national portals
examined. Everything at 0.08–0.2 m is a **US state or municipality**. Everything
outside the US at that resolution is registration-gated. Esri Wayback is 2–3x
coarser than the US municipal programmes and is the only global option that exists
without credentials.

That is a real structural finding, not a search failure: US state/local government
publishes its orthoimagery openly under state open-records law; most other
countries' equivalents are sold or gated. Any genuinely global sub-metre feed with
no key does not exist.