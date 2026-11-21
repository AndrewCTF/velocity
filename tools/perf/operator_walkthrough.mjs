#!/usr/bin/env node
// Operator walkthrough harness for issue #107.
// Extends tools/perf/ui_clip_sweep.mjs (measure) + tools/perf/console_frame_check.mjs
// (console gating): per surface screenshot + click every button/toggle and flag
// dead controls, open/close panels, resize 1366/1920/2560 clipping/overlap,
// pan globe and flag overlay drift, fail on console errors.
//
// Usage:
//   node tools/perf/operator_walkthrough.mjs [--quick] [--apps=map,ai] [--out=docs/media/walkthrough]
// Requires dev servers: API :8000 (scripts/run-api.sh, output to file) + Vite :5173.
// Chrome: /usr/bin/google-chrome-stable. Playwright: OSINT-sec copy noted in issue,
// fallback to tools/adsb-globe-feeder copy if the OSINT-sec path is absent.
// Login bypass: sessionStorage velocity.devNoLogin=1 (AppRouter.tsx:130, dev only).
//
// Output: screenshots + metrics-walkthrough-<w>.json + summary printed.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

async function loadPlaywright() {
  const candidates = [
    '/home/andrew/Projects/OSINT-sec/tools/adsb-globe-feeder/node_modules/playwright/index.mjs',
    path.join(REPO, 'tools/adsb-globe-feeder/node_modules/playwright/index.mjs'),
    path.join(REPO, 'tools/browser-fetch/node_modules/playwright/index.mjs'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const mod = await import(p);
      return mod;
    }
  }
  throw new Error('playwright not found in any candidate path');
}
const { chromium } = await loadPlaywright();

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const QUICK = !!args.quick;
const OUT = args.out || path.join(REPO, 'docs/media/walkthrough');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = QUICK
  ? [{ w: 1920, h: 1080 }]
  : [
      { w: 1366, h: 768 },
      { w: 1920, h: 1080 },
      { w: 2560, h: 1440 },
    ];

const ALL_APPS = [
  'map','ai','explorer','graph','investigate','targeting','video','sim','reports',
  'foundry','workflows','city','country','markets','models','quiver','vertex','workshop',
];
const APPS = args.apps ? String(args.apps).split(',').map((s) => s.trim()).filter(Boolean) : (QUICK ? ['map','ai','foundry'] : ALL_APPS);

const BASE = process.env.BASE || 'http://localhost:5173';

function measure() {
  const out = { truncated: [], overflowing: [], tiny: 0, tinySamples: [], offscreen: [], overlaps: 0, overlapSamples: [], textNodes: 0, chars: 0, hScroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const label = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70);
  const leaves = [];
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT','STYLE','CANVAS','SVG','svg','path'].includes(el.tagName)) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || !vis(el)) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const t = label(el);
    out.textNodes++; out.chars += t.length;
    leaves.push({ el, r, t });
    const fs = parseFloat(s.fontSize);
    if (fs < 11) { out.tiny++; if (out.tinySamples.length < 12) out.tinySamples.push(`${fs}px "${t.slice(0,40)}"`); }
    const clipX = el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible' && s.overflowX !== 'auto' && s.overflowX !== 'scroll';
    const clipY = el.scrollHeight > el.clientHeight + 2 && (s.overflowY === 'hidden' || s.overflowY === 'clip') && el.clientHeight > 0;
    if (clipX || clipY || (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1)) out.truncated.push(`${clipX?'X':''}${clipY?'Y':''} ${el.scrollWidth}/${el.clientWidth} "${t}"`);
    for (let a = el.parentElement, d = 0; a && d < 6; a = a.parentElement, d++) {
      const as = getComputedStyle(a);
      if (as.overflow === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (r.right > ar.right + 2 || r.bottom > ar.bottom + 2 && as.overflowY !== 'auto' && as.overflowY !== 'scroll' || r.left < ar.left - 2) {
        if (as.overflowX === 'auto' || as.overflowX === 'scroll') break;
        out.overflowing.push(`"${t}" exceeds ${a.tagName.toLowerCase()}`);
      }
      break;
    }
    if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1) out.offscreen.push(`"${t.slice(0,40)}" @${Math.round(r.left)},${Math.round(r.top)}`);
  }
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length && j < i + 60; j++) {
    const a = leaves[i], b = leaves[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (ix > 4 && iy > 4) { out.overlaps++; if (out.overlapSamples.length < 8) out.overlapSamples.push(`"${a.t.slice(0,30)}" x "${b.t.slice(0,30)}"`); }
  }
  out.truncated = [...new Set(out.truncated)];
  out.overflowing = [...new Set(out.overflowing)];
  return out;
}

function domSig() {
  // cheap signature: body text length + aria-selected/pressed counts + visible button count
  // + focused control (a click that only moves focus still changed selection state)
  // + the active app/title so a rail click that re-renders the same text counts
  const btns = document.querySelectorAll('button');
  const sel = document.querySelectorAll('[aria-selected="true"],[aria-pressed="true"],[aria-current="page"]');
  const ae = document.activeElement ? (document.activeElement.getAttribute('aria-label') || document.activeElement.tagName || 'none').slice(0, 40) : 'none';
  return `${document.body.innerText.length}:${btns.length}:${sel.length}:${ae}:${document.title}`;
}

async function clickSweep(page, label) {
  const results = [];
  // Disabled buttons are not dead controls: they carry a spoken reason
  // (Hit disabledWhy, wired via title). Clicking one changes nothing by
  // design, so sweeping them would false-report a dead control.
  const buttons = page.locator('button:visible:not([disabled])');
  const count = await buttons.count().catch(() => 0);
  const maxClicks = QUICK ? 12 : 40;
  const n = Math.min(count, maxClicks);
  for (let i = 0; i < n; i++) {
    const loc = buttons.nth(i);
    const text = ((await loc.innerText().catch(() => '')) || (await loc.getAttribute('aria-label').catch(() => '')) || (await loc.getAttribute('title').catch(() => '')) || `btn${i}`).trim().slice(0, 60);
    const before = await page.evaluate(domSig).catch(() => '');
    await loc.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(250);
    const after = await page.evaluate(domSig).catch(() => '');
    const changed = before !== after;
    if (!changed) results.push({ idx: i, label: text, changed: false });
    // dismiss any dialog/menu we just opened so the next click lands on the same surface
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(80);
  }
  return { totalVisible: count, swept: n, dead: results };
}

async function panelSweep(page, vpLabel, app) {
  const opened = [];
  // The clickSweep before this often switched surfaces (click 5 in probe:
  // "Explorer" unmounts the left panel: ptabsBtn 3->0, roleTab 3->0), which is
  // why the original run reported tabsFound=0 even though a fresh load has 3
  // [role=tab]. Navigate back to the target app before counting so tabsFound
  // reflects that surface. Debug cause: 0 count = bleed/different route/scheme
  // where the left panel is not mounted (SlateShell.tsx:828 `.sl-ptabs` gated
  // by !bleed), or before React mounted.
  await page.evaluate((id) => {
    try { window.__useAppView?.getState?.()?.setApp?.(id); } catch { /* noop */ }
  }, app).catch(() => {});
  await page.waitForTimeout(QUICK ? 2500 : 3500);
  // Fallback chain per debug cause: [role=tab] -> .sl-ptabs button -> left-panel
  // tab buttons -> MANEUVERS menus.
  await page.waitForSelector('.slate-shell, .sl-ptabs, [role="tablist"]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  const chain = [
    '[role="tab"]:visible',
    '.sl-ptabs button:visible',
    'aside[aria-label="Left panel"] button:visible, aside.a.panel button:visible, .a.panel button:visible',
    '.a.menu button:visible, .mv-menu:visible, [aria-label="MANEUVERS"]:visible',
  ];
  let tabs = null;
  let n = 0;
  for (const sel of chain) {
    const loc = page.locator(sel);
    const c = await loc.count().catch(() => 0);
    if (c > 0) { tabs = loc; n = c; break; }
  }
  if (tabs && n > 0) {
    // menu-*.png: menus row (7 buttons per debug cause) is the last chain step;
    // screenshot it before clicking tabs (clicking collapses menus).
    await page.screenshot({ path: path.join(OUT, `menu-${app}.png`) }).catch(() => {});
    for (let i = 0; i < Math.min(n, 12); i++) {
      const loc = tabs.nth(i);
      const label = ((await loc.innerText().catch(() => '')) || (await loc.getAttribute('aria-label').catch(() => '')) || `tab${i}`).trim().slice(0, 50);
      const visibleBefore = await loc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      }).catch(() => false);
      await loc.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(400);
      opened.push({ label, visibleBefore });
      // panel-*.png: capture the first panel that opened visibly.
      if (opened.length === 1) {
        await page.screenshot({ path: path.join(OUT, `panel-${app}.png`) }).catch(() => {});
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
  } else {
    await page.screenshot({ path: path.join(OUT, `panel-${app}.png`) }).catch(() => {});
    await page.screenshot({ path: path.join(OUT, `menu-${app}.png`) }).catch(() => {});
  }
  return { tabsFound: n, clicked: opened.length, opened };
}

async function driftCheck(page) {
  // Capture positions of key overlay selectors, pan the globe, re-measure.
  // An overlay that was anchored to the map but moves WITH screen pixels after
  // a camera pan is flagged as drifting (it should move with the camera or stay
  // fixed as chrome, not slide relative to the map frame).
  const selectors = ['.slate-shell', '.a.panel', '.a.obj', '.csl2-dock', '.a.rail', '.a.tabsbar'];
  const before = await page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) { out[s] = null; continue; }
      const r = el.getBoundingClientRect();
      out[s] = { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return out;
  }, selectors).catch(() => ({}));

  const panned = await page.evaluate(() => {
    const v = window.__viewer;
    if (!v || v.isDestroyed()) return false;
    try {
      const c = v.camera;
      c.moveLeft(500000);
      return true;
    } catch { return false; }
  }).catch(() => false);
  await page.waitForTimeout(600);

  const after = await page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) { out[s] = null; continue; }
      const r = el.getBoundingClientRect();
      out[s] = { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return out;
  }, selectors).catch(() => ({}));

  const deltas = {};
  for (const s of selectors) {
    const a = before[s], b = after[s];
    if (!a || !b) continue;
    const dl = b.l - a.l, dt = b.t - a.t;
    if (Math.abs(dl) > 2 || Math.abs(dt) > 2) deltas[s] = { dl, dt };
  }
  return { panned, before, after, deltas };
}

// browser once; viewports via context
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--use-gl=angle','--use-angle=vulkan','--ignore-gpu-blocklist'],
});

const summary = { viewports: [], apps: APPS, quick: QUICK, out: OUT };

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  await ctx.addInitScript(() => {
    sessionStorage.setItem('velocity.devNoLogin', '1');
    localStorage.setItem('velocity.onboarded.v1', '1');
    localStorage.setItem('velocity.aiSetupSeen', '1');
    localStorage.setItem('velocity.openModeDismissed', '1');
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.text().slice(0, 300)} @${m.location()?.url || ''}: ${m.location()?.lineNumber || ''}`); });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  // Wait for the Slate shell (DEV globals) so drift/panel probes never run on a
  // pre-mount DOM — the nulls in the 2026-11-05 run came from running before
  // React replaced the login shell, not from missing selectors (.a.panel does
  // render: SlateShell.tsx:821).
  await page.waitForSelector('.slate-shell', { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !!window.__viewer && !!window.__useAppView, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(10000);
  for (const label of ['Skip','Dismiss','Close','Got it']) {
    const el = page.getByRole('button', { name: label }).first();
    if ((await el.count().catch(() => 0)) > 0) await el.click({ timeout: 2000 }).catch(() => {});
  }
  await page.waitForTimeout(2000);

  const vpSummary = { viewport: vp, consoleErrors, pageErrors, surfaces: [] };

  for (const app of APPS) {
    const setOk = await page.evaluate((id) => {
      try { window.__useAppView?.getState?.()?.setApp?.(id); return true; }
      catch { return false; }
    }, app).catch(() => false);
    await page.waitForTimeout(QUICK ? 2500 : 3500);
    await page.screenshot({ path: path.join(OUT, `${vp.w}-${app}.png`) }).catch(() => {});
    const metrics = await page.evaluate(measure).catch(() => null);
    const dead = await clickSweep(page, `${vp.w}-${app}`);
    const panels = await panelSweep(page, `${vp.w}-${app}`, app);
    const drift = await driftCheck(page);
    vpSummary.surfaces.push({ app, setOk, metrics, dead, panels, drift });
    console.log(`${vp.w}x${vp.h} ${app.padEnd(12)} text=${metrics?.textNodes ?? '?'} trunc=${metrics?.truncated?.length ?? '?'} clip=${metrics?.overflowing?.length ?? '?'} overlaps=${metrics?.overlaps ?? '?'} hScroll=${metrics?.hScroll ?? '?'} deadClicks=${dead.dead.length}/${dead.swept} drift=${Object.keys(drift.deltas || {}).join(',') || 'none'}`);
  }

  fs.writeFileSync(path.join(OUT, `metrics-${vp.w}.json`), JSON.stringify(vpSummary, null, 1));
  summary.viewports.push(vpSummary);
  await ctx.close();
}

fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
await browser.close();

// exit 1 if any surface had console errors (issue requirement)
const totalErrors = summary.viewports.reduce((n, v) => n + v.consoleErrors.length + v.pageErrors.length, 0);
console.log(`\nconsole/page errors total: ${totalErrors}`);
console.log(`screenshots: ${OUT}/`);
if (totalErrors > 0) process.exitCode = 1;
