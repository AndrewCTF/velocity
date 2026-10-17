// Per surface: screenshot + clipping/readability metrics measured from the DOM.
//   node tools/perf/ui_clip_sweep.mjs [width] [height]   (dev server on :5173)
// Phone grade (one surface, exits 1 on a failed threshold, no app sweep):
//   node tools/perf/ui_clip_sweep.mjs --device "Pixel 7" [--route /2d]
//        [--first-visit] [--chrome-arg=--disable-3d-apis] [--cpu-throttle 4]
//        [--checks layout,perf,data] --grade
// checks: layout = map share / right edge / tap targets / dialogs (default);
// perf = worst long task after the first 10 s < 300 ms (use --cpu-throttle);
// data = no /ws/adsb socket and every aircraft request carries a bbox.
// Limits: no scrolling, no hover states; the ancestor check stops at the first
// non-visible-overflow ancestor. belowFold counts content outside the viewport,
// which includes scrolled list rows and is NOT a clipping defect.
import { chromium, devices } from '../adsb-globe-feeder/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const DEVICE = opt('device');
const ROUTE = opt('route') || '/';
const FIRST_VISIT = argv.includes('--first-visit');
const GRADE = argv.includes('--grade');
const CPU_THROTTLE = +(opt('cpu-throttle') || 1);
const CHECKS = new Set((opt('checks') || 'layout').split(','));
const CHROME_ARGS = argv.filter((a) => a.startsWith('--chrome-arg=')).map((a) => a.slice('--chrome-arg='.length));
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--device', '--route', '--cpu-throttle', '--checks'].includes(argv[i - 1])));

const OUT = process.env.OUT || 'scratchpad/sweep';
fs.mkdirSync(OUT, { recursive: true });
const W = +(pos[0] || 1920), H = +(pos[1] || 1080);
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', ...CHROME_ARGS],
});
if (DEVICE && !devices[DEVICE]) { console.error(`unknown Playwright device "${DEVICE}"`); process.exit(2); }
const ctx = await browser.newContext(DEVICE ? { ...devices[DEVICE] } : { viewport: { width: W, height: H } });
if (!FIRST_VISIT) {
  await ctx.addInitScript(() => {
    localStorage.setItem('velocity.onboarded.v1', '1');
    localStorage.setItem('velocity.aiSetupSeen', '1');
    localStorage.setItem('velocity.openModeDismissed', '1');
  });
}
await ctx.addInitScript(() => {
  window.__lt = [];
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true }); } catch { /* no longtask API */ }
});
const page = await ctx.newPage();
const sockets = [], aircraftReqs = [];
page.on('websocket', (ws) => sockets.push(ws.url()));
page.on('request', (r) => { if (/\/api\/adsb\/(global|fi\/global)/.test(r.url())) aircraftReqs.push(r.url()); });
if (CPU_THROTTLE > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
await page.goto(`${process.env.BASE_URL || 'http://localhost:5173'}${ROUTE}`, { waitUntil: GRADE ? 'domcontentloaded' : 'networkidle', timeout: 90000 });
await page.waitForTimeout(GRADE ? 25000 : 12000);

if (GRADE) {
  // Phone thresholds from the 2026-10-17 plan (baseline then: map 23%, 77 past
  // the right edge, 276 controls under 24 px, two blocking dialogs on first visit).
  const g = await page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const vis = (e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < vh && b.left < vw && b.right > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const lbl = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 30);
    const controls = [...document.querySelectorAll('button,a[href],[role=button],input,select,[role=tab],[role=menuitem],[role=switch],[role=radio],[role=checkbox]')].filter(vis);
    const box = (e) => e.getBoundingClientRect();
    const under24 = controls.filter((e) => box(e).width < 24 || box(e).height < 24);
    const nav = controls.filter((e) => e.closest('nav,[role=navigation],[data-primary-nav]'));
    const navUnder44 = nav.filter((e) => box(e).width < 44 || box(e).height < 44);
    const pastRight = [...document.querySelectorAll('body *')].filter((e) => { const b = box(e); return b.width > 0 && b.height > 0 && b.right > vw + 2; });
    const cvs = [...document.querySelectorAll('canvas')].filter(vis).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const cb = cvs && box(cvs);
    const mapPct = cb ? Math.round(100 * Math.max(0, Math.min(cb.bottom, vh) - Math.max(cb.top, 0)) * Math.max(0, Math.min(cb.right, vw) - Math.max(cb.left, 0)) / (vw * vh)) : 0;
    const dialog = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(vis).map(lbl)[0] || null;
    return { vw, vh, mapPct, pastRight: pastRight.length, pastRightSamples: pastRight.slice(0, 5).map(lbl), controls: controls.length,
      under24: under24.length, under24Samples: under24.slice(0, 8).map((e) => `${lbl(e)} ${Math.round(box(e).width)}x${Math.round(box(e).height)}`),
      navControls: nav.length, navUnder44: navUnder44.length, dialog,
      worstLongTaskAfter10s: Math.round(Math.max(0, ...window.__lt.filter(([t]) => t > 10000).map(([, d]) => d))),
      longTaskMsTotal: Math.round(window.__lt.reduce((a, [, d]) => a + d, 0)) };
  });
  g.cpuThrottle = CPU_THROTTLE;
  g.adsbSockets = sockets.filter((u) => u.includes('/ws/adsb')).length;
  g.aircraftRequests = aircraftReqs.length;
  g.aircraftRequestsWithoutBbox = aircraftReqs.filter((u) => !/lamin=/.test(u)).length;
  const fails = [];
  if (CHECKS.has('layout')) {
    if (g.mapPct < 70) fails.push(`map ${g.mapPct}% of screen (< 70%)`);
    if (g.pastRight > 0) fails.push(`${g.pastRight} elements past the right edge`);
    if (g.under24 > 0) fails.push(`${g.under24} controls under 24 px`);
    if (g.navUnder44 > 0) fails.push(`${g.navUnder44} primary-nav controls under 44 px`);
    if (g.navControls === 0) fails.push('no primary nav found (nav / [data-primary-nav])');
    if (g.dialog) fails.push(`blocking dialog: ${g.dialog}`);
  }
  if (CHECKS.has('perf') && g.worstLongTaskAfter10s >= 300) fails.push(`worst long task after 10 s ${g.worstLongTaskAfter10s} ms (>= 300) at ${CPU_THROTTLE}x CPU`);
  if (CHECKS.has('data')) {
    if (g.adsbSockets > 0) fails.push(`${g.adsbSockets} /ws/adsb socket(s) opened`);
    if (g.aircraftRequestsWithoutBbox > 0) fails.push(`${g.aircraftRequestsWithoutBbox} of ${g.aircraftRequests} aircraft requests without a bbox`);
  }
  fs.writeFileSync(`${OUT}/phone-grade.json`, JSON.stringify({ device: DEVICE || `${W}x${H}`, route: ROUTE, firstVisit: FIRST_VISIT, ...g, fails }, null, 1));
  await page.screenshot({ path: `${OUT}/phone-grade.png` });
  console.log(JSON.stringify({ device: DEVICE || `${W}x${H}`, route: ROUTE, ...g }));
  console.log(fails.length ? `FAIL\n- ${fails.join('\n- ')}` : 'PASS');
  await browser.close();
  process.exit(fails.length ? 1 : 0);
}

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
