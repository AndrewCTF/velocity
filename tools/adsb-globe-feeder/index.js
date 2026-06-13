#!/usr/bin/env node
/*
 * adsb-globe-feeder — headless-browser bridge for Cloudflare-gated tar1090
 * aggregators (airplanes.live, adsb.fi, adsb.lol, adsb.one, ...).
 *
 * Those sites serve their FULL global aircraft set, but only as
 * zstd-compressed binCraft behind Cloudflare, with no CORS and the whole-globe
 * box blocked — so neither httpx nor the browser frontend can pull them.
 *
 * Instead of reverse-engineering zstd + binCraft + globe-tiling (which breaks
 * every time they change it), we let THE SITE'S OWN tar1090 do all of that:
 * open the page in a real headless Chromium (clears Cloudflare), zoom the map
 * to the whole world so tar1090 fetches + decodes + parses every aircraft into
 * its own `g.planesOrdered` store, then just read that store out and serve it
 * as a plain readsb-style aircraft.json on localhost. Robust by construction —
 * when the aggregator changes its wire format, their frontend updates and we
 * keep reading the same plane objects.
 *
 * Point the OSINT backend at it:
 *   ADSB_FEED_URLS=...,http://127.0.0.1:8090/aircraft.json
 *
 * Env:
 *   GLOBE_URLS   comma-separated tar1090 sites (default airplanes.live)
 *   PORT         http port (default 8090)
 *   ZOOM         world zoom level (default 2.2)
 *   CENTER       "lon,lat" map center (default "15,35")
 *   MIN_PLANES   minimum plane count to consider a page healthy (default 500)
 *   READ_MS      how often to re-read each page's store (default 5000)
 */
'use strict';

const http = require('http');
const { chromium } = require('playwright');

const GLOBE_URLS = (process.env.GLOBE_URLS || 'https://globe.airplanes.live/')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PORT = parseInt(process.env.PORT || '8090', 10);
const ZOOM = parseFloat(process.env.ZOOM || '2.2');
const CENTER = (process.env.CENTER || '15,35').split(',').map(Number);
const MIN_PLANES = parseInt(process.env.MIN_PLANES || '500', 10);
const READ_MS = parseInt(process.env.READ_MS || '5000', 10);
const NUDGE_MS = parseInt(process.env.NUDGE_MS || '30000', 10);
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* eslint-disable no-undef */
// These run IN THE PAGE (via page.evaluate) — they reference the page's tar1090
// globals (g, OLMap, ol), which don't exist in Node. They are passed as
// functions (NOT strings) so Playwright serializes + CALLS them.

// In-page reader: pull tar1090's own plane store → readsb aircraft.json items.
function readFn() {
  if (typeof g === 'undefined' || !g.planesOrdered) return null;
  const out = [];
  for (const p of g.planesOrdered) {
    if (!p || !p.position) continue;
    const lon = p.position[0], lat = p.position[1];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const hex = (p.icao || p.hex || '').toLowerCase();
    if (!hex) continue;
    out.push({
      hex, lat, lon,
      flight: ((p.flight || '') + '').trim() || undefined,
      track: p.track, alt_baro: p.alt_baro, gs: p.gs,
      squawk: p.squawk, category: p.category, r: p.registration,
      seen: p.seen, seen_pos: p.seen_pos,
    });
  }
  return out;
}

function zoomFn({ z, c }) {
  try { OLMap.getView().setZoom(z); OLMap.getView().setCenter(ol.proj.fromLonLat(c)); return true; }
  catch (e) { return false; }
}

let browser = null;
const pages = new Map(); // url -> { page, aircraft:[], lastGood:0 }

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function openPage(url) {
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait for Cloudflare to clear + tar1090 globals to exist.
  await page.waitForFunction('typeof OLMap !== "undefined" && typeof g !== "undefined"', { timeout: 60000 });
  // Zoom to the whole world ONCE — this single move makes tar1090 fetch +
  // decode + parse every aircraft into g.planesOrdered. Do NOT keep re-moving
  // it (that resets the load); a slow keep-alive nudge refreshes it later.
  await page.evaluate(zoomFn, { z: ZOOM, c: CENTER });
  // Poll (same READ_FN the loop uses) until the store populates. tar1090
  // typically fills within ~3 s of the zoom.
  let loaded = 0;
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(2500);
    const ac = await page.evaluate(readFn);
    if (Array.isArray(ac) && ac.length >= MIN_PLANES) { loaded = ac.length; break; }
  }
  if (loaded) log('opened', url, '-', loaded, 'aircraft');
  else log('warn: planes not populated for', url, '(loop will keep trying)');
  return page;
}

// Tiny alternating pan to keep tar1090's fetch loop alive (headless tabs can be
// treated as "hidden" and throttle refresh). Once every NUDGE_MS, NOT per read.
function nudgeFn({ c, d }) {
  try { OLMap.getView().setCenter(ol.proj.fromLonLat([c[0] + d, c[1]])); return true; } catch (e) { return false; }
}
/* eslint-enable no-undef */

async function initPage(url) {
  try {
    const existing = pages.get(url);
    if (existing && existing.page) { try { await existing.page.context().close(); } catch (e) {} }
    const page = await openPage(url);
    pages.set(url, { page, aircraft: [], lastGood: Date.now() });
  } catch (e) {
    log('init failed for', url, '-', e.message);
    pages.set(url, { page: null, aircraft: [], lastGood: 0 });
  }
}

async function pump(url) {
  const slot = pages.get(url);
  if (!slot || !slot.page) { await initPage(url); return; }
  try {
    // READ ONLY — never re-move the map here; that resets tar1090's load.
    const ac = await slot.page.evaluate(readFn);
    if (Array.isArray(ac) && ac.length >= MIN_PLANES) {
      slot.aircraft = ac;
      slot.lastGood = Date.now();
    } else if (Date.now() - slot.lastGood > 150000) {
      // Truly stalled for >2.5 min — rebuild the page (rare; keeps stream open
      // the rest of the time per "don't open/close constantly").
      log('stalled', url, '- reloading');
      await initPage(url);
    }
  } catch (e) {
    log('read error', url, '-', e.message, '- reinit');
    await initPage(url); // page died (e.g. Cloudflare re-challenge); rebuild it
  }
}

let nudgeTick = 0;
async function nudgeAll() {
  nudgeTick++;
  const d = (nudgeTick % 2) ? 0.03 : -0.03; // alternate so center actually changes
  for (const slot of pages.values()) {
    if (!slot.page) continue;
    try { await slot.page.evaluate(nudgeFn, { c: CENTER, d }); } catch (e) {}
  }
}

function unioned() {
  const merged = new Map();
  for (const slot of pages.values()) {
    for (const a of slot.aircraft) merged.set(a.hex, a);
  }
  return { now: Date.now() / 1000, aircraft: [...merged.values()] };
}

async function main() {
  // No bundled Playwright Chromium on this distro — use system Google Chrome.
  // Override with CHROME_PATH=/path/to/chrome if needed.
  const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;
  else launchOpts.channel = 'chrome';
  browser = await chromium.launch(launchOpts);
  for (const url of GLOBE_URLS) await initPage(url);

  http.createServer((req, res) => {
    if (req.url.startsWith('/aircraft.json')) {
      const body = JSON.stringify(unioned());
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      res.end(body);
    } else if (req.url.startsWith('/health')) {
      const per = {};
      for (const [u, s] of pages) per[u] = { aircraft: s.aircraft.length, age_s: ((Date.now() - s.lastGood) / 1000) | 0 };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ total: unioned().aircraft.length, sources: per }));
    } else { res.statusCode = 404; res.end('not found'); }
  }).listen(PORT, '127.0.0.1', () => log(`serving aircraft.json on http://127.0.0.1:${PORT}`));

  // Slow keep-alive: nudge the map every NUDGE_MS so tar1090 keeps refreshing
  // the global extent (headless tabs can otherwise be throttled as "hidden").
  setInterval(() => { nudgeAll().catch(() => {}); }, NUDGE_MS);

  // Read loop — just read each page's store on a cadence (no map moves here).
  for (;;) {
    for (const url of GLOBE_URLS) await pump(url);
    await new Promise((f) => setTimeout(f, READ_MS));
  }
}

main().catch((e) => { log('fatal', e); process.exit(1); });
