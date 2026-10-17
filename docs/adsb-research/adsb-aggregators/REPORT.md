# Multi-Feed / Multi-Radar ADS-B Aggregation Projects — Documented Public Instances

Research date: 2026-10-04. **Research only — no ADS-B endpoints were called.** All URLs below are
transcribed from project READMEs and docs fetched over HTTPS
(`raw.githubusercontent.com`, `github.com/search`, `sdr-enthusiasts.gitbook.io`, `www.adsb.lol`).

---

## TL;DR — what actually exists

The user's candidate list mixed real projects with two that **do not exist** as ADS-B software:

| Candidate asked about | Verdict                               | Canonical repo                                                                                                                                                                                                     |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **readsb**            | ✅ Real                               | `wiedehopf/readsb` (686★), fork of `Mictronics/readsb` ← `dump1090-fa` ← `mutability` ← `Malcolm Robb` ← `antirez`                                                                                                 |
| **tar1090**           | ✅ Real                               | `wiedehopf/tar1090` (1,919★) — web UI _for_ readsb, not a replacement                                                                                                                                              |
| **adsbhub**           | ⚠️ Service is real, **closed-source** | `adsbhub.org` — no public source; only third-party feeder wrappers exist                                                                                                                                           |
| **dvbs**              | ❌ **No such ADS-B project**          | `github.com/dvbs` exists but is an **empty org with zero public repos**. Searches return only DVB-S2 satellite/TV tooling (`gr-dvbs2`, `minisatip`, …). "dvbs" is almost certainly a garbling of **ADS-B** itself. |
| **multi-radar**       | ❌ **No such project**                | Zero ADS-B repos. "multi-radar" is a **generic feature description**, not a product. Real implementations are named `combine1090` / `tar1090` multi-instance.                                                      |

**Correction up front:** the true "multi-feed aggregator" primitives in this ecosystem are
`combine1090` (merge N receivers), `tar1090` multi-instance, and the `adsb.lol` /
`airplanes.live` / `adsb.fi` federation services — not anything named "dvbs" or "multi-radar".

---

## Tier 1 — Core aggregation software

### 1. `wiedehopf/readsb` — decoder + Beast-net hub

The multi-feed aggregation _primitive_: `--net` ports let N receivers push Beast binary into one
readsb instance. README documents the exact connector syntax, including the de-dup
(`beast_reduce`) mode "used by some aggregators to aggregate ADS-B data":

```
--net-connector=feed.airplanes.live,30004,beast_reduce_plus_out,uuid=0033062d-e17e-4389-91a9-79ebb967fb4c
```

**Public instances this project documents** (README → "Websites using this software"):

- https://adsb.lol/
- https://globe.airplanes.live/
- https://globe.adsb.fi/
- https://globe.adsbexchange.com/

Projects using it: https://sdr-enthusiasts.gitbook.io/ads-b/ ·
https://github.com/sdr-enthusiasts/docker-adsb-ultrafeeder · https://adsb.im/
Downstream data users: https://gpsjam.org/ · https://adsb.exposed/ ·
https://tech.marksblogg.com/global-flight-tracking-adsb.html

### 2. `wiedehopf/tar1090` — globe/multi-map UI + **Multiple instances** feature

README has a dedicated "**Multiple instances**" section (each instance keeps its own IP/port and
`config.js`; `config.js` must be edited per instance). Documented share-link target:
`shareBaseUrl = "https://globe.adsbexchange.com/"`.

**Public instances this project documents** ("Websites using this software"):

- https://adsb.lol/
- https://globe.adsbexchange.com/
- https://globe.airplanes.live/
- https://globe.adsb.fi/

Notable projects using ADS-B data: https://gpsjam.org/ · https://adsb.exposed/ ·
https://tech.marksblogg.com/global-flight-tracking-adsb.html

### 3. `wiedehopf/combine1090` — **the actual multi-receiver combiner**

> "Combine data from multiple dump1090 / readsb receivers (or other receivers providing beast
> protocol data). Does not interfere with an already configured dump1090-fa / readsb but instead
> creates another instance with its own webinterface at `/combine1090`"

Config in `/etc/default/combine1090` (list of source IPs); services
`combine1090` + `combine1090-dump`. Works on the adsbexchange / piaware SD-card images.

Documented instance URLs: https://adsb.im/stage2 (named as the "easier alternative") ·
http://192.168.2.33/combine1090 (sample LAN). **No public hosted instance is advertised** — it is
self-hosted by design.

### 4. `wiedehopf/graphs1090`

Companion telemetry graphs + a **graphs1090-to-adsb.im** exporter. Documents https://adsb.im
(and a `graphs1090-to-adsb.im.backup` artifact path). No public hosted instance advertised.

---

## Tier 2 — Federation / aggregation _services_ (open infra, own public endpoint)

### 5. adsb.lol — `adsblol/*` (the reference modern aggregator stack)

This is the closest thing to a documented "multi-feed aggregation project".

- `adsblol/infra` (31★) — GitOps Flux/K8s cluster: readsb + tar1090 + mlat-server, `bases/` +
  `manifests/default`. README motivation: _"Due to recent events regarding ADSBExchange being
  acquired, it would be wise for the community to have a quick and easy way to deploy an
  alternative aggregation service."_
- `adsblol/feed` (78★) — multi-feed MLAT/ADS-B/ACARS/VDL2 client.
- `adsblol/api` (75★) — public API, ADSBExchange-compatible.
- `adsblol/globe_history_2026` — daily open Parquet/trace drops, ODbL.

**Documented URLs:**

- https://adsb.lol/ (live map) · https://api.adsb.lol · https://api.adsb.lol/docs
- https://adsb.lol/feed · https://adsb.lol/feed.sh
- https://www.adsb.lol/docs/get-started/docker/
- https://api.adsb.lol/api/0/routeset (per-solution context)
- Ack pages: https://www.adsb.lol/docs/acknowledgements/partners/ · …/open-source/

Acknowledgement docs also credit these partner/incumbent sites:
https://flyitalyadsb.com/ · https://theairtraffic.com · https://www.adsbhub.org/ ·
https://opensky-network.org/

### 6. `offworldlabs/adsb-service` — RETINA data plane

Built on the adsb.lol lineage (`vendor/` includes adsblol/api + adsblol/infra + readsb); ingests
the worldwide ADSBHub SBS feed `data.adsbhub.org:5002` and serves geo-filtered state back.

- **Documented endpoint:** https://adsb.retina.fm/v2/
- ⚠️ Serves `GET /v2/lat/{lat}/lon/{lon}/dist/{radius}` (adsb.lol v2 shape). Phase A only;
  node-local → not a broadly open public endpoint.

### 7. `CHA0S-CORP/SkySpy` — tar1090 alternative UI

Public instance: **radar.chaos.navy/** (per local prior research doc). Repo README is
self-host instructions (localhost:3000 / :5000 / :8080 / :8081) + references
https://opensky-network.org/ and https://aviationweather.gov/.

---

## Tier 3 — ADSBHub (`adsbhub.org`) — service real, source not open

No first-party repo. Every public repo is a **third-party feeder wrapper**:

| Repo                                                                                     | Notes                                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `sdr-enthusiasts/docker-adsbhub` (21★)                                                   | Docker SBS→ADSBHub; pairs with `docker-readsb-protobuf` |
| `jeanralphaviles/adsbhub-docker` (2★)                                                    | dump1090 → ADSBHub                                      |
| `lloydpick/docker-adsbhub`, `regishanna/adsbhub`, `lacsar712/adsbhub`, `ShoGinn/adsbhub` | minimal feeder scripts                                  |

Documented URLs: https://www.adsbhub.org · https://www.adsbhub.org/howtofeed.php ·
https://www.adsbhub.org/statistic.php · SBS ingest `data.adsbhub.org:5002` (protocol "SBS", client mode).

---

## Tier 4 — Documented instance/mirror lists from tooling READMEs

### `sdr-enthusiasts/gitbook-adsb-guide` — the canonical aggregator directory

Its README is effectively an aggregator/consumer index (feeder targets):

https://adsb.lol/ · https://airplanes.live/ · https://adsb.fi/ · https://adsbexchange.com ·
https://adsb.exposed/ · https://www.adsbhub.org · https://opensky-network.org ·
https://plane.watch/ (+ https://atc.plane.watch) · https://theairtraffic.com ·
https://flyitalyadsb.com · https://avioadsb.org · **https://skylink.hpradar.com** ·
https://avdelphi.com · https://www.planespotters.net · https://planefinder.net ·
https://www.airnavradar.com · https://www.radarvirtuel.com (+ https://alpha.radarvirtuel.com/stations/KBOS) ·
https://www.flightradar24.com/share-your-data · https://flightaware.com/adsb/piaware/ ·
https://www.1090mhz.uk/ (Radar1090 UK)

### `sdr-enthusiasts/docker-adsb-ultrafeeder` (579★)

Documents https://api.adsb.lol/api/0/routeset and https://my.adsb.im/home (per-user map).

### `airplanes-live/api-archive`

Documents https://api.adsb.one and https://api.adsb.one/v2/hex/{hex}.

### Local prior art in this workspace

`tools/probe_adsb_mirrors.py` already maintains a hand-verified keyless mirror list (comment:
_"Open readsb/tar1090 instances + ADSBx-v2 endpoints"_), and `tools/CLAUDE.md` records the
Cloudflare caveats (adsb.lol 451 / airplanes.live & adsb.fi 403 from datacenter IPs):

- https://globe.theairtraffic.com/data/aircraft.json
- https://skylink.hpradar.com/data/aircraft.json · https://hpradar.com/data/aircraft.json
- https://radar.fdy.cz/data/aircraft.json · https://adsb.330k.info/data/aircraft.json
- https://tar1090.adsb.im/data/aircraft.json · https://adsbexchange.com/data/aircraft.json
- https://api.adsb.lol/v2/point/0/0/20000 · https://api.airplanes.live/v2/point/0/0/20000
- https://api.adsb.fi/v2/point/0/0/20000 · https://api.adsb.one/v2/point/0/0/20000
- https://opendata.adsb.fi/v2/point/0/0/20000 · https://adsb.exposed/ · https://my.ultrafeeder

---

## Consolidated public-instance list (all hosts documented by these projects)

**Globes / aggregators (readsb + tar1090 both list these four):**
adsb.lol · globe.adsbexchange.com · globe.airplanes.live · globe.adsb.fi

**APIs / re-api:** api.adsb.lol (+/docs) · api.adsb.one · api.adsbdb.com ·
api.adsb.fi · opendata.adsb.fi · api.airplanes.live · adsb.retina.fm/v2 · my.adsb.im

**Other federation sites:** adsb.im · adsbhub.org · theairtraffic.com · flyitalyadsb.com ·
skylink.hpradar.com · hpradar.com · radar.fdy.cz · adsb.330k.info · adsb.exposed ·
plane.watch · opensky-network.org · atc.plane.watch · 1090mhz.uk · radarvirtuel.com ·
airnavradar.com · planefinder.net · flightaware · flightradar24 · avdelphi.com · avioadsb.org ·
planespotters.net · adsbexchange.com · radar.chaos.navy · my.ultrafeeder

---

## Method / caveats

- `web_search` and `web_extract` were **unconfigured** (no `FIRECRAWL_API_KEY`); DuckDuckGo,
  Bing, Mojeek, Ecosia, Brave, Startpage and public SearXNG instances were all captcha-walled or
  returned cached junk. Working channels: **`api.github.com` search** (rate-limited, 10/min —
  space queries ~8s), **`github.com/search` HTML**, and **`raw.githubusercontent.com`** (unlimited).
- `api.github.com` unauthenticated limit is 60 req/hr and it began returning 403 partway through;
  repo existence was then confirmed via `github.com/<owner>/<repo>` status codes instead.
- Several plausible-looking repo owners (`wxjeavor/readsb`, `w84death/tar1090`,
  `jaesm00/adsbhub`, `radar-compose`, `multiradar`) are **wrong or non-existent** — the real
  owners are `wiedehopf` and `adsblol`. `wiedehopf/tar1090` also keeps a `screenshots` branch.
- Repo names in this ecosystem are commonly **misspelled upstream** (`adsb_deku`,
  `adsb2otel`, `adsb-rx`, `readsd` in one flake) — don't trust the name alone.
- **Nothing was called on any live ADS-B endpoint**; the `aircraft.json` / `/v2/point/` URLs above
  are transcribed from README text only.
