// Per surface: screenshot + clipping/readability metrics measured from the DOM.
//   node tools/perf/ui_clip_sweep.mjs [width] [height]   (dev server on :5173)
// Limits: no scrolling, no hover states; the ancestor check stops at the first
// non-visible-overflow ancestor. belowFold counts content outside the viewport,
// which includes scrolled list rows and is NOT a clipping defect.
import { chromium } from '../adsb-globe-feeder/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const OUT = process.env.OUT || 'scratchpad/sweep';
fs.mkdirSync(OUT, { recursive: true });
const W = +(process.argv[2] || 1920), H = +(process.argv[3] || 1080);
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
await ctx.addInitScript(() => {
  localStorage.setItem('velocity.onboarded.v1', '1');
  localStorage.setItem('velocity.aiSetupSeen', '1');
  localStorage.setItem('velocity.openModeDismissed', '1');
});
const page = await ctx.newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(12000);

function measure() {
  const out = { truncated: [], overflowing: [], tiny: 0, tinySamples: [], offscreen: [], overlaps: 0, overlapSamples: [], textNodes: 0, chars: 0 };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const label = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70);
  const path = (el) => { const p = []; for (let e = el; e && p.length < 3; e = e.parentElement) p.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '')); return p.join('<'); };
  const leaves = [];
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'CANVAS', 'SVG', 'svg', 'path'].includes(el.tagName)) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || !vis(el)) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const t = label(el);
    out.textNodes++; out.chars += t.length;
    leaves.push({ el, r, t });
    const fs = parseFloat(s.fontSize);
    if (fs < 11) { out.tiny++; if (out.tinySamples.length < 12) out.tinySamples.push(`${fs}px "${t.slice(0, 40)}"`); }
    // clipped horizontally or vertically inside its own box
    const clipX = el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible' && s.overflowX !== 'auto' && s.overflowX !== 'scroll';
    const clipY = el.scrollHeight > el.clientHeight + 2 && (s.overflowY === 'hidden' || s.overflowY === 'clip') && el.clientHeight > 0;
    if (clipX || clipY || s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) out.truncated.push(`${clipX ? 'X' : ''}${clipY ? 'Y' : ''} ${el.scrollWidth}/${el.clientWidth} "${t}" ${path(el)}`);
    // clipped by an ancestor
    for (let a = el.parentElement, d = 0; a && d < 6; a = a.parentElement, d++) {
      const as = getComputedStyle(a);
      if (as.overflow === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (r.right > ar.right + 2 || r.bottom > ar.bottom + 2 && as.overflowY !== 'auto' && as.overflowY !== 'scroll' || r.left < ar.left - 2) {
        if (as.overflowX === 'auto' || as.overflowX === 'scroll') break;
        out.overflowing.push(`"${t}" exceeds ${a.tagName.toLowerCase()} by ${Math.round(Math.max(r.right - ar.right, r.bottom - ar.bottom, ar.left - r.left))}px`);
      }
      break;
    }
    if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1) out.offscreen.push(`"${t.slice(0, 40)}" @${Math.round(r.left)},${Math.round(r.top)}`);
  }
  // overlapping text leaves (not ancestors of each other)
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length && j < i + 60; j++) {
    const a = leaves[i], b = leaves[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (ix > 4 && iy > 4) { out.overlaps++; if (out.overlapSamples.length < 8) out.overlapSamples.push(`"${a.t.slice(0, 30)}" x "${b.t.slice(0, 30)}"`); }
  }
  out.truncated = [...new Set(out.truncated)]; out.overflowing = [...new Set(out.overflowing)];
  return out;
}

const results = {};
async function snap(name) {
  await page.screenshot({ path: `${OUT}/${W}-${name}.png` });
  const m = await page.evaluate(measure);
  results[name] = m;
  console.log(`${name.padEnd(22)} text=${m.textNodes} chars=${m.chars} trunc=${m.truncated.length} ancestorClip=${m.overflowing.length} tiny<11px=${m.tiny} belowFold=${m.offscreen.length} overlaps=${m.overlaps}`);
}

await snap('map-default');
for (const panel of ['Layers', 'Find', 'Histogram', 'Info']) {
  const tab = page.locator('button', { hasText: new RegExp(`^${panel}\\d*$`) }).first();
  if (await tab.count().catch(() => 0)) { await tab.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(2500); await snap('panel-' + panel); }
}
// select a live aircraft
const picked = await page.evaluate(() => {
  const v = window.__viewer; if (!v) return null;
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i); const ents = ds.entities.values;
    if (/aircraft|adsb/i.test(ds.name) && ents.length) { const id = ents[Math.floor(ents.length / 2)].id; window.__useSelection.getState().select(id); return ds.name + ':' + id; }
  }
  return 'none:' + [...Array(v.dataSources.length)].map((_, i) => v.dataSources.get(i).name).join(',');
});
console.log('selected', picked);
await page.waitForTimeout(6000);
await snap('map-selected-aircraft');
const APPS = ['ai', 'explorer', 'graph', 'investigate', 'targeting', 'video', 'sim', 'reports', 'foundry', 'workflows', 'city', 'country', 'markets'];
for (const app of APPS) {
  await page.evaluate((id) => window.__useAppView.getState().setApp(id), app);
  await page.waitForTimeout(5000);
  await snap('app-' + app);
}
fs.writeFileSync(`${OUT}/metrics-${W}.json`, JSON.stringify(results, null, 1));
await browser.close();
