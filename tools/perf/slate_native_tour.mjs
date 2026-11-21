#!/usr/bin/env node
// Render tour of the Slate app surfaces: does any app still draw a UI inside
// the UI (a zoomed or fixed-size frame, its own title bar or a vendor logo)?
//
//   node tools/perf/slate_native_tour.mjs [outDir] [url]
//
// For every app and every in-app page reachable from its own page switcher it
// takes a screenshot and measures: the surface rect against the well it sits
// in, the largest child's width share (a letterboxed frame shows as < 98%),
// any element with CSS zoom != 1 or a scaled transform over 200px wide, any
// .copy / .frame element, and any logo / Palantir mark (img, svg, class, alt,
// background-image). A REPORT with one exit code: 1 when anything is flagged.

import { mkdirSync } from 'node:fs';
import { chromium } from '../adsb-globe-feeder/node_modules/playwright/index.mjs';

const OUT = process.argv[2] || '/tmp/slate-tour';
const URL = process.argv[3] || 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });

// app -> selector of that app's own page switcher buttons (null = landing only)
const APPS = {
  ai: '.pg-nav .pg-tab',
  reports: '.eu-bar button[aria-label]:not([aria-label="Gaia home"])',
  explorer: 'button.px-btn',
  foundry: '__foundry_menu__',
  video: null,
  targeting: null,
  graph: null,
  investigate: null,
};
// a button to press after the landing shot to reach the page switcher
const ENTRY = {
  ai: 'button[aria-label="Open the Foundry workspace"]',
  reports: '__text__Create Map',
};

// surfaces behind a button rather than a page switcher: [app, name, clicks]
// (each click is a button or tab accessible name, pressed in order from the
// app's landing; the app is remounted first so every visit starts clean)
const EXTRA = [
  ['ai', 'hub', ['AI hub: watch officer, analyst agent, local models']],
  ['reports', 'map', ['Create Map']],
  ['reports', 'present2', ['Create Map', 'Slides', 'Previous slide']],
  ['reports', 'present1', ['Create Map', 'Slides', 'Previous slide', 'Previous slide']],
  ['reports', 'ring', ['Create Map', 'Simulation', 'AOI ring']],
  ['reports', 'case-export', ['Create Case export']],
  ['video', 'ground-recon', ['Ground recon']],
  ['video', 'imagery', ['Imagery']],
  ['targeting', 'taskings', ['Taskings']],
  ['investigate', 'extract', ['Extract']],
  ['investigate', 'sources', ['Sources']],
];
const MIN_FONT = 11; // the shell's smallest type (slate.css micro-labels)

const measure = (MIN_FONT) => {
  // the app root: walk up from a point inside the well to the outermost
  // ancestor that is not also the globe's container
  let root = document.elementFromPoint(innerWidth * 0.62, innerHeight * 0.55);
  while (root && root.parentElement && root.parentElement !== document.body && !root.parentElement.querySelector('.cesium-widget')) root = root.parentElement;
  if (root && root.querySelector('.cesium-widget')) root = null;
  if (!root) return { err: 'no surface' };
  const r = root.getBoundingClientRect();
  const well = (root.offsetParent || root.parentElement).getBoundingClientRect();
  const flags = [];
  let railR = well.x;
  if (r.x > well.x + 1) {
    const side = document.elementFromPoint(r.x - 3, r.y + r.height / 2);
    if (side && !side.closest('.cesium-widget') && side.tagName !== 'CANVAS') railR = r.x;
  }
  let biggest = 0;
  for (const c of root.children) biggest = Math.max(biggest, c.getBoundingClientRect().width);
  for (const el of root.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    // .pst is FMV's imagery plate: a map zoom of tiles, content, not UI chrome
    if (el.closest('.pst')) continue;
    // a 16:9 slide is a document fitted into its viewer, like any slide editor
    if (el.closest('.eux-slide')) continue;
    if (cs.zoom && cs.zoom !== '1' && cs.zoom !== 'normal') flags.push(`zoom=${cs.zoom} ${el.className}`.slice(0, 120));
    if (b.width > 200 && cs.transform && cs.transform !== 'none') {
      const m = cs.transform.match(/matrix\(([^,]+),[^,]+,[^,]+,([^,]+)/);
      if (m && (Math.abs(+m[1] - 1) > 0.01 || Math.abs(+m[2] - 1) > 0.01)) flags.push(`scale ${cs.transform} ${el.tagName}.${String(el.className).slice(0, 60)}`);
    }
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    if (/(^|\s)(copy|frame)(\s|$)/.test(cls)) flags.push(`.${cls.trim()} ${Math.round(b.width)}x${Math.round(b.height)}`);
    const hay = `${cls} ${el.getAttribute('alt') || ''} ${el.getAttribute('src') || ''} ${el.getAttribute('href') || ''} ${el.getAttribute('aria-label') || ''} ${cs.backgroundImage !== 'none' ? cs.backgroundImage : ''}`;
    if (/palantir|logo/i.test(hay) && b.width > 0) flags.push(`logo? ${el.tagName} ${hay.trim().slice(0, 100)}`);
  }
  if (/palantir/i.test(root.textContent || '')) flags.push('text mentions Palantir');
  // type size: every visible text node's computed font-size, as painted
  // (CSS zoom and scaled ancestors fold into the effective size)
  let minFont = 99;
  const small = new Map();
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = n.textContent.trim();
    const el = n.parentElement;
    if (!t || !el || el.closest('.cesium-widget, .pst')) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || b.bottom < 0 || b.top > innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    let px = parseFloat(cs.fontSize);
    // an SVG text's painted size follows the viewBox scale, not the CSS px
    const svg = el.closest('svg');
    if (svg && svg.viewBox?.baseVal?.width) px *= svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    let a = el;
    while (a && a !== root) {
      const tr = getComputedStyle(a).transform;
      const m = tr && tr !== 'none' && tr.match(/matrix\(([^,]+)/);
      if (m) px *= +m[1];
      a = a.parentElement;
    }
    px = Math.round(px * 10) / 10;
    if (el.closest('.eux-slide')) continue; // slide documents scale by design
    minFont = Math.min(minFont, px);
    if (px < MIN_FONT) {
      const k = `${px}px ${el.tagName.toLowerCase()}.${String(el.getAttribute('class') || '').split(' ')[0]} "${t.slice(0, 24)}"`;
      small.set(k, (small.get(k) || 0) + 1);
    }
  }
  if (small.size) flags.push(`${[...small.values()].reduce((x, y) => x + y, 0)} text nodes < ${MIN_FONT}px: ${[...small.keys()].slice(0, 4).join('; ')}`);
  return {
    surface: [r.x, r.y, r.width, r.height].map(Math.round),
    well: [well.x, well.y, well.width, well.height].map(Math.round),
    // the shell's own left rail panel may sit inside the well beside the app
    rail: Math.round(railR - well.x),
    minFont,
    fill: +((r.width * r.height) / ((well.right - railR) * well.height)).toFixed(3),
    childW: +(biggest / r.width).toFixed(3),
    flags,
  };
};

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
});
const rows = [];
for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => {
    localStorage.setItem('velocity.onboarded.v1', '1');
    localStorage.setItem('velocity.aiSetupSeen', '1');
    localStorage.setItem('velocity.openModeDismissed', '1');
    sessionStorage.setItem('velocity.devNoLogin', '1'); // AppRouter dev-only login bypass
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  const shot = async (name) => {
    await page.waitForTimeout(2500);
    const m = await page.evaluate(measure, MIN_FONT);
    await page.screenshot({ path: `${OUT}/${name}-${w}.png` });
    // rail > 0: the shell's panel card sits beside the app and the globe shows
    // below it (how Video looked before it went full-bleed under Slate)
    const bad = m.err || m.fill < 0.98 || m.childW < 0.98 || m.rail > 0 || m.flags.length;
    rows.push({ name, w, ...m, bad: !!bad });
  };
  for (const [app, nav] of Object.entries(APPS)) {
    await page.evaluate((id) => window.__useAppView.getState().setApp(id), app);
    await shot(app);
    if (!nav) continue;
    const entry = ENTRY[app];
    const enter = async () => {
      if (!entry || (await page.locator(nav).count())) return;
      if (entry.startsWith('__text__')) await page.getByRole('button', { name: entry.slice(8), exact: true }).first().click({ timeout: 5000 }).catch(() => {});
      else await page.locator(entry).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    };
    await enter();
    if (nav === '__foundry_menu__') {
      const n = await page.evaluate(() => {
        document.querySelector('.fxn-btn, .om-btn')?.click();
        return document.querySelectorAll('.fx-menu [role=menuitem]').length;
      });
      await page.waitForTimeout(300);
      const count = await page.locator('.fx-menu [role=menuitem]').count();
      for (let i = 0; i < Math.max(n, count); i++) {
        await page.evaluate(() => document.querySelector('.fxn-btn, .om-btn, .sl-fx button')?.click());
        await page.waitForTimeout(300);
        const item = page.locator('.fx-menu [role=menuitem]').nth(i);
        if (!(await item.count())) break;
        const label = (await item.textContent()).trim().replace(/\W+/g, '_').slice(0, 30);
        await item.click();
        await shot(`foundry-${i}-${label}`);
      }
      continue;
    }
    const labels = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((b) => b.getAttribute('aria-label') || b.textContent.trim()), nav);
    for (const label of labels) {
      await enter(); // a tab that returns to the landing drops the switcher
      const ok = await page.evaluate(([sel, l]) => {
        const b = [...document.querySelectorAll(sel)].find((x) => (x.getAttribute('aria-label') || x.textContent.trim()) === l);
        if (!b || b.disabled) return false;
        b.click();
        return true;
      }, [nav, label]);
      if (ok) await shot(`${app}-${label.replace(/\W+/g, '_').slice(0, 30)}`);
    }
  }
  for (const [app, name, clicks] of EXTRA) {
    await page.evaluate(() => window.__useAppView.getState().setApp('map'));
    await page.waitForTimeout(500);
    await page.evaluate((id) => window.__useAppView.getState().setApp(id), app);
    await page.waitForTimeout(2500);
    let ok = true;
    for (const c of clicks) {
      const target = page.getByRole('button', { name: c, exact: true }).or(page.getByRole('tab', { name: c, exact: true })).first();
      if (!(await target.count())) { ok = false; break; }
      await target.click({ timeout: 5000 }).catch(() => { ok = false; });
      await page.waitForTimeout(1500);
    }
    if (ok) await shot(`${app}-${name}`);
    else rows.push({ name: `${app}-${name}`, w, err: `could not reach (${clicks.join(' > ')})`, bad: true });
  }
  await ctx.close();
}
await browser.close();
console.log('page                                 vw    fill  childW  surface            rail font flags');
for (const r of rows)
  console.log(`${r.bad ? '!!' : '  '} ${r.name.padEnd(34)} ${r.w}  ${String(r.fill).padEnd(5)} ${String(r.childW).padEnd(6)} ${JSON.stringify(r.surface || r.err).padEnd(18)} ${String(r.rail ?? '').padEnd(4)} ${String(r.minFont ?? '').padEnd(4)} ${(r.flags || []).slice(0, 3).join(' | ')}`);
const bad = rows.filter((r) => r.bad).length;
console.log(`\n${rows.length} pages measured, ${bad} flagged; screenshots in ${OUT}`);
process.exit(bad ? 1 : 0);
