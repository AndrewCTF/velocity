# Public Keyless AIS Mirrors — Probe Report

> Raw first-pass probe output (2026-10-04). The written-up result, with the
> corrected OpenWaters longitude window and the final coverage numbers, is
> **`docs/ais/ais-vessel-pipeline.md`**. This file is kept as the underlying
> evidence — including findings the pipeline does not use (HF archived
> datasets, dead hosts) and the pitfall list.

Probed 2026-10-04 00:51–01:05 (+08). Method: `curl -4 -s -L` with browser UA.
All counts measured from actual returned payloads; blanks = no vessel data returned.

## Verdict

**Only 3 genuinely keyless vessel-position sources returned real positions.**
Best: `ais.openwaters.io` (live, 1947+ vessels keyless), HF `hormuz-ais`
(619 vessels, archived), and `aisdb` test CSV (2275 vessels, global incl. deep ocean).
Every other "public" AIS API found is key-gated (AISStream, VesselAPI, AISHub) or dead.

**Deep-ocean: NO live keyless source reaches open ocean.** All 6 open-ocean boxes
returned 0 vessels on openwaters (incl. its AISHub worldwide aggregate) — terrestrial
AIS + coastal receiver coverage only. The only deep-ocean positions came from a
**static 2021 archive** (aisdb test CSV): 18 rows >500km from land, incl. Indian
0,80 / mid-Pacific 0,160 / S Atlantic 0,-20 / N Atlantic 40,-40.

## Results

| source                         | URL                                                                                                | http    | bytes     | vessels     | deep-ocean?  | notes                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------- | --------- | ----------- | ------------ | ------------------------------------------------------------------------------- |
| **openwaters (BEST)**          | `ais.openwaters.io/v1/vessels?bbox=38,-10,42,5`                                                    | 200     | 853,875   | **1,947**   | no           | KEYLESS, live, `truncated:true` (~2k cap). W Med.                               |
| openwaters                     | `.../bbox=20,110,25,122` (S China Sea)                                                             | 200     | 875,016   | **1,979**   | no           | KEYLESS, live, truncated                                                        |
| openwaters                     | `.../bbox=24,55,27,57` (Hormuz)                                                                    | 200     | 352,789   | **736**     | no           | KEYLESS, live, truncated                                                        |
| openwaters                     | `.../bbox=55,3,56,5` (North Sea)                                                                   | 200     | 1,414     | 2           | coastal      | KEYLESS, live                                                                   |
| openwaters                     | 6 deep-ocean boxes (mid-Pac 0,159 / SAtl 0,-20 / Ind 0,80 / NAtl 40,-40 / S-Pac -30,-150 + 3 more) | 200     | 60 ea     | **0**       | **NO**       | empty FeatureCollection — terrestrial coverage only                             |
| openwaters                     | `/v1/stations`                                                                                     | 200     | 14,968    | 34 stations | —            | KEYLESS coverage map; names PASSAGES, NAUTICLOUD, AZURIS…                       |
| openwaters                     | `ais.openwaters.io/mcp`                                                                            | —       | —         | —           | —            | keyless MCP server, 5 read-only tools                                           |
| openwaters                     | `/v1/vessels` bbox >10°×10°                                                                        | **400** | 30        | —           | —            | "bbox not allowed for this key"; anon limit 100 sq deg                          |
| **HF hormuz-ais**              | `huggingface.co/…/yasumorishima/hormuz-ais/resolve/main/positions.parquet`                         | 200     | 6,929,517 | **619**     | no           | KEYLESS, not gated, 175,773 positions, 2026-03-14→04-11, bbox lat22–30/lon48–60 |
| HF hormuz-ais                  | `…/transit_events.parquet`                                                                         | 200     | 17,022    | 100         | no           | KEYLESS, 260 gate crossings                                                     |
| HF repo                        | `huggingface.co/api/datasets/yasumorishima/hormuz-ais`                                             | 200     | 8,922     | —           | —            | `"gated": false`, 490 downloads, upd 2026-10-03                                 |
| **aisdb (deep-ocean YES)**     | `raw.githubusercontent.com/matt24smith/aisdb/master/aisdb/tests/testdata/test_data_20210701.csv`   | 200     | 1,258,678 | **2,275**   | **YES (18)** | KEYLESS, global lat−53..91/lon−180..181, dated 2021-07-01                       |
| SuperMayo tracker              | `raw.githubusercontent.com/SuperMayo/AIS_tracker/main/out.jsonl`                                   | 200     | 108,967   | 4           | no           | KEYLESS but only 4 stale vessels (2023, Caribbean/Med)                          |
| shadow-fleet                   | `raw.githubusercontent.com/FormerLab/shadow-fleet-tracker-light/main/Vessels1.db`                  | 200     | 81,920    | **1,206**   | n/a          | KEYLESS watchlist (GUR sanctions), no positions                                 |
| hormuz live map                | `yasumorishima.github.io/hormuz-ship-tracker/`                                                     | 200     | 5,478     | —           | —            | live demo, reads HF parquet client-side                                         |
| marine-eye live map            | `time2map.github.io/marine-eye/`                                                                   | 200     | 522       | —           | —            | live demo, but browser-side AISStream WS (needs key)                            |
| AISStream                      | `aisstream.io` + `stream.aisstream.io`                                                             | 200     | 15,826    | —           | —            | **KEY REQUIRED** (free signup). WS handshake gated                              |
| VesselAPI                      | `api.vesselapi.com/v1/search/vessels`                                                              | **401** | 119       | —           | —            | **KEY REQUIRED**                                                                |
| AISHub                         | `data.aishub.net/ws.php?username=x&password=x`                                                     | 200     | 96        | —           | —            | **CREDS REQUIRED** ("Invalid username or password")                             |
| phantomtide                    | `phantom.labs.jamessawyer.co.uk/api/public/…`                                                      | 200     | 2,284     | 0           | no           | keyless but **aircraft only**, no vessel endpoint (5 crossings)                 |
| ~~aisdata.io~~                 | `aisdata.io/`                                                                                      | **000** | 0         | —           | —            | **DEAD** — DoH: domain resolves, **no A/AAAA record**, NS=iwantmyname (parked)  |
| ~~datasets.helmholtz.de~~      | `datasets.helmholtz.de/`                                                                           | **000** | 0         | —           | —            | **DEAD** — DoH Status 3 = **NXDOMAIN**; apex `helmholtz.de` is fine (200)       |
| ~~ais-exchange~~               | `raw.githubusercontent.com/ais-exchange/`                                                          | 404     | 14        | —           | —            | not a data source; org README = 450-byte profile stub, LICENSE only             |
| ~~kaggle~~                     | kaggle.com/datasets                                                                                | —       | —         | —           | —            | SKIPPED per task (needs auth)                                                   |
| NOAA ERDDAP                    | `coastwatch.pfeg.noaa.gov/erddap/…`                                                                | 000     | 0         | —           | —            | reachable in DNS (161.55.160.15) but **TCP times out** from this host           |
| shipmap.org / pacioos / ais.gs | —                                                                                                  | 000     | 0         | —           | —            | DNS resolves, connections time out (egress filtered)                            |

## GitHub repos found

**Search `q=ais+api+keyless`** → total_count **1** only (`AndrewCTF/velocity`, 94★) — the
literal query is too narrow; widened with `ais+vessel+tracking` (227 results).

| repo                                  | ★   | keyless public data found                                     |
| ------------------------------------- | --- | ------------------------------------------------------------- |
| AndrewCTF/velocity                    | 94  | none (self-hosted, local :8000)                               |
| Ysurac/FlightAirMap                   | 617 | marine.flightairmap.com live demo (no data API)               |
| tg12/phantomtide                      | 126 | keyless API but aircraft-only                                 |
| FormerLab/shadow-fleet-tracker-light  | 44  | **Vessels1.db 1,206 MMSIs**                                   |
| reyemb/oss-aisexplorer                | 38  | scrapes MarineTraffic (not a source)                          |
| dh1542/vessel-tracker                 | 4   | AISStream WS (key)                                            |
| xang1234/neptune                      | 3   | library, NOAA/Digitraffic fetchers (no live endpoint)         |
| **yasumorishima/hormuz-ship-tracker** | 9   | **HF dataset, 619 vessels keyless**                           |
| SuperMayo/AIS_tracker                 | 3   | **out.jsonl, 4 vessels**                                      |
| matt24smith/aisdb                     | 6   | **test CSV, 2,275 vessels, deep ocean**                       |
| vessel-api/VesselApi                  | 3   | 401, key required                                             |
| tools-mcp/vessel-traffic-mcp          | 6   | opt-in public adapters (myshiptracking, tradlinx, aisfriends) |
| aisstream/example                     | 131 | examples only                                                 |
| **openwatersio/aiscast**              | 7   | **KEYLESS live API, 1,947+ vessels** ← best find              |
| ais-exchange/ais-exchange             | –   | empty profile stub                                            |

## Reusable commands

```bash
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
# keyless live vessel count (max ~10x10 deg anonymous)
curl -4 -s -L -o /tmp/v.json -w "http=%{http_code} sz=%{size_download}\n" --max-time 30 -A "$UA" \
  "https://ais.openwaters.io/v1/vessels?bbox=38,-10,42,5"
python3 -c "import json;print(len(json.load(open('/tmp/v.json'))['features']),'vessels')"
```

## Pitfalls hit

- **GitHub API `core` rate limit (60/hr unauth) was already 0/60.** `search/*` has a
  separate limit and still worked; `raw.githubusercontent.com` is unlimited. When core is
  dead, use `git clone --depth 1` (not rate limited) to inspect repo data files — this is
  how the aisdb/Vessels1.db payloads were found.
- `execute_code` runs in a **separate sandbox interpreter** without the terminal's
  packages — install via terminal `python3`, then call `terminal("python3 script.py")`.
- System pip is PEP-668 managed: `pip install --break-system-packages pyarrow pandas`.
- Local resolver (systemd-resolved 127.0.0.53) fails on some hosts; **Cloudflare DoH
  `https://1.1.1.1/dns-query?name=X&type=A`** proved NXDOMAIN vs. no-A-record vs.
  network-blocked. Distinguish `rc=6` (DNS) from `rc=28` (TCP timeout/egress).
- openwaters GeoJSON has a `truncated` boolean — always read it; naive counts under-report
  at the ~2,000-vessel response cap.

---

## Addendum: satellite-AIS providers WITH live maps (probed 2026-10-03)

The obvious follow-up: every dedicated satellite-AIS vendor ships a public live
map. Does any of them expose that data without a credential? **No — measured.**

| provider              | live map                         | data API                                                                              | keyless? |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| exactEarth            | 200 (HTML)                       | `api.exactearth.com/v2/vessels` → **401**                                             | no       |
| FleetMon              | TCP-unreachable from this egress | `api.fleetmon.com` → **401**                                                          | no       |
| Kpler                 | 200 (HTML)                       | keyed                                                                                 | no       |
| Spire Maritime        | 200 (HTML)                       | keyed, commercial                                                                     | no       |
| MarineTraffic         | 200 (HTML)                       | `services.marinetraffic.com/api/exportvessels` → **401** "SERVICE KEY NOT FOUND"      | no       |
| VesselFinder          | 200 (HTML)                       | `/api/pub/addressbook/overview` → 404                                                 | no       |
| Global Fishing Watch  | 200 (HTML)                       | `gateway.api.globalfishingwatch.org/v3/vessels` → **401** `{"error":"invalid token"}` | no       |
| GFW public bucket     | —                                | `storage.googleapis.com/global-fishing-watch-datasets/` → **404 NoSuchBucket**        | no       |
| GFW `gfw-public-data` | —                                | **403**                                                                               | no       |

GFW is the instructive case: the live map is fully public HTML, but the page
ships `Authorization` headers and the data gateway demands a token. The map is
a viewer, not a feed. `storage.googleapis.com/gfw-public-data/` returns 403 and
the `global-fishing-watch-datasets` bucket does not exist.

### Correction to an earlier reading of OpenWaters

An earlier probe of `ais.openwaters.io/v1/stations` appeared to show a
`barentswatch/sat` row (123 vessels / 294 in 24 h). **Re-probing returned 22
stations with zero satellite entries**, and a Barents Sea bbox (20-30E/70-78N)
returned 18 vessels, _all_ tagged `aishub`, _zero_ SAT. That earlier reading was
a transient/misread and is withdrawn. `SATELLITE_AIS_KEYLESS = False` now pins
this, with a test, so the claim cannot silently reappear.

### What this leaves

There is no keyless satellite-AIS tier. Open-ocean coverage must come from
**Sentinel-1 SAR bright-target detection**, which is keyless end-to-end
(Earth Search STAC catalogue + anonymous `sentinel-s1-l1c` reads, verified
HTTP 206 and a full 806 MB scene). SAR also has the property that makes it
_better_ than satellite AIS for dark vessels: it detects a contact whether or
not that contact is broadcasting.
