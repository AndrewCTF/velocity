#!/usr/bin/env node
// Re-record the README hero GIF: the live world, a fly-in to Europe, an
// aircraft selected with its owned track, then the last hour rewound on the
// replay dock. One take against live feeds, same beats as the caption claims.
//
//   bash scripts/run-api.sh                 # :8000
//   pnpm --dir apps/web dev:poll            # :5173
//   node scripts/record-hero-gif.mjs [--out docs/media/hero-replay.gif]
//
// Frames are grabbed on a fixed interval and encoded by ffmpeg with a per-clip
// palette (a 256-colour global palette is what keeps a dark globe from banding
// into mud). Headless software raster: the CONTENT is real, the frame rate is
// the capture cadence, not the app's.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'tools/adsb-globe-feeder/index.js'));
const { chromium } = require('playwright');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const out = join(root, String(arg('out', 'docs/media/hero-replay.gif')));
const FPS = 8;
const W = 1600;
const H = 900;

const frames = mkdtempSync(join(tmpdir(), 'hero-gif-'));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable',
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.addInitScript(() => {
  localStorage.setItem('velocity.onboarded.v1', '1');
  localStorage.setItem('velocity.onboarding.v1', '1');
  localStorage.setItem('velocity.lowEndDismissed', '1');
  localStorage.setItem('velocity.degradedDismissed', '1');
  localStorage.setItem('velocity.openModeDismissed', '1');
});
await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__viewer), null, { timeout: 90_000 });

let n = 0;
/** Grab `count` frames at the capture cadence, running `during` alongside. */
async function record(count) {
  for (let i = 0; i < count; i++) {
    await page.screenshot({ path: join(frames, `f${String(n++).padStart(4, '0')}.png`) });
    await page.waitForTimeout(1000 / FPS);
  }
}

const setView = (lon, lat, h) =>
  page.evaluate(
    (v) =>
      window.__viewer.camera.setView({
        destination: window.__Cesium.Cartesian3.fromDegrees(v[0], v[1], v[2]),
      }),
    [lon, lat, h],
  );

// 1. The live world.
await setView(15, 20, 24_000_000);
await page.waitForTimeout(14_000); // let the world paint before the first frame
await record(16);

// 2. Fly in to Europe. flyTo, not setView: the movement IS the shot.
await page.evaluate(() =>
  window.__viewer.camera.flyTo({
    destination: window.__Cesium.Cartesian3.fromDegrees(10, 50, 4_000_000),
    duration: 3.5,
  }),
);
await record(36);

// 3. Select an aircraft with a real identity — an airframe whose dossier is all
//    em-dashes makes the panel look empty in the one frame people look at.
const id = await page.evaluate(() => {
  const C = window.__Cesium;
  const now = window.__viewer.clock.currentTime;
  const target = C.Cartesian3.fromDegrees(10, 50, 0);
  const ds = window.__viewer.dataSources;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < ds.length; i++) {
    const src = ds.get(i);
    if (!src.entities?.values) continue;
    for (const e of src.entities.values) {
      if (typeof e.id !== 'string' || !e.id.startsWith('aircraft:') || !e.position) continue;
      const pos = e.position.getValue ? e.position.getValue(now) : null;
      if (!pos) continue;
      const d = C.Cartesian3.distance(pos, target);
      if (d < bestDist) {
        bestDist = d;
        best = e.id;
      }
    }
  }
  return best;
});
if (id) await page.evaluate((i) => window.__useSelection.getState().select(i), id);
else console.error('WARN: no aircraft to select');
await record(28);

// 4. Rewind the hour: widen the dock, then seek to the head of the window.
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find(
    (x) => (x.textContent ?? '').trim() === '1h',
  );
  b?.click();
});
await page.waitForTimeout(1_500);
await page.evaluate(() => document.querySelector('button[title="Jump to start"]')?.click());
await record(32);

await browser.close();

execFileSync(
  'ffmpeg',
  [
    '-y',
    '-framerate', String(FPS),
    '-i', join(frames, 'f%04d.png'),
    '-filter_complex',
    `[0:v] fps=${FPS},scale=900:-1:flags=lanczos,split [a][b];[a] palettegen=max_colors=256 [p];[b][p] paletteuse=dither=bayer:bayer_scale=3`,
    '-loop', '0',
    out,
  ],
  { stdio: 'inherit' },
);
rmSync(frames, { recursive: true, force: true });
console.log(`saved ${out}`);
