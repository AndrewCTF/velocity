#!/usr/bin/env node
// Measure the app the way the operator sees it: real browser, real GPU, real
// camera motion, with every layer toggle on.
//
// Reads window.__perf (globe/perf.ts) rather than inventing new instrumentation.
//
//   node tools/perf/measure_ui.mjs --profile baseline     --seconds 60
//   node tools/perf/measure_ui.mjs --profile all-toggles  --seconds 60
//
// Headless cannot measure GPU fps (docs/decisions.md, Playwright section), so
// --headless prints every fps figure as UNVERIFIED rather than a number.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
// playwright lives under the sidecar's node_modules — the only copy in the repo.
const require = createRequire(path.join(REPO, 'tools/adsb-globe-feeder/package.json'));
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const URL_ = opt('url', 'http://127.0.0.1:5173');
const PROFILE = opt('profile', 'baseline');
const SECONDS = parseInt(opt('seconds', '60'), 10);
const HEADLESS = flag('headless');

const pct = (v, p) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
const f = (x, nd = 1) => (Number.isFinite(x) ? x.toFixed(nd) : '—');

// The camera script — fixed so runs are comparable.
const LEGS = [
  { name: 'world', lat: 20, lon: 10, alt: 20_000_000, hold: 10 },
  { name: 'europe-800km', lat: 48, lon: 10, alt: 800_000, hold: 10 },
  { name: 'orbit', orbit: true, hold: 20 },
  { name: 'london-60km', lat: 51.5, lon: -0.12, alt: 60_000, hold: 10 },
  { name: 'world-return', lat: 20, lon: 10, alt: 20_000_000, hold: 10 },
];

async function waitFor(page, fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    if (Date.now() - t0 > ms) {
      console.error(`  ! timed out waiting for ${label} after ${ms}ms`);
      return false;
    }
    await page.waitForTimeout(500);
  }
}

async function enableAllLayers(page) {
  // Drive the REAL registry (window.__registry, published in DEV by App.tsx) so
  // the measurement goes through the same enable path the LayerRail uses.
  const viaGlobal = await page.evaluate(() => {
    const reg = window.__registry;
    if (!reg || typeof reg.list !== 'function') return 0;
    let n = 0;
    for (const d of reg.list()) {
      if (!reg.isEnabled(d.id)) {
        reg.enable(d.id);
        n++;
      }
    }
    return n;
  }).catch(() => 0);
  if (viaGlobal > 0) {
    console.error(`  enabled ${viaGlobal} layers via window.__registry`);
    return viaGlobal;
  }
  console.error('  window.__registry absent — falling back to clicking the LayerRail');
  const rows = page.locator('[data-layer-toggle], [role="switch"]');
  const count = await rows.count().catch(() => 0);
  let n = 0;
  for (let i = 0; i < count; i++) {
    const r = rows.nth(i);
    const on = await r.getAttribute('aria-checked').catch(() => null);
    if (on === 'true') continue;
    await r.click({ timeout: 2000 }).catch(() => {});
    n++;
    await page.waitForTimeout(250);
  }
  return n;
}

const sampleFn = () => {
  const v = window.__viewer;
  const p = window.__perf || {};
  let entities = 0;
  let dataSources = 0;
  if (v && v.dataSources) {
    dataSources = v.dataSources.length;
    for (let i = 0; i < v.dataSources.length; i++) {
      entities += v.dataSources.get(i).entities.values.length;
    }
  }
  return {
    rendersPerSec: p.rendersPerSec ?? NaN,
    frameMsEMA: p.frameMsEMA ?? NaN,
    drainMsLast: p.drainMsLast ?? NaN,
    longtasksPerMin: p.longtasksPerMin ?? NaN,
    liveLabels: p.liveLabels ?? NaN,
    animatedPrims: p.animatedPrims ?? NaN,
    entities,
    dataSources,
    heapMB: performance.memory
      ? performance.memory.usedJSHeapSize / 1048576
      : NaN,
  };
};

async function main() {
  console.log(`# measure_ui — ${new Date().toISOString()}`);
  console.log(`url=${URL_} profile=${PROFILE} seconds=${SECONDS} headless=${HEADLESS}`);

  // The repo's playwright has no downloaded browser bundle (it drives the
  // system Chrome the sidecars use). Point at that binary explicitly.
  const chromePath =
    process.env.CHROME_PATH ||
    ['/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser'].find((p) => {
      try {
        return require('node:fs').existsSync(p);
      } catch {
        return false;
      }
    });
  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: chromePath,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  console.error(`  chrome: ${chromePath || '(playwright bundled)'}`);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  // Count /api traffic from the network layer, not the resource-timing buffer:
  // that buffer caps at 250 entries and silently drops the rest, which is
  // exactly the range this measurement lives in.
  const apiHits = new Map();
  let counting = false;
  page.on('request', (r) => {
    if (!counting) return;
    try {
      const p = new URL(r.url()).pathname;
      if (p.startsWith('/api/') || p.startsWith('/ws/')) {
        apiHits.set(p, (apiHits.get(p) || 0) + 1);
      }
    } catch { /* not a URL */ }
  });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
  });

  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const ready = await waitFor(page, () => !!window.__viewer && !!window.__perf, 90_000, 'viewer+perf');
  if (!ready) {
    console.log('\n**HARNESS FAILED** — window.__viewer / window.__perf never appeared. '
      + 'Is the dev server running with DEV globals?');
    await browser.close();
    process.exit(2);
  }
  await waitFor(page, () => (window.__perf?.drainMsLast ?? 0) > 0, 90_000, 'first drain');

  if (PROFILE === 'all-toggles') {
    const n = await enableAllLayers(page);
    console.error(`  toggled ${n} layers on; settling 20s`);
    await page.waitForTimeout(20_000);
  }

  // Sanity-check the harness before trusting any number it prints.
  const pre = await page.evaluate(sampleFn);
  console.log(`\nprofile check: dataSources=${pre.dataSources} entities=${pre.entities}`);
  if (PROFILE === 'all-toggles' && pre.dataSources < 40) {
    console.log('\n**PROFILE DID NOT APPLY** — fewer than 40 data sources with '
      + 'all-toggles. Every number below would describe an empty globe. Aborting.');
    await browser.close();
    process.exit(3);
  }

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable').catch(() => {});
  const metricsAt = async () => {
    const r = await cdp.send('Performance.getMetrics').catch(() => null);
    if (!r) return {};
    return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
  };
  const m0 = await metricsAt();
  counting = true;
  const countStart = Date.now();

  const series = {};
  const push = (s) => {
    for (const [k, v] of Object.entries(s)) {
      if (!Number.isFinite(v)) continue;
      (series[k] ||= []).push(v);
    }
  };

  const deadline = Date.now() + SECONDS * 1000;
  const perLeg = Math.max(1, Math.floor(SECONDS / LEGS.reduce((a, l) => a + l.hold, 0)));
  const legSamples = {};

  for (const leg of LEGS) {
    if (Date.now() > deadline) break;
    if (leg.orbit) {
      await page.evaluate(() => {
        const v = window.__viewer;
        v.camera.rotateRight(0.0);
      }).catch(() => {});
    } else {
      await page.evaluate(({ lat, lon, alt }) => {
        const C = window.__Cesium;
        window.__viewer.camera.flyTo({
          destination: C.Cartesian3.fromDegrees(lon, lat, alt),
          duration: 2.0,
        });
      }, leg).catch(() => {});
      await page.waitForTimeout(2500);
    }
    const holdMs = leg.hold * perLeg * 1000;
    const legEnd = Date.now() + holdMs;
    while (Date.now() < legEnd && Date.now() < deadline) {
      if (leg.orbit) {
        await page.evaluate(() => window.__viewer.camera.rotateRight(0.02)).catch(() => {});
      }
      const s = await page.evaluate(sampleFn).catch(() => null);
      if (s) {
        push(s);
        (legSamples[leg.name] ||= []).push(s.rendersPerSec);
      }
      await page.waitForTimeout(1000);
    }
  }

  const m1 = await metricsAt();
  counting = false;
  const countSecs = Math.max(1, (Date.now() - countStart) / 1000);
  const requests = {
    total: [...apiHits.values()].reduce((a, b) => a + b, 0),
    by: Object.fromEntries(apiHits),
    secs: countSecs,
  };

  console.log(`\n## Series (${(series.rendersPerSec || []).length} samples)\n`);
  console.log('| series | p05 | p50 | p95 | max |');
  console.log('|---|---|---|---|---|');
  const fpsNote = HEADLESS ? ' **UNVERIFIED (headless)**' : '';
  for (const k of Object.keys(series).sort()) {
    const v = series[k];
    const note = k === 'rendersPerSec' || k === 'frameMsEMA' ? fpsNote : '';
    console.log(`| ${k}${note} | ${f(pct(v, 5))} | ${f(pct(v, 50))} | ${f(pct(v, 95))} | ${f(Math.max(...v))} |`);
  }

  console.log('\n## rendersPerSec by camera leg\n');
  console.log('| leg | p05 | p50 |');
  console.log('|---|---|---|');
  for (const [name, v] of Object.entries(legSamples)) {
    const c = v.filter(Number.isFinite);
    console.log(`| ${name}${fpsNote} | ${f(pct(c, 5))} | ${f(pct(c, 50))} |`);
  }

  console.log('\n## CDP Performance deltas\n');
  console.log('| metric | delta |');
  console.log('|---|---|');
  for (const k of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize']) {
    if (m0[k] === undefined) continue;
    const d = (m1[k] ?? 0) - (m0[k] ?? 0);
    console.log(`| ${k} | ${k === 'JSHeapUsedSize' ? `${f(d / 1048576)} MB` : `${f(d)} s`} |`);
  }

  console.log(`\n## Measured /api requests: ${requests.total} over `
    + `${f(requests.secs)}s = ${f((requests.total / requests.secs) * 60)} req/min\n`);
  const top = Object.entries(requests.by).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('| path | count |');
  console.log('|---|---|');
  for (const [p, n] of top) console.log(`| \`${p}\` | ${n} |`);

  if (consoleErrors.length) {
    console.log(`\n## Console errors (${consoleErrors.length}, first 10)\n`);
    console.log('```');
    for (const e of consoleErrors.slice(0, 10)) console.log(e);
    console.log('```');
  }

  const p05 = pct(series.rendersPerSec || [], 5);
  const verdict = HEADLESS
    ? 'UNVERIFIED (headless — GPU fps cannot be measured)'
    : p05 >= 20
      ? `OK (p05 rendersPerSec ${f(p05)})`
      : `POOR (p05 rendersPerSec ${f(p05)} < 20)`;
  console.log(`\n**Verdict: ${verdict}**`);

  await browser.close();
  process.exit(!HEADLESS && Number.isFinite(p05) && p05 < 20 && PROFILE === 'all-toggles' ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
