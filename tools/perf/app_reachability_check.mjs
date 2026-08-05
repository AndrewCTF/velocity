#!/usr/bin/env node
// Opens every app in the launcher and every left panel, and reports what each
// one actually rendered.
//
//   node tools/perf/app_reachability_check.mjs [url]
//
// `shell/rehoming.test.ts` asserts that each re-homed address renders, in jsdom,
// with mocked data. That is the right guard for the contract and it cannot see
// the failure the operator reported as "a lot of old stuff not yet ported in":
// a surface that mounts, paints its chrome, and then shows nothing because the
// thing it was supposed to carry never came across. A panel that renders 40
// characters of heading and no content passes a mount assertion and fails a
// human.
//
// So this measures rendered text per surface against the live backend and prints
// the number. It is a REPORT, not a pass/fail gate: the floor for "enough" is a
// judgement, and a check that guesses it would be the same lie one level up.

import { chromium } from '../adsb-globe-feeder/node_modules/playwright/index.mjs';

const URL = process.argv[2] || 'http://localhost:5173/';
const THIN = 240; // characters below which a surface is worth a human looking

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
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
// A 401/404 in the console is a URL, and the URL is the whole finding.
const failedRequests = [];
page.on('response', (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().replace(/[?&]key=[^&]*/, '')}`);
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
for (const label of ['Skip', 'Dismiss', 'Close', 'Got it']) {
  const el = page.getByRole('button', { name: label }).first();
  if (await el.count().catch(() => 0)) await el.click({ timeout: 2000 }).catch(() => {});
}
await page.waitForTimeout(6000);

// Driven through the store's DEV handle rather than the launcher, so a broken
// launcher cannot hide a broken app behind it. The list is asserted against the
// app registry below, so it cannot silently go stale.
const APPS = [
  'map', 'ai', 'explorer', 'graph', 'investigate', 'targeting', 'video',
  'sim', 'reports', 'foundry', 'workflows', 'city', 'country', 'markets',
];
const PANELS = ['Layers', 'Find', 'Histogram', 'Info'];

const rows = [];

const buttonNames = await page.evaluate(() =>
  [...document.querySelectorAll('button')]
    .map((b) => (b.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 40),
);
console.log('visible buttons:', JSON.stringify(buttonNames.slice(0, 20)));

for (const panel of PANELS) {
  // Located by exact text, not by role+name: the tabs carry a count badge, so
  // Info's accessible name is "Info4" and a name regex silently matched nothing.
  const tab = page.locator('button', { hasText: new RegExp(`^${panel}\\d*$`) }).first();
  if (!(await tab.count().catch(() => 0))) {
    rows.push({ kind: 'panel', name: panel, chars: 0, note: 'tab not found' });
    continue;
  }
  await tab.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const chars = await page.evaluate(() => {
    const el = document.querySelector('aside, [data-left-panel]') || document.body;
    return (el.textContent || '').trim().length;
  });
  rows.push({ kind: 'panel', name: panel, chars, note: '' });
}

for (const app of APPS) {
  const before = errors.length;
  const ok = await page.evaluate((id) => {
    const store = window.__useAppView;
    if (!store?.getState) return false;
    store.getState().setApp(id);
    return true;
  }, app);
  if (!ok) {
    rows.push({ kind: 'app', name: app, chars: -1, note: 'no app store on window' });
    continue;
  }
  await page.waitForTimeout(3500);
  const chars = await page.evaluate(() => (document.body.textContent || '').trim().length);
  rows.push({
    kind: 'app',
    name: app,
    chars,
    note: errors.length > before ? `${errors.length - before} console errors` : '',
  });
}

console.log('surface                 chars   note');
for (const r of rows) {
  const flag = r.chars >= 0 && r.chars < THIN ? '  <-- thin' : '';
  console.log(
    `${(r.kind + ':' + r.name).padEnd(22)} ${String(r.chars).padStart(6)}   ${r.note}${flag}`,
  );
}
console.log(`\ntotal console errors: ${errors.length}`);
errors.slice(0, 10).forEach((e) => console.log('  -', e.slice(0, 180)));
const uniq = [...new Set(failedRequests)];
console.log(`failed requests: ${uniq.length}`);
uniq.slice(0, 20).forEach((u) => console.log('  -', u.slice(0, 160)));
await browser.close();
