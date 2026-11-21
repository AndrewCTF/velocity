// FMV layout probe: four layout states x 1366/1920/2560. Reports sampled points that hit the bare
// host (exposed background), pane rects (gutters), timeline x, toolbar overflow, and whether a
// right-click on pane 1 resolves to the header coordinate. Usage: node tools/perf/fmv_layout_probe.mjs <outDir>
import { chromium } from '../adsb-globe-feeder/node_modules/playwright/index.mjs';
const out = process.argv[2];
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', args: ['--use-gl=angle', '--use-angle=vulkan'] });
const probe = () => {
  const host = document.querySelector('.mfv');
  if (!host) return { err: 'no .mfv' };
  const r = host.getBoundingClientRect();
  let bare = 0, n = 0;
  for (let x = r.left + 4; x < r.right; x += 24)
    for (let y = r.top + 4; y < r.bottom; y += 24) {
      n++;
      if (document.elementFromPoint(x, y) === host) bare++;
    }
  const row = host.querySelector('.row2');
  const panes = [...host.querySelectorAll('.vids > .pane')].map((p) => p.getBoundingClientRect()).map((q) => [q.x, q.y, q.width, q.height].map(Math.round));
  const ftl = host.querySelector('.ftl')?.getBoundingClientRect();
  return { host: [r.x, r.y, r.width, r.height].map(Math.round), bareHostPoints: `${bare}/${n}`, rowOverflow: row.scrollWidth > row.clientWidth, panes, timelineX: ftl ? Math.round(ftl.x) : null };
};
for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => { localStorage.setItem('velocity.onboarded.v1', '1'); localStorage.setItem('velocity.aiSetupSeen', '1'); localStorage.setItem('velocity.openModeDismissed', '1'); sessionStorage.setItem('velocity.devNoLogin', '1'); });
  const p = await ctx.newPage();
  await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(8000);
  await p.evaluate(() => window.__useAppView.getState().setApp('video'));
  await p.waitForSelector('.mfv .pane', { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const click = async (sel) => { await p.locator(sel).first().click({ timeout: 3000 }).catch(() => {}); await p.waitForTimeout(800); };
  const states = [
    ['two-panel-tl', async () => {}],
    ['two-nopanel', async () => click('.row2 button[title="Telemetry"]')],
    ['single-nopanel-notl', async () => { await click('.row2 button[title="Single pane"]'); await click('.row2 button[title="Timeline"]'); }],
    ['single-panel', async () => { await click('.row2 button[title="Timeline"]'); await click('.row2 button[title="Telemetry"]'); }],
  ];
  for (const [name, act] of states) {
    await act();
    const m = await p.evaluate(probe);
    console.log(w, name.padEnd(20), JSON.stringify(m));
    if (w !== 1366 || name === 'two-panel-tl') await p.screenshot({ path: `${out}/${name}-${w}.png` });
  }
  // context-menu geometry: right-click the centre of the first pane
  await click('.row2 button[title="Map and video side by side"]');
  const c = await p.evaluate(() => { const q = document.querySelector('.vids > .pane .pv').getBoundingClientRect(); return [q.x + q.width / 2, q.y + q.height / 2]; });
  await p.mouse.click(c[0], c[1], { button: 'right' });
  await p.waitForTimeout(600);
  const geo = await p.evaluate(() => ({ menu: document.querySelector('.mfv .ctx button')?.textContent?.trim(), header: document.querySelector('.mfv .mhd span')?.textContent?.trim() }));
  console.log(w, 'ctx-geometry        ', JSON.stringify(geo));
  await ctx.close();
}
await b.close();
