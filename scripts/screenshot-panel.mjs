#!/usr/bin/env node
// Capture ONE app/panel of the console at 1440p (2560x1440) for docs/media.
// Deep-links the app via ?app= (and Foundry ?fv=), optionally opens a left-rail
// flyout by its button title, or selects a live entity for the inspector.
//
//   node scripts/screenshot-panel.mjs --out FILE [options]
//     --out FILE            output png path (required)
//     --app ID             top app: map|explorer|graph|targeting|video|sim|
//                          reports|foundry|workflows|city|country  (default map)
//     --fv VIEW            Foundry sub-view: home|datasets|pipeline|builds|ontology
//     --panel "Title"      open a left-rail flyout by its button title
//     --select             pick a live aircraft near the view and select it
//     --view lon,lat,h     camera (map only). default 10,50,4000000
//     --wait MS            extra settle time after actions (default 9000)
//
// Headless software-raster: checks CONTENT/layout, never fps.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'tools/adsb-globe-feeder/index.js'));
const { chromium } = require('playwright');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const out = arg('out');
if (!out) {
  console.error('ERROR: --out FILE is required');
  process.exit(2);
}
const app = arg('app', 'map');
const fv = arg('fv', null);
const panel = arg('panel', null);
const doSelect = arg('select', false) === true;
const wait = Number(arg('wait', '9000'));
const [lon, lat, height] = String(arg('view', '10,50,4000000'))
  .split(',')
  .map(Number);

const url = new URL('http://127.0.0.1:5173');
if (app !== 'map') url.searchParams.set('app', app);
if (fv) url.searchParams.set('fv', fv);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
// Suppress the first-run onboarding overlay (dims + blurs the whole app).
await page.addInitScript(() => {
  localStorage.setItem('velocity.onboarded.v1', '1');
  localStorage.setItem('velocity.onboarding.v1', '1');
});
await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

// The globe is always mounted; wait for the Cesium viewer DEV global regardless
// of which app is active, then position the camera (map-context apps only).
await page.waitForFunction(() => Boolean(window.__viewer), null, { timeout: 60_000 });
if (Number.isFinite(lon)) {
  await page.evaluate(
    ([ln, lt, h]) => {
      const C = window.__Cesium;
      window.__viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(ln, lt, h) });
    },
    [lon, lat, height],
  );
}

// Let feeds paint before interacting.
await page.waitForTimeout(6_000);

if (panel) {
  // Left-rail flyout buttons carry title={label}. Click to open. The rail opens
  // one flyout at a time and toggles: if the target is already the open default
  // ("Layers"), a single click would CLOSE it — so verify the flyout header for
  // this panel is present afterward and click once more if it isn't.
  const sel = `button[title="${panel}"]`;
  const flyoutOpen = () =>
    page.evaluate((label) => {
      const heads = Array.from(document.querySelectorAll('span'));
      return heads.some((h) => h.textContent?.trim().toUpperCase() === label.toUpperCase());
    }, panel);
  // Playwright's actionable click never settles here: the live feed mutates the
  // DOM every second, so "wait for element stable" times out (and a failed click
  // leaves the default-open Layers flyout in place — the wrong panel). Dispatch
  // the click directly on the DOM node instead; native el.click() bubbles a real
  // MouseEvent that React's delegated onClick still catches. Retry until the
  // flyout header for THIS panel is actually confirmed present.
  let opened = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const clicked = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.click();
      return true;
    }, sel);
    if (!clicked) console.error(`WARN: rail button for "${panel}" not found (attempt ${attempt + 1})`);
    await page.waitForTimeout(1_400);
    if (await flyoutOpen()) {
      opened = true;
      break;
    }
  }
  if (!opened) console.error(`WARN: panel "${panel}" flyout never confirmed open`);
  await page.waitForTimeout(2_000);
}

if (doSelect) {
  const id = await page.evaluate(
    ([ln, lt]) => {
      const C = window.__Cesium;
      const now = window.__viewer.clock.currentTime;
      const target = C.Cartesian3.fromDegrees(ln, lt, 0);
      let best = null;
      let bestDist = Infinity;
      const ds = window.__viewer.dataSources;
      for (let i = 0; i < ds.length; i++) {
        const src = ds.get(i);
        if (!src.entities || !src.entities.values) continue;
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
    },
    [lon, lat],
  );
  if (id) {
    await page.evaluate((i) => window.__useSelection.getState().select(i), id);
    await page.waitForTimeout(5_000);
  } else {
    console.error('WARN: --select found no aircraft near the view');
  }
}

await page.waitForTimeout(wait);
await page.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
