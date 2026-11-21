#!/usr/bin/env node
// Frame budget hunt — per-layer render ms + longtask attribution.
// Usage: node tools/perf/perf_hunt3.mjs [--seconds 12] [--out docs/media/walkthrough/perf-hunt.json]
// Headless by default (JS/CPU cost measurable); set PERF_HEADFUL=1 under xvfb for GPU frames.
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
const SECONDS = parseInt(opt('seconds', '12'), 10);
const OUT = opt('out', path.join(REPO, 'docs/media/walkthrough/perf-hunt.json'));
const URL_ = opt('url', 'http://127.0.0.1:5174');
const HEADFUL = process.env.PERF_HEADFUL === '1';
const pct = (v, p) => { if (!v?.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))]; };
const stats = (v) => { const c = (v || []).filter(Number.isFinite); if (!c.length) return null; return { n: c.length, p50: pct(c, 50), p95: pct(c, 95), max: Math.max(...c) }; };
const chromePath = fs.existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable' : '/usr/bin/chromium-browser';

const sampleFn = () => {
  const v = window.__viewer; const p = window.__perf || {};
  let entities = 0, dataSources = 0;
  if (v?.dataSources) { dataSources = v.dataSources.length; for (let i = 0; i < v.dataSources.length; i++) entities += v.dataSources.get(i).entities.values.length; }
  return { renderMsEMA: p.renderMsEMA ?? NaN, renderMsLast: p.renderMsLast ?? NaN, rendersPerSec: p.rendersPerSec ?? NaN, longtasksPerMin: p.longtasksPerMin ?? NaN, entities, dataSources, heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : NaN };
};
const installFn = () => {
  window.__hunt = { longtasks: [], frames: [], err: null };
  try {
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__hunt.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration * 10) / 10 }); });
    po.observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__hunt.err = String(e); }
  try {
    const v = window.__viewer;
    v.scene.preRender.addEventListener(() => { window.__hunt._t0 = performance.now(); });
    v.scene.postRender.addEventListener(() => { if (window.__hunt._t0 > 0) window.__hunt.frames.push({ t: Math.round(performance.now()), ms: Math.round((performance.now() - window.__hunt._t0) * 100) / 100 }); window.__hunt._t0 = 0; });
  } catch (e) { window.__hunt.err = String(e); }
  return !!window.__hunt;
};

async function main() {
  // Spawn Chrome ourselves (playwright's launch closes the page on GPU context
  // loss in this env); attach via CDP the way the sidecars do.
  const { spawn } = await import('node:child_process');
  const profile = fs.mkdtempSync('/tmp/perf-hunt-launch-');
  const DEBUG_PORT = 9225;
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-sandbox',
    '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', ...(HEADFUL ? ['--use-angle=gl-egl'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--window-size=1920,1080', `--user-data-dir=${profile}`, '--disable-features=Translate', '--disable-dev-shm-usage',
    ...(!HEADFUL ? ['--headless=new'] : []),
    'about:blank',
  ], { stdio: 'ignore' });
  let endpoint = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`); const j = await r.json(); endpoint = j.webSocketDebuggerUrl; break; } catch {}
  }
  if (!endpoint) { console.error('DevTools endpoint never came up'); process.exit(2); }
  const browser = await chromium.connectOverCDP(endpoint);
  console.error(`chrome: ${chromePath} headless=${!HEADFUL} cdp=${DEBUG_PORT}`);
  console.error(`chrome: ${chromePath} headless=${!HEADFUL}`);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + String(e).slice(0, 200)));
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const waitFor = async (fn, ms, label) => { const t0 = Date.now(); for (;;) { if (await page.evaluate(fn).catch(() => false)) return true; if (Date.now() - t0 > ms) { console.error(`timeout: ${label}`); console.error('globals:', await page.evaluate(() => JSON.stringify({ viewer: !!window.__viewer, perf: !!window.__perf, registry: !!window.__registry })).catch(() => '(eval failed)')); return false; } await page.waitForTimeout(500); } };
  if (!await waitFor(() => !!window.__viewer && !!window.__perf && !!window.__registry, 90000, 'viewer+perf+registry')) { console.log('HARNESS FAILED'); await browser.close(); process.exit(2); }
  await page.evaluate(installFn);
  const orbit = async () => { await page.evaluate(() => { if (window.__Cesium) window.__viewer.camera.flyTo({ destination: window.__Cesium.Cartesian3.fromDegrees(10 + Math.random() * 20, 48, 800000), duration: 0.5 }); else window.__viewer.camera.rotateRight(0.02); }).catch(() => {}); };
  const measure = async (seconds) => {
    const ser = { renderMsEMA: [], renderMsLast: [], rendersPerSec: [], longtasksPerMin: [], entities: [], dataSources: [], heapMB: [] };
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await orbit();
      const s = await page.evaluate(sampleFn).catch(() => null);
      if (s) for (const k of Object.keys(ser)) if (Number.isFinite(s[k])) ser[k].push(s[k]);
      await page.waitForTimeout(500);
    }
    return ser;
  };
  const baseline = await measure(10);
  const layers = await page.evaluate(() => window.__registry.list().map((d) => ({ id: d.id, name: d.name || d.id })));
  console.error(`baseline ds=${baseline.dataSources.at(-1)} entities=${baseline.entities.at(-1)} layers=${layers.length}`);
  const n = await page.evaluate(() => { const reg = window.__registry; let c = 0; for (const d of reg.list()) if (!reg.isEnabled(d.id)) { reg.enable(d.id); c++; } return c; });
  console.error(`enabled ${n} layers; settling 20s`);
  await page.waitForTimeout(20000);
  const allSer = await measure(Math.max(SECONDS, 12));
  await page.evaluate(() => { const reg = window.__registry; for (const d of reg.list()) if (reg.isEnabled(d.id)) reg.disable(d.id); });
  await page.waitForTimeout(5000);
  const perLayer = [];
  for (const L of layers) {
    await page.evaluate((id) => window.__registry.enable(id), L.id).catch(() => {});
    await page.waitForTimeout(3000);
    const s = await measure(4);
    perLayer.push({ id: L.id, name: L.name, renderMsEMA: stats(s.renderMsEMA), renderMsLast: stats(s.renderMsLast), rendersPerSec: stats(s.rendersPerSec), longtasksPerMin: stats(s.longtasksPerMin), entities: s.entities.at(-1) || 0, dataSources: s.dataSources.at(-1) || 0, heapMB: stats(s.heapMB) });
    await page.evaluate((id) => window.__registry.disable(id), L.id).catch(() => {});
  }
  perLayer.sort((a, b) => ((b.renderMsEMA?.p50 || 0) - (a.renderMsEMA?.p50 || 0)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Tracing.start', { categories: ['*'], options: 'sampling' }).catch(() => {});
  for (let i = 0; i < 12; i++) { await orbit(); await page.waitForTimeout(1000); }
  const trace = await cdp.send('Tracing.stop').catch(() => null);
  let topFns = [];
  try {
    const evs = trace?.traceEvents || [];
    const byFn = {};
    for (const e of evs) { if (e.ph !== 'X' || !e.name) continue; const k = e.name.slice(0, 100); byFn[k] = (byFn[k] || 0) + (e.dur || 0); }
    topFns = Object.entries(byFn).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, durUs]) => ({ name, durMs: Math.round(durUs / 100) / 100 }));
  } catch (e) { topFns = [{ error: String(e) }]; }
  const huntFinal = await page.evaluate(() => ({ longtasks: window.__hunt?.longtasks || [], frames: window.__hunt?.frames || [], err: window.__hunt?.err })).catch(() => null);
  const report = {
    at: new Date().toISOString(), url: URL_, headless: !HEADFUL, seconds: SECONDS, chrome: chromePath,
    baseline: { renderMsEMA: stats(baseline.renderMsEMA), renderMsLast: stats(baseline.renderMsLast), rendersPerSec: stats(baseline.rendersPerSec), longtasksPerMin: stats(baseline.longtasksPerMin), entities: baseline.entities.at(-1), dataSources: baseline.dataSources.at(-1), heapMB: stats(baseline.heapMB) },
    allToggles: { renderMsEMA: stats(allSer.renderMsEMA), renderMsLast: stats(allSer.renderMsLast), rendersPerSec: stats(allSer.rendersPerSec), longtasksPerMin: stats(allSer.longtasksPerMin), entities: allSer.entities.at(-1), dataSources: allSer.dataSources.at(-1), heapMB: stats(allSer.heapMB) },
    perLayer,
    longtaskTrace: { topFunctions: topFns, observer: { count: huntFinal?.longtasks?.length || 0, entries: huntFinal?.longtasks?.slice(0, 50) || [], err: huntFinal?.err }, frames: { count: huntFinal?.frames?.length || 0, sample: huntFinal?.frames?.slice(0, 50) || [] } },
    consoleErrors: errors.length,
    worstLayers: perLayer.slice(0, 10).map((l) => ({ id: l.id, name: l.name, renderMsEMA_p50: l.renderMsEMA?.p50, renderMsEMA_p95: l.renderMsEMA?.p95, entities: l.entities, longtasksPerMin_p50: l.longtasksPerMin?.p50 })),
  };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ worstLayers: report.worstLayers, baseline: report.baseline, allToggles: report.allToggles }, null, 2));
  console.log(`wrote ${OUT}`);
  try { await browser.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
}
main().catch((e) => { console.error(e); process.exit(2); });
