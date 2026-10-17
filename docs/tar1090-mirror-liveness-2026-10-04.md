# tar1090 / readsb public mirror liveness

**Verified:** 2026-10-04 · **Egress:** residential MY (`<egress-ip>`) ·
**Method:** research only — HTTP status + headers + **static asset** content
inspection (`/config.js`, `index.html`). **No data endpoints were called**
(`/data/aircraft.json` was never requested).

## Upstream correction: tar1090 moved orgs

`github.com/wcampbell0x2a/tar1090` → **HTTP 404** (repo gone; not in the
`wcampbell0x2a` repo list at all). Canonical repo is now:

**`https://github.com/wiedehopf/tar1090`** (1,920★, default branch `master`,
last push 2026-09-29). Any doc citing `wcampbell0x2a/tar1090` is stale.

Canonical tar1090 data path, from `html/early.js` (the only file in the repo
that names it): **`data/aircraft.json`**, relative to the webroot.

## What tar1090's README actually lists

`wiedehopf/tar1090` README §"Notable websites related to tar1090 / readsb"
splits its list into **two different sections**, and conflating them is the
error that produces phantom mirrors:

### A. "Websites using this software" — these ARE tar1090 deployments

| hostname                    | full path              | liveness evidence |
| --------------------------- | ---------------------- | ----------------- |
| `adsb.lol`                  | `/data/aircraft.json`  | root 200 `text/html`; `/config.js` **200 `application/javascript`**, 200 B: `adsblol=true;aggregator=true;PageName="ADSB.lol ✈ Globe"` |
| `globe.adsbexchange.com`    | `/data/aircraft.json`  | root 200, 108 KB; `/config.js` 200, **14,253 B** stock tar1090 config (its `PageName` comment reads `ADS-B Exchange - track aircraft live`) |
| `globe.airplanes.live`      | `/data/aircraft.json`  | root 200; **`<title>tar1090</title>`**; `/config.js` 200, 13,440 B stock tar1090 config; HTML links `github.com/airplanes-live/tar1090` |
| `globe.adsb.fi`             | `/data/aircraft.json`  | **CF-challenged from this egress** (403, `server: cloudflare`, `cf-ray: …-SIN`). *Alive but unverifiable here.* Corroborated: `adsb.fi` main site 200 and links `globe.adsb.fi` |
| `globe.theairtraffic.com`  | `/data/aircraft.json`  | `/config.js` 200, 15,617 B stock tar1090 config (already a configured feed in this repo) |
| `skylink.hpradar.com`       | `/data/aircraft.json`  | `/config.js` 200, 14,592 B stock tar1090 config (already a configured feed) |

**Mount point proven for all five:** `/config.js` → 200 while
`/tar1090/config.js` → 404. That is the tar1090-at-webroot signature, so the
path is `/data/aircraft.json`, not `/tar1090/data/aircraft.json`.

### B. "Notable Projects that use ADS-B data" — these are NOT mirrors

Listed in the **same README**, but under a heading that means *consumer of
ADS-B data*, not *deployment of tar1090*. Neither exposes `aircraft.json`:

| hostname                | full path                          | verdict |
| ----------------------- | ---------------------------------- | ------- |
| `adsb.exposed`          | **none — no tar1090/readsb endpoint exists** | **Not a mirror.** HTTP 200 but `server: GitHub.com`, `x-github-request-id`, `x-served-by: cache-kul9829-KUL` → **static GitHub Pages**. 0 hits for `tar1090`/`readsb`. HTML is Leaflet 1.9.4 (CDN) + Next.js; `/config.js` points at **`clickhouse-staging.com` / `fly-selfhosted-backend-3.clickhouse.com`**, not readsb. `/data/aircraft.json` does not exist. |
| `tech.marksblogg.com`   | **none — article, not an instance** | **Not a mirror.** Root 200 (88 KB) is a blog. The README points at the *article* `/global-flight-tracking-adsb.html` (200, 108 KB), which is prose about flight tracking and mentions `readsb` 3× / `Raspberry` 1× as the author's own setup — it hosts no data endpoint. |
| `gpsjam.org`            | n/a                                | 200 (4 KB), a GPS-jamming map that *consumes* ADS-B. Not in this repo's measured feed set. |

**Bottom line:** both hosts named in the task are reachable (HTTP 200) but
**neither is a tar1090/readsb mirror and neither has an `aircraft.json`.** Any
mirror list that includes them is wrong.

## Already-known-dead (excluded, re-confirmed out of scope)

`adsb.330k.info`, `tar1090.adsb.im`, `radar.fdy.cz` — per task, not re-probed.

## Caveat

`globe.adsb.fi`'s 403 is a Cloudflare managed challenge scoped to this egress,
**not** evidence of a dead host — its `/tar1090/config.js` returns 302 (a
catch-all redirect to `/`), which is what a CF-fronted site does. Do not record
it as dead without testing from a browser/headful Chrome.
