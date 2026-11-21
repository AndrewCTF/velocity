#!/usr/bin/env node
// Frame budget: per-layer-group render cost by toggling each group.
// Usage: xvfb-run -a node tools/perf/frame_budget.mjs [--seconds 4] [--settle 3] [--out docs/media/walkthrough/frame-budget.json]
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
const SECONDS = parseInt(opt('seconds', '4'), 10);
const SETTLE = parseInt(opt('settle', '3'), 10);
const OUT = opt('out', path.join(REPO, 'docs/media/walkthrough/frame-budget.json'));
const URL_ = opt('url', 'http://127.0.0.1:5173');
const pct = (v, p) => { if (!v?.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))]; };
const p50 = (v) => { const c = (v || []).filter(Number.isFinite); if (!c.length) return null; return Math.round(pct(c, 50) * 100) / 100; };
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser'].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
const sampleFn = () => {
  const v = window.__viewer; const p = window.__perf || {};
  let entities = 0, dataSources = 0;
  if (v?.dataSources) { dataSources = v.dataSources.length; for (let i = 0; i < v.dataSources.length; i++) entities += v.dataSources.get(i).entities.values.length; }
  return { renderMsEMA: p.renderMsEMA ?? NaN, renderMsLast: p.renderMsLast ?? NaN, entities, dataSources };
};
async function main() {
  const browser = await chromium.launch({ headless: false, executablePath: chromePath, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--window-size=1920,1080'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const waitFor = async (fn, ms, label) => { const t0 = Date.now(); for (;;) { if (await page.evaluate(fn).catch(() => false)) return true; if (Date.now() - t0 > ms) { console.error(`timeout: ${label}`); return false; } await page.waitForTimeout(500); } };
  if (!await waitFor(() => !!window.__viewer && !!window.__perf && !!window.__registry, 90000, 'viewer+perf+registry')) throw new Error('HARNESS FAILED');
  await waitFor(() => (window.__perf?.drainMsLast ?? 0) >= 0 && !!window.__viewer, 30000, 'first drain');
  const orbit = () => page.evaluate(() => window.__viewer.camera.rotateRight(0.02)).catch(() => {});
  const measure = async (seconds) => {
    const ser = { renderMsEMA: [], renderMsLast: [] };
    let entities = 0, dataSources = 0;
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await orbit();
      const s = await page.evaluate(sampleFn).catch(() => null);
      if (s) { if (Number.isFinite(s.renderMsEMA)) ser.renderMsEMA.push(s.renderMsEMA); if (Number.isFinite(s.renderMsLast)) ser.renderMsLast.push(s.renderMsLast); entities = s.entities; dataSources = s.dataSources; }
      await page.waitForTimeout(500);
    }
    return { ...ser, entities, dataSources };
  };
  // Enumerate groups from descriptors (LayerGroup union from packages/shared).
  const groups = await page.evaluate(() => {
    const reg = window.__registry; const m = {};
    for (const d of reg.list()) { (m[d.group] ??= []).push(d.id); }
    return Object.entries(m).map(([name, ids]) => ({ name, ids }));
  });
  console.error(`groups: ${groups.map((g) => `${g.name}(${g.ids.length})`).join(', ')}`);
  const disableAll = () => page.evaluate(() => { const reg = window.__registry; for (const d of reg.list()) if (reg.isEnabled(d.id)) reg.disable(d.id); });
  const setGroup = (ids) => page.evaluate((ids) => { const reg = window.__registry; for (const id of ids) if (!reg.isEnabled(id)) reg.enable(id); }, ids);
  // Baseline: nothing enabled.
  await disableAll(); await page.waitForTimeout(5000);
  const base = await measure(SECONDS);
  console.error(`baseline(none): renderEMA p50=${p50(base.renderMsEMA)} ents=${base.entities} ds=${base.dataSources}`);
  const layers = [];
  for (const g of groups) {
    await disableAll(); await page.waitForTimeout(1500);
    await setGroup(g.ids);
    await page.waitForTimeout(SETTLE * 1000);
    const s = await measure(SECONDS);
    const ms = p50(s.renderMsEMA);
    layers.push({ name: g.name, ms, entities: s.entities, dataSources: s.dataSources, renderMsLastP50: p50(s.renderMsLast) });
    console.error(`  ${g.name}: ms(p50)=${ms} ents=${s.entities} ds=${s.dataSources}`);
  }
  // All-on context.
  await disableAll(); await page.evaluate(() => { const reg = window.__registry; for (const d of reg.list()) reg.enable(d.id); });
  await page.waitForTimeout(15000);
  const all = await measure(SECONDS);
  console.error(`all-on: renderEMA p50=${p50(all.renderMsEMA)} ents=${all.entities} ds=${all.dataSources}`);
  layers.sort((a, b) => (b.ms || 0) - (a.ms || 0));
  const report = { at: new Date().toISOString(), url: URL_, headless: false, seconds: SECONDS, settleSec: SETTLE, chrome: chromePath, method: 'per-layer-group toggle (LayerGroup), renderMsEMA p50 while orbiting; baseline = no layers enabled', baseline: { name: 'none', ms: p50(base.renderMsEMA), entities: base.entities, dataSources: base.dataSources }, allOn: { name: 'all', ms: p50(all.renderMsEMA), entities: all.entities, dataSources: all.dataSources }, layers };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ layers: layers.map(({ name, ms }) => ({ name, ms })) }, null, 2));
  console.log(`wrote ${OUT}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(2); });
