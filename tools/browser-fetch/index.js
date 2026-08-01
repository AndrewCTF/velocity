#!/usr/bin/env node
// Generic real-Chrome fetch tier. Serves on 127.0.0.1:8095.
//
// WHY: some upstreams answer 403 to every HTTP client from every address —
// measured 2026-08-01 with httpx, curl (bare and with a full browser header
// set), and both a residential and a Cloudflare WARP exit. Headers and IPs are
// not the discriminator; running a real browser is. Two distinct cases, and
// only the second one needs `capture`:
//
//   1. JS/managed challenge — the gate wants a browser to execute something.
//      Navigating to the URL clears it and the body is the answer.
//   2. WAF PATH rule — e.g. globe.airplanes.live/data/aircraft.json is 403 for
//      everyone INCLUDING real Chrome (measured), while the map at / loads fine
//      and its own /re-api/?binCraft call returns 200. Nothing can fetch that
//      path directly; you have to load the page and read what IT fetched.
//
//   GET /fetch?url=<u>[&wait=<ms>]              → navigate, return the body
//   GET /fetch?url=<page>&capture=<regex>[&wait=<ms>]
//                                               → navigate, return the body of
//                                                 the first response the page
//                                                 made whose URL matches
//   GET /health                                 → {ok, contexts, last_good}
//
// Bodies come back base64 in JSON because case 2 is routinely binary (zstd).
// There is deliberately no eval endpoint: this is an HTTP server that fetches
// arbitrary URLs, and arbitrary in-page JS on top of that is a footgun. It
// binds loopback only.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const PORT = Number(process.env.BROWSER_FETCH_PORT || 8095);
const MAX_CONTEXTS = Number(process.env.BROWSER_MAX_PAGES || 4);
const IDLE_MS = Number(process.env.BROWSER_IDLE_S || 300) * 1000;
const NAV_TIMEOUT_MS = Number(process.env.BROWSER_NAV_TIMEOUT_MS || 45000);
const PROFILE_ROOT =
  process.env.BROWSER_PROFILE_DIR || path.join(os.homedir(), '.cache', 'osint', 'browser-profiles');

// Pacing floor between page loads of the SAME host, plus jitter. A browser that
// hammers gets blocked like anything else, and a metronome-exact interval is
// itself a tell — real sessions are irregular.
const PACE_MS = Number(process.env.BROWSER_PACE_MS || 2000);
const JITTER_MS = Number(process.env.BROWSER_JITTER_MS || 1500);
// How long to let a Cloudflare interstitial work before giving up on it.
const CHALLENGE_MS = Number(process.env.BROWSER_CHALLENGE_MS || 25000);
const CHALLENGE_RE = /just a moment|checking your browser|challenge-platform|cf-chl/i;

let browser = null;
let lastGood = 0;
const contexts = new Map(); // host -> { ctx, page, idleTimer }
const gates = new Map(); // host -> { chain, last }

function log(...a) { console.log(new Date().toISOString(), ...a); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One page load at a time per host, never closer together than PACE_MS+jitter.
// Concurrency 1 is the point: two tabs of the same site loading at once is not
// something a person does, and it doubles the rate at the moment a gate is
// deciding about you. Callers of other hosts are unaffected.
function paced(host, fn) {
  const g = gates.get(host) || { chain: Promise.resolve(), last: 0 };
  gates.set(host, g);
  const run = async () => {
    const wait = g.last + PACE_MS + Math.floor(Math.random() * JITTER_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      // Stamp AFTER the work: the floor is between page loads finishing and the
      // next starting, so a slow load can never bunch up against the next one.
      g.last = Date.now();
    }
  };
  // .then(run, run) — the next caller must run whether or not this one failed,
  // or one error would wedge the host's queue forever.
  g.chain = g.chain.then(run, run);
  return g.chain;
}

// Copied from tools/adsb-globe-feeder/index.js rather than shared: those flags
// carry measured post-mortems (timer throttling starved tar1090's own poll
// loop; the heap cap turned a slow renderer leak into a restart instead of an
// 8.9 GB host climb) and four working feeders are not worth refactoring to
// de-duplicate one function. Keep them in step by hand.
// HEADLESS IS ITSELF THE TELL. Measured 2026-08-01 on globe.adsb.fi, same box,
// same address, seconds apart: headless Chrome got 403 + a "Just a moment..."
// interstitial that never cleared in 25 s; headful Chrome on an Xvfb display
// got 200 and the real page with no challenge at all. When this is on, the
// python side spawns us under xvfb-run so there is a display to draw into.
const HEADFUL = process.env.BROWSER_HEADFUL === '1';

function launchOpts() {
  const o = {
    headless: !HEADFUL,
    // Own the shutdown. Playwright installs its own signal handlers by default
    // and tears the browser down the instant SIGTERM lands — measured: the
    // flush below then failed with "Failed to open a new tab" and the session's
    // cookies were lost, which is exactly what the persistent profile exists to
    // prevent. With these off, our handler flushes first and closes second.
    handleSIGTERM: false,
    handleSIGINT: false,
    handleSIGHUP: false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
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
      // The one anti-detection flag worth having: it drops the obvious
      // navigator.webdriver tell. Anything past this is a stealth-plugin arms
      // race that is itself fingerprinted.
      '--disable-blink-features=AutomationControlled',
    ],
  };
  if (HEADFUL) {
    // Pin the window system to the X11 display xvfb-run handed us. Chrome picks
    // its Ozone backend automatically and WAYLAND_DISPLAY is inherited even
    // inside xvfb-run, so without this a Chrome release that starts preferring
    // Wayland would draw on the OPERATOR'S real desktop instead of the virtual
    // one. Measured 2026-08-01 it already chooses X11 (3 and 7 top-level
    // windows on the Xvfb root, none on :0) — this stops that being luck.
    o.args.push('--ozone-platform=x11');
  }
  if (process.env.CHROME_PATH) o.executablePath = process.env.CHROME_PATH;
  else o.channel = 'chrome'; // real Chrome, not bundled Chromium — different fingerprint
  if (process.env.WARP_PROXY) o.proxy = { server: process.env.WARP_PROXY };
  return o;
}

// Heal on disconnect: without this a crashed browser leaves every later request
// throwing "Target page, context or browser has been closed" forever.
async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  if (browser) { try { await browser.close(); } catch (e) {} }
  browser = await chromium.launch(launchOpts());
  browser.on('disconnected', () => { browser = null; log('browser disconnected — relaunching on next use'); });
  log('browser launched');
}

// One persistent context per host, so a clearance cookie earned once is still
// there on the next request (and after a restart). Do NOT override the user
// agent: a hand-set UA that disagrees with the JS fingerprint reads worse than
// none at all.
async function contextFor(host) {
  let slot = contexts.get(host);
  if (slot && slot.ctx) {
    clearTimeout(slot.idleTimer);
  } else {
    await ensureBrowser();
    while (contexts.size >= MAX_CONTEXTS) {
      const [oldest] = contexts.keys();
      await closeContext(oldest);
    }
    // Reload this host's saved cookies. A returning visitor with a live
    // clearance cookie is both cheaper (no re-clear) and less interesting to a
    // bot filter than a first-time one on every boot.
    const statePath = path.join(PROFILE_ROOT, `${host.replace(/[^a-z0-9.-]/gi, '_')}.json`);
    const restored = fs.existsSync(statePath);
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      storageState: restored ? statePath : undefined,
      serviceWorkers: 'block',
    });
    ctx._statePath = statePath;
    slot = { ctx, page: await ctx.newPage(), idleTimer: null };
    contexts.set(host, slot);
    const carried = restored ? (await ctx.cookies()).length : 0;
    log(
      `context opened for ${host} (${contexts.size}/${MAX_CONTEXTS})` +
      (restored ? ` — restored ${carried} cookies from ${path.basename(statePath)}` : ' — new profile')
    );
  }
  slot.idleTimer = setTimeout(() => closeContext(host), IDLE_MS);
  return slot;
}

// Write this host's cookies to disk. Called after every successful load, not
// only at close: a SIGKILL, an OOM or a crashed browser must not cost a
// clearance that has already been earned.
async function saveState(host) {
  const slot = contexts.get(host);
  if (!slot) return;
  try {
    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    await slot.ctx.storageState({ path: slot.ctx._statePath });
  } catch (e) { log('storageState save failed', host, e && e.message); }
}

async function closeContext(host) {
  const slot = contexts.get(host);
  if (!slot) return;
  await saveState(host);
  contexts.delete(host);
  clearTimeout(slot.idleTimer);
  try { await slot.ctx.close(); } catch (e) {}
  log(`context closed for ${host}`);
}

// A Cloudflare MANAGED CHALLENGE answers the navigation itself with 403/503 and
// a "Just a moment..." interstitial, then runs its JS and replaces the document
// once satisfied. Returning that first response is returning the trap, not the
// page — which is exactly what this tier existed to avoid. Wait for the
// interstitial to go away, then read the document that replaced it.
async function awaitChallenge(page, nav) {
  const status = nav ? nav.status() : 0;
  const title = await page.title().catch(() => '');
  const head = (await page.content().catch(() => '')).slice(0, 3000);
  if (![403, 429, 503].includes(status) && !CHALLENGE_RE.test(title)) return null;
  if (!CHALLENGE_RE.test(title) && !CHALLENGE_RE.test(head)) return null; // a plain block, not a challenge
  log(`challenge detected (${status}) on ${page.url()} — waiting up to ${CHALLENGE_MS}ms`);
  try {
    await page.waitForFunction(
      () => !/just a moment|checking your browser/i.test(document.title),
      { timeout: CHALLENGE_MS, polling: 500 }
    );
  } catch (e) {
    log('challenge did not clear');
    return null; // caller returns the interstitial honestly, status and all
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  log('challenge cleared');
  return Buffer.from(await page.content());
}

function fetchUrl(url, opts) {
  const host = new URL(url).host;
  return paced(host, () => loadPage(host, url, opts));
}

async function loadPage(host, url, { capture, waitMs }) {
  const { page } = await contextFor(host);
  let captured = null;
  const onResponse = async (r) => {
    if (captured || !capture || !capture.test(r.url())) return;
    try { captured = { status: r.status(), url: r.url(), body: await r.body() }; } catch (e) {}
  };
  if (capture) page.on('response', onResponse);
  try {
    const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const solved = await awaitChallenge(page, nav);
    if (solved && !capture) {
      lastGood = Date.now();
      return { status: 200, url: page.url(), body: solved, captured: false, challenge: 'cleared' };
    }
    if (waitMs) await page.waitForTimeout(waitMs);
    if (capture) {
      // Give the page time to make the request we are after, if it has not yet.
      const deadline = Date.now() + NAV_TIMEOUT_MS;
      while (!captured && Date.now() < deadline) await page.waitForTimeout(250);
      if (!captured) throw new Error(`no response matched ${capture}`);
      lastGood = Date.now();
      return { status: captured.status, url: captured.url, body: captured.body, captured: true };
    }
    const body = await nav.body().catch(() => Buffer.from(''));
    lastGood = Date.now();
    return { status: nav.status(), url: nav.url(), body, captured: false };
  } finally {
    if (capture) page.off('response', onResponse);
    await saveState(host);
  }
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  let u;
  try { u = new URL(req.url, `http://127.0.0.1:${PORT}`); } catch (e) { return send(400, { error: 'bad url' }); }

  if (u.pathname === '/health') {
    return send(200, { ok: true, contexts: contexts.size, last_good: lastGood, max: MAX_CONTEXTS });
  }
  if (u.pathname !== '/fetch') return send(404, { error: 'not found' });

  const target = u.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) return send(400, { error: 'url must be http(s)' });
  let capture = null;
  if (u.searchParams.get('capture')) {
    try { capture = new RegExp(u.searchParams.get('capture')); } catch (e) { return send(400, { error: 'bad capture regex' }); }
  }
  const waitMs = Math.min(Number(u.searchParams.get('wait') || 0) || 0, 30000);
  const t0 = Date.now();
  try {
    const out = await fetchUrl(target, { capture, waitMs });
    send(200, {
      status: out.status,
      url: out.url,
      captured: out.captured,
      bytes: out.body.length,
      body_b64: out.body.toString('base64'),
      ms: Date.now() - t0,
    });
  } catch (e) {
    log('fetch failed', target, e && e.message);
    send(502, { error: String((e && e.message) || e).slice(0, 300), ms: Date.now() - t0 });
  }
});

if (require.main === module) {
  // Loopback only. This endpoint fetches arbitrary URLs on request; it must
  // never be reachable off the host. The caller (app/browser_fetch.py) does the
  // public-address check before asking.
  server.listen(PORT, '127.0.0.1', () => log(`browser-fetch listening on 127.0.0.1:${PORT} (profiles: ${PROFILE_ROOT})`));

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      // Flush every live context's cookies FIRST. Without this a shutdown threw
      // away the clearance a session had just earned, and the next boot arrived
      // as a first-time visitor again — the opposite of what the persistent
      // profile is for.
      try {
        await Promise.all([...contexts.keys()].map((h) => closeContext(h)));
      } catch (e) {}
      try { if (browser) await browser.close(); } catch (e) {}
      process.exit(0);
    });
  }
} else {
  // Required as a module (selftest.js) — export the pure bits worth checking.
  module.exports = { paced, gates, PACE_MS, JITTER_MS, launchOpts, HEADFUL };
}
