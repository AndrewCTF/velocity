// Product recordings for the site: one short clip per carousel tab, per
// software row and per hero insert, shot from the running console.
//
// Same method as tools/film/shoot.js: the camera is a pure function of frame
// time and every frame is screenshotted and piped to ffmpeg, so the machine
// never has to keep up in real time and a slow GPU only makes the shoot slower,
// not worse. Runs on whatever GPU ANGLE/Vulkan finds (the AMD iGPU while the
// NVIDIA driver is mismatched), which is why it stays at 2560x1440 and never 4K.
//
//   node scripts/shoot-product.cjs --out DIR [--only air,rows.explorer] [--fps 24] [--test]
//
// Needs the API on :8000 and Vite on :5173 (DEV globals). No AI routes are
// touched: the console's AI calls are stubbed so loading it cannot warm a model.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes('--' + k);
const OUT = arg('out', path.join(__dirname, 'product'));
const FPS = parseInt(arg('fps', '24'), 10);
const ONLY = arg('only', '') ? arg('only').split(',') : null;
const TEST = has('test');
const W = 2560, H = 1440;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Every shot: what the console shows (app, basemap, layers, chrome) and where
// the camera looks at t=0 and t=end (interpolated, log range). Camera fields:
// lon, lat, range m, pitch deg, heading deg. Layers not listed are left alone
// except NOISE, which is switched off for every globe shot.
const NOISE = ['conflict.gdelt.live', 'news.gdelt.events', 'news.acled.events', 'intel.incidents.live'];
const SHOTS = {
  // carousel tabs, chrome kept: these are the product
  'tab-air':      { s: 8, imagery: '3d-sat', on: ['aviation.adsb.global'], cam: [[8, 47, 2_300_000, -58, -8], [11, 48.5, 2_050_000, -56, -2]] },
  'tab-maritime': { s: 8, imagery: '3d-sat', on: ['maritime.keyless', 'maritime.digitraffic'], settle: 18000, cam: [[1.6, 51.0, 230_000, -44, 8], [2.2, 51.3, 205_000, -42, 14]] },
  'tab-space':    { s: 8, imagery: '3d-sat', on: ['space.celestrak.starlink', 'space.celestrak.stations'], settle: 25000, cam: [[20, 10, 15_500_000, -72, 20], [44, 14, 14_500_000, -70, 34]] },
  'tab-hazards':  { s: 8, imagery: '3d-sat', on: ['hazards.usgs.quakes', 'hazards.nasa.firms', 'hazards.fireperimeters', 'hazards.volcanoes', 'hazards.gdacs'], settle: 18000, cam: [[-121, 37.5, 2_300_000, -66, -6], [-119.5, 38.5, 2_050_000, -64, 0]] },
  'tab-signals':  { s: 8, imagery: '3d-sat', on: ['env.jamming.nacp', 'aviation.adsb.global'], settle: 18000, cam: [[33, 44, 2_600_000, -60, -10], [36, 45.5, 2_300_000, -58, -4]] },
  'tab-infra':    { s: 8, imagery: '3d-sat', on: ['places.bases', 'places.ports', 'infra.cables.lines', 'infra.cables.landings', 'maritime.chokepoints'], settle: 18000, cam: [[55.5, 26.2, 820_000, -50, -12], [56.3, 26.6, 740_000, -48, -6]] },
  'tab-archive':  { s: 8, imagery: '3d-sat', on: ['aviation.adsb.global'], replay: true, cam: [[6, 49, 2_000_000, -55, -4], [8, 50, 1_850_000, -54, 0]] },
  // software rows, chrome kept
  'row-explorer':   { s: 6, app: 'explorer', cam: [[8, 47, 2_300_000, -58, -8], [9, 47.5, 2_200_000, -58, -6]] },
  'row-workflows':  { s: 6, app: 'workflows' },
  'row-briefs':     { s: 6, app: 'reports' },
  'row-foundry':    { s: 6, app: 'foundry' },
  'row-satellites': { s: 6, imagery: '3d-sat', on: ['space.celestrak.stations', 'space.celestrak.gps', 'space.celestrak.visual'], settle: 25000, cam: [[-30, 30, 12_500_000, -78, 10], [-18, 32, 11_800_000, -76, 24]] },
  'row-layers':     { s: 6, imagery: '3d-sat', on: ['aviation.adsb.global', 'maritime.keyless'], cam: [[10, 50, 3_400_000, -64, 0], [12, 51, 3_100_000, -62, 4]] },
  // walkthrough: click a plane, get its dossier and track (selection fires 1 s in)
  'walk-select':    { s: 8, imagery: '3d-sat', on: ['aviation.adsb.global'], select: [5.0, 50.2], cam: [[5.0, 50.2, 760_000, -40, -3], [5.3, 50.1, 700_000, -39, -5]] },
  // hero inserts, chrome hidden, cropped later in the reel
  'hero-med':   { s: 3, hero: true, imagery: '3d-sat', on: ['aviation.adsb.global', 'maritime.keyless'], cam: [[16, 36, 4_200_000, -64, -14], [19, 37, 3_900_000, -63, -10]] },
  'hero-gulf':  { s: 3, hero: true, imagery: '3d-sat', on: ['aviation.adsb.global', 'maritime.keyless'], cam: [[52, 22, 4_200_000, -64, -14], [55, 23, 3_900_000, -62, -8]] },
  'hero-asia':  { s: 3, hero: true, imagery: '3d-sat', on: ['aviation.adsb.global', 'maritime.keyless'], cam: [[125, 30, 4_600_000, -66, 20], [128, 31, 4_300_000, -64, 24]] },
  'hero-orbit': { s: 3, hero: true, imagery: '3d-sat', on: ['space.celestrak.starlink'], cam: [[-40, 20, 26_000_000, -74, 30], [-30, 22, 25_000_000, -72, 36]] },
};

(async () => {
  const browser = await chromium.launch({
    headless: true, executablePath: '/usr/bin/google-chrome-stable',
    args: ['--headless=new', '--enable-gpu', '--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist',
      '--enable-features=Vulkan', '--hide-scrollbars', '--force-gpu-mem-available-mb=4096'],
  });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('velocity.onboarded.v1', '1'); localStorage.removeItem('velocity.appView'); } catch (e) {} });
  await page.route('**/api/ai/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer && window.__viewer.scene.primitives.length > 3, null, { timeout: 180000 });
  const renderer = await page.evaluate(() => {
    const gl = window.__viewer.canvas.getContext('webgl2') || window.__viewer.canvas.getContext('webgl');
    try { return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL); } catch (e) { return 'unknown'; }
  });
  log('renderer:', renderer);
  if (/swiftshader|llvmpipe|software/i.test(renderer)) throw new Error('software GL: ' + renderer);
  log('warming feeds'); await sleep(TEST ? 6000 : 20000);

  await page.evaluate(() => {
    const V = window.__viewer, scene = V.scene;
    scene.globe.dynamicAtmosphereLighting = true;
    scene.fog.enabled = true;
    const credits = document.querySelector('.cesium-widget-credits'); if (credits) credits.style.display = 'none';
    // chrome hide, borrowed from tools/film/director.js __filmHero
    let hidden = null, stash = {};
    const el = V.canvas.closest('.cesium-viewer') || V.container;
    window.__hero = (on) => {
      if (on && !hidden) {
        hidden = []; let e = V.canvas;
        while (e && e !== document.body) { const p = e.parentElement; if (!p) break;
          for (const sib of p.children) if (sib !== e) { hidden.push([sib, sib.style.visibility]); sib.style.visibility = 'hidden'; }
          e = p; }
        stash = { pos: el.style.position, z: el.style.zIndex };
        Object.assign(el.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '2147482000' });
      } else if (!on && hidden) {
        for (const [s, v] of hidden) s.style.visibility = v; hidden = null;
        Object.assign(el.style, { position: stash.pos || '', inset: '', width: '', height: '', zIndex: stash.z || '' });
      }
      scene.globe.enableLighting = !!on;
      requestAnimationFrame(() => { V.resize(); scene.requestRender(); });
    };
    window.__cam = (c) => {
      const C = window.__Cesium;
      if (!(el.clientWidth > 8 && el.clientHeight > 8)) return;
      V.camera.lookAt(C.Cartesian3.fromDegrees(c[0], c[1]), new C.HeadingPitchRange(C.Math.toRadians(c[4]), C.Math.toRadians(c[3]), c[2]));
      V.camera.lookAtTransform(C.Matrix4.IDENTITY);
      scene.requestRender();
    };
  });

  const names = Object.keys(SHOTS).filter((n) => !ONLY || ONLY.includes(n));
  for (const name of names) {
    const sh = SHOTS[name];
    const secs = TEST ? 1 : sh.s;
    log('shot', name);
    // state
    await page.evaluate(({ sh, NOISE }) => {
      const R = window.__registry;
      window.__useAppView.getState().setApp(sh.app || 'map');
      if (sh.imagery) window.__useImagery.getState().setMode(sh.imagery);
      for (const id of NOISE) { try { R.disable(id); } catch (e) {} }
      for (const id of sh.on || []) { try { R.enable(id); } catch (e) {} }
      window.__hero(!!sh.hero);
      // Dev-box notices (auth breadth, keyless compute toast) are operator
      // config, not product: hide the smallest element carrying each.
      // Only short leaf-ish nodes: walking up from #root once hid the whole app.
      for (const el of document.querySelectorAll('body *')) {
        const t = (el.textContent || '').trim();
        if (t.length > 400 || !/OpenSky authenticated breadth|Compute\/LLM endpoints/.test(t)) continue;
        let p = el;
        while (p.parentElement && p.parentElement !== document.body && (p.parentElement.textContent || '').trim().length < 400) p = p.parentElement;
        p.style.visibility = 'hidden';
      }
    }, { sh, NOISE });
    if (sh.replay) {
      await page.locator('button[aria-label="Rewind"]').first().click({ timeout: 15000 }).catch((e) => log('replay btn', e.message.split('\n')[0]));
      await sleep(2500);
      await page.locator('button[aria-label="Jump to window start"]').first().click().catch(() => {});
      await sleep(1000);
      const play = page.locator('button[aria-label="Play"]'); if (await play.count()) await play.first().click();
    }
    if (sh.cam) await page.evaluate((c) => window.__cam(c), sh.cam[0]);
    await sleep(TEST ? 3000 : (sh.settle || (sh.app && !sh.cam ? 5000 : 9000))); // tiles + layers settle

    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      '-vf', 'noise=alls=2:allf=t', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      path.join(OUT, name + '.mp4')]);
    ff.stderr.on('data', (d) => process.stderr.write(d));
    const write = (buf) => new Promise((res) => { ff.stdin.write(buf) ? res() : ff.stdin.once('drain', res); });
    const total = secs * FPS, t0 = Date.now();
    for (let i = 0; i < total; i++) {
      const p = i / Math.max(1, total - 1), e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      if (sh.cam) {
        const [a, b] = sh.cam;
        const L = (u, v) => u + (v - u) * e;
        await page.evaluate((c) => window.__cam(c), [L(a[0], b[0]), L(a[1], b[1]), Math.exp(L(Math.log(a[2]), Math.log(b[2]))), L(a[3], b[3]), L(a[4], b[4])]);
      }
      if (sh.select && i === FPS) {
        const picked = await page.evaluate(async ([lon, lat]) => {
          const r = await (await fetch('/api/adsb/global')).json();
          const d2 = (f) => (f.geometry.coordinates[0] - lon) ** 2 + (f.geometry.coordinates[1] - lat) ** 2;
          const eu = r.features.filter((f) => f.geometry && String(f.id).startsWith('aircraft:') && f.properties.callsign && d2(f) < 4).sort((a, b) => d2(a) - d2(b));
          if (eu.length) window.__useSelection.getState().select(eu[0].id);
          return eu.length ? eu[0].properties.callsign : 'NONE';
        }, sh.select);
        log('  selected', picked);
      }
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await sleep(30);
      if (i % 24 === 0) {
        const dead = await page.evaluate(() => { const p = document.querySelector('.cesium-widget-errorPanel'); return p && p.offsetParent !== null ? (p.textContent || '').slice(0, 160) : null; });
        if (dead) throw new Error(`Cesium stopped at ${name} frame ${i}: ${dead}`);
      }
      await write(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
    }
    ff.stdin.end(); await new Promise((r) => ff.on('close', r));
    log(`  ${total} frames, ${((Date.now() - t0) / 1000 / total).toFixed(2)} s/frame -> ${name}.mp4`);
    if (sh.replay) { const e = page.getByRole('button', { name: /^exit$/i }); if (await e.count()) await e.first().click(); await sleep(1500); }
    await page.evaluate((ids) => { for (const id of ids) { try { window.__registry.disable(id); } catch (e) {} } window.__hero(false); }, sh.on || []);
  }
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
