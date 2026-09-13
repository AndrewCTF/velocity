// Release smoke: drives the SHIPPED stack (docker-compose.prod.yml: built web
// bundle behind nginx + the api image) in a real browser and proves the boot
// contract that unit tests cannot see.
//
// Why this exists (docs/decisions.md, 2026-09-13): verify.sh was green while
// the map sat on "loading config…" for the whole backend lifespan. The defect
// only existed when the real stack booted and a browser loaded it.
//
// Usage (repo root, stack already `up -d`):
//   NODE_PATH=<dir containing playwright> node scripts/smoke-release.cjs
// Env: BASE_URL (default http://127.0.0.1:8080), COMPOSE_FILE
// (default docker-compose.prod.yml), CHROME (optional executable path),
// ARTIFACT_DIR (screenshots on failure; default ./smoke-artifacts).
//
// DOM-only assertions: a production build has no window.__viewer DEV globals.
// ponytail: no entity-count checks; they depend on upstreams a CI runner may
// not reach and would flake. The shell must work with zero data.

const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const COMPOSE = process.env.COMPOSE_FILE || 'docker-compose.prod.yml';
const ART = process.env.ARTIFACT_DIR || 'smoke-artifacts';
const BOOT_S = Number(process.env.SMOKE_BOOT_TIMEOUT_S || 600);

const log = (...a) => console.log(`[smoke +${Math.round(process.uptime())}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compose(...args) {
  execFileSync('docker', ['compose', '-f', COMPOSE, ...args], { stdio: 'inherit' });
}

async function status(p) {
  try {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(5000) });
    return { code: r.status, body: await r.text() };
  } catch {
    return { code: 0, body: '' };
  }
}

async function waitFor(what, fn, timeoutS) {
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutS}s waiting for ${what}`);
    await sleep(1000);
  }
}

function check(cond, msg) {
  if (!cond) throw new Error(msg);
  log('ok:', msg);
}

async function stackChecks() {
  // A failed `vite build` leaves the PREVIOUS bundle in the web_dist volume, so
  // nginx would serve stale code and every check below would test the wrong
  // build (happened in the 2026-09-13 rehearsal). Require this run's build to
  // have exited 0.
  const exit = execFileSync('docker', ['compose', '-f', COMPOSE, 'ps', '-a', 'web-build', '--format', '{{.ExitCode}} {{.State}}'])
    .toString().trim();
  check(exit === '0 exited', `web-build completed successfully (${exit || 'no container'})`);

  // nginx serves the built bundle (not a 404 while web-build is still running).
  const index = await waitFor('index.html via nginx', async () => {
    const s = await status('/');
    return s.code === 200 && s.body.includes('id="root"') ? s : null;
  }, BOOT_S);
  const assets = [...index.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  check(assets.length > 0, `index.html references built assets (${assets.length})`);
  for (const a of assets) check((await status(a)).code === 200, `asset 200: ${a}`);

  // Backend reachable through nginx, config carries the RuntimeConfig contract.
  await waitFor('/api/config 200', async () => (await status('/api/config')).code === 200, BOOT_S);
  check((await status('/api/health')).code === 200, '/api/health 200 via nginx');
  const cfg = JSON.parse((await status('/api/config')).body);
  for (const k of ['cesiumIonToken', 'features', 'classification', 'buildId', 'openMode'])
    check(k in cfg, `/api/config has ${k}`);
}

async function browserChecks() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const text = () => page.evaluate(() => document.body.textContent || '');
  try {
    // The race itself: backend DOWN while the page loads. Stopping the api
    // makes the test non-vacuous; a backend that happens to be warm before
    // the browser arrives would otherwise pass without exercising boot.
    compose('stop', 'api');
    await waitFor('/api/config to be unreachable', async () => (await status('/api/config')).code !== 200, 60);

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.csl2-globe canvas', { timeout: 60000 });
    check((await status('/api/config')).code !== 200, 'globe canvas rendered while backend is down');
    check((await text()).includes('connecting to backend'), 'boot label shown while backend is down');
    check(!(await text()).includes('config error'), 'no config error while backend is down');
    check(!(await text()).includes('loading config'), 'map not gated on config');
    // A real reload wipes window state; in-app URL updates do not.
    await page.evaluate(() => { window.__smokeNoReload = true; });

    // Backend comes up: the page must recover in place, no reload.
    const t0 = Date.now();
    compose('start', 'api');
    await page.waitForFunction(
      () => !(document.body.textContent || '').includes('connecting to backend'),
      null,
      { timeout: BOOT_S * 1000, polling: 1000 },
    );
    log(`label cleared ${Math.round((Date.now() - t0) / 1000)}s after api start`);
    check((await page.$$('.csl2-globe canvas')).length > 0, 'globe canvas still present after recovery');
    check(!(await text()).includes('config error'), 'no config error after recovery');
    check(await page.evaluate(() => window.__smokeNoReload === true), 'page recovered without a reload');
    check(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? ': ' + pageErrors.join(' | ') : ''}`);

    // A fresh load against a warm backend: no boot label left behind.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.csl2-globe canvas', { timeout: 60000 });
    await waitFor('boot label to clear on warm load', async () => !(await text()).includes('connecting to backend'), 30);
    check(true, 'warm load clears the boot label within 30s');
  } catch (e) {
    fs.mkdirSync(ART, { recursive: true });
    await page.screenshot({ path: path.join(ART, 'failure.png') }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}

(async () => {
  await stackChecks();
  await browserChecks();
  log('RELEASE SMOKE PASSED');
})().catch((e) => {
  console.error('[smoke] FAILED:', e.message);
  process.exit(1);
});
