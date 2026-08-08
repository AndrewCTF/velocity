#!/usr/bin/env node
// Re-shoot every still the README embeds, at 1440p, against the running dev
// server. One script rather than fourteen invocations, because the shots have
// to stay in step with each other: they are the same console photographed at
// different surfaces, and a set half-reshot after a redesign reads worse than
// one that is uniformly old.
//
//   bash scripts/run-api.sh                 # :8000, wait for it to warm
//   pnpm --dir apps/web dev:poll            # :5173  (DEV globals required)
//   node scripts/screenshot-readme.mjs [--only NAME] [--list]
//
// Headless software raster: this checks CONTENT and layout, never fps.
// executablePath is explicit — the ms-playwright cache on this box carries no
// chromium bundle, so a bare launch() fails with "Executable doesn't exist".
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'tools/adsb-globe-feeder/index.js'));
const { chromium } = require('playwright');

const MEDIA = join(root, 'docs/media');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable';

const WORLD = [15, 20, 24_000_000];
const EUROPE = [10, 50, 4_000_000];
const ATLANTIC = [-15, 45, 5_000_000];
const US = [-98, 39, 6_000_000];

/** Each shot names its file, the app it opens, the camera, and what it does
 *  before the shutter. `wait` is settle time after the actions. */
// NOT here: `ui-detach-toolbar.jpeg` (README §11, "tear the workspace apart").
// The detach control lives in ConsoleShell, which only the /2d route renders.
// The 3D console renders Console.tsx, which has no detach affordance at all, so
// there is nothing current to photograph — the figure in the README is the old
// shell. Restore detach to the 3D console, or rewrite §11; do not re-shoot this
// against /2d, which is a different console and reads as a different product.
const SHOTS = [
  {
    name: 'hero-world',
    out: 'hero-world.jpeg',
    view: WORLD,
    wait: 12_000,
  },
  {
    name: 'rail-layers',
    out: 'panels/rail-layers.jpeg',
    view: EUROPE,
    tab: 'Layers (1)',
    wait: 10_000,
  },
  {
    name: 'inspector-selection',
    out: 'panels/inspector-selection.jpeg',
    view: ATLANTIC,
    select: true,
    wait: 8_000,
  },
  {
    name: 'ui-explorer',
    out: 'ui-explorer.png',
    app: 'explorer',
    wait: 10_000,
  },
  {
    name: 'rail-chokepoints',
    out: 'panels/rail-chokepoints.jpeg',
    view: WORLD,
    tab: 'Info (4)',
    subTab: 'Chokepoints',
    layers: ['maritime.chokepoints'],
    wait: 10_000,
  },
  {
    name: 'places-airspace',
    out: 'places-airspace.jpeg',
    // Closer than the whole CONUS: airports and ports load per viewport, so at
    // 6,000 km both counted zero and the figure was TFR polygons alone.
    view: [-92, 32, 3_000_000],
    layers: ['airspace.tfr', 'places.airports', 'places.ports', 'aviation.sigmet'],
    wait: 16_000,
  },
  {
    name: 'hero-satellites',
    out: 'hero-satellites.jpeg',
    view: WORLD,
    layers: [
      'space.celestrak.stations',
      'space.celestrak.starlink',
      'space.celestrak.gps',
      'space.celestrak.visual',
    ],
    // SGP4 propagation is chunked and client-side; the constellation is not on
    // the globe the moment the layer flips on.
    wait: 45_000,
  },
  {
    name: 'rail-inbox',
    out: 'panels/rail-inbox.jpeg',
    view: EUROPE,
    click: 'button[title^="Inbox:"]',
    wait: 8_000,
  },
  {
    name: 'ui-briefs',
    out: 'ui-briefs.png',
    view: EUROPE,
    tab: 'Info (4)',
    subTab: 'Intel',
    // The incident brief fuses on request and renders "(loading…)" for a while.
    wait: 30_000,
  },
  {
    name: 'foundry-pipeline',
    out: 'foundry-pipeline-new.png',
    app: 'foundry',
    fv: 'pipeline',
    wait: 12_000,
  },
  {
    name: 'workflows-dag',
    out: 'workflows-dag.png',
    app: 'workflows',
    // The app opens on an empty canvas ("No blocks yet"); a DAG only draws once
    // a saved workflow is opened from the list.
    subTab: 'live-e2e-high-alt',
    wait: 12_000,
  },
  {
    name: 'replay-scrubber',
    out: 'replay-scrubber.jpeg',
    view: EUROPE,
    // "Rewind" sets the playback MULTIPLIER, it does not seek — clicking it
    // left the clock on live, the one state a replay figure must not be in.
    // "Jump to start" seeks to the head of the loaded window.
    rangeButton: '1h',
    click: 'button[title="Jump to start"]',
    wait: 14_000,
  },
];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

if (arg('list', false) === true) {
  for (const s of SHOTS) console.log(`${s.name.padEnd(22)} docs/media/${s.out}`);
  process.exit(0);
}

const only = arg('only', null);
const todo = only ? SHOTS.filter((s) => s.name === only) : SHOTS;
if (todo.length === 0) {
  console.error(`ERROR: no shot named ${only}. Try --list.`);
  process.exit(2);
}

mkdirSync(join(MEDIA, 'panels'), { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });

for (const shot of todo) {
  const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
  // Suppress every first-run overlay and standing banner. The tour dims and
  // blurs the whole app; the low-end, degraded-feed and open-mode banners each
  // eat two rows of chrome at the top of the window and are environment notes
  // about THIS box, not the product. All five are localStorage-dismissible.
  await page.addInitScript(() => {
    localStorage.setItem('velocity.onboarded.v1', '1');
    localStorage.setItem('velocity.onboarding.v1', '1');
    localStorage.setItem('velocity.lowEndDismissed', '1');
    localStorage.setItem('velocity.degradedDismissed', '1');
    localStorage.setItem('velocity.openModeDismissed', '1');
  });

  const url = new URL(`http://127.0.0.1:5173${shot.path ?? ''}`);
  if (shot.app) url.searchParams.set('app', shot.app);
  if (shot.fv) url.searchParams.set('fv', shot.fv);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  // The 2D shell is maplibre, not Cesium: it never publishes __viewer.
  if (!shot.noViewer) {
    await page.waitForFunction(() => Boolean(window.__viewer), null, { timeout: 90_000 });
  }

  if (shot.view) {
    await page.evaluate((v) => {
      window.__viewer.camera.setView({
        destination: window.__Cesium.Cartesian3.fromDegrees(v[0], v[1], v[2]),
      });
    }, shot.view);
  }

  if (shot.layers) {
    await page.evaluate((ids) => {
      for (const id of ids) window.__registry.enable(id);
    }, shot.layers);
  }

  // Feeds paint on a 1 s cadence; give them cycles before touching the DOM.
  await page.waitForTimeout(8_000);

  if (shot.tab) {
    // The live feed mutates the DOM every second, so Playwright's actionability
    // wait never settles here. A native el.click() still bubbles a MouseEvent
    // React's delegated handler catches.
    await page.evaluate((sel) => document.querySelector(sel)?.click(), `button[title="${shot.tab}"]`);
    await page.waitForTimeout(2_000);
  }

  if (shot.subTab) {
    // Info's four sections (Feeds, Chokepoints, ACARS, Intel) are buttons whose
    // whole text is the label. Match exactly: "Chokepoints" also appears inside
    // the Layers tree as "Chokepoint congestion".
    const hit = await page.evaluate((label) => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => (b.textContent ?? '').trim() === label,
      );
      btn?.click();
      return Boolean(btn);
    }, shot.subTab);
    if (!hit) console.error(`WARN ${shot.name}: no sub-tab button "${shot.subTab}"`);
    await page.waitForTimeout(2_500);
  }

  if (shot.click) {
    await page.evaluate((sel) => document.querySelector(sel)?.click(), shot.click);
    await page.waitForTimeout(2_500);
  }

  if (shot.select) {
    const id = await page.evaluate((v) => {
      const C = window.__Cesium;
      const now = window.__viewer.clock.currentTime;
      const target = C.Cartesian3.fromDegrees(v[0], v[1], 0);
      let best = null;
      let bestDist = Infinity;
      const ds = window.__viewer.dataSources;
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
    }, shot.view ?? EUROPE);
    if (id) {
      await page.evaluate((i) => window.__useSelection.getState().select(i), id);
      await page.waitForTimeout(6_000);
    } else {
      console.error(`WARN ${shot.name}: no aircraft near the view to select`);
    }
  }

  if (shot.detach) {
    // Through the store, not the button: the inspector's detach control is not
    // in the DOM at rest (it renders with the header on the docked panel), and
    // the left rail carries a button with the SAME title, which is what a
    // querySelector by title picked up while the inspector stayed docked.
    const hit = await page.evaluate(() => {
      const b = document.querySelector(
        'button[aria-label="Detach inspector into a floating window"]',
      );
      b?.click();
      return Boolean(b);
    });
    if (!hit) console.error(`WARN ${shot.name}: no detach control on the inspector`);
    await page.waitForTimeout(3_500);
    // Drag it clear of the rail so the figure shows a floating window, not one
    // parked where the docked panel already was.
    await page.evaluate(() =>
      window.__useFloatingPanels.getState().setRect('inspector', { x: 700, y: 220, w: 560, h: 760 }),
    );
    await page.waitForTimeout(2_000);
  }

  if (shot.scrollTo) {
    const found = await page.evaluate((needle) => {
      const els = Array.from(document.querySelectorAll('div,section,h2,h3,span'));
      const hit = els.find((e) => (e.textContent ?? '').toLowerCase().includes(needle));
      if (!hit) return false;
      hit.scrollIntoView({ block: 'center' });
      return true;
    }, shot.scrollTo);
    if (!found) console.error(`WARN ${shot.name}: nothing matching "${shot.scrollTo}" to scroll to`);
    await page.waitForTimeout(1_500);
  }

  if (shot.rangeButton) {
    const hit = await page.evaluate((label) => {
      const b = Array.from(document.querySelectorAll('button')).find(
        (x) => (x.textContent ?? '').trim() === label,
      );
      b?.click();
      return Boolean(b);
    }, shot.rangeButton);
    if (!hit) console.error(`WARN ${shot.name}: no range button "${shot.rangeButton}"`);
    await page.waitForTimeout(4_000);
  }



  await page.waitForTimeout(shot.wait ?? 8_000);

  const out = join(MEDIA, shot.out);
  const opts = out.endsWith('.jpeg') || out.endsWith('.jpg') ? { quality: 88 } : {};
  await page.screenshot({ path: out, ...opts });
  console.log(`saved docs/media/${shot.out}`);
  await page.close();
}

await browser.close();
