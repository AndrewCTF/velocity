#!/usr/bin/env node
/*
 * ais-myshiptracking-feeder — headless-browser bridge for MyShipTracking's public
 * vessel API. The MMSI-keyed twin of the MarineTraffic / VesselFinder feeders.
 *
 * MyShipTracking's map calls a public bbox endpoint:
 *   /requests/vesselsonmaptempTTT.php?type=json&minlat=&maxlat=&minlon=&maxlon=&zoom=&...&filters=
 * It returns a TAB-delimited text body (NOT JSON despite type=json): a unix-time
 * header line, then one row per vessel:
 *   [type] \t 0 \t MMSI \t NAME \t LAT \t LON \t SOG \t COG \t ? \t last_ts \t
 * Crucially the vessels carry a real 9-digit MMSI (col 2) plus SOG/COG/name — so
 * unlike MarineTraffic (SHIP_ID only) these key on the standard `vessel:<mmsi>` id
 * and dedup cleanly against every other AIS feed. Measured ~23k unique MMSI world-
 * wide across a 30-degree grid (2026-07-05).
 *
 * The endpoint caps each response at ~5000 rows, so global coverage needs a bbox
 * GRID (not one call). It is NOT behind Cloudflare (a plain UA + the page session
 * is enough) and tolerated 72 rapid grid calls without throttling.
 *
 * Same headless trick + degrade-to-zero contract as the sibling feeders: open the
 * site once in a real Chromium (sets its session), drive the page's own fetch()
 * across the grid, parse in-page, serve the union as vessels.json on localhost.
 * app/ais_keyless.py polls it into the unified vessel store + snapshot layer.
 *
 * Env:
 *   SITE         MyShipTracking map URL (default the world map)
 *   PORT         http port (default 8093)
 *   ZOOM         zoom passed to the endpoint (server decimation; default 8)
 *   GRID_DEG     world-grid bbox cell size in degrees (default 30)
 *   CONCURRENCY  parallel in-page fetches (default 3)
 *   READ_MS      world-grid refresh cadence (default 30000)
 *   MIN_VESSELS  floor to accept a scrape as good (default 500)
 *   MAX_VESSELS  hard cap on the union (default 60000)
 *   CHROME_PATH  system Chrome path
 */
'use strict';

const http = require('http');
const { chromium } = require('playwright');

const SITE = process.env.SITE || 'https://www.myshiptracking.com/?lat=25&lng=0&zoom=3';
const PORT = parseInt(process.env.PORT || '8093', 10);
const ZOOM = parseInt(process.env.ZOOM || '8', 10);
const GRID_DEG = parseInt(process.env.GRID_DEG || '30', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const READ_MS = parseInt(process.env.READ_MS || '30000', 10);
const MIN_VESSELS = parseInt(process.env.MIN_VESSELS || '500', 10);
const MAX_VESSELS = parseInt(process.env.MAX_VESSELS || '60000', 10);
// Viewport stays at the size the site was verified against. A Playwright route
// handler and a smaller viewport were both tried on 2026-07-27 and the site's
// own vessel endpoint became unreachable for 20 minutes straight against a
// working baseline — this feeder drives that endpoint from inside the page, so
// anything that perturbs the page's request path costs the whole tier. The
// process flags below are safe and are where this feeder's savings come from.
const VIEW_W = parseInt(process.env.VIEW_W || '1366', 10);
const VIEW_H = parseInt(process.env.VIEW_H || '900', 10);
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Default filter the map sends — all vessel types, no size/speed/year restriction.
const FILTERS = JSON.stringify({
  vtypes: ',0,3,4,6,7,8,9,10,11,12,13', ports: '1', minsog: 0, maxsog: 60,
  minsz: 0, maxsz: 500, minyr: 1950, maxyr: 2026, status: '', mapflt_from: '', mapflt_dest: '',
});

/* eslint-disable no-undef */
// fetchCellInPage runs IN THE PAGE (one bbox cell per evaluate — a page navigation
// destroys at most one cell's context, which node retries). Passed as a FUNCTION.
// Parses the TAB-delimited body and returns mapped vessel objects.
async function fetchCellInPage(cfg) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 12000);
  try {
    const u = `/requests/vesselsonmaptempTTT.php?type=json&minlat=${cfg.minlat}&maxlat=${cfg.maxlat}` +
      `&minlon=${cfg.minlon}&maxlon=${cfg.maxlon}&zoom=${cfg.zoom}&selid=-1&seltype=0&timecode=-1` +
      `&filters=${encodeURIComponent(cfg.filters)}`;
    const r = await fetch(u, { headers: { accept: '*/*' }, signal: ac.signal });
    if (!r.ok) return { fail: true };
    const txt = await r.text();
    if (txt.indexOf('\t') === -1) return { fail: true }; // an HTML challenge/error, not the tab body
    const out = [];
    for (const line of txt.split('\n')) {
      const a = line.split('\t');
      if (a.length < 8) continue;
      const mmsi = parseInt(a[2], 10);
      const lat = parseFloat(a[4]);
      const lon = parseFloat(a[5]);
      if (!Number.isFinite(mmsi) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (mmsi < 100000000 || mmsi >= 1000000000) continue; // 9-digit MMSI only
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      const nm = (a[3] || '').trim();
      const sog = parseFloat(a[6]);
      const cog = parseFloat(a[7]);
      out.push({
        mmsi,
        lat, lon,
        name: nm && nm !== String(mmsi) ? nm : undefined, // unnamed rows repeat the MMSI as name
        sog: Number.isFinite(sog) ? sog : undefined,
        cog: Number.isFinite(cog) ? cog : undefined,
      });
    }
    return { rows: out };
  } catch (e) {
    return { fail: true };
  } finally { clearTimeout(to); }
}
/* eslint-enable no-undef */

let browser = null;
let page = null;
let latest = { vessels: [], lastGood: 0, cellsOk: 0, cellsFail: 0, cellsTotal: 0 };
// The vessel array is the whole cost of /vessels.json (~2 MB, ~22k entries) and
// it only changes once per 30 s sweep, while the backend polls every 30 s and
// retries. Serialise it ONCE per sweep and splice the small header per request.
//
// Deliberately NO ETag/304 here: `age_s` is the freshness the poller uses to
// REFUSE a stale union (docs/decisions.md, 2026-07-15). A 304 would make the
// caller reuse the age it was told last time, which is exactly how a frozen
// cache advertises itself as live. The header must be recomputed every time.
let vesselsJson = Buffer.from('[]');

function rebuildVesselsJson() {
  vesselsJson = Buffer.from(JSON.stringify(latest.vessels));
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

function launchOpts() {
  const o = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Match the ADS-B feeder: headless tabs are treated as background and
      // throttle their timers, which slows the SPA's own boot and the retry
      // path. The rest is long-lived-scraper hygiene — a per-renderer heap cap
      // turns a slow leak into a renderer restart instead of a host-memory
      // climb (8.9 GB across the browser tier, measured 2026-07-27).
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      '--js-flags=--max-old-space-size=512',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-client-side-phishing-detection',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  };
  if (process.env.CHROME_PATH) o.executablePath = process.env.CHROME_PATH;
  else o.channel = 'chrome';
  // Optional Cloudflare WARP egress (app/warp.py publishes the loopback SOCKS5
  // port). Unset = direct, which is what has been clearing the gate here.
  if (process.env.WARP_PROXY) o.proxy = { server: process.env.WARP_PROXY };
  return o;
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  if (browser) { try { await browser.close(); } catch (e) {} }
  browser = null;
  browser = await chromium.launch(launchOpts());
  browser.on('disconnected', () => { browser = null; log('browser disconnected — will relaunch'); });
  log('browser launched');
}

// Confirm the vessel endpoint answers the tab body from THIS context.
async function waitForApi(p) {
  for (let i = 0; i < 12; i++) {
    try {
      const res = await p.evaluate(async (filters) => {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 8000);
        try {
          const u = `/requests/vesselsonmaptempTTT.php?type=json&minlat=-85&maxlat=85&minlon=-180&maxlon=180&zoom=3&selid=-1&seltype=0&timecode=-1&filters=${encodeURIComponent(filters)}`;
          const r = await fetch(u, { headers: { accept: '*/*' }, signal: ac.signal });
          const t = await r.text();
          return { ok: r.ok, rows: t.split('\n').filter((l) => l.indexOf('\t') !== -1).length };
        } catch (e) { return { err: String(e) }; }
        finally { clearTimeout(to); }
      }, FILTERS);
      if (res && res.ok && res.rows > 0) return true;
    } catch (e) {}
    await p.waitForTimeout(3000);
  }
  return false;
}

async function openPage() {
  await ensureBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: VIEW_W, height: VIEW_H },
  });
  try {
    const p = await context.newPage();
    try {
      await p.goto(SITE, { waitUntil: 'commit', timeout: 45000 });
    } catch (e) {
      log('goto warning -', e.message, '- probing API anyway');
    }
    if (!(await waitForApi(p))) {
      throw new Error('myshiptracking vessel API not reachable yet');
    }
    // Settle past any early SPA reroute (same one-shot reroute footgun as the
    // MarineTraffic feeder) before the first grid sweep fires.
    await p.waitForTimeout(3000);
    return p;
  } catch (e) {
    // Close THIS context on any failed open so its chrome renderer processes
    // don't orphan on the browser. While the site blocks us, initPage() reloads
    // every cycle and each failed openPage (waitForApi false / goto throw) used
    // to leave its context alive — ~1-2 leaked renderers per 30 s, hundreds/hr.
    try { await context.close(); } catch (_) {}
    throw e;
  }
}

async function initPage() {
  try {
    if (page) { try { await page.context().close(); } catch (e) {} }
    page = await openPage();
    log('page opened', SITE);
  } catch (e) {
    log('init failed -', e.message);
    page = null;
  }
}

async function fetchCell(cell) {
  try {
    const res = await page.evaluate(fetchCellInPage, { ...cell, zoom: ZOOM, filters: FILTERS });
    return res && Array.isArray(res.rows) ? res.rows : null;
  } catch (e) {
    return null; // navigation/context-destroyed — caller retries
  }
}

async function pump() {
  if (!page) { await initPage(); if (!page) return; }
  const cells = [];
  for (let lon = -180; lon < 180; lon += GRID_DEG) {
    for (let lat = -90; lat < 90; lat += GRID_DEG) {
      cells.push({ minlat: lat, maxlat: Math.min(lat + GRID_DEG, 85), minlon: lon, maxlon: Math.min(lon + GRID_DEG, 180) });
    }
  }
  const union = new Map();
  let idx = 0, cellsOk = 0, cellsFail = 0;

  async function worker() {
    while (idx < cells.length && union.size < MAX_VESSELS) {
      if (!page) return;
      const cell = cells[idx++];
      let rows = await fetchCell(cell);
      if (rows === null) {
        await new Promise((f) => setTimeout(f, 500));
        rows = await fetchCell(cell);
      }
      if (rows === null) { cellsFail++; }
      else { for (const v of rows) union.set(v.mmsi, v); cellsOk++; }
    }
  }

  try {
    const ws = [];
    for (let i = 0; i < CONCURRENCY; i++) ws.push(worker());
    await Promise.all(ws);
  } catch (e) {
    log('sweep error -', e.message);
  }

  if (union.size >= MIN_VESSELS) {
    latest = { vessels: [...union.values()], lastGood: Date.now(), cellsOk, cellsFail, cellsTotal: cells.length };
    rebuildVesselsJson();
    log('scraped', union.size, 'vessels', `(${cellsOk}/${cells.length} cells ok, ${cellsFail} failed)`);
  } else if (Date.now() - latest.lastGood > 180000) {
    log('stalled (' + union.size + ' vessels) — reloading page');
    await initPage();
  } else {
    log('partial scrape', union.size, 'vessels (below floor, keeping last good)');
  }
}

async function main() {
  http.createServer((req, res) => {
    if (req.url.startsWith('/vessels.json')) {
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      // last_good is the wall-clock of the scrape these positions came from, NOT
      // the serve time. When the site blocks us the union below is kept verbatim
      // (see pump()), so `now` alone would advertise a frozen cache as fresh
      // forever and the poller would stamp hour-old fixes as live — the same
      // cached-tier trap as ADS-B seen_pos_s. Serve the honest age with the data.
      const head = JSON.stringify({
        now: Date.now() / 1000,
        last_good: latest.lastGood ? latest.lastGood / 1000 : null,
        age_s: latest.lastGood ? ((Date.now() - latest.lastGood) / 1000) | 0 : null,
      });
      // {"now":…,"last_good":…,"age_s":…  +  ,"vessels":[…]}
      const body = Buffer.concat([
        Buffer.from(head.slice(0, -1)),
        Buffer.from(',"vessels":'),
        vesselsJson,
        Buffer.from('}'),
      ]);
      res.setHeader('content-length', body.length);
      res.end(body);
    } else if (req.url.startsWith('/health')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        total: latest.vessels.length,
        age_s: latest.lastGood ? ((Date.now() - latest.lastGood) / 1000) | 0 : null,
        cells_ok: latest.cellsOk, cells_fail: latest.cellsFail, cells_total: latest.cellsTotal,
        rss_mb: (process.memoryUsage().rss / 1048576) | 0,
        bytes_json: vesselsJson.length,
      }));
    } else { res.statusCode = 404; res.end('not found'); }
  }).listen(PORT, '127.0.0.1', () => log(`serving vessels.json on http://127.0.0.1:${PORT}`));

  await initPage();
  for (;;) {
    await pump();
    await new Promise((f) => setTimeout(f, READ_MS));
  }
}

main().catch((e) => { log('fatal', e); process.exit(1); });
