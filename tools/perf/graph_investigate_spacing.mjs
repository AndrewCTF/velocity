// Spacing check for the Slate Graph and Investigate surfaces at 1920 and 2560.
// It covers empty states and states after a run (Lookup, a Sources lookup, an
// Extract preview, a seeded graph). Each control must sit on one metric:
//   - inputs, selects and bordered buttons are 28px tall and never wrap or clip
//   - neighbouring controls on one row are 8px apart
//   - content starts 12px in from the surface edge
// Exits 1 on any violation. Usage: node tools/perf/graph_investigate_spacing.mjs [outDir] [url]
import { chromium } from '../adsb-globe-feeder/node_modules/playwright/index.mjs';

const OUT = process.argv[2] || '/tmp/gi-spacing';
const URL = process.argv[3] || 'http://localhost:5173/';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', args: ['--use-gl=angle', '--use-angle=vulkan'] });

const measure = () => {
  const root = document.querySelector('.sl-form');
  if (!root) return { err: 'no .sl-form surface' };
  const R = root.getBoundingClientRect();
  const isCtl = (el) => {
    const t = el.tagName;
    if (t === 'SELECT') return true;
    if (t === 'INPUT') return !['checkbox', 'radio', 'range', 'hidden'].includes(el.type);
    if (t === 'BUTTON') { const cs = getComputedStyle(el); return parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'; }
    return false;
  };
  const ctls = [...root.querySelectorAll('input,select,button')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && isCtl(el) && r.bottom > R.top && r.top < R.bottom;
  });
  const bad = [];
  const name = (el) => (el.getAttribute('placeholder') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 24);
  for (const el of ctls) {
    const r = el.getBoundingClientRect();
    if (Math.round(r.height) !== 28) bad.push(`height ${Math.round(r.height)} != 28: ${name(el)}`);
    if (el.tagName === 'BUTTON' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) bad.push(`clipped/wrapped: ${name(el)}`);
  }
  // Row gaps: controls sharing a top edge, sorted by x, adjacent pairs.
  const rows = new Map();
  for (const el of ctls) { const r = el.getBoundingClientRect(); const k = Math.round(r.top); (rows.get(k) || rows.set(k, []).get(k)).push(r); }
  for (const rs of rows.values()) {
    rs.sort((a, c) => a.left - c.left);
    for (let i = 1; i < rs.length; i++) {
      const g = Math.round(rs[i].left - rs[i - 1].right);
      if (g >= 0 && g < 20 && g !== 8) bad.push(`row gap ${g} != 8 at y=${Math.round(rs[i].top - R.top)} x=${Math.round(rs[i].left - R.left)}`);
    }
  }
  // Content inset: the leftmost control or text line (tabs excluded; their
  // label is checked separately) sits 12px in. A gap wider than 20px between
  // two controls has a label in it and is not a control gap.
  const texts = [...root.querySelectorAll('p,span,div,label,li')].filter((el) => {
    if (el.closest('.k-ptab, svg')) return false;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const r = el.getBoundingClientRect();
    return own && r.width > 0 && r.height > 0 && r.bottom > R.top && r.top < R.bottom && getComputedStyle(el).visibility !== 'hidden';
  });
  const textLeft = (el) => {
    const n = [...el.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim());
    const rg = document.createRange(); rg.selectNodeContents(n);
    return rg.getBoundingClientRect().left;
  };
  const xs = [...ctls.map((el) => el.getBoundingClientRect().left), ...texts.map(textLeft)].map((x) => x - R.left);
  const inset = Math.round(Math.min(...xs));
  if (inset !== 12) bad.push(`content inset ${inset} != 12`);
  const tab = root.querySelector('.k-ptab');
  if (tab) { const label = tab.querySelector('span') || tab; const tx = Math.round(label.getBoundingClientRect().left - R.left); if (tx !== 12) bad.push(`tab label inset ${tx} != 12`); }
  return { controls: ctls.length, bad };
};

let failures = 0;
for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => { localStorage.setItem('velocity.onboarded.v1', '1'); localStorage.setItem('velocity.aiSetupSeen', '1'); localStorage.setItem('velocity.openModeDismissed', '1'); sessionStorage.setItem('velocity.devNoLogin', '1'); });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(8000);
  const app = async (id) => { await p.evaluate((a) => window.__useAppView.getState().setApp(a), id); await p.waitForTimeout(2500); };
  const tab = async (t) => { await p.locator('.sl-form .k-ptab', { hasText: t }).first().click(); await p.waitForTimeout(1500); };
  const check = async (state) => {
    const m = await p.evaluate(measure);
    const n = m.err ? 1 : m.bad.length;
    failures += n;
    console.log(`${w} ${state.padEnd(22)} ${m.err ?? `${m.controls} controls, ${n} violations`}`);
    for (const v of m.bad ?? []) console.log(`     ${v}`);
    await p.screenshot({ path: `${OUT}/${state}-${w}.png` });
  };
  await app('graph');
  await check('graph-empty');
  const seed = p.locator('.sl-form input[placeholder^="callsign"]').first();
  await seed.fill('Amsterdam'); await seed.press('Enter'); await p.waitForTimeout(5000);
  await check('graph-seeded');
  await app('investigate');
  await tab('Lookup');
  await check('inv-lookup');
  const target = p.locator('.sl-form input[placeholder^="example.com"]').first();
  await target.fill('example.com'); await target.press('Enter'); await p.waitForTimeout(20000);
  // A lookup seeds the link graph and opens Graph, so that is what gets checked.
  await check('graph-after-lookup');
  await app('investigate');
  await tab('Extract');
  await check('inv-extract');
  await p.locator('.sl-form textarea').first().fill('The vessel EVER GIVEN left Port Said for Rotterdam on 3 March.');
  await p.locator('.sl-form button', { hasText: 'Preview' }).first().click().catch(() => {});
  await p.waitForTimeout(8000);
  await check('inv-extract-preview');
  await app('investigate');
  await tab('Sources');
  await check('inv-sources');
  await p.locator('.sl-form button:visible', { hasText: 'Run' }).first().click();
  await p.waitForTimeout(10000);
  await check('inv-sources-ran');
  await ctx.close();
}
await b.close();
console.log(failures ? `${failures} violations` : 'all states on the metric');
process.exit(failures ? 1 : 0);
