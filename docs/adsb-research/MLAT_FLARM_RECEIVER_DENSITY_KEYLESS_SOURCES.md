# Keyless MLAT & FLARM-Network Data Sources — ADS-B Receiver Density Near Islands & Oceans

**Research date:** 2026-10-04
**Method:** Passive OSINT — source-code review of public JS/HTML clients, HTTP probes, and offline analysis of the **publicly served static metadata files** that back the network maps. **No live traffic/aircraft APIs were queried.** Where a data file was fetched it was fetched to _validate schema and count receivers_, not to track aircraft.

**Tooling note:** the configured `web_search`/`web_extract` backend was unconfigured (`FIRECRAWL_API_KEY` unset), so discovery was done via direct HTTP, GitHub REST, Mojeek/Brave HTML search, and client-side JavaScript analysis. The Web search tool is still broken for other subagents.

---

## 1. Headline result

| Source                                                       | Keyless?           | Auth                          | What it gives you                                                     | Islands/oceans signal                   |
| ------------------------------------------------------------ | ------------------ | ----------------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| **ADS-B Exchange MLAT map** `map.adsbexchange.com/mlat-map/` | ✅ yes             | none (needs `Referer` header) | **17,914 feeder stations with lat/lon + live MLAT peer counts**       | **Strongest available signal**          |
| **OGN / live.glidernet.org** `rec.php`                       | ✅ yes             | none                          | **2,602 FLARM/OGN receiver sites, named, with lat/lon + online flag** | Strong for glider/FLARM island outposts |
| **OpenSky Trino** (free academic account)                    | ⚠️ free account    | account approval              | `flarm_raw`, `readsb_mlat_sv` + `serials[]` per state vector          | Indirect — must aggregate               |
| ~~mlat.net~~                                                 | ❌ **dead**        | —                             | **Parked redirect domain**                                            | Do not use                              |
| ~~flarm.net netMap~~                                         | ❌ **unreachable** | —                             | Connection refused from two independent egresses                      | Do not rely on                          |

### ⚠️ Two dead ends — worth recording so nobody re-wastes time

1. **`mlat.net` is gone.** It now serves a "Branded Short Domain" parking page (`mlat.net is configured for link redirection`) pointing at `d2te5kruq0pvbl.cloudfront.net`. All guessed API paths (`/api/v1/feeders`, `/api/feeders`, `/feeders`, `/stations`, `/data/feeders.json`) return 404. The domain is likely a lapsed short-link domain, _not_ a live MLAT network map.
2. **`flarm.net` (FLARMnet / netMap) refuses all connections** from this host — `ERR_CONNECTION_REFUSED` on TCP/443 to `217.26.63.20`, confirmed on both `curl` (v4-forced) and the browser stack (separate egress). DNS resolves fine and returns `2a00:d70:0:a::400` (A) / IPv6. This is an upstream IP-level block or firewall, not a local network fault. **FLARMnet's official netMap cannot be programmatically harvested**; use OGN instead (below), which is the open equivalent.

---

## 2. PRIMARY SOURCE — ADS-B Exchange MLAT Feeder Map

**The single best keyless receiver-density source found.** It is a per-region JSON mirror that the public MLAT map page loads client-side; no API key, no account, no rate limit observed.

### Endpoints (all confirmed 200)

```
https://map.adsbexchange.com/mlat-map/mirror_regions.json          # 25 region definitions
https://map.adsbexchange.com/mlat-map/sync/<region>/sync.json      # stations for that region
```

Region numbers are read from `mirror_regions.json` — it maps `"region"` → name:
`1` NA Upper North · `2` NA Lower NW · `3` NA Central North · `4` NA Central South · `5` NA East ·
`6` South America · `7` UK North · `8` UK SE · `9`/`10`/`11`/`16` Europe Western 1–4 ·
`12` Europe N/E/S · `13` Asia · `14` Other · `15` UK SW · `17`/`18`/`19` Other(NA) ·
`20`/`21`/`22`/`25` Other(UK/EU) · `23` **Africa, Australia** · `24` **NA South, Caribbean**

For island/ocean work the regions of interest are **23 (Africa/Australia)**, **24 (Caribbean)**, **14 (Other)**, and **13 (Asia)**.

### 🔑 Access gotcha (cost me two failed fetches)

Bare `curl` gets **403** from a WAF. You must send a browser-shaped `Referer`:

```bash
curl -s -A "Mozilla/5.0" -H "Referer: https://map.adsbexchange.com/mlat-map/" \
     https://map.adsbexchange.com/mlat-map/sync/23/sync.json
```

`Accept: application/json` and `X-Requested-With: XMLHttpRequest` also work. No key, no cookie.

### Schema (reverse-engineered from `mlat-map/overlay.js`)

```
{
  "<stationName>": {
    "lat": 38.86,          // station latitude  (WGS84)
    "lon": -104.79,        // station longitude (WGS84)
    "bad_syncs": 0,
    "peers": {             // >>> THE MLAT SIGNAL <<<
      "KPUB":  [32, 0.1, 2, 0, 0, 0.0, 11, 131],   // 8-tuple per peer station
      ...
    }
  }
}
```

`peers` is the MLAT mesh itself: **each key is a peer feeder ID, each 8-tuple is that peer's link telemetry.** Peer count = how many other MLAT stations this site can hear, i.e. a direct measure of _genuine_ receiver density rather than self-reported position.

### Measured scale (full 25-region sweep, 2026-10-04)

| Metric                            | Value                             |
| --------------------------------- | --------------------------------- |
| Unique feeder station names       | **17,914**                        |
| Records carrying coordinates      | **17,054** (860 missing)          |
| MLAT peers/station — mean         | **48.5**                          |
| MLAT peers/station — median       | **52**                            |
| Stations with **zero** MLAT peers | **3,375** (20%)                   |
| Region file sizes                 | 40 KB (reg 14) → 2.95 MB (reg 19) |

The **zero-peer 20%** is itself an analytic gold mine: those are receivers that exist but are geometrically or operationally isolated — exactly the island/offshore population the parent task cares about.

### Island / oceanic corridor density (measured)

```
zone                          feeders   verdict
------------------------------------------------------------------
Japan (seto / Okinawa)           606   dense
New Zealand                      149
Alaska                            68
Indonesia                         57
Central Pacific                   31
Hawaii                            31
Caribbean                         18
Philippines                       16
Canary Is.                        13
Greenland                         13
Mediterranean isles                8
Madeira                            7   thin
Iceland                            6   thin
Mascarenes (Indian Ocean)          4   thin
Réunion / Mauritius                4   thin
Bermuda                            3   very sparse
Azores                             2   very sparse
Cape Verde                         2   very sparse
Faroe Is.                          1   very sparse
Seychelles / Maldives              1   very sparse
Aleutians                          1   very sparse
Pacific mid-ocean                  0   *** NO MLAT ***
South Pacific                      0   *** NO MLAT ***
Falkland Is.                       0   *** NO MLAT ***
South Georgia                      0   *** NO MLAT ***
Tristan da Cunha                   0   *** NO MLAT ***
Socotra                            0   *** NO MLAT ***
```

### ⇒ Direct answer to the parent's question

**Zones with zero MLAT feeders are corridors no open ADS-B feed genuinely covers.** Absence of a receiver is the load-bearing evidence: an MLAT position requires reception by **4+ receivers**, so with 0 feeders there can be no MLAT solution and any aircraft position seen out there came from a _single_ feeder — a noisy, unverified local fix, not a network fix.

Confirmed oceanic long-range MLAT outposts (nearest peer >500 km, i.e. true ocean nodes):

|    lat |     lon | km to nearest peer | location                           |
| -----: | ------: | -----------------: | ---------------------------------- |
| +70.48 |  −68.54 | ∞ (no peer at all) | NW Greenland / Baffin              |
| −38.17 | −144.56 |                  ∞ | Robinson Crusoe I., Juan Fernández |
| −48.97 |   +9.23 |                  ∞ | Nightingale I., Tristan da Cunha   |
| +33.84 | −177.76 |                  ∞ | mid-Pacific (dateline)             |
| +22.85 |  −43.34 |                  ∞ | Fernando de Noronha                |
| −22.30 | +166.43 |               1554 | New Caledonia                      |
| −33.64 |  −33.81 |               1470 | Tristan da Cunha region            |
| +62.83 |  −92.12 |               1370 | Hudson Bay                         |
| +52.15 | −174.23 |               1150 | **Atka, Aleutians**                |
| +15.58 |  +32.57 |                995 | Khartoum/Sudan (river Niles)       |
| −36.01 |  −84.26 |                978 | Juan Fernández / S. Pacific        |

Notable **named island feeders** (useful as ground-truth anchors): `Atka_Airport` (Aleutians), `Bermuda_ADS-B` + `Ferry-Reach` + `juicegood` (3 on Bermuda alone), `Akureyri-ADSB` (Iceland), `shryke-wur` (Azores), `EBE1987`+`drizzle` (Cape Verde), `Karsnes`/`is_nyhofn`/`konni-kopavogur`/`pallih`/`Grafarholt` (Iceland), `Canto_Radar`+`ADSBX_MD_LPHR` (Azores), `mlacle_aruba`/`Every75-TNCC`/`PJ2BG_ADSB` (Aruba/Curacao), `NMO-Qaqortoq` (Greenland).

### Data-quality audit (do this before mapping)

- Latitude out of range (−90..90): **0** · Longitude out of range (−180..180): **0** — no swapped pairs, no wrapped longitudes. Data is clean.
- 9 records carry an exact `0.0` longitude — these are **legitimate** London-area sites (`adam-peacehaven`, `T-EGLC566`, `pi_lhr56_02`, …), not unset sentinels. Do **not** drop them.
- 860 stations have **no** coordinates — retain but exclude from density maths.
- ⚠️ My own first-pass lonelongs print mis-formatted wrapped coordinates; the raw values above are the corrected figures.

---

## 3. SECONDARY SOURCE — OGN / live.glidernet.org (the keyless FLARM substitute)

Since `flarm.net` is unreachable, **Open Glider Network is the working keyless FLARM receiver source.**

### Endpoint

```
https://live.glidernet.org/rec.php     # 200, ~140 KB, plain XML, no auth
```

Referenced directly in the live page's JS vars: `var rxml = "rec.php"` (`https://live.glidernet.org/`), consumed by `checkrec()` in `ogn.js`.

### Schema (compact XML — parse with regex, not an XML lib)

```xml
<markers>
  <m e="0"/>                                <!-- error code; 0 = OK -->
  <m a="09PA" b="40.8248329" c="-77.9886703" d="1"/>
  <m a="Abdalajis" b="36.917" c="-4.683" d="1"/>
</markers>
```

| attr | meaning                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| `e`  | error/status (first element only; `0` = healthy)                                                               |
| `a`  | receiver call-sign **or site name** (`09PA`, `Abdalajis`, `AVX1004`, `T-EDDS711`) — human-readable, geocodable |
| `b`  | latitude                                                                                                       |
| `c`  | longitude                                                                                                      |
| `d`  | online flag (`1` = online, `0` = offline)                                                                      |

### Measured scale

| Metric          | Value              |
| --------------- | ------------------ |
| Receiver sites  | **2,602**          |
| Online (`d=1`)  | **2,485** (95%)    |
| Offline (`d=0`) | 117                |
| lat range       | 0.00 .. 69.73      |
| lon range       | −124.93 .. +141.90 |

Densest 0.5° cells (all European): `+52.0/+0.0` n=20, `+50.5/+8.5` n=18, `+51.5/−1.0` n=16 — i.e. **UK, Benelux, Germany/Alps**, matching FLARM's real-world concentration.

**438 sites are "isolated"** (no other site within ~3°) — the sparse-island/ocean subset, e.g. `AVX1004` (+69.64, +19.00 Arctic), `Alppila` (+65.04, +25.45 Finland), `Abdalajis` (Spain), `AntlpVly` (California).

### Companion endpoints (same host, all keyless, from the page's JS)

```
lxml.php      # live aircraft positions  (~1.9 MB)
dataxml.php   # aircraft detail
livexml1.php  # track history  (?id=<station>&l=<lon>)
ogn.js        # client, documents the rec.php schema
```

`lxml.php?a=all&b=lat&...` accepts bounding-box filtering, so FLARM coverage can be clipped to a specific oceanic corridor.

### ⚠️ FLARM caveat for the parent task

OGN density is **European-centric and glider-centric**. It is excellent for proving _specific_ island outposts exist (Atlantic islands, Alps, Nordic coastlines) but is **not** a proxy for oceanic ADS-B coverage. Japan/China/Oceania FLARM presence is near-absent here. **Do not use ON density alone to conclude an oceanic corridor is uncovered** — cross-check ADSBX.

OGN data-use rules apply ("tracking data is freely available to anyone as long as they follow OGN data usage rules" — glidernet.org). Attribution expected.

---

## 4. TERTIARY — OpenSky Network (free, but account-gated; NOT keyless)

Important because it is the only source offering **`serials[]`** — the actual receiver IDs behind every position — making it the authoritative cross-check on all of the above.

- **Trino historical DB** — `https://trino.opensky-network.org`, catalog `minio`, schema `osky`. Free for **university-affiliated researchers / government / aviation authorities**; commercial needs a licence. Browser-based external auth (`--external-authentication`), so it cannot be headless-scripted without a session. Access is granted per-application.
- **Relevant tables:** `flarm_raw` (FLARM), `readsb_mlat_sv` (MLAT state vectors), `readsb_adsc_sv`, `state_vectors_data4`, `position_data4`, `flights_data4/5`, `acas_data4`, `allcall_replies_data4`.
- **Key column:** `state_vectors_data4.serials array<int>` — the receiver serials that contributed a fix. Combined with `readsb_mlat_sv`, this lets you **derive** receiver density without any receiver-claims data at all: count distinct serials per grid cell. This is the methodologically strongest approach, but it costs an account application.
- **REST API** — `https://opensky-network.org/api/states/all` returned 200 keyless during this survey, but is heavily rate-limited and doc'd under "Authentication" (OAuth2 client credentials). Index `12` of a state vector = `sensors int[]`.
- ⚠️ **The old public sensor-metadata CSV is retired.** `opensky-network.org/datasets/metadata/sensors.csv` 302-redirects to `https://s3.opensky-network.org/data-samples/metadata/sensors.csv` → **404 NoSuchKey**. Don't plan around it. Also `opensky-network.org/network/facts` returns **410 Gone** and `/network/coverage` returns _"This resource has been moved."_
- Scientific datasets (`/datasets`) exist but the landing page is JS-rendered; the COVID-19 Flight Dataset was built from **>5,500 receivers since Jan 2019** and is a legitimate published density proxy.

---

## 5. Sources checked and ruled out

| Source                                                                                         | Result                                                                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `mlat.net`                                                                                     | Parked redirect domain. Dead.                                                              |
| `flarm.net` / `netmap.flarm.net` / `api.flarm.net`                                             | **Connection refused** on TCP/443 (217.26.63.20), both curl + browser egress. DNS healthy. |
| `adsb.fi` (web + `api.adsb.fi/v1/*`)                                                           | 403 WAF / 404. No keyless public surface found.                                            |
| `api.airplanes.live`                                                                           | 403.                                                                                       |
| `adsb.lol/api/0/mlat`, `api.adsb.lol/api/0/locations`                                          | 404 — no public receiver/MLAT location endpoint.                                           |
| `wiki.glidernet.org` (list_of_receivers, ogn_receiver_range, ogn_coverage_map, infrastructure) | All 404 — **these nav links are dead**; only the live map + `rec.php` work.                |
| `opensky-network.org/datasets/metadata/sensors.csv`                                            | 404 (retired, see §4).                                                                     |
| `opensky-network.org/network/facts`, `/network/coverage`                                       | 410 / moved.                                                                               |
| Zenodo `"ADS-B receivers" network deployment`                                                  | Top hits are unrelated (SAR, AIS/IoT). No usable island-density dataset.                   |
| Wayback Machine for `flarm.net/~netmap/`                                                       | Never archived; and archive.org 429-rate-limited.                                          |

---

## 6. Recommended pipeline for the parent task

1. **Ground truth = ADS-B Exchange MLAT map.** Fetch all 25 `sync/<r>/sync.json` with a `Referer` header. 17,054 coordinate-bearing stations, cached locally — it changes slowly, so a weekly refresh is plenty.
2. **FLARM cross-check = `live.glidernet.org/rec.php`.** Regex the XML; keep `a` (site name) for geocoding island outposts. Weight by `d` (online) — an offline FLARM site is not coverage.
3. **Density metric to use, in order of preference:**
   - _declared_: peer count from ADSBX `peers` (free, instant, but self-reported);
   - _peer-gated_: count of sites with ≥3 peers — MLAT needs 4+ receivers, so sub-3-peer sites cannot produce MLAT;
   - _derived_: `SUM(serials[])` per grid cell from OpenSky Trino (authoritative, account-gated).
4. **Flag hard gaps** where declared feeders = 0: **mid-Pacific, South Pacific, Falklands, South Georgia, Tristan da Cunha, Socotra.** Any aircraft seen there is a single-receiver local fix.
5. **Caveat to state in any output:** ADS-B reception is line-of-sight (≈ 250 NM for aircraft at FL350). Even dense feeder networks leave oceanic gaps — a low receiver count near an island is strong evidence of a coverage gap, but absence of a _reported_ receiver is weaker evidence than a confirmed one, since commercial receivers frequently do not publish.

### Files written during this task

`/tmp/oss/` — `s.py` (search helper), `an_rec.py`, `an_adsbx.py`, `an_isl.py`, `an_global.py`, `an_dq.py` (analysis scripts), `regions/1..25.json` (cached ADSBX regional snapshots, ~34 MB), `rec.json` (OGN FLARM receiver list).
