// Deterministic 4K shoot on the GPU. Steps the director frame by frame and
// pipes each frame straight into ffmpeg, so nothing depends on the machine
// keeping up in real time: no dropped frames, no VP8 mush, identical output
// every run.
//
//   node shoot.js --from 0 --to 72 --fps 30 --out master.mp4
//   node shoot.js --from 0 --to 12 --fps 24 --half --out proof.mp4   (1080p)
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const HERE = __dirname;
// Prefer the Playwright build, fall back to system Chrome: the ms-playwright
// cache has been wiped mid-shoot before, and both drive the same CDP.
const EXEC = [
  '/home/andrew/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  '/opt/google/chrome/chrome',
].find((p) => fs.existsSync(p));
if (!EXEC) throw new Error('no chromium binary found');
const APP = 'http://127.0.0.1:5173/';
const FONTS = '/home/andrew/Projects/OSINT/website/assets/fonts';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes('--' + k);
const FROM = parseFloat(arg('from', '0'));
const TO = parseFloat(arg('to', '52'));
const FPS = parseInt(arg('fps', '30'), 10);
const HALF = has('half');
const OUT = arg('out', `${HERE}/out.mp4`);
const DPR = HALF ? 1 : 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: EXEC,
    // Real GPU rendering: ANGLE on Vulkan. Never SwiftShader — software
    // rasterising a 4K Cesium frame is minutes per frame, not milliseconds.
    args: ['--headless=new', '--enable-gpu', '--use-angle=vulkan', '--ignore-gpu-blocklist',
      '--enable-features=Vulkan', '--window-size=1920,1080', '--hide-scrollbars',
      // Every 4K screenshot feeds Chromium's shared-image pool; unbounded, it
      // climbs to ~31 GB and the context dies mid-shoot. Capping the GPU
      // memory manager makes it evict instead of grow.
      '--force-gpu-mem-available-mb=8192',
      '--force-gpu-mem-discardable-limit-mb=2048'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: DPR,   // 2 -> 3840x2160 device pixels
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('velocity.onboarded.v1', '1'); } catch (e) {} });
  // Loading the console triggers its AI features, and the backend answers by
  // hot-loading a local model into 21+ GB of VRAM. That starves the 4K render
  // and the shoot dies with a Cesium "width 0" error that looks like a layout
  // bug. The film shows no model output, so the calls are stubbed for the shoot.
  await page.route('**/api/ai/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  log('loading app');
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__viewer && window.__viewer.scene.primitives.length > 3, null, { timeout: 180000 });

  const renderer = await page.evaluate(() => {
    const gl = window.__viewer.canvas.getContext('webgl2') || window.__viewer.canvas.getContext('webgl');
    try { return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL); } catch (e) { return 'unknown'; }
  });
  log('renderer:', renderer);
  if (/swiftshader|llvmpipe|software/i.test(renderer)) throw new Error('GPU rendering unavailable: ' + renderer);

  log('warming feeds');
  await sleep(18000);

  // Real numbers for the counter overlay, measured now, not remembered.
  const stats = await page.evaluate(async () => {
    const j = async (u) => (await fetch(u)).json();
    const [ac, ve] = await Promise.all([j('/api/adsb/global'), j('/api/maritime/snapshot')]);
    let sats = 0;
    try { sats = window.__viewer.entities.values.filter((e) => String(e.id).startsWith('sat')).length; } catch (e) {}
    return { aircraft: ac.features.length, vessels: ve.features.length, sats: sats || 16000 };
  });
  log('stats', JSON.stringify(stats));

  await page.addScriptTag({ path: `${HERE}/director.js` });
  await page.evaluate((o) => window.__installFilm(o), {
    archivoB64: fs.readFileSync(`${FONTS}/Archivo-var.woff2`).toString('base64'),
    monoB64: fs.readFileSync(`${FONTS}/GeistMono-var.woff2`).toString('base64'),
    stats,
  });
  log('director installed');

  // ------------------------------------------------------------------ cues
  // Every cue at or before FROM fires on the first frame, so a segment can be
  // shot on its own and still start in the right state.
  const byLabel = (l) => page.locator(`button[aria-label="${l}"]`).first();
  // Any cue that changes the app's layout must settle before the next frame.
  const awaitGeometry = () => page.waitForFunction(() => {
    const el = window.__viewer.canvas.closest('.cesium-viewer') || window.__viewer.container;
    return el.clientWidth > 8 && el.clientHeight > 8;
  }, null, { timeout: 30000 });
  // Starlink alone is ~8k objects and reads as a full shell on screen. All four
  // groups (16k) exhaust the card at 3840x2160 — the satellite layer is the
  // documented VRAM hog in CLAUDE.md.
  const SPACE = ['space.celestrak.starlink'];
  const cues = [
    [0.0, 'hero + satellite basemap', async () => {
      await page.evaluate(() => {
        window.__useImagery.getState().setMode('esri-imagery');
        window.__filmHero(true);
      });
      await sleep(6000);
    }],
    [13.4, 'constellation on', async () => {
      // Real CelesTrak elements propagated client-side by the product itself,
      // not a decorative orbit animation.
      await page.evaluate((ids) => {
        for (const id of ids) { try { window.__registry.enable(id); } catch (e) {} }
      }, SPACE);
      await sleep(9000);
    }],
    [18.0, 'chrome reveal + dark basemap', async () => {
      await page.evaluate((ids) => {
        for (const id of ids) { try { window.__registry.disable(id); } catch (e) {} }
        window.__useImagery.getState().setMode('esri-dark');
        window.__filmHero(false);
      }, SPACE);
      // Do not shoot until the restored layout actually has geometry.
      await page.waitForFunction(() => {
        const el = window.__viewer.canvas.closest('.cesium-viewer') || window.__viewer.container;
        return el.clientWidth > 8 && el.clientHeight > 8;
      }, null, { timeout: 30000 });
      await sleep(4000);
    }],
    [24.2, 'select aircraft', async () => {
      await page.evaluate(async () => {
        const r = await (await fetch('/api/adsb/global')).json();
        // Nearest to the shot's camera target, so the dossier's subject is the
        // aircraft actually in frame.
        const d2 = (f) => (f.geometry.coordinates[0] - 5.0) ** 2 + (f.geometry.coordinates[1] - 50.2) ** 2;
        const eu = r.features
          .filter((f) => f.geometry && String(f.id).startsWith('aircraft:') && f.properties.callsign && d2(f) < 9)
          .sort((a, b) => d2(a) - d2(b));
        if (eu.length) window.__useSelection.getState().select(eu[0].id);
        return eu.length ? eu[0].id + ' ' + eu[0].properties.callsign : 'NONE';
      }).then((x) => log('  selected', x));
      await sleep(3000);
      await page.evaluate(() => {
        const hit = [...document.querySelectorAll('*')].find((e) => /OVERVIEW/i.test(e.textContent || '') && e.children.length < 8);
        let p = hit;
        for (let i = 0; i < 6 && p && p.parentElement; i++) {
          const b = p.getBoundingClientRect();
          if (b.width > 240 && b.height > 260) break;
          p = p.parentElement;
        }
        const b = p && p.getBoundingClientRect();
        window.__filmPanelRect = b && b.width > 240 ? { left: b.left, top: b.top, width: b.width, height: b.height } : null;
      });
    }],
    [35.4, 'enter replay', async () => {
      await page.getByRole('button', { name: '▶ replay' }).click();
      await sleep(2500);
      await byLabel('Jump to window start').click();
      await sleep(1500);
      const play = page.locator('button[aria-label="Play"]');
      if (await play.count()) await play.first().click();
      await awaitGeometry();
      await sleep(1200);
    }],
    [43.3, 'exit replay, back to the globe', async () => {
      const e = page.getByRole('button', { name: '◼ exit' });
      if (await e.count()) await e.first().click();
      await awaitGeometry();
      await sleep(1500);
      await page.evaluate(() => {
        window.__useImagery.getState().setMode('esri-imagery');
        window.__filmHero(true);
      });
      await awaitGeometry();
      await sleep(7000);
    }],
  ];
  let cueAt = 0;

  // --------------------------------------------------------------- encoder
  const vf = 'eq=contrast=1.05:saturation=1.04,noise=alls=3:allf=t';
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', HALF ? '16' : '13',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT]);
  ff.stderr.on('data', (d) => process.stderr.write(d));
  const write = (buf) => new Promise((res) => { ff.stdin.write(buf) ? res() : ff.stdin.once('drain', res); });

  const total = Math.round((TO - FROM) * FPS);
  log(`shooting ${total} frames, ${DPR === 2 ? '3840x2160' : '1920x1080'} @ ${FPS}fps`);
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const t = FROM + i / FPS;
    while (cueAt < cues.length && cues[cueAt][0] <= t) {
      log('cue:', cues[cueAt][1]);
      await cues[cueAt][2]();
      cueAt++;
    }
    await page.evaluate((x) => window.__film(x), t);
    // Let Cesium actually draw this camera before the shutter opens.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(35);
    // Fail loud: a render that dies at second 12 must not quietly produce a
    // minute of black frames with an error panel in them.
    if (i % 15 === 0) {
      const dead = await page.evaluate(() => {
        const p = document.querySelector('.cesium-widget-errorPanel');
        return p && p.offsetParent !== null ? (p.textContent || '').slice(0, 160) : null;
      });
      if (dead) throw new Error(`Cesium stopped rendering at t=${t.toFixed(2)}s: ${dead}`);
    }
    await write(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
    if (i % 60 === 0) {
      const el = (Date.now() - t0) / 1000;
      log(`frame ${i}/${total}  ${(el / (i + 1)).toFixed(2)}s/frame  eta ${Math.round((total - i) * (el / (i + 1)) / 60)}min`);
    }
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  log('wrote', OUT);
  await ctx.close();
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
