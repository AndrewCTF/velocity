#!/usr/bin/env node
/*
 * ais-vesselfinder-feeder — headless-browser bridge for VesselFinder's
 * Cloudflare-gated public vessel API. The AIS twin of tools/adsb-globe-feeder.
 *
 * There is NO keyless GLOBAL AIS REST feed reachable from a datacenter IP — the
 * keyless backend sources (Digitraffic, Kystverket/Kystdatahuset) are Northern-
 * Europe regional (~4.5k). VesselFinder aggregates terrestrial + satellite AIS
 * worldwide, but its tile API (/api/pub/mp2) sits behind Cloudflare and a
 * proprietary packed-binary wire format, so neither httpx nor the browser
 * frontend can pull it directly.
 *
 * Same trick as the ADS-B globe feeder: open VesselFinder in a real headless
 * Chromium (clears Cloudflare, sets the session cookies), then drive the page's
 * OWN authorized `fetch('/api/pub/mp2?bbox=...')` across a world grid of tiles
 * (the one thing the gate lets through), decode the packed records in-page, and
 * serve the union as a plain vessels.json on localhost. ~21k vessels worldwide
 * (measured 2026-06-29). The backend's keyless AIS poller (app/ais_keyless.py)
 * pulls it and republishes each fix into the unified vessel store + /ws/ais.
 *
 * Robust by construction in the degrade direction: every record is range-gated
 * (valid MMSI MID + lat/lon), so if VesselFinder changes the wire layout the
 * feed thins toward zero rather than emitting garbage onto the operator's map.
 *
 * Env:
 *   SITE         VesselFinder origin (default https://www.vesselfinder.com/)
 *   PORT         http port (default 8091)
 *   ZOOM         tile zoom passed to mp2 (default 7 — lower = more decimated)
 *   GRID_DEG     world-grid tile size in degrees (default 30)
 *   CONCURRENCY  parallel in-page tile fetches (default 4 — VF rate-limits high)
 *   READ_MS      world-grid refresh cadence (default 30000 — vessels move slow)
 *   MIN_VESSELS  floor to accept a scrape as good (default 200)
 *   MAX_VESSELS  hard cap on the union (default 60000)
 *   CHROME_PATH  system Chrome path (no bundled Playwright Chromium on this distro)
 */
'use strict';

const http = require('http');
const { chromium } = require('playwright');

const SITE = process.env.SITE || 'https://www.vesselfinder.com/';
const PORT = parseInt(process.env.PORT || '8091', 10);
const ZOOM = parseInt(process.env.ZOOM || '7', 10);
const GRID_DEG = parseInt(process.env.GRID_DEG || '30', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const READ_MS = parseInt(process.env.READ_MS || '30000', 10);
const MIN_VESSELS = parseInt(process.env.MIN_VESSELS || '200', 10);
const MAX_VESSELS = parseInt(process.env.MAX_VESSELS || '60000', 10);
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* eslint-disable no-undef */
// scrapeFn runs IN THE PAGE (via page.evaluate) — it uses the page's own
// authorized fetch() + DataView. Passed as a FUNCTION (not a string) so
// Playwright serializes + CALLS it with the cfg arg (a string arg would be
// eval'd as an expression and never invoked — the classic feeder footgun).
//
// VesselFinder /api/pub/mp2 wire layout (reverse-engineered + validated live):
//   bytes 0..15   header (skipped)
//   then records: [fixed payload][1-byte name length][name UTF-8]
//   vessel records have a 15-byte fixed payload:
//     [0..1]  unknown (course/nav-status — not decoded; we don't guess)
//     [2..5]  MMSI            uint32 big-endian
//     [6..9]  latitude  *1e6  int32  big-endian
//     [10..13] longitude *1e6 int32  big-endian
//     [14]    unknown (not decoded)
//   other marker types (clusters, AtoN, base stations) carry other payload
//   sizes; we anchor on the length-prefixed ASCII name and accept ONLY the
//   15-byte vessel layout, then range-gate MMSI + lat/lon.
async function scrapeFn(cfg) {
  const S = 1e6;
  function decode(buf) {
    const u = new Uint8Array(buf);
    if (u.length < 18) return [];
    const dv = new DataView(buf);
    const out = [];
    let cur = 16; // after header
    for (let k = 16; k < u.length - 1; k++) {
      const L = u[k];
      if (L < 1 || L > 24 || k + 1 + L > u.length) continue;
      let ok = true;
      let hasAlpha = false;
      for (let j = 1; j <= L; j++) {
        const c = u[k + j];
        if (c < 32 || c > 126) { ok = false; break; }
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) hasAlpha = true;
      }
      if (!ok || !hasAlpha || k < cur) continue;
      // bytes [cur .. k-1] are this record's fixed payload
      if (k - cur === 15) {
        const mmsi = dv.getUint32(cur + 2, false);
        const lat = dv.getInt32(cur + 6, false) / S;
        const lon = dv.getInt32(cur + 10, false) / S;
        if (mmsi >= 100000000 && mmsi < 800000000 &&
            lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
          let nm = '';
          for (let j = 1; j <= L; j++) nm += String.fromCharCode(u[k + j]);
          nm = nm.trim();
          out.push({ mmsi, lat, lon, name: nm || undefined });
        }
      }
      cur = k + L + 1; // next record starts after this name
    }
    return out;
  }

  // World grid of bbox tiles (bbox units are degrees*1e6, lon,lat,lon,lat).
  const tiles = [];
  for (let lon = -180; lon < 180; lon += cfg.gridDeg) {
    for (let lat = -80; lat < 80; lat += cfg.gridDeg) {
      tiles.push([lon, lat, Math.min(lon + cfg.gridDeg, 180), Math.min(lat + cfg.gridDeg, 84)]);
    }
  }
  const union = new Map();
  let idx = 0, tilesOk = 0, tilesFail = 0;
  async function worker() {
    while (idx < tiles.length && union.size < cfg.maxVessels) {
      const t = tiles[idx++];
      const bbox = [t[0] * S, t[1] * S, t[2] * S, t[3] * S].map(Math.round).join(',');
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 12000);
        let r, b;
        try {
          r = await fetch(`/api/pub/mp2?bbox=${bbox}&zoom=${cfg.zoom}&mmsi=0&mcbe=1`, {
            headers: { accept: '*/*' }, signal: ac.signal,
          });
          if (!r.ok) { tilesFail++; continue; }
          b = await r.arrayBuffer();
        } finally { clearTimeout(to); }
        for (const v of decode(b)) {
          union.set(v.mmsi, v);
          if (union.size >= cfg.maxVessels) break;
        }
        tilesOk++;
      } catch (e) {
        tilesFail++;
      }
    }
  }
  const ws = [];
  for (let i = 0; i < cfg.concurrency; i++) ws.push(worker());
  await Promise.all(ws);
  return { vessels: [...union.values()], tilesOk, tilesFail, tilesTotal: tiles.length };
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

// Relaunch Chromium if it crashed/disconnected (OOM, Cloudflare nuking the tab)
// — without this a dead browser made every newContext() throw forever. Same
// self-heal as the ADS-B feeder.
async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  if (browser) { try { await browser.close(); } catch (e) {} }
  browser = null;
  browser = await chromium.launch(launchOpts());
  browser.on('disconnected', () => { browser = null; log('browser disconnected — will relaunch'); });
  log('browser launched');
}

// Confirm Cloudflare cleared + the vessel API answers from THIS browser context
// — poll a tiny-bbox mp2 until it returns the binary (application/json) body.
// This is the real "ready" signal (same idea as the ADS-B feeder waiting for
// tar1090 globals): a Cloudflare challenge answers /api/pub/mp2 with a text/html
// interstitial, so we require a json content-type + non-empty body, not just 200.
async function waitForApi(p) {
  for (let i = 0; i < 12; i++) {
    try {
      // 8s AbortController so a Cloudflare-stalled connection can't hang the
      // evaluate (and wedge the whole feeder loop) instead of resolving.
      const res = await p.evaluate(async () => {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 8000);
        try {
          const r = await fetch('/api/pub/mp2?bbox=-2000000,-2000000,2000000,2000000&zoom=4&mmsi=0&mcbe=1', { headers: { accept: '*/*' }, signal: ac.signal });
          const ct = r.headers.get('content-type') || '';
          const b = await r.arrayBuffer();
          return { ok: r.ok, json: ct.includes('json'), n: b.byteLength };
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
    // 'commit' returns as soon as the response starts — we don't need the full
    // page or its sub-resources, just the origin + Cloudflare cookies. A slow
    // challenge no longer blows the whole timeout before we can probe the API.
    await p.goto(SITE, { waitUntil: 'commit', timeout: 45000 });
  } catch (e) {
    // Don't abort init on a goto stall (Cloudflare interstitial / slow nav) —
    // waitForApi below is the real readiness gate.
    log('goto warning -', e.message, '- probing API anyway');
  }
  if (!(await waitForApi(p))) {
    throw new Error('vessel API not reachable (Cloudflare not cleared yet)');
  }
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

async function pump() {
  if (!page) { await initPage(); if (!page) return; }
  try {
    const res = await page.evaluate(scrapeFn, {
      zoom: ZOOM, gridDeg: GRID_DEG, concurrency: CONCURRENCY, maxVessels: MAX_VESSELS,
    });
    if (res && Array.isArray(res.vessels) && res.vessels.length >= MIN_VESSELS) {
      latest = { vessels: res.vessels, lastGood: Date.now(), tilesOk: res.tilesOk, tilesFail: res.tilesFail, tilesTotal: res.tilesTotal };
      log('scraped', res.vessels.length, 'vessels', `(${res.tilesOk}/${res.tilesTotal} tiles ok, ${res.tilesFail} failed)`);
    } else if (Date.now() - latest.lastGood > 180000) {
      // Stalled >3 min (Cloudflare re-challenge, cookies expired) — rebuild page.
      log('stalled — reloading page');
      await initPage();
    }
  } catch (e) {
    log('scrape error -', e.message, '- reinit');
    await initPage();
  }
}

async function main() {
  // Serve IMMEDIATELY — before any browser init — so a slow Cloudflare clear can
  // never block the port. The union is just empty until the first scrape lands;
  // the backend poller tolerates an empty/200 response.
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
