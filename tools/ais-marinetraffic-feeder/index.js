#!/usr/bin/env node
/*
 * ais-marinetraffic-feeder — headless-browser bridge for MarineTraffic's public
 * vessel tile API. The richer twin of tools/ais-vesselfinder-feeder.
 *
 * MarineTraffic tracks ~326k vessels worldwide (terrestrial + satellite AIS) and
 * its map calls a public per-tile JSON endpoint:
 *   /getData/get_data_json_4/z:{z}/X:{x}/Y:{y}/station:0
 * Unlike VesselFinder's packed-binary /api/pub/mp2, this returns CLEAN JSON rows
 * with name, speed, course, heading, type, flag, length and destination — a much
 * richer per-vessel payload. It is not Cloudflare-gated as hard as VesselFinder,
 * but the frontend still issues it with the page's own session, so we drive it
 * the same way: open MarineTraffic in a real headless Chromium, fetch its OWN
 * tile endpoint across a world grid, dedup by SHIP_ID in-page, and serve the
 * union as vessels.json on localhost. app/ais_keyless.py polls it and republishes
 * each fix into the unified vessel store + /ws/ais.
 *
 * MarineTraffic rows carry SHIP_ID (MarineTraffic's own vessel id), NOT MMSI, so
 * these vessels are keyed under a distinct id namespace (vessel:mt-<ship_id>) by
 * the backend and cannot be MMSI-deduped against the other feeds — that is why
 * MarineTraffic is the PRIMARY keyless global source and VesselFinder is OFF by
 * default (running both would double-render every ship).
 *
 * Degrades toward zero, not garbage: every row is range-gated (finite lat/lon +
 * a SHIP_ID), so a MarineTraffic schema change thins the feed rather than putting
 * junk on the operator's map.
 *
 * Env:
 *   SITE         MarineTraffic origin (default https://www.marinetraffic.com/en/ais/home)
 *   PORT         http port (default 8092)
 *   ZOOM         tile zoom (default 2 → 16 world tiles ~10k vessels, gentle; 3 → 64 ~15k; 4 → 256 dense)
 *   CONCURRENCY  parallel in-page tile fetches (default 1 — MarineTraffic throttles bursts)
 *   PACE_MS      gap between tile fetches (default 400 — respects the /getData rate limit)
 *   READ_MS      world-grid refresh cadence (default 60000 — vessels move slow)
 *   MIN_VESSELS  floor to accept a scrape as good (default 200)
 *   MAX_VESSELS  hard cap on the union (default 60000)
 *   CHROME_PATH  system Chrome path (no bundled Playwright Chromium on this distro)
 */
'use strict';

const http = require('http');
const { chromium } = require('playwright');

const SITE = process.env.SITE || 'https://www.marinetraffic.com/en/ais/home/centerx:0/centery:20/zoom:3';
const PORT = parseInt(process.env.PORT || '8092', 10);
// ZOOM 2 = 16 world tiles (~10k vessels), a gentle sweep that finishes in ~8s and
// idles ~50s — sustainable against MarineTraffic's Cloudflare throttle. ZOOM 3 (64
// tiles ~15k) or 4 (256 tiles) get denser but the near-continuous request rate
// eventually trips an IP-level block. Prefer widening ZOOM only if you also raise
// READ_MS to keep the average request rate low.
const ZOOM = parseInt(process.env.ZOOM || '2', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
const PACE_MS = parseInt(process.env.PACE_MS || '400', 10); // gap between tile fetches — MarineTraffic burst-throttles /getData
const READ_MS = parseInt(process.env.READ_MS || '60000', 10);
const MIN_VESSELS = parseInt(process.env.MIN_VESSELS || '200', 10);
const MAX_VESSELS = parseInt(process.env.MAX_VESSELS || '60000', 10);
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* eslint-disable no-undef */
// fetchTileInPage runs IN THE PAGE (via page.evaluate) — it uses the page's own
// authorized fetch() so the Cloudflare cf_clearance cookie applies. Passed as a
// FUNCTION (not a string) so Playwright serializes + CALLS it with the arg (a
// string arg would be eval'd as an expression and never invoked — the classic
// feeder footgun). It fetches ONE tile and returns the mapped vessel objects —
// ONE tile per evaluate (not a whole-world loop) so MarineTraffic's SPA client-
// navigation destroys at most a single tile's context, which node retries, rather
// than killing an entire in-page sweep.
//
// MarineTraffic /getData/get_data_json_4/z:{z}/X:{x}/Y:{y}/station:0 returns
// { type, data: { rows: [ {LAT,LON,SPEED,COURSE,HEADING,SHIPNAME,SHIPTYPE,
// SHIP_ID,FLAG,LENGTH,DESTINATION,...}, ... ], areaShips } }. SPEED is in tenths
// of a knot; COURSE/HEADING in degrees; SHIPTYPE is the numeric AIS type code.
// Returns { rows: [mapped] } on success, or { fail: true } on non-200/non-json.
async function fetchTileInPage(cfg) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(`/getData/get_data_json_4/z:${cfg.zoom}/X:${cfg.x}/Y:${cfg.y}/station:0`, {
      headers: { accept: '*/*' }, signal: ac.signal,
    });
    if (!r.ok) return { fail: true };
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return { fail: true };
    const j = await r.json();
    const raw = j && j.data && Array.isArray(j.data.rows) ? j.data.rows : [];
    const out = [];
    for (const v of raw) {
      const id = v.SHIP_ID;
      const lat = parseFloat(v.LAT);
      const lon = parseFloat(v.LON);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      const speed = parseFloat(v.SPEED);
      const course = parseFloat(v.COURSE);
      const heading = parseFloat(v.HEADING);
      const shipType = parseInt(v.SHIPTYPE, 10);
      const length = parseFloat(v.LENGTH);
      const nm = (v.SHIPNAME || '').trim();
      out.push({
        ship_id: String(id),
        lat, lon,
        name: nm && nm !== '[SAT-AIS]' ? nm : undefined,
        sog: Number.isFinite(speed) ? speed / 10 : undefined,
        cog: Number.isFinite(course) ? course : undefined,
        heading: Number.isFinite(heading) ? heading : undefined,
        shipType: Number.isFinite(shipType) ? shipType : undefined,
        flag: v.FLAG || undefined,
        length: Number.isFinite(length) ? length : undefined,
        destination: (v.DESTINATION || '').trim() || undefined,
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
let latest = { vessels: [], lastGood: 0, tilesOk: 0, tilesFail: 0, tilesTotal: 0 };

function log(...a) { console.log(new Date().toISOString(), ...a); }

function launchOpts() {
  const o = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (process.env.CHROME_PATH) o.executablePath = process.env.CHROME_PATH;
  else o.channel = 'chrome';
  return o;
}

// Relaunch Chromium if it crashed/disconnected — same self-heal as the ADS-B +
// VesselFinder feeders (a dead browser otherwise makes every newContext() throw).
async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  if (browser) { try { await browser.close(); } catch (e) {} }
  browser = null;
  browser = await chromium.launch(launchOpts());
  browser.on('disconnected', () => { browser = null; log('browser disconnected — will relaunch'); });
  log('browser launched');
}

// Confirm the tile API answers JSON from THIS browser context (Cloudflare cleared
// / session set). A challenge would answer with a text/html interstitial, so we
// require a json content-type + rows array, not just 200.
async function waitForApi(p) {
  for (let i = 0; i < 12; i++) {
    try {
      const res = await p.evaluate(async () => {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 8000);
        try {
          const r = await fetch('/getData/get_data_json_4/z:2/X:1/Y:1/station:0', { headers: { accept: '*/*' }, signal: ac.signal });
          const ct = r.headers.get('content-type') || '';
          if (!ct.includes('json')) return { ok: false };
          const j = await r.json();
          return { ok: r.ok, json: true, n: j && j.data && j.data.rows ? j.data.rows.length : 0 };
        } catch (e) { return { err: String(e) }; }
        finally { clearTimeout(to); }
      });
      if (res && res.ok && res.json && res.n > 0) return true;
    } catch (e) {}
    await p.waitForTimeout(3000);
  }
  return false;
}

async function openPage() {
  await ensureBrowser();
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
  const p = await context.newPage();
  try {
    // 'commit' returns as soon as the response starts — the map SPA never reaches
    // 'domcontentloaded' inside 45s (it long-polls), so waiting for that just burns
    // the timeout. We only need the origin's Cloudflare cookies; waitForApi below is
    // the real readiness gate. Do NOT add a settle wait here: the SPA client-
    // navigates (zoom/center route change) shortly after commit, and a probe fired
    // during that navigation throws "Execution context was destroyed" — probing
    // immediately catches the page before the reroute.
    await p.goto(SITE, { waitUntil: 'commit', timeout: 45000 });
  } catch (e) {
    log('goto warning -', e.message, '- probing API anyway');
  }
  if (!(await waitForApi(p))) {
    throw new Error('marinetraffic tile API not reachable (challenge not cleared yet)');
  }
  // The map SPA does ONE client-side reroute (URL normalization) ~0.5s after
  // commit that destroys the JS execution context; after that the page is stable
  // for minutes. waitForApi may have passed BEFORE that reroute, so settle past it
  // here — otherwise the first scrape sweep fires straight through the reroute and
  // every in-page tile fetch throws "Execution context was destroyed".
  await p.waitForTimeout(4000);
  return p;
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

// One node-driven tile fetch: runs a SHORT page.evaluate (one tile). Returns the
// mapped rows, or null on a recoverable failure — which includes MarineTraffic's
// SPA client-navigation throwing "Execution context was destroyed" (that kills the
// evaluate but not the page, so node just retries the tile).
async function fetchTile(x, y) {
  try {
    const res = await page.evaluate(fetchTileInPage, { zoom: ZOOM, x, y });
    return res && Array.isArray(res.rows) ? res.rows : null;
  } catch (e) {
    return null; // navigation/context-destroyed/throttle — caller retries
  }
}

async function pump() {
  if (!page) { await initPage(); if (!page) return; }
  const n = 1 << ZOOM; // 2^zoom tiles per axis
  const tiles = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) tiles.push([x, y]);
  const union = new Map();
  let idx = 0, tilesOk = 0, tilesFail = 0;

  async function worker() {
    while (idx < tiles.length && union.size < MAX_VESSELS) {
      if (!page) return; // page went away mid-sweep (initPage nulls it on failure)
      const [x, y] = tiles[idx++];
      let rows = await fetchTile(x, y);
      if (rows === null) {
        await new Promise((f) => setTimeout(f, 600)); // back off a throttle / let a nav settle
        rows = await fetchTile(x, y);
      }
      if (rows === null) { tilesFail++; }
      else { for (const v of rows) union.set(v.ship_id, v); tilesOk++; }
      await new Promise((f) => setTimeout(f, PACE_MS)); // pace — MarineTraffic burst-throttles /getData
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
    latest = { vessels: [...union.values()], lastGood: Date.now(), tilesOk, tilesFail, tilesTotal: tiles.length };
    log('scraped', union.size, 'vessels', `(${tilesOk}/${tiles.length} tiles ok, ${tilesFail} failed)`);
  } else if (Date.now() - latest.lastGood > 180000) {
    // Persistent under-floor (Cloudflare re-challenge, cookies expired) — rebuild page.
    log('stalled (' + union.size + ' vessels) — reloading page');
    await initPage();
  } else {
    log('partial scrape', union.size, 'vessels (below floor, keeping last good)');
  }
}

async function main() {
  // Serve IMMEDIATELY — before browser init — so a slow challenge clear can never
  // block the port. The union is empty until the first scrape lands; the backend
  // poller tolerates an empty/200 response.
  http.createServer((req, res) => {
    if (req.url.startsWith('/vessels.json')) {
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      res.end(JSON.stringify({ now: Date.now() / 1000, vessels: latest.vessels }));
    } else if (req.url.startsWith('/health')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        total: latest.vessels.length,
        age_s: latest.lastGood ? ((Date.now() - latest.lastGood) / 1000) | 0 : null,
        tiles_ok: latest.tilesOk, tiles_fail: latest.tilesFail, tiles_total: latest.tilesTotal,
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
