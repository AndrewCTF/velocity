// Verify the Gotham-grammar mockups in a real browser.
//
// The spec's own rule is that these claims get measured, not asserted: the
// first pass claimed every primitive was keyboard reachable while the markup
// used <div> for rows, chips, switches and the whole map toolbar, and a browser
// found 76 unreachable controls. This re-runs that measurement, plus the 12px
// type floor and the structural metrics that were derived from the reference
// crops, so a regression in either shows up as a FAIL line.
//
// Run: node _verify.mjs [file.html ...]
import { chromium } from 'playwright-core';
import path from 'node:path';
import process from 'node:process';

const EXEC = `${process.env.HOME}/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`;

// Measured off _ref/ at the 0.633 capture scale; see gotham.css for the table.
const EXPECT = {
  '.gk-band': 20,
  '.gk-title': 40,
  '.gk-tabs': 32,
  '.gk-rail': 40, // width
  '.gk-action': 50,
};

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['gotham-console.html', 'gotham-loading.html', 'gotham-empty.html',
     'gotham-error.html', 'gotham-degraded.html'];

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1834, height: 1032 } });

let fails = 0;
const problem = (m) => { console.log(`  FAIL ${m}`); fails++; };

for (const f of files) {
  const errors = [];
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`file://${path.resolve(f)}`, { waitUntil: 'load' });

  // Pass functions to page.evaluate, never strings.
  const r = await page.evaluate(() => {
    const vis = (el) => {
      const s = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
    };

    // Text nodes rendered below the 12px floor.
    const tiny = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || !vis(el)) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 12) tiny.push({ px, text: n.textContent.trim().slice(0, 30) });
    }

    // Every focusable control must have an accessible name.
    const SEL = 'a[href],button,input,select,textarea,[tabindex],[role=switch],[role=button],[role=option]';
    const focusables = [...document.querySelectorAll(SEL)].filter(vis);
    const unnamed = focusables
      .filter((el) => {
        const n = (el.getAttribute('aria-label') || el.textContent || '').trim();
        const ph = el.getAttribute('placeholder') || '';
        return !n && !ph;
      })
      .map((el) => el.tagName + '.' + (el.className || '').toString().slice(0, 24));

    // Things that look clickable but are not reachable by keyboard.
    const clickableish = [...document.querySelectorAll('.gk-row,.chip,.sw,.gk-tab,.gk-maptools>*,.tok')]
      .filter(vis)
      // Decoration is exempt: a hairline separator is not a control, and it
      // declares that itself with aria-hidden.
      .filter((el) => !el.closest('[aria-hidden="true"]'))
      // A labelled toolbar group is a container for controls, not a control.
      .filter((el) => el.getAttribute('role') !== 'group')
      .filter((el) => {
        const t = el.tagName;
        if (t === 'BUTTON' || t === 'A' || t === 'INPUT') return false;
        return !el.hasAttribute('tabindex');
      })
      .map((el) => el.tagName + '.' + (el.className || '').toString().slice(0, 24));

    // Every symbol-referencing <svg> needs a viewBox or it renders cropped.
    const noViewBox = [...document.querySelectorAll('svg')]
      .filter((s) => s.querySelector('use') && !s.hasAttribute('viewBox')).length;

    const m = (sel, prop) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return prop === 'width' ? Math.round(b.width) : Math.round(b.height);
    };

    return {
      tiny, unnamed, clickableish, noViewBox,
      focusableCount: focusables.length,
      metrics: {
        '.gk-band': m('.gk-band'), '.gk-title': m('.gk-title'),
        '.gk-tabs': m('.gk-tabs'), '.gk-rail': m('.gk-rail', 'width'),
        '.gk-action': m('.gk-action'), '.gk-status': m('.gk-status'),
      },
      // Horizontal overflow of the page body is a layout defect.
      hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

  console.log(`\n=== ${f} ===`);
  console.log(`  focusable controls: ${r.focusableCount}`);
  if (r.tiny.length) problem(`${r.tiny.length} text nodes below 12px, e.g. ${r.tiny[0].px}px "${r.tiny[0].text}"`);
  else console.log('  type floor: 0 nodes below 12px');
  if (r.unnamed.length) problem(`${r.unnamed.length} focusable without an accessible name: ${r.unnamed.slice(0, 3).join(', ')}`);
  else console.log('  accessible names: all focusables named');
  if (r.clickableish.length) problem(`${r.clickableish.length} keyboard-unreachable controls: ${r.clickableish.slice(0, 3).join(', ')}`);
  else console.log('  keyboard: 0 unreachable controls');
  if (r.noViewBox) problem(`${r.noViewBox} <svg> referencing a symbol without a viewBox (icons render cropped)`);
  else console.log('  icons: every symbol-referencing svg has a viewBox');
  if (r.hscroll) problem('page body scrolls horizontally');
  if (errors.length) problem(`${errors.length} console errors: ${errors[0]}`);
  else console.log('  console: 0 errors');

  for (const [sel, want] of Object.entries(EXPECT)) {
    const got = r.metrics[sel];
    if (got === null) { problem(`${sel} not found`); continue; }
    if (got !== want) problem(`${sel} is ${got}px, measured reference says ${want}px`);
  }
  console.log(`  metrics: ${Object.entries(r.metrics).map(([k, v]) => `${k.replace('.gk-', '')}=${v}`).join(' ')}`);
}

await browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nall checks passed');
process.exit(fails ? 1 : 0);
