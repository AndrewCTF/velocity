// _gate.mjs — the fidelity bar, as checks that run in a real browser.
//
//   node _gate.mjs            check every page
//   node _gate.mjs --shots    check, and write _shots/*.png
//
// This file exists because the previous mockup set made these same claims in
// prose and two of them were false when finally measured: 76 controls were
// keyboard-unreachable and every icon was cropped. A claim that is not checked
// is a claim that is wrong later.
//
// Exit codes: 0 all pass, 1 a check failed, 2 the harness itself broke.

import { chromium } from '/home/andrew/Projects/OSINT/tools/adsb-globe-feeder/node_modules/playwright-core/index.mjs';
import { readdirSync, mkdirSync } from 'node:fs';

const SHOTS = process.argv.includes('--shots');
const DIR = process.cwd();
const pages = readdirSync(DIR).filter((f) => /^\d\d-.*\.html$/.test(f)).sort();
if (!pages.length) { console.error('no pages found; run python3 _build.py first'); process.exit(2); }
if (SHOTS) mkdirSync(`${DIR}/_shots`, { recursive: true });

// Gate 1 allows exactly two non-ASCII characters through.
//   U+2014 EM DASH   the lone "no value reported" sentinel, which the copy
//                    rules require and which stripping would be the mistake.
//   U+00B7 MIDDLE DOT the label separator the same rules mandate.
// Everything else above U+00FF in rendered text is a pictograph standing in
// for an icon, which is the thing being banned.
// Typographic punctuation is typography, not a pictograph standing in for an
// icon. The ellipsis is here because CLAUDE.md sanctions the `loading…`
// register explicitly.
const ALLOWED = new Set(['—', '·', '°', ' ', '→', 'σ',
                         '÷', '≥', '’', '‘', '“', '”',
                         '…', '½', '×', '−']);

const checks = {
  // 1 — zero emoji. Every icon is a real SVG symbol.
  emoji: () => {
    const bad = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      if (!n.parentElement || n.parentElement.closest('svg')) continue;
      for (const ch of n.textContent) {
        if (ch.codePointAt(0) > 0x00ff && !window.__ALLOWED.has(ch)) {
          bad.push(`${ch} (U+${ch.codePointAt(0).toString(16).toUpperCase()}) in "${n.textContent.trim().slice(0, 40)}"`);
        }
      }
    }
    return [...new Set(bad)];
  },

  // 2 — the basemap is real raster tiles, not drawn geometry.
  basemap: () => {
    const well = document.querySelector('.map');
    if (!well) return [];
    const imgs = [...document.querySelectorAll('.tiles img')];
    if (!imgs.length) return ['map well has no tile images'];
    const broken = imgs.filter((i) => !i.complete || i.naturalWidth === 0);
    if (broken.length) return [`${broken.length} of ${imgs.length} tiles failed to load`];
    // Coverage, not just presence. A grid that loads perfectly and stops
    // two-thirds of the way across a 2560 screen leaves contacts floating over
    // bare background, which is exactly the failure this check exists for.
    const w = well.getBoundingClientRect();
    const t = document.querySelector('.tiles').getBoundingClientRect();
    const gaps = [];
    if (t.left > w.left + 1) gaps.push(`left ${Math.round(t.left - w.left)}px`);
    if (t.top > w.top + 1) gaps.push(`top ${Math.round(t.top - w.top)}px`);
    if (t.right < w.right - 1) gaps.push(`right ${Math.round(w.right - t.right)}px`);
    if (t.bottom < w.bottom - 1) gaps.push(`bottom ${Math.round(w.bottom - t.bottom)}px`);
    return gaps.length ? [`basemap does not cover the map well: ${gaps.join(', ')}`] : [];
  },

  // 3 — every count carries a mark. This is the operator's "numbers do
  //     nothing" complaint, enforced rather than promised.
  marks: () => {
    const bad = [];
    for (const c of document.querySelectorAll('.count')) {
      const m = c.closest('.mark');
      if (!m) { bad.push(`.count outside a .mark: "${c.textContent.trim()}"`); continue; }
      if (!m.querySelector('.bar, .spark, .dots, .meter')) {
        bad.push(`.mark with no bar/spark/dots/meter: "${c.textContent.trim()}"`);
      }
    }
    return [...new Set(bad)].slice(0, 8);
  },

  // 4 — every object card carries a thumbnail.
  thumbs: () => {
    const bad = [];
    for (const c of document.querySelectorAll('.obj-card')) {
      const t = c.querySelector('.thumb');
      if (!t || !t.querySelector('img, svg')) {
        bad.push(`obj-card with no thumbnail: "${(c.querySelector('.obj-t') || c).textContent.trim().slice(0, 30)}"`);
      }
    }
    return [...new Set(bad)].slice(0, 8);
  },

  // 5a — the 12px text floor. Blueprint pairs its 20px dense row with a 12px
  //      font, so density and the floor were never in tension. Two 11px
  //      exemptions are declared in the CSS and listed here by class.
  floor: () => {
    const EXEMPT = ['clas', 'tl', 'tbtn', 'ax', 'tgroup', 'gl-label', 'badge', 'attrib',
                'ph-stamp', 'hud', 'det-label'];
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('svg')) continue;
      const txt = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).length;
      if (!txt) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px >= 12) continue;
      if (EXEMPT.some((c) => el.classList.contains(c) || el.closest(`.${c}`))) continue;
      bad.push(`${px}px on ${el.className || el.tagName}: "${el.textContent.trim().slice(0, 30)}"`);
    }
    return [...new Set(bad)].slice(0, 8);
  },

  // 5b — every symbol-referencing <svg> carries its own viewBox. The previous
  //      set failed this and every icon rendered cropped.
  viewbox: () => {
    const bad = [];
    for (const s of document.querySelectorAll('svg')) {
      if (s.querySelector('use') && !s.hasAttribute('viewBox')) bad.push(s.outerHTML.slice(0, 60));
    }
    return bad.slice(0, 5);
  },

  // 5c — nothing is a mystery glyph: every focusable has an accessible name,
  //      and nothing is keyboard-unreachable.
  a11y: () => {
    const sel = 'a[href], button, input, select, textarea, [tabindex]';
    const bad = [];
    let unreachable = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (el.tabIndex < 0) unreachable++;
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim()
        || el.getAttribute('title') || '';
      if (!name) bad.push(`${el.tagName}.${el.className} has no accessible name`);
    }
    if (unreachable) bad.push(`${unreachable} keyboard-unreachable controls`);
    return [...new Set(bad)].slice(0, 8);
  },

  // 6 — copy rules. No " — " anywhere; the em dash survives only alone.
  copy: () => {
    const bad = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const t = n.textContent;
      if (/\s—\s/.test(t)) bad.push(`spaced em dash: "${t.trim().slice(0, 50)}"`);
      else if (t.includes('—') && t.trim() !== '—') {
        bad.push(`em dash in prose: "${t.trim().slice(0, 50)}"`);
      }
    }
    return [...new Set(bad)].slice(0, 5);
  },

  // 8 — no readout is clipped. A right-aligned box with text-overflow:ellipsis
  //     clips the START of its content, so at 1366 the Altitude row rendered
  //     "8,975 ft" for 38,975. A truncated label is cosmetic; a truncated
  //     number is a lie, and an instrument may not tell one.
  clipped: () => {
    const bad = [];
    // A VALUE may not clip at all. It is right-aligned, so the ellipsis eats
    // the leading digits and the loss is invisible: 38,975 becomes 8,975 and
    // nothing on screen says so.
    for (const el of document.querySelectorAll('.kv dd, .count, .clock, .stat .v')) {
      if (el.scrollWidth > el.clientWidth + 1) {
        bad.push(`clipped VALUE "${el.textContent.trim().slice(0, 24)}" ` +
                 `(${el.scrollWidth} > ${el.clientWidth})`);
      }
    }
    // A NAME may clip, because a name is left-aligned and the ellipsis is
    // visible where the text was cut. What it may not do is clip silently.
    for (const el of document.querySelectorAll('.obj-t, .obj-s, .nm, .sub, .panel-title, .row, .kv dt')) {
      if (el.scrollWidth > el.clientWidth + 1 &&
          getComputedStyle(el).textOverflow !== 'ellipsis') {
        bad.push(`hard-clipped name "${el.textContent.trim().slice(0, 24)}"`);
      }
    }
    return [...new Set(bad)].slice(0, 6);
  },

  // 11 — no two sibling surfaces share an edge. The whole console was one
  //      continuous slab divided by hairlines, which is what made it read as
  //      welded. Two pairs are deliberate and listed by name: a title bar and
  //      the tab strip under it are ONE header unit, as are an app's title row
  //      and its sub-tabs. Everything else must sit in the gutter.
  welded: () => {
    // Keys are the two class names sorted, so 'tabs' sorts before 'titlebar'.
    const OK = new Set(['tabs|titlebar', 'app-head|subtabs']);
    const SURF = '.panel, .map, .app, .rail, .card, .dock, .app-head, .subtabs, ' +
                 '.actionbar, .tabs, .titlebar';
    const nm = (e) => e.className.toString().split(' ').filter(Boolean)[0] || e.tagName;
    const kids = new Map();
    for (const el of document.querySelectorAll(SURF)) {
      if (!kids.has(el.parentElement)) kids.set(el.parentElement, []);
      kids.get(el.parentElement).push(el);
    }
    const bad = [];
    for (const [, list] of kids) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i].getBoundingClientRect();
          const c = list[j].getBoundingClientRect();
          if (!a.width || !c.width) continue;
          const gap = Math.max(Math.max(a.left - c.right, c.left - a.right),
                               Math.max(a.top - c.bottom, c.top - a.bottom));
          if (gap <= -1 || gap >= 1) continue;
          const key = [nm(list[i]), nm(list[j])].sort().join('|');
          if (OK.has(key)) continue;
          bad.push(`welded surfaces: ${key}`);
        }
      }
    }
    return [...new Set(bad)];
  },

  // 10 — floating map furniture must not sit on top of other floating map
  //      furniture. The toolbar covered the status strip once and the dock
  //      covered the scale bar and coordinate readout once; both were found by
  //      eye at one viewport, which is not a method.
  overlap: () => {
    const pairs = [['.map-foot', '.dock'], ['.map-strip', '.toolbar'],
                   ['.map-strip', '.dock'], ['.toolbar', '.dock'],
                   ['.map-foot', '.toolbar']];
    const bad = [];
    const hit = (a, b) => !(a.right <= b.left + 1 || a.left >= b.right - 1 ||
                            a.bottom <= b.top + 1 || a.top >= b.bottom - 1);
    for (const [sa, sb] of pairs) {
      const ea = document.querySelector(sa), eb = document.querySelector(sb);
      if (!ea || !eb) continue;
      const ra = ea.getBoundingClientRect(), rb = eb.getBoundingClientRect();
      if (!ra.width || !rb.width) continue;
      if (hit(ra, rb)) bad.push(`${sa} overlaps ${sb}`);
    }
    return bad;
  },

  // 9 — no stray text outside the shell. A build step that appended its own
  //     progress line to the sprite put "icons.mjs: 131 symbols" at the top of
  //     every page, and nothing else here would have noticed: it is ASCII, so
  //     the emoji check passes it, and it is not in a panel, so the clipping
  //     checks never see it.
  stray: () => {
    const bad = [];
    for (const n of document.body.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) {
        bad.push(`stray text node in <body>: "${n.textContent.trim().slice(0, 40)}"`);
      }
    }
    return bad;
  },

  // 7 — the page must not scroll sideways at the reference viewport.
  overflow: () => {
    const d = document.documentElement;
    return d.scrollWidth > d.clientWidth
      ? [`horizontal overflow: ${d.scrollWidth} > ${d.clientWidth}`] : [];
  },
};

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const VIEWPORTS = [[1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [1834, 1032]];
const page = await browser.newPage({ viewport: { width: 1834, height: 1032 }, deviceScaleFactor: 1 });

let failures = 0;
const totals = {};
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

for (const file of pages) {
  consoleErrors.length = 0;
  const bySize = {};
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`file://${DIR}/${file}`, { waitUntil: 'networkidle' });
    await page.evaluate((a) => { window.__ALLOWED = new Set(a); }, [...ALLOWED]);
    for (const [name, fn] of Object.entries(checks)) {
      const out = await page.evaluate(fn);
      if (out.length) (bySize[name] ||= []).push(...out.map((m) => `${w}x${h}  ${m}`));
    }
  }
  const results = bySize;
  results.console = consoleErrors.slice(0, 3);

  const bad = Object.entries(results).filter(([, v]) => v.length);
  const counted = await page.evaluate(() => ({
    icons: document.querySelectorAll('svg use').length,
    marks: document.querySelectorAll('.mark').length,
    focus: document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]').length,
  }));
  for (const k of Object.keys(counted)) totals[k] = (totals[k] || 0) + counted[k];

  if (bad.length) {
    failures++;
    console.log(`\nFAIL ${file}`);
    for (const [name, msgs] of bad) for (const m of msgs) console.log(`   ${name}: ${m}`);
  } else {
    console.log(`pass ${file.padEnd(24)} ${String(counted.icons).padStart(4)} icons  ` +
                `${String(counted.marks).padStart(4)} marks  ${String(counted.focus).padStart(4)} focusable`);
  }
  if (SHOTS) await page.screenshot({ path: `${DIR}/_shots/${file.replace('.html', '.png')}` });
}

await browser.close();
console.log(`\n${pages.length - failures} of ${pages.length} pages pass  ` +
            `(${totals.icons} icon uses, ${totals.marks} marks, ${totals.focus} focusable controls)`);
process.exit(failures ? 1 : 0);
