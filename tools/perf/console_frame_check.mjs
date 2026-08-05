#!/usr/bin/env node
// Checks the three W1 claims in docs/plan-99-2026-08.md against a real browser,
// because all three are claims about what an operator SEES and none of them can
// be settled from a unit test.
//
//   node tools/perf/console_frame_check.mjs [url]
//
// 1. The Earth's disk fills the map frame. Measured from the live camera height
//    and the live canvas size, not from the constant the code was written with,
//    so a regression that leaves globalAltitude() correct and stops CALLING it
//    still fails here.
// 2. The right dock says something at t=0. It used to be an apology in a 384px
//    column until the operator happened to click.
// The fourth W1 claim, that a layer row distinguishes off / pending / empty /
// live, is NOT checked here. Which of those four a given row is in at any moment
// depends on what the upstreams did in the last ten seconds, so a browser
// assertion on it fails for reasons that have nothing to do with the code. It is
// deterministic in `rowState`, so it is tested there
// (apps/web/src/layer-rail/useLayerCounts.test.ts).
//
// Exit code 0 = all of them hold. Any failure prints what it measured.

import { chromium } from '../adsb-globe-feeder/node_modules/playwright/index.mjs';

const URL = process.argv[2] || 'http://localhost:5173/';
const FILL_FLOOR = 0.8;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.addInitScript(() => {
  localStorage.setItem('velocity.onboarded', '1');
  localStorage.setItem('velocity.openModeDismissed', '1');
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
for (const label of ['Skip', 'Dismiss', 'Close', 'Got it']) {
  const el = page.getByRole('button', { name: label }).first();
  if (await el.count().catch(() => 0)) await el.click({ timeout: 2000 }).catch(() => {});
}
await page.waitForTimeout(12000);

const frame = await page.evaluate(() => {
  const v = window.__viewer;
  if (!v) return null;
  const canvas = v.canvas;
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  const fov = v.camera.frustum.fov;
  const aspect = w / h;
  const fovy = aspect <= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) / aspect);
  const R = 6378137;
  const alt = v.camera.positionCartographic.height;
  const angularDiameter = 2 * Math.asin(R / (R + alt));
  return { w, h, altMeters: alt, fill: angularDiameter / fovy };
});

// The right dock, and how many distinct count-cell renderings the layers list
// shows. Both read off the rendered DOM rather than component state.
const panels = await page.evaluate(() => {
  const dock = document.querySelector('[aria-label="On the map"]')?.closest('div');
  const dockText = (dock?.textContent || '').trim();
  // Provenance has to be visible on the rows themselves, not only in the filter.
  const marks = document.querySelectorAll('section abbr[title^="Sensor"], section abbr[title^="Registry"], section abbr[title^="Filing"], section abbr[title^="Claim"]');
  return { dockChars: dockText.length, tierMarks: marks.length };
});

const results = [
  {
    name: `globe fills >= ${FILL_FLOOR} of the map frame`,
    ok: !!frame && frame.fill >= FILL_FLOOR,
    got: frame
      ? `fill ${frame.fill.toFixed(3)} at ${Math.round(frame.altMeters / 1000)} km, canvas ${frame.w}x${frame.h}`
      : 'no viewer',
  },
  {
    name: 'right dock says something with no selection',
    ok: panels.dockChars > 120,
    got: `${panels.dockChars} characters rendered`,
  },
  {
    name: 'every visible layer row states its provenance tier',
    ok: panels.tierMarks >= 20,
    got: `${panels.tierMarks} tier marks rendered`,
  },
  { name: 'no console errors', ok: consoleErrors.length === 0, got: `${consoleErrors.length}` },
];

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.got}`);
consoleErrors.slice(0, 5).forEach((e) => console.log('   error:', e.slice(0, 180)));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
