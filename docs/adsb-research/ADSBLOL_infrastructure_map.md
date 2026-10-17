# adsb.lol / adsblol — Public Infrastructure & Mirror Endpoint Map

**Research date:** 2026-10-04
**Method:** Passive OSINT only — GitHub API + repo source review, DNS resolution, certificate transparency (CertSpotter), HTTP header-only probes of web front doors. **No data/API endpoints were queried**; no auth'd or authenticated calls. GitHub REST API hit its unauthenticated rate limit partway through; remaining data was derived from `raw.githubusercontent.com` mirrors of the same content.

---

## 1. Organisation identity

| Field            | Value                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------- |
| GitHub org       | `adsblol` — ID `123735118`                                                               |
| Display name     | ADSB.lol                                                                                 |
| Created          | 2023-01-27T10:58:55Z                                                                     |
| Public repos     | 22                                                                                       |
| Followers        | 197                                                                                      |
| Contact          | `info@adsb.lol`                                                                          |
| Self-description | "ADSB.lol, by @iakat - openly licensed, publicly available, unfiltered flight tracking." |
| Org avatar UID   | `avatars.githubusercontent.com/u/123735118`                                              |

### Operator

| Field                                | Value                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| GitHub user                          | `iakat` — display name `katia ◊◖⸴⹤`                                                |
| Real name (from git commit metadata) | **Katia Esposito**                                                                 |
| Commit identity                      | `Katia Esposito <katia@linux.com>`; also `1695469+katlol@users.noreply.github.com` |
| Account created                      | 2012-05-01 (pre-dates the org by ~11 years)                                        |
| Public repos / followers             | 84 / 249                                                                           |
| Personal domain                      | **katia.sh** (Cloudflare, same NS pair as adsb.lol)                                |
| GitHub noreply ID                    | `1695469`                                                                          |

**Strong pivot:** `adsb.lol` MX → `mail.katia.sh`; SPF → `include:_spf.katia.sh`. The same SPF string appears on both `adsb.lol` and `katia.sh`, and both use Cloudflare NS `lady/noah.ns.cloudflare.com`. TXT also carries `katia on irc.libera.chat` and `libera-51207669` (Libera.Chat network ID). Handle **@iakat** on Libera.Chat is the operator's likely live identity.

### Second org

| Field        | Value                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub org   | `katlol` — ID `163901842`, name "@iakat", created 2024-03-18                                                                              |
| Public repos | 0 (images only — no public source)                                                                                                        |
| Role         | **Build/registry host for the operator's custom images**: `ghcr.io/katlol/readsb`, `ghcr.io/katlol/mlat-server`, `ghcr.io/katlol/tar1090` |

---

## 2. Repository inventory (22 public repos)

| Repo                                | Lang       | ★   | Pushed     | Role                                                          |
| ----------------------------------- | ---------- | --- | ---------- | ------------------------------------------------------------- |
| `globe_history_2026`                | Shell      | 58  | 2026-10-03 | Current-year open flight-history archive (1762 GiB)           |
| `globe_history_2025`                | Shell      | 53  | 2025-12-31 | Prior-year archive                                            |
| `globe_history_2024`                | Shell      | 58  | 2024-12-31 | Prior-year archive                                            |
| `globe_history_2023`                | Shell      | 36  | 2024-01-02 | Prior-year archive                                            |
| `api`                               | Python     | 75  | 2026-08-21 | FastAPI front door (`adsb.lol`, `api.adsb.lol`)               |
| `feed`                              | Shell      | 78  | 2024-10-18 | RPi/Docker feeder client toolkit                              |
| `infra`                             | JavaScript | 31  | 2026-06-03 | **Flux GitOps k8s manifests — primary infra source of truth** |
| `website`                           | HTML       | 10  | 2026-09-28 | Hugo docs site (www.adsb.lol)                                 |
| `vrs-standing-data`                 | Python     | 10  | 2026-10-03 | VRS standing-data mirror on GH Pages, hourly                  |
| `tar1090`                           | JavaScript | 2   | 2026-08-27 | Frontend fork                                                 |
| `mlat-server`                       | Python     | 1   | 2026-08-25 | mlat-server deployment                                        |
| `mlat-server-sync-map`              | HTML       | 1   | 2026-07-11 | MLAT sync status map                                          |
| `aircraft-data-links-2026`          | —          | 0   | 2026-10-03 | ACARS/HFDL/VDL2 open data (CC0)                               |
| `aircraft-data-links-2025`          | —          | 4   | 2026-03-01 | Prior-year data-links archive                                 |
| `status`                            | Markdown   | 1   | 2025-04-14 | Upptime status page → `status.adsb.lol`                       |
| `mapproxy`                          | Dockerfile | 2   | 2024-09-17 | Tile proxy/cacher                                             |
| `history`                           | Python     | 0   | 2023-03-17 | Legacy history server                                         |
| `mlat-client`, `discord-bot`, `ssh` | —          | 0   | various    | Dormant / one-shot                                            |
| `naturalearthvector`                | —          | 0   | 2024-06-03 | Single `natural_earth.vector.mbtiles` basemap asset           |
| `containers`                        | —          | 0   | 2024-04-07 | **Empty repo — zero commits**                                 |
| `ssh`                               | —          | 0   | 2024-09-24 | **Empty repo — zero commits** ("ssh2adsb")                    |

---

## 3. Infrastructure topology (from `adsblol/infra`)

**Stack:** Flux CD (GitOps, 1-minute reconcile interval) → Kustomize → Kubernetes namespace `adsblol`. Cluster provider signal: `load-balancer.hetzner.cloud/location: fsn1` annotation on the ingest LoadBalancer — but **live IPs are netcup, not Hetzner** (see §5), indicating either a migrated cluster or the annotation is vestigial.

Secrets come from **Vault** via External Secrets Operator (`ClusterSecretStore: vault`, key `adsblol/infra`, props `identity` + `known_hosts`). Flux repo sync uses `ssh://git@github.com/adsblol/infra.git`. No secret material is in-git (sensitive paths correctly excluded).

### Data path

```
user → ingest → hub → planes
        ↘ mlat ↗
```

Readsb instances are chained with `--net-connector` over BEAST:

| Stage                   | Readsb args (connectors)                                                                         | Notes                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `external`              | `hub-readsb,30004,beast_out`; `cnvr.io,30005,beast_out`                                          | Receives 3rd-party partner feeds               |
| `ingest`                | `external-readsb,30004,beast_reduce_out`; `--net-ingest`, `--write-receiver-id-json`             | Public ingest; `commonLabels: service: public` |
| `hub`                   | `planes-readsb,30004,beast_out`; `--forward-mlat`                                                | Aggregator                                     |
| `planes` (prod)         | `mlat-mlat-server,30104,sbs_in_mlat`; `--write-globe-history /var/globe_history`, `--heatmap 30` | Public tar1090 + **history writer**            |
| `planes-test` (staging) | `hub-readsb,30006,beast_in`; StatefulSet, `stage: test`                                          | Staging replica                                |
| `reapi`                 | `hub-readsb,30006,beast_in`; `mlat-mlat-server,30104,sbs_in_mlat`                                | Feeder-only readsb API                         |

### Services & ports

- **HAProxy ingest LB** (3 replicas, `haproxy:2.7`), PROXY protocol on both directions, `send-proxy`:
  - `1337` BEAST-in, `1338` MLAT, `30004` BEAST-in, `30005` BEAST-out, `31090` MLAT
  - `:9090` stats + Prometheus exporter (`/metrics`, `/stats`, 10s refresh)
  - `backend beast → ingest-readsb:30004`, `backend mlat → mlat-mlat-server:31090`
- **mlat-server** (`ghcr.io/katlol/mlat-server`): client-listen `31090`, filtered-basestation-listen `30104`; pinned `OMP/MKL/NUMEXPR` threads to 1; 10GiB RWX PVC.
- **readsb** ports: `80` http, `150` json-stats, `30004` adsb-in, `30005` adsb-out, `30006` adsb-out-reduce, `30152` http-api (re-api), `32006` sbs-in, `32007` sbs-out.
- **Redis** (`redis:alpine`, 10GiB PVC) — locks + caches. Key namespace: `beast:clients`, `beast:receivers`, `mlat:sync_json`, `mlat:clients`, `mlat:totalcount`, `hub:aircraft_totalcount`. Distributed lock via `SET nx` + hostname-scoped Lua release. Default TTL 5s.
- **api** (`ghcr.io/adsblol/api`) — FastAPI, ServiceMonitor on port `http`.
- **history** — 3-container sidecar: `ghcr.io/adsblol/history` (8080) + `nginx:alpine` (80, autoindex, CORS `*`, 60s cache) + **`rclone/rclone`** doing both `move` (every 10s) and a **FUSE mount of the `adsblol:history` remote** (privileged, `SYS_ADMIN`). Rclone credentials from Secret `adsblol-rclone`. This is the rclone/S3-compatible object store mirroring the open history data.
- Flux pins images by SHA-ish tags, e.g. `ghcr.io/adsblol/api:main-e3ee81a8-1679998426`, `ghcr.io/katlol/readsb:3ef880844dde1a18d5b053cb0775064083171f93`.

### Network policy

Namespace `adsblol` carries a single `allow-all` NetworkPolicy (`podSelector: {}`, Ingress+Egress empty rules = allow all). Ingest Service uses `externalTrafficPolicy: Local` + `internalTrafficPolicy: Local` — direct client-IP preservation for per-feeder attribution, no hop through a shared proxy tier.

### Homepage ingress redirects (`adsb.lol`, nginx configuration-snippet)

| Path                    | Target                                                                        |
| ----------------------- | ----------------------------------------------------------------------------- |
| `/discord`              | `https://discord.gg/3wPfmyNFRq`                                               |
| `/todo`                 | `https://github.com/orgs/adsblol/projects/1/views/1`                          |
| `/feed`                 | `https://github.com/adsblol/feed`                                             |
| `/stats`, `/graphs1090` | `https://grafana.adsb.lol/public-dashboards/4fcdab6726f34960b73be95ecb74386e` |
| `/metrics`              | literal `"lol"` (disables automated probing)                                  |

Public Grafana dashboard ID `4fcdab6726f34960b73be95ecb74386e` is published anonymously.

---

## 4. Public endpoints & hostnames

### Front door / web

| Host                                            | Ingress backend                                 | Notes                                                              |
| ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `adsb.lol`                                      | `api:80`                                        | Apex; HTTP/2 200, HTML                                             |
| `planes.lol`                                    | `api:80`                                        | **Apex returns 404** (content-type `text/plain`, `server: Vercel`) |
| `www.adsb.lol`                                  | (website)                                       | HTTP/2 200                                                         |
| `globe.adsb.lol`                                | `planes-readsb` (`/re-api`, `http`, `http-api`) | **302 → `adsb.lol/`**                                              |
| `test.adsb.lol`                                 | `planes-readsb-test`                            | Staging twin of globe                                              |
| `api.adsb.lol`                                  | —                                               | 302 → `/docs` (FastAPI Swagger live)                               |
| `re-api.adsb.lol`                               | reapi readsb                                    | **Separate netcup nodes, not behind the adsb.lol LB**              |
| `history.adsb.lol`                              | `history` (`http-nginx`)                        | **TLS cert does not match hostname**                               |
| `map.adsb.lol`                                  | `mlat-map`                                      | **TLS cert does not match hostname**                               |
| `mlat.adsb.lol`                                 | mlat                                            | CNAME→ingress                                                      |
| `mapproxy.adsb.lol`                             | mapproxy                                        | Cloudflare-proxied; HTTP/2 404 on `/`                              |
| `grafana.adsb.lol`                              | Grafana                                         | Public dashboard                                                   |
| `vrs-standing-data.adsb.lol`                    | GH Pages                                        | 200, `server: cloudflare`                                          |
| `status.adsb.lol`                               | GH Pages (`adsblol.github.io`)                  | 200, `server: GitHub.com`                                          |
| `out.adsb.lol`                                  | —                                               | Single node, no CNAME                                              |
| `git.adsb.lol`, `speranza.adsb.lol`             | —                                               | CT-only / internal, wildcard-covered                               |
| `vrs.adsb.lol`, `pilot.adsb.lol`, `my.adsb.lol` | —                                               | Wildcard-covered, not in repo config                               |

### Data ingest (TCP)

All four resolve through the same external-dns annotation on one LoadBalancer:
`in.adsb.lol`, `feed.adsb.lol`, `in.planes.lol`, `feed.planes.lol`

| Host:port                            | Protocol                        |
| ------------------------------------ | ------------------------------- |
| `feed.adsb.lol:1337`                 | BEAST in (with UUID)            |
| `feed.adsb.lol:1338`                 | MLAT                            |
| `feed.adsb.lol:30004`                | BEAST in                        |
| `feed.adsb.lol:30005`                | BEAST out                       |
| `feed.adsb.lol:31090`                | MLAT                            |
| `acars.in.adsb.lol:5550/5553`        | ACARS / ACARS (JSON lines)      |
| `feed-acars.adsb.lol:5550/5551/5552` | ACARS / HFDL / VDL2 (JSON only) |

Feeder identity uses UUIDs (`--write-receiver-id-json`, `mlat-client --uuid=UUID --privacy`), which is the mechanism for the per-feeder map and for `re-api` IP-based access control.

### TLS / certificate transparency

- `*.adsb.lol` + `adsb.lol` wildcard cert (covers all above).
- Also issued: `*.my.adsb.lol`, `status.adsb.lol`, **`speranza.adsb.lol`**, and — notably — **`birds.fbi.zip`** appearing inside an `adsb.lol` cert SAN set.
- `*.planes.lol` + `planes.lol` (separate wildcard).

---

## 5. Network-level attribution

### netcup GmbH — AS197540, Nuremberg, DE (primary production)

| IP               | rDNS                               | Serves                                                                                            |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `89.58.11.153`   | `v2202403213202259628.powersrv.de` | `adsb.lol`, `globe`, `test`, `history`, `map`, `api`, `mlat`, `in`, `feed`, `www`, `vrs`, `pilot` |
| `89.58.34.223`   | `v2202403213202259627.bestsrv.de`  | same cluster (2nd LB) + `out.adsb.lol`                                                            |
| `185.233.105.52` | `v2202403213202259629.nicesrv.de`  | same cluster (3rd LB)                                                                             |
| `159.195.60.218` | `v2202607213202481711.supersrv.de` | `re-api.adsb.lol`, `feed-acars.adsb.lol`                                                          |
| `159.195.81.163` | `v2202606213202470046.bestsrv.de`  | same                                                                                              |

Three consecutive netcup VPS IDs (`…259627`, `…259628`, `…259629`) forming the primary 3-node LB set, plus a later pair (`…2481711`, `…2470046`) for re-api/ACARS. Serial-adjacent allocation indicates same-day provisioning. All five are `nginx ingress-system2.adsb.lol`.

### Cloudflare — AS13335 (proxied edge + DNS + Pages)

`mapproxy.adsb.lol`, `vrs-standing-data.adsb.lol` → `104.26.4.74` / `104.26.5.74` / `172.67.68.25`. Cloudflare provides the free Pro plan via its open-source program (documented under sponsors). Note: most `*.adsb.lol` ingresses are annotated `cloudflare-proxied: "true"`, but resolve to bare netcup IPs — meaning those annotations are not in effect, or DNS-only records were kept for origin protection.

### planes.lol — Amazon AS16509 (different operator-owned path)

`planes.lol` → `216.150.1.65` / `216.150.1.1`; `feed.planes.lol` → `216.150.16.1`; `in.planes.lol` → `216.150.16.129`. NS = `ns1/ns2.vercel-dns.com`, `server: Vercel`, apex 404. This is a **Vercel/AWS-hosted parallel deployment** that accepts ingest traffic on the same ports but does not currently serve content — a second live ingest surface independent of the netcup stack.

### Operator's personal infrastructure

| Host                                          | IP                                      | ASN / Location               | Service                                                                   |
| --------------------------------------------- | --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `katia.sh`                                    | `172.67.154.93`                         | Cloudflare                   | apex                                                                      |
| `mail.katia.sh`                               | `31.220.45.124`                         | AS63473 HostHatch, Amsterdam | MX for adsb.lol; also `jitsi`, `pad` (CNAME→jitsi), `stalwart`, `webmail` |
| `git.katia.sh`                                | `37.187.156.130`                        | AS16276 OVH, Roubaix FR      | Gitea                                                                     |
| `hs.katia.sh`                                 | `193.123.36.0`                          | AS31898 Oracle, Amsterdam    | Home server                                                               |
| `wekan`/`nitter`/`lemmy`/`ams`/`ldn.katia.sh` | `202.61.194.69` → `gateway-56.katia.sh` | AS197540 netcup              | self-hosted services                                                      |
| `birds.fbi.zip`                               | `172.67.145.89`                         | Cloudflare                   | alt-domain; in adsb.lol cert SANs                                         |

SPF `_spf.katia.sh` = `ip4:31.220.45.124 ip6:2a01:6f0:ffff:5412::/64 ~all` — mail egress is HostHatch only.

### Peer network (mutual data sharing)

Partners exchange aggregated BEAST + MLAT bilaterally under CC0 (no PII). Documented:

- **FlyItalyADSB** (`flyitalyadsb.com`) — since Feb 2023
- **TheAirTraffic** (`theairtraffic.com`) — since Jul 2023, run by **Jack Sweeney (@Jxck-S)** + Ground Control (`grndcntrl.net`)

The `external` readsb also hardcodes `cnvr.io:30005` as a BEAST source. GitHub Actions bot identity is `github-actions@adsb.lol`.

Co-monitored on the same status page: **`adsb.im`** and `my.adsb.im` → `31.220.30.207` (AS63473 HostHatch, San Rafael), rDNS `adsb.im`, assigned to **dirkhh**. Same AS as the operator's own `mail.katia.sh`, but a different node and owner — the status config explicitly lists `dirkhh` as assignee for both `.im` sites.

---

## 6. Mirror topology — three distinct mirror mechanisms

### (a) GitHub Releases archive (open flight history) — the primary mirror

`globe_history_<year>` repos, one per year, **ODbL 1.0** licensed, GZIP-JSON per aircraft, generated by readsb `--write-globe-history`.

- `globe_history_2026` = **1762 GiB**
- Release tag = `v<YYYY.MM.DD>-<pod-name>`; each release = 1 day
- Pipeline: `kubectl -n adsblol get pods | grep planes-readsb` → `kubectl cp` day folder → tar → **`split -b 2000000000`** when >2GB (GitHub asset limit) → `github-release` upload → commit README. Idempotent; skips today and already-backed-up tags.
- Archive replicas by pod (from `PREFERRED_RELEASES.txt` day counts):

| Year | prod | staging | test | mlatonly |
| ---- | ---- | ------- | ---- | -------- |
| 2023 | 234  | 66      | 19   | —        |
| 2024 | 259  | 103     | —    | —        |
| 2025 | 274  | 86      | —    | —        |
| 2026 | 217  | 137     | —    | 4        |

⇒ **2× prod + 1× staging replicas**, matching the README: "two replicas of prod and one of staging." `prod` chosen as "preferred" when it is the larger payload; staging fills gaps when prod is down. `planes-readsb-mlatonly-0` is a newer 2026 variant shipping an unsplit single `.tar`.

- **Machine-readable manifests (the mirror discovery index):**
  - `PREFERRED_RELEASES.txt` — one line/day, comma-joined asset URLs (2026: 175 lines)
  - `ALL_RELEASES.txt` — every release, all replicas (2026: 293 lines)
  - `RELEASES.md` — human-readable month-grouped table with per-replica sizes
  - Regenerated daily by GitHub Actions cron `21 5 * * *` via `update-releases.py`
- Hotlink pattern: `https://github.com/adsblol/globe_history_<year>/releases/download/v<date>-<pod>/v<date>-<pod>.tar.a{a,b}`
- Each archive embeds `README.txt` with `envsubst` metadata: original path, **pod of origin**, `readsb --version`, upload date, ODbL + CC0 license files.
- Dual license per release: **ODbL** for the compiled database, **CC0** for the underlying feeder data (feeders waive rights by feeding).
- `history/` subfolder (readsb flags) powers the **`?r` replay feature**; `traces/` powers per-aircraft history display.

### (b) rclone object-store mirror

`upload-preferred-releases.sh` reads `PREFERRED_RELEASES.txt`, streams each `.tar`, and `rclone sync`s to `$REMOTE/globe_history/YYYY/MM/DD` — keeping only the most recent 3 complete days. In production this is served by the `rclone-mount` FUSE container inside the `history` deployment (remote `adsblol:history`, `--poll-interval=9s`, `--dir-cache-time=9999h`). Thus **GitHub Releases and the rclone remote are co-equal mirrors**, with GitHub as the durable/authoritative copy.

### (c) Data-link mirrors

`aircraft-data-links-2025` / `-2026` — ACARS/HFDL/VDL2 message archives, **CC0**, published to GitHub Releases. Ingest via `feed-acars.adsb.lol:5550/5551/5552` (JSON only — `acarsdec --output-format json`, `vdlm2dec`, `dumphfdl`, `dumpvdl2`).

### (d) Standing-data mirror

`vrs-standing-data` re-publishes **vradarserver/standing-data** hourly to GitHub Pages:
`vrs-standing-data.adsb.lol/routes/<XX>/<CALLSIGN>.json`, plus `routes.csv`, `airports.csv`.
`api:0/route/{callsign}` is deprecated and **302-redirects** here; `api:0/airport/{icao}` and `POST api:0/routeset` (≤100 callsigns, cached + bulk-fetched) remain live.

### (e) Client-side fetch helper

`scripts/best-download.py` is a ready-made downloader for third parties: it pulls all three years' `PREFERRED_RELEASES.txt`, reverses chronological order, downloads `.aa`/`.ab` chunks concurrently (semaphore 4), concatenates, untars to `YYYY/MM/DD`, and writes a `.done` marker. The team actively supports bulk community replication.

### Tile/basemap upstreams (proxied via `mapproxy` + `layers.js`)

`c.tile.openstreetmap.org` (primary, cached to GeoPackage), `api.maptiler.com`, `basemaps.cartocdn.com`, `services.arcgisonline.com` (World Imagery / Canvas / Street Map), `maps.dwd.de` WMS, `maps.wikimedia.org/osm-intl`, `wms.chartbundle.com`, `mesonet.agron.iastate.edu` (NEXRAD), `nowcoast.noaa.gov` WMSServer, `korona.geog.uni-heidelberg.de` (ASTER/roads), `tiles.adsb.co`, `github.com/alkissack/Dump1090-OpenLayers3-html`, `github.com/olithissen/AwacsOrbitsDE`.
Map proxy inherits `map.adsbexchange.com/mapproxy/tiles/1.0.0/` (OpenAIP + UL grids) — **ADSBExchange tile dependency**, notable given the infra README cites the ADSBExchange acquisition as the project's motivation.

---

## 7. Notable observations

1. **Hardcoded third-party secrets in git.** A **Bing Maps API key** is committed in cleartext in two files: `infra/manifests/default/planes/default/resources.yaml` (`tar1090-config`, `config.js`) and `infra/manifests/default/planes/test/kustomization.yaml` (`html-overlay` literals) — identical value `AqCdYNFHcAZuy4k9zT_UXZMdfSo5zN-mImkwN6PzcXNYyo0bYHaHik2F8qg-h1c1`. A **MapTiler Cloud API key** `777ad15e-3e64-4edf-8e86-84ba16e50961` appears in `planes/default/layers.js`. Both should be rotated and moved to Vault/SOPS.
2. **TLS breakage on two ingresses.** `history.adsb.lol` and `map.adsb.lol` fail hostname verification — no cert covers them despite the `adsblol-tls` secret and `*.adsb.lol` wildcard being referenced. These look stale/broken paths.
3. **`planes.lol` is a live ingest surface but serves nothing** (Vercel 404) while advertising `in.planes.lol` / `feed.planes.lol` on AWS IPs. Feeder redundancy or an unfinished migration.
4. **`allow-all` NetworkPolicy** across the whole `adsblol` namespace — no segmentation between the public ingest tier and internal hub/planes.
5. **Latent secret patterns.** `scripts/update.sh` still carries `Authorization: Bearer ***` (redacted, but the pattern invites re-leak) and sources an untracked `.envrc` via `source ... || true` (fail-open).
6. **Reproducibility gap.** `kustomization.yaml` Flux image tags are ~Feb 2023 vintage while `infra` was last pushed 2026-06-03 — the auto-generated pins appear stale relative to live images.
7. **`/metrics` returns literal `"lol"`** — deliberate anti-scraping, but it also defeats external uptime/metrics verification.
8. **Certificate cross-domain oddity:** `birds.fbi.zip` present in an `adsb.lol` SAN set — an operator-owned alternate domain sharing a cert with production.

---

## Appendix — Endpoint quick reference

**Web:** `adsb.lol` · `www.adsb.lol` · `api.adsb.lol` (→`/docs`) · `globe.adsb.lol` · `test.adsb.lol` · `re-api.adsb.lol` (feeder-IP-gated) · `history.adsb.lol` ⚠TLS · `map.adsb.lol` ⚠TLS · `mapproxy.adsb.lol` · `grafana.adsb.lol` · `mlat.adsb.lol` · `vrs-standing-data.adsb.lol` · `status.adsb.lol` · `planes.lol` (404)

**Ingest TCP:** `feed.adsb.lol` / `in.adsb.lol` / `feed.planes.lol` / `in.planes.lol` — `1337` `1338` `30004` `30005` `31090` · `feed-acars.adsb.lol` `5550` `5551` `5552` · `acars.in.adsb.lol` `5550` `5553`

**Open data:** `github.com/adsblol/globe_history_{2023..2026}` (releases + `PREFERRED_RELEASES.txt`) · `github.com/adsblol/aircraft-data-links-{2025,2026}` · `vrs-standing-data.adsb.lol`

**Images:** `ghcr.io/adsblol/{api,history,mlat-server-sync-map}` · `ghcr.io/katlol/{readsb,mlat-server,tar1090}`

**Contact:** `info@adsb.lol` · Discord `discord.gg/3wPfmyNFRq` · Libera.Chat `katia` (`libera-51207669`)
