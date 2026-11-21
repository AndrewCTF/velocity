#!/usr/bin/env node
// A11y sweep of the :5173 map surface. axe-core style checks, implemented in
// page.evaluate (no new dep — follow operator_walkthrough.mjs boot/login):
//  - button without accessible name (aria-label/title/visible text)
//  - img without alt attribute
//  - text/background contrast < 4.5:1 normal, < 3:1 large (WCAG AA), reusing
//    the relLum/ratio math from theme/contrast.test.ts (read-only).
// Writes docs/media/walkthrough/a11y.json. Edit nothing else.

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
  for (const p of candidates) if (fs.existsSync(p)) return await import(p);
  throw new Error('playwright not found');
}
const { chromium } = await loadPlaywright();

const OUT = path.join(REPO, 'docs/media/walkthrough/a11y.json');
const BASE = process.env.BASE || 'http://localhost:5173';

function a11yCheck() {
  const violations = [];
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : ''} @${Math.round(r.left)},${Math.round(r.top)}`;
  };

  // ── 1. buttons without accessible name ────────────────────────────────
  document.querySelectorAll('button').forEach((el, i) => {
    if (!vis(el)) return;
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '').trim();
    if (!name) violations.push({ rule: 'button-name', severity: 'serious', target: describe(el), detail: `button #${i} has no accessible name` });
  });

  // ── 2. img without alt ────────────────────────────────────────────────
  document.querySelectorAll('img').forEach((el, i) => {
    if (!vis(el)) return;
    if (!el.hasAttribute('alt')) violations.push({ rule: 'image-alt', severity: 'serious', target: describe(el), detail: `img #${i} src=${(el.getAttribute('src') || '').slice(0, 80)} has no alt attribute` });
  });

  // ── 3. color contrast (WCAG AA), same math as theme/contrast.test.ts ─
  const toRgb = (s) => {
    const m = s.match(/^rgba?\(([^)]+)\)$/); if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return [p[0], p[1], p[2], p.length > 3 && !isNaN(p[3]) ? p[3] : 1];
  };
  const parseColor = (s) => {
    s = (s || '').trim();
    if (s.startsWith('#')) {
      let h = s.slice(1);
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    return toRgb(s);
  };
  const relLum = ([r, g, b]) => {
    const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const ratio = (fg, bg) => {
    const a = relLum(fg), b = relLum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const composite = (fg, bg) => [
    Math.round(fg[0] * fg[3] + bg[0] * (1 - fg[3])),
    Math.round(fg[1] * fg[3] + bg[1] * (1 - fg[3])),
    Math.round(fg[2] * fg[3] + bg[2] * (1 - fg[3])), 1,
  ];
  // walk ancestors from el upward, compositing each background over the
  // next opaque one; returns opaque [r,g,b] or null
  const effBg = (el) => {
    let acc = null;
    for (let n = el; n && n !== document.body.parentElement; n = n.parentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (!c) continue;
      if (c[3] === 1) return acc ? composite(acc, c) : c;
      acc = acc ? composite(acc, c) : c;
    }
    return acc || [255, 255, 255, 1];
  };
  const seen = new Set();
  document.querySelectorAll('body *').forEach((el) => {
    if (['SCRIPT', 'STYLE', 'CANVAS', 'SVG', 'svg', 'path'].includes(el.tagName)) return;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || !vis(el)) return;
    const s = getComputedStyle(el);
    const fg = parseColor(s.color);
    if (!fg) return;
    const bg = effBg(el);
    const r = Math.round(ratio(fg, bg) * 100) / 100;
    const fs = parseFloat(s.fontSize);
    const large = fs >= 24 || (fs >= 18.67 && (parseInt(s.fontWeight, 10) >= 700 || s.fontWeight === 'bold'));
    const need = large ? 3 : 4.5;
    if (r < need) {
      const key = `${r}|${(el.innerText || '').trim().slice(0, 40)}|${s.color}|${bg}`;
      if (seen.has(key)) return; seen.add(key);
      violations.push({ rule: 'color-contrast', severity: 'depends', target: describe(el), detail: `${r}:1 < ${need}:1 (${large ? 'large' : 'normal'} text) "${(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50)}" fg=${s.color} bg=rgb(${bg.slice(0, 3)})` });
    }
  });
  return violations;
}

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('console', (m) => { if (m.type() === 'error') console.error('[browser]', m.text().slice(0, 200)); });
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.evaluate(() => { try { sessionStorage.setItem('velocity.devNoLogin', '1'); } catch {} });
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForSelector('.slate-shell, canvas', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.evaluate((id) => { try { window.__useAppView?.getState?.()?.setApp?.(id); } catch {} }, 'map').catch(() => {});
await page.waitForTimeout(3000);

const violations = await page.evaluate(a11yCheck);
await browser.close();

const result = { url: BASE, surface: 'map', viewport: '1920x1080', violations };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
