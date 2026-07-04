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

function launchOpts() {
  const o = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Headless/background tabs throttle their JS timers — which slows
      // tar1090's OWN fetch loop, so g.planesOrdered refreshed only ~every 10 s
      // (measured) instead of tar1090's native ~1-7 s. These keep the tab
      // "foreground" so tar1090 polls the aggregator at full rate.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  };
  if (process.env.CHROME_PATH) o.executablePath = process.env.CHROME_PATH;
  else o.channel = 'chrome';
  return o;
}

// Relaunch Chromium if it has crashed/disconnected. WITHOUT this, a browser
// crash (OOM, Cloudflare nuking the tab) left `browser` pointing at a dead
// process and every newContext() threw "Target page, context or browser has
// been closed" forever — the feeder served 0 aircraft until restarted. Now any
// page-open first heals the browser. The last-served aircraft per source are
// carried forward (slots aren't cleared) so recovery is a brief dip, not a
// blackout. A `disconnected` handler nulls `browser` so the next call relaunches.
async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  if (browser) { try { await browser.close(); } catch (e) {} }
  browser = null;
  browser = await chromium.launch(launchOpts());
  browser.on('disconnected', () => { browser = null; log('browser disconnected — will relaunch on next read'); });
  log('browser launched');
}

async function openPage(url) {
  await ensureBrowser();
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
  // Freshest-wins per hex: keep the aircraft from whichever aggregator reported
  // the NEWEST position (smallest seen_pos). This is what exploits phase
  // diversity across multiple out-of-phase aggregators — a shared aircraft
  // updates whenever ANY source refreshes it, so the effective refresh is
  // ~(globe-regen / N sources) instead of one source's full ~10s cycle.
  // (Last-wins pinned every shared aircraft to a single source's cadence, which
  // wasted the extra feeds — they added coverage but not refresh rate.)
  const merged = new Map(); // hex -> { sp, a }
  for (const slot of pages.values()) {
    for (const a of slot.aircraft) {
      const sp = typeof a.seen_pos === 'number' ? a.seen_pos : 1e9;
      const prev = merged.get(a.hex);
      if (!prev || sp < prev.sp) merged.set(a.hex, { sp, a });
    }
  }
  return { now: Date.now() / 1000, aircraft: [...merged.values()].map((v) => v.a) };
}

async function main() {
  // Serve the HTTP endpoint IMMEDIATELY — BEFORE any browser init — so a slow or
  // dead aggregator (Cloudflare challenge, a globe that won't populate) can never
  // block the port. With N sources unioned for phase diversity, sequential
  // init-before-serve hung :8090 for >70s on one bad tab. The union is just empty
  // until tabs populate; the backend's sidecar-only path backfills with OpenSky
  // below its floor in the meantime.
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

  // Launch (or relaunch) Chrome, then init every source CONCURRENTLY so one slow
  // tab can't gate the others (the boot hang). Each source self-heals in the read
  // loop regardless of how its init went.
  await ensureBrowser();
  await Promise.allSettled(GLOBE_URLS.map((url) => initPage(url)));

  // Read loop — just read each page's store on a cadence (no map moves here).
  for (;;) {
    for (const url of GLOBE_URLS) await pump(url);
    await new Promise((f) => setTimeout(f, READ_MS));
  }
}

main().catch((e) => { log('fatal', e); process.exit(1); });
