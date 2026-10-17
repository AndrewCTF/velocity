# Keyless own-network feeds — maritime + aviation (2026-10-04)

**Scope:** flight-tracking / maritime sites exposing ADS-B or vessel positions
with **no login, no key, no registration**. Priority is providers that run their
**OWN receiver network** (government / satellite / proprietary), not ones that
re-publish another aggregator's feed — those carry genuinely unique coverage.

**Method.** Research only. No data-endpoint position pull was performed. Keylessness
was verified two ways: (a) from the **operator's own access-terms page**, and
(b) for the two new archive/blob finds, an anonymous HTTP probe of the **index /
HEAD only** (never a position payload). Read a provider's README is not
verification; the ADS-B Exchange case in `docs/decisions.md:758-761` is why.

**Relationship to existing work.** This does **not** overturn the standing finding
in `docs/adsb-keyless-ocean-coverage.md` or `docs/adsb-keyless-endpoints-ranked-2026-10-04.md`
that no keyless *ground-grid* endpoint has ocean coverage. That finding is
untouched and remains correct. What is new here is a **second axis**: national
maritime authority networks, which are the one class of keyless source that is
neither a volunteer rooftop grid nor an aggregator.

---

## 1. THE NEW FIND — USCG Nationwide AIS via NOAA Marine Cadastre

**This is the only genuinely unknown keyless source found. The repo has zero
mentions of it** (`grep -ri 'marinecadastre\|ocmgeodatastor\|noaaocm'` → 0 hits).

| | |
| --- | --- |
| **Operator** | US Coast Guard **NAIS** (Nationwide AIS) → NOAA Marine Cadastre / BOEM |
| **Own network?** | **YES** — a purpose-built US federal receiver network, not an aggregator. Acknowledgement in the dataset readme is literally "U.S. Coast Guard Navigation Center". |
| **Key / login** | **NONE.** Anonymous Azure blob. Verified below. |
| **License** | **CC0 1.0 Universal** — the most permissive license in this entire report, and the only one. |
| **Format** | GeoParquet 1.0.0, Snappy, WKB point geometry, WGS84, UTC, downsampled to whole minute |
| **Cadence** | Archive, not live. Daily broadcast points; monthly vessel tracks. |

Verified anonymous (index + HEAD only, **no payload downloaded**):

```
== 200  noaaocm.blob.core.windows.net/ais/gdb/gdb2009/index.html   (27,673 B index)
== 200  ocmgeodatastor1.../marinecadastre/ais/guam/index-guam.html (3,329 B)
== 200  ocmgeodatastor1.../marinecadastre/aistrack/index-aistrack.html (6,620 B)
HEAD ais-2024-01-01.parquet -> HTTP/1.1 200 OK, Content-Length 227181435 (227 MB)
```

Working keyless paths:

- Daily broadcast points 2024 — `https://ocmgeodatastor1.blob.core.windows.net/marinecadastre/ais2024/ais-YYYY-MM-DD.parquet` (max ~325 MB/day)
- Monthly tracks 2024–2025 — `.../marinecadastre/aistrack/ais-track-YYYY-MM.parquet`
- Bulk 2009+ annual zone zips — `https://noaaocm.blob.core.windows.net/ais/gdb/gdbYYYY/index.html` (e.g. `Zone15_2009_*.zip`, ~1.8 GB/zip — these are the large open-ocean US EEZ zones)
- ArcGIS transit-count REST services 2020–2024 — `https://coast.noaa.gov/arcgis/rest/services/MarineCadastre/AISVesselTransitCounts2024/MapServer`
- AccessAIS order tool — `https://marinecadastre.gov/accessais/` (map-driven custom extracts, ~2 GB cap, zipped CSV)

**Why this matters for the ocean question.** `Zone15`/`Zone16`/`Zone17` are
1.5–1.8 GB *per month* — these are the Hawaii / Guam / Pacific-remote EEZ
scraps, i.e. exactly the water where every keyless live feed measured zero.
NAIS is a **federal** network with receivers the volunteer grid does not have.
It is archive data, so it cannot feed a live globe — but it is the strongest
available answer to "where do vessels actually go when no live keyless feed
sees them", and it is CC0.

**Trap to record:** Azure blob **directory listing is not enabled**. `.../ais/`,
`.../ais/gdb/` and `.../ais2024/` all answer **404**, while the `index.html`
inside them answers **200**. A probe that walks directories will conclude the
bucket is dead. Fetch the `index.html`, don't list the parent.

---

## 2. Kystverket / Norwegian Coastal Administration — keyless, own network, INCLUDES SATELLITE

**Already in the repo and already marked dead from this egress**
(`apps/api/app/ais_pipeline/providers.py:15`: `kystverket  TCP NMEA
153.44.253.27:5631 — DEAD (connect timeout) from here`). Re-verified against the
operator's own page — **it is genuinely keyless, and the dead verdict is an
egress problem, not a gate.** Worth re-testing from another address.

> "The data are free and universally accessible, and are regulated under the
> Norwegian Licence for Open Government Data (NLOD). **Access does not require
> user registration.**"
> — `kystverket.no/en/sea-transport-and-ports/ais/access-to-ais-data/`

- **Raw NMEA TCP:** `153.44.253.27:5631`, standard IEC 62320-1 AIVDM/AIVDO.
  No account, no token — a `nc` to the socket is the whole client.
  Independently corroborated with real captured output in
  `jordanbell.info/blog/2023/04/24/Kystverket-AIS-ncat-gpsd-jq.html`
  (raw sentences + `gpsdecode` JSON), and by Kystverket's own
  `Kystverket/ais-dotnet` reference receiver.
- **Network size (own receivers, documented):** `ais-dotnet` README states the
  endpoint broadcasts sentences **"captured by over 50 base stations, and covers
  the area 40–60 nautical miles from the Norwegian coastline"** — an
  official-attribution number, not a marketing claim.
- **⭐ The satellite detail, and why it is the notable part.** The BarentsWatch
  developer docs state the open AIS dataset is collected from three source
  classes, of which **two are not terrestrial**:
  1. "The Norwegian Coastal Administration's terrestrial stations in Norway and on **Svalbard**"
  2. "**Offshore stations organized by Equinor**"
  3. "**Norwegian satellites**"

  Equinor offshore platforms are fixed installations in the middle of the
  North Sea / Barents Sea — genuinely offshore receivers, not coast. Combined
  with Norwegian satellites and Svalbard, this is the closest thing to a
  keyless **non-line-of-sight maritime** source found in this research.

- **Constraints (documented, not guessed):** Norwegian EEZ + Svalbard/Jan Mayen
  protection zones only; **no** fishing vessels <15 m; **no** leisure craft
  <45 m; no data older than 14 days.
- **⚠️ The REST/JSON API is NOT keyless — do not confuse the two.** The
  nicer BarentsWatch HTTP API (`live.ais.barentswatch.no/v1/latest/ais`,
  `/v1/ais`, `/v1/sse/ais`, `/v1/combined`) requires an OAuth2 client
  (`client_id`/`client_secret` from a registered account). Only the **raw TCP
  socket** is registration-free. Since `OpenWaters` already ingests a BarentsWatch
  aggregate (1.9k, per `ais_pipeline/providers.py:395`), adding the socket would
  be a *dedup* question, not a coverage win — unless the satellite/offshore
  rows are genuinely absent from OpenWaters' accepted longitude window.

---

## 3. Other national authority networks surveyed

| Provider | Own network | Keyless? | Verdict |
| --- | --- | --- | --- |
| **USCG NAIS / Marine Cadastre** | yes (federal) | **YES**, CC0 | **Use it** — §1, archive |
| **Kystverket (Norway)** | yes + **satellites** | **YES** (raw TCP only) | **Re-test from another egress** — §2 |
| **Digitraffic / Fintraffic (Finland)** | yes (state) | YES (`meri.digitraffic.fi/api/ais/v1/vessels`) | Already in pipeline (Baltic, 30 s). Regional only. |
| **Kystdatahuset (Norway)** | yes | YES, GeoJSON | Already polled by `ais_keyless`. |
| **AMSA (Australia)** | yes (CTS, terrestrial **+ satellite**) | Portal is free; monthly zipped shapefiles | **Archive, worth a look** — covers all of Australia's SAR region incl. Great Australian Bight / Bass Strait, i.e. ocean water. `operations.amsa.gov.au/spatial/DataServices/DigitalData` |
| **Danish Maritime Authority** | yes (shore-based, now under Danish Emergency Mgmt Agency) | Historical CSV free; live access is a request form | Historical only. `dma.dk/safety-at-sea/navigational-information/ais-data` |
| **Japan Coast Guard** | yes | No public position API found | — |
| **Korea KCG** | yes | No public position API found | — |
| **Rijkswaterstaat (NL)** | yes | No public AIS position API found | — |

---

## 4. Corrections to existing repo claims

**a) `marinesia.com` is NOT keyless.** The Open Data Stack Exchange answer
("It's totally free, no need base station to get API key") is a **misreading**:
"no need base station" refers to *not needing your own AIS base station*, not to
the API key. `marinesia.com/docs` shows the key is a **required query
parameter** on every documented call:
`GET https://api.marinesia.com/api/v1/vessel/{mmsi}/location/latest?key=YOUR_API_KEY`.
A second user in the source thread corrects it directly: "I just checked
marinesia.com, but that API requires api key." Anyone who picks this up from
that thread without opening `/docs` will burn a cycle.

**b) The hpradar "8 stations in Hai Phong, Vietnam" claim is CONFIRMED — from
hpradar's own homepage, with useful new detail.** The claim lives at
`docs/adsb-keyless-ocean-coverage.md:64` (not `decisions.md`). Fetched
`hpradar.com` — it enumerates exactly 8 stations, all in Hai Phong:

- **ADS-B #01–#04** — "AN DUONG", "AN DUONG", "TCA", "CVT" → `a1`–`a4.hpradar.com`
- **AIS #01–#04** — "AN DUONG", "AN DUONG", "THUY NGUYEN", "THUY NGUYEN" → `m1`–`m4.hpradar.com`

The number checks out. **But the detail sharpens the existing conclusion rather
than overturning it, and one correction is worth making:** each station runs
**multiple feeder dockers simultaneously** — station #1 is described as
running "readsb-protobuf, **fr24, radarbox, flightaware and tar1090** docker
images", and the AIS stations feed "**MT, FM, VT, VF**" (MarineTraffic, FleetMon,
VesselFinder, VesselFinder) via AIS-catcher. So `skylink.hpradar.com` is **not a
Vietnamese-coverage mirror at all** — it is a Vietnamese-operated node that
**re-publishes other people's global aggregators**. That is a stronger and more
precise explanation for its tiny measured marginal contribution (45 aircraft /
9 ocean) than "8 stations in Vietnam" is. Worth patching that line: the 8
stations explain *where the hardware is*, not *why the feed is a mirror* — the
feeder-docker list explains the mirror.

---

## 5. Aviation side — nothing new that beats the existing shortlist

The task asked for flight-tracking too. Result: **no new keyless aviation
endpoint found** that isn't already in
`docs/adsb-keyless-endpoints-ranked-2026-10-04.md`.

Checked and rejected:

- **AirNav RadarBox** — runs a real proprietary ground + satellite network
  (exactly the class that would qualify), but every data path is gated:
  `airnavradar.com/api/documentation` requires an On-Demand API key, and the
  Firehose API is a commercial product. Live map ≠ keyless feed — same shape as
  the Global Fishing Watch case already recorded at
  `ais_pipeline/providers.py:437-441`.
- **ADS-B Networks / NAVBLUE** — commercial, keyed.
- **marinesia, VesselAPI, AISStream, AISHub, exactEarth, FleetMon, Kpler,
  Spire, MarineTraffic, VesselFinder, GFW** — all already recorded as key-gated
  or 401 in `docs/ais/keyless-provider-probe-report.md`; re-confirmed, no change.
- The known-dead set (`fdy.cz`, `330k.info`, `tar1090.adsb.im`) is still the
  cheapest remaining unknown and is untouched by this research.

The ranked shortlist's row 1 (FR24 `feed.js` — satellite + MLAT fused, the only
keyless **non-line-of-sight** aviation candidate) remains the highest-value
unmeasured item. This research found nothing that displaces it.

---

## Recommended next measurements

1. **Re-probe Kystverket TCP from a different egress** — it is confirmed
   keyless and it is the only source with documented satellite + offshore
   Equinor receivers. The DEAD verdict in `providers.py:15` is one address.
2. **Pull one Marine Cadastre daily parquet** (227 MB, CC0) and run the repo's
   existing land mask + ocean-box logic against it — the first honest
   measurement of where USCG NAIS actually sees vessels in the remote Pacific
   EEZ zones (`Zone15`–`Zone17`).
3. **FR24 `feed.js` ocean yield** — unchanged, still the top open question on
   the aviation side.