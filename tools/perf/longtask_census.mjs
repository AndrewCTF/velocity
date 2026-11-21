#!/usr/bin/env node
// Longtask census: per-dataSource entity counts (all-toggles) + per-source
// render/longtask distribution for the top-N sources by entity count, measured
// one at a time (single-source isolation, same as perf_hunt.mjs). Uses the
// app's existing window.__perf (perf.ts) — no new instrumentation.
// Usage: xvfb-run -a node tools/perf/longtask_census.mjs [--seconds 5] [--top 15] [--out docs/media/walkthrough/longtask-census.json]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require = createRequire(path.join(REPO, 'tools/adsb-globe-feeder/package.json'));
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const SECONDS = parseInt(opt('seconds', '5'), 10);
const TOP = parseInt(opt('top', '15'), 10);
const OUT = opt('out', path.join(REPO, 'docs/media/walkthrough/longtask-census.json'));
const URL_ = opt('url', 'http://127.0.0.1:5173');
const HEADLESS = args.includes('--headless');
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser'].find((p) => { try { return fs.existsSync(p); } catch { return false; } });

const pct = (v, p) => { if (!v?.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))]; };
const stats = (v) => { const c = (v || []).filter(Number.isFinite); if (!c.length) return null; return { n: c.length, p05: pct(c, 5), p50: pct(c, 50), p95: pct(c, 95), max: Math.max(...c), mean: c.reduce((a, b) => a + b, 0) / c.length, total: c.reduce((a, b) => a + b, 0) }; };

const sampleFn = () => {
  const v = window.__viewer, p = window.__perf || {};
  let entities = 0; const srcs = [];
  if (v?.dataSources) {
    const reg = window.__registry;
    const ids = reg ? reg.list().map((d) => ({ id: d.id, name: d.name || d.id })) : [];
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      const n = ds.entities.values.length;
      entities += n;
      const dsName = ds.name || ds.id || (ds.dataSource?.name) || null;
      const match = ids.find((x) => x.name === dsName || x.id === dsName || x.id === ds.id);
      srcs.push({ name: (match || {}).name || dsName || `ds${i}`, id: (match || {}).id || ds.id || null, entities: n, enabled: reg && ds.id ? reg.isEnabled(ds.id) : undefined });
    }
  }
  return { entities, dataSources: v?.dataSources?.length || 0, renderMsEMA: p.renderMsEMA ?? NaN, renderMsLast: p.renderMsLast ?? NaN, rendersPerSec: p.rendersPerSec ?? NaN, longtasksPerMin: p.longtasksPerMin ?? NaN, heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : NaN, srcs };
};

async function waitFor(page, fn, ms, label) {
  const t0 = Date.now();
  for (;;) { if (await page.evaluate(fn).catch(() => false)) return true; if (Date.now() - t0 > ms) { console.error(`timeout: ${label}`); return false; } await page.waitForTimeout(500); }
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS, executablePath: chromePath, args: HEADLESS ? ['--no-sandbox', '--enable-unsafe-swiftshader'] : ['--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--window-size=1920,1080'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!await waitFor(page, () => !!window.__viewer && !!window.__perf && !!window.__registry, 90000, 'viewer+perf+registry')) throw new Error('HARNESS FAILED');
  await waitFor(page, () => (window.__perf?.drainMsLast ?? 0) >= 0 && !!window.__viewer, 30000, 'first drain');

  // Step 1: all-toggles for per-source entity counts.
  await page.evaluate(() => { const reg = window.__registry; for (const d of reg.list()) if (!reg.isEnabled(d.id)) reg.enable(d.id); });
  await page.waitForTimeout(15000);
  const snap = await page.evaluate(sampleFn).catch(() => null);
  const perSource = (snap?.srcs || []).map((s) => ({ name: s.name, id: s.id, entities: s.entities, enabled: s.enabled }));
  perSource.sort((a, b) => b.entities - a.entities);
  console.error(`all-toggles: ds=${snap?.dataSources} entities=${snap?.entities} lt/min=${snap?.longtasksPerMin}`);

  // Step 2: measure top-N one at a time.
  await page.evaluate(() => { const reg = window.__registry; for (const d of reg.list()) if (reg.isEnabled(d.id)) reg.disable(d.id); });
  await page.waitForTimeout(5000);
  const measured = [];
  const layers = await page.evaluate(() => window.__registry.list().map((d) => ({ id: d.id, name: d.name || d.id })));
  const topIds = perSource.filter((s) => s.entities > 0).slice(0, TOP).map((s) => s.id).filter(Boolean);
  const todo = layers.filter((L) => topIds.includes(L.id));
  console.error(`isolating ${todo.length} sources`);
  for (const L of todo) {
    await page.evaluate((id) => window.__registry.enable(id), L.id).catch(() => {});
    await page.waitForTimeout(3000);
    const ser = { renderMsEMA: [], renderMsLast: [], rendersPerSec: [], longtasksPerMin: [], heapMB: [] };
    let ents = 0;
    const deadline = Date.now() + SECONDS * 1000;
    while (Date.now() < deadline) {
      await page.evaluate(() => window.__viewer.camera.rotateRight(0.02)).catch(() => {});
      const s = await page.evaluate(sampleFn).catch(() => null);
      if (s) { for (const k of Object.keys(ser)) if (Number.isFinite(s[k])) ser[k].push(s[k]); ents = s.entities; }
      await page.waitForTimeout(500);
    }
    measured.push({ name: L.name, id: L.id, entities: ents, renderMsEMA: stats(ser.renderMsEMA), renderMsLast: stats(ser.renderMsLast), rendersPerSec: stats(ser.rendersPerSec), longtasksPerMin: stats(ser.longtasksPerMin), heapMB: stats(ser.heapMB) });
    await page.evaluate((id) => window.__registry.disable(id), L.id).catch(() => {});
    console.error(`  ${L.id}: ents=${ents} renderEMA p50=${stats(ser.renderMsEMA)?.p50?.toFixed(1)} lt/min p50=${stats(ser.longtasksPerMin)?.p50}`);
  }
  await browser.close();

  const byId = Object.fromEntries(measured.map((m) => [m.id, m]));
  const perSourceFull = perSource.map((s) => ({ ...s, ...(byId[s.id] || {}), measured: !!byId[s.id] }));
  const report = {
    at: new Date().toISOString(), url: URL_, headless: HEADLESS, profile: 'all-toggles',
    sources: snap?.dataSources || 0, entities: snap?.entities || 0,
    perSource: perSourceFull,
    measured,
    worst: [...measured].sort((a, b) => (b.renderMsEMA?.p50 || 0) - (a.renderMsEMA?.p50 || 0)).slice(0, 10).map((m) => ({ name: m.name, id: m.id, entities: m.entities, renderMsEMA_p50: m.renderMsEMA?.p50, renderMsEMA_p95: m.renderMsEMA?.p95, renderMsLast_p50: m.renderMsLast?.p50, longtasksPerMin_p50: m.longtasksPerMin?.p50 })),
    errors: errors.slice(0, 10),
  };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ worst: report.worst }, null, 2));
  console.log(`wrote ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(2); });
