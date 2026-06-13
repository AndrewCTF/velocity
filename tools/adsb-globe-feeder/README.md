# adsb-globe-feeder

A tiny **headless-browser bridge** that turns a Cloudflare-gated `tar1090`
aggregator (airplanes.live, adsb.fi, adsb.lol, adsb.one, …) into a plain
`aircraft.json` the OSINT backend can ingest via `ADSB_FEED_URLS`.

## Why this exists

The big ADS-B aggregators serve their **full global** aircraft set, but only as
zstd-compressed `binCraft` **behind Cloudflare**, with **no CORS** and the
whole-globe box blocked. So:

- the backend (httpx) gets `403`,
- the OSINT frontend can't fetch them cross-origin (no CORS),
- reverse-engineering zstd + binCraft + globe-tiling is brittle (breaks on every
  format change).

Instead we let **the site's own `tar1090`** do all of that. We open the page in a
real headless Chrome (which clears Cloudflare), zoom the map to the **whole
world** once — that single move makes `tar1090` fetch + decode + parse every
aircraft into its own `g.planesOrdered` store — then just **read that store out**
and serve it as a plain readsb-style `aircraft.json`. When the aggregator changes
its wire format, *their* frontend updates and we keep reading the same plane
objects. (Measured: ~14.6k aircraft from airplanes.live alone.)

The stream is kept **open** — we never open/close the browser per cycle. We read
the store every few seconds and nudge the map only ~once every 30 s to keep the
fetch loop alive (headless tabs can otherwise be throttled as "hidden").

## Run it

Needs Node + a system Google Chrome (Playwright has no bundled Chromium on this
distro, so it uses `channel: 'chrome'`).

```bash
cd tools/adsb-globe-feeder
npm install
node index.js
# serving aircraft.json on http://127.0.0.1:8090
```

Then point the OSINT backend at it (in `.env`), appended to the keyless feeds:

```
ADSB_FEED_URLS=https://globe.theairtraffic.com/data/aircraft.json,https://skylink.hpradar.com/data/aircraft.json,https://api.adsb.lol/v2/point/0/0/20000,http://127.0.0.1:8090/aircraft.json
```

The backend rotates one feed per cycle, so the sidecar is just one more
independent network unioned (deduped by icao24) into the global snapshot.

## Config (env vars)

| var | default | meaning |
|-----|---------|---------|
| `GLOBE_URLS` | `https://globe.airplanes.live/` | comma-separated tar1090 sites; each opens its own page and is unioned |
| `PORT` | `8090` | http port for `/aircraft.json` + `/health` |
| `ZOOM` | `2.2` | world zoom level (lower = wider) |
| `CENTER` | `15,35` | `lon,lat` map center |
| `MIN_PLANES` | `500` | min plane count to consider a page healthy |
| `READ_MS` | `5000` | how often to re-read the store |
| `NUDGE_MS` | `30000` | keep-alive map-nudge interval |
| `CHROME_PATH` | _(unset)_ | explicit Chrome binary path (else uses the `chrome` channel) |

Add more Cloudflare-gated aggregators to widen coverage, e.g.:

```bash
GLOBE_URLS="https://globe.airplanes.live/,https://globe.adsb.fi/,https://globe.adsb.one/" node index.js
```

## Endpoints

- `GET /aircraft.json` → `{ now, aircraft: [ {hex,lat,lon,flight,track,alt_baro,gs,squawk,…}, … ] }`
- `GET /health` → per-source counts + staleness

## Caveats

- Best-effort and **ToS-gray** — these sites prefer you *feed* (run an
  ultrafeeder) rather than scrape. Use a sane `NUDGE_MS`; don't spin many pages.
- Run it where it won't get IP-blocked (a residential box is friendlier than a
  datacenter). The robust, blessed alternative is to run the sdr-enthusiasts
  ultrafeeder and point `ADSB_FEED_URLS` at *your own* tar1090.
