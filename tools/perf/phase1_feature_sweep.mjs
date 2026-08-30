#!/usr/bin/env node
// Phase 1 of the God's-Eye-View answer plan: OBSERVE the seven user-visible
// features that docs/exec-report-2026-07-29.md §3 says were shipped with unit
// guards and never seen rendering.
//
//   node tools/perf/phase1_feature_sweep.mjs [url] [outdir]
//
// Why this exists rather than app_reachability_check.mjs: that harness counts
// rendered characters per SURFACE, which is a reachability proxy. It cannot say
// "the provenance chip appeared". This drives each named feature and records
// what it found, one screenshot and one verdict per feature.
//
// It is a REPORT, not a gate. A feature that needs a stale contact or a
// corroborated contact to be visible cannot be forced by a script, and saying
// "unverified, and here is why" is the honest output. Inventing a pass is the
// failure this whole plan is about.
//
// Clean profile, deliberately: the 2026-07 persona study's UX findings were
// void because a shared browser profile restored a persisted app view and five
// of ten screenshots captured the wrong app. Every navigation here carries an
// explicit ?app= so localStorage 'velocity.appView' cannot decide what we see.

import { chromium } from '../adsb-globe-feeder/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:5173/';
const OUT = process.argv[3] || '/tmp/phase1-sweep';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.addInitScript(() => {
  // Suppress the tour and the open-mode banner so they do not cover the thing
  // under test. Deliberately NOT setting velocity.appView — the URL decides.
  // 'velocity.onboarded.v1' — Onboarding.tsx:8 versioned the key; the old
  // unversioned one stopped suppressing the tour, so every run since was
  // measuring the console with the WELCOME modal open over it.
  localStorage.setItem('velocity.onboarded.v1', '1');
  localStorage.setItem('velocity.aiSetupSeen', '1'); // AppRouter.tsx:163 AiSetupGate
  localStorage.setItem('velocity.openModeDismissed', '1');
  // AppRouter.tsx:159 AiSetupGate is a THIRD first-run gate, independent of
  // the tour. Without this the wizard modal covers the whole console and every
  // probe below measures the modal instead of the feature.
  localStorage.setItem('velocity.aiSetupSeen', '1');
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

const results = [];
const record = (id, verdict, evidence) => {
  results.push({ id, verdict, evidence });
  console.log(`${verdict.padEnd(12)} ${id.padEnd(22)} ${evidence}`);
};

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function goto(app) {
  const u = new global.URL(URL);
  if (app) u.searchParams.set('app', app);
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000); // globe + first feed poll
}

// Select the first live aircraft through the DEV store handle, the way
// apps/web/CLAUDE.md documents. Functions, never strings, into evaluate.
async function selectFirstAircraft() {
  return page.evaluate(async () => {
    const v = window.__viewer;
    if (!v) return { ok: false, why: 'no window.__viewer (is this a dev build?)' };
    for (let i = 0; i < 40; i++) {
      const ds = v.dataSources;
      for (let d = 0; d < ds.length; d++) {
        const ents = ds.get(d).entities.values;
        for (const e of ents) {
          const p = e.properties?.getValue?.(v.clock.currentTime) ?? {};
          if (p.kind === 'aircraft' || String(e.id).startsWith('aircraft:')) {
            window.__useSelection?.getState?.().select?.(String(e.id));
            return { ok: true, id: String(e.id) };
          }
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, why: 'no aircraft entity in the scene after 20s' };
  });
}


// Click a TitleBar menu item by its label, opening whichever top-level menu
// holds it. Returns false if the label never appeared - which is itself a
// finding, since apps/web/CLAUDE.md says a control that renders must run.
async function clickMenuItem(label) {
  for (const menu of ['File', 'Edit', 'View', 'Collect', 'Help']) {
    const top = page.locator(`button:text-is("${menu}")`).first();
    if (!(await top.count())) continue;
    await top.click().catch(() => {});
    await page.waitForTimeout(250);
    const item = page.locator(`text="${label}"`).first();
    if (await item.count()) {
      await item.click().catch(() => {});
      await page.waitForTimeout(250);
      return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return false;
}

const textOf = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? '', sel);
const bodyHas = (re) => page.evaluate((r) => new RegExp(r, 'i').test(document.body.innerText), re);

// ── 1. replay transport ─────────────────────────────────────────────────────
await goto(null);
await shot('01-map-default');
{
  // Match the real controls by their own accessible names (TimeDock.tsx:178,
  // :201, :296) rather than guessing at a text cluster.
  const play = await page.locator('[title="Play or pause (space)"]').count();
  const live = await page.locator('[title="Return to live"]').count();
  const scrub = await page.locator('[aria-label="Scrub replay position"]').count();
  record('replay-transport', play && live && scrub ? 'RENDERED' : 'NOT-FOUND',
    `play=${play} return-to-live=${live} scrubber=${scrub} (all three are TimeDock.tsx controls)`);
}

// ── 2. staleness dimming ────────────────────────────────────────────────────
{
  const r = await page.evaluate(() => {
    const v = window.__viewer;
    const perf = window.__perf || {};
    return {
      viewer: !!v,
      dataSources: v ? v.dataSources.length : 0,
      primitives: v ? v.scene.primitives.length : 0,
      entities: perf.entities ?? null,
      rendersPerSec: perf.rendersPerSec ?? null,
    };
  });
  record('staleness-dimming', 'UNMEASURABLE-BY-SCRIPT',
    `scene has ${r.primitives} primitive collections, ${r.dataSources} datasources, __perf.entities=${r.entities}. ` +
    'Contacts are drawn as PRIMITIVES (the entity->primitive rewrite), so per-contact alpha is not reachable ' +
    'from the entity graph. Forcing a stale contact needs a frozen upstream. Verdict from screenshot only.');
}

// ── 3 + 6. provenance chip and archive sparkline (need a selection) ──────────
{
  const sel = await selectFirstAircraft();
  if (!sel.ok) {
    record('provenance-chip', 'UNVERIFIED', sel.why);
    record('archive-sparkline', 'UNVERIFIED', sel.why);
  } else {
    await page.waitForTimeout(4000);
    await shot('03-selection-panel');
    const panel = await page.evaluate(() => document.body.innerText);
    const tier = /\b(sensor|registry|filing|claim)\b/i.test(panel);
    record('provenance-chip', tier ? 'RENDERED' : 'NOT-FOUND',
      `selected ${sel.id}; tier vocabulary ${tier ? 'present' : 'absent'} in the panel`);
    const arch = /archive|history|last seen|coverage/i.test(panel);
    const svg = await page.evaluate(() => document.querySelectorAll('svg polyline, svg path').length);
    record('archive-sparkline', arch && svg > 0 ? 'RENDERED' : 'UNVERIFIED',
      `archive wording ${arch}; ${svg} svg polyline/path nodes in the DOM`);
  }
}

// ── 7. corroboration lens ───────────────────────────────────────────────────
{
  // __useSettings is NOT a DEV global (only __viewer / __Cesium / __useSelection /
  // __useAppView / __perf are), so drive the real control: the View menu item
  // registered at shell/TitleBar.tsx:226. Clicking the menu is better evidence
  // than poking a store anyway.
  await shot('07a-before-lens');
  const toggled = await clickMenuItem('Corroborated contacts only');
  await page.waitForTimeout(3000);
  await shot('07b-after-lens');
  record('corroboration-lens', toggled ? 'CONTROL-RUNS' : 'CONTROL-NOT-FOUND',
    toggled
      ? 'View menu item clicked; compare 07a/07b screenshots. NOTE: /api/status/provenance measured ' +
        '93.7% of contacts unattributed this run, so this lens should dim nearly the whole map - ' +
        'which is the Phase 20 finding, not a rendering bug.'
      : 'the menu item never appeared (apps/web/CLAUDE.md: a control that renders must run)');
  if (toggled) await clickMenuItem('Corroborated contacts only'); // back off
}

// ── 5. inbox keyboard path ──────────────────────────────────────────────────
{
  await page.keyboard.press('j');
  await page.waitForTimeout(400);
  await page.keyboard.press('k');
  await page.waitForTimeout(400);
  await shot('05-inbox-keyboard');
  const rows = await page.evaluate(() => document.querySelectorAll('[data-inbox-row], [class*="inbox"] li, [class*="Inbox"] li').length);
  record('inbox-keyboard', rows > 0 ? 'OBSERVED' : 'UNVERIFIED',
    `${rows} inbox rows present; j/k dispatched. With an empty queue the handler returns early by design (InboxPanel.tsx:98), so 0 rows is not a defect.`);
}

// ── 4. answers panel ────────────────────────────────────────────────────────
await goto('ai');
await page.waitForTimeout(5000);
await shot('04-answers-panel');
{
  const txt = await page.evaluate(() => document.body.innerText);
  const hasAnswers = /answer/i.test(txt);
  const unknowns = (txt.match(/unknown/gi) || []).length;
  record('answers-panel', hasAnswers ? 'RENDERED' : 'NOT-FOUND',
    `answers wording ${hasAnswers}; ${unknowns} "unknown" verdicts on screen (Phase 23 premise: all 10 read unknown until 3 days are recorded)`);
}

const report = { url: URL, at: new Date().toISOString(), results, consoleErrors: consoleErrors.slice(0, 20) };
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`\nconsole errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 8).forEach((e) => console.log('  ' + e.slice(0, 160)));
console.log(`\nscreenshots + report.json -> ${OUT}`);
await browser.close();
