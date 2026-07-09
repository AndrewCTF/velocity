#!/usr/bin/env node
// Capture a selected entity with magenta track polyline
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'tools/adsb-globe-feeder/index.js'));
const { chromium } = require('playwright');

const [out = 'selected-track.png', lon = '8', lat = '50', height = '1500000'] =
  process.argv.slice(2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
// Suppress the first-run onboarding overlay (dims + blurs the whole app).
await page.addInitScript(() => localStorage.setItem('velocity.onboarded.v1', '1'));
await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' });

// Wait for the Cesium viewer DEV global, then fly to the requested view.
await page.waitForFunction(() => Boolean(window.__viewer), null, { timeout: 60_000 });
await page.evaluate(
  ([ln, lt, h]) => {
    const C = window.__Cesium;
    window.__viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(ln, lt, h),
    });
  },
  [Number(lon), Number(lat), Number(height)],
);

// Let feeds paint
await page.waitForTimeout(10_000);

// Find a real aircraft entity near the camera center (skip helper entities
// like __spotlight__ring; require a billboard icon + position).
const aircraftId = await page.evaluate(
  ([ln, lt]) => {
    const C = window.__Cesium;
    const now = window.__viewer.clock.currentTime;
    const target = C.Cartesian3.fromDegrees(ln, lt, 0);
    let best = null;
    let bestDist = Infinity;
    const dataSources = window.__viewer.dataSources;
    for (let i = 0; i < dataSources.length; i++) {
      const ds = dataSources.get(i);
      if (!ds.entities || !ds.entities.values) continue;
      for (const entity of ds.entities.values) {
        if (!entity.id || typeof entity.id !== 'string') continue;
        if (!entity.id.startsWith('aircraft:')) continue;
        if (!entity.position) continue;
        const pos = entity.position.getValue
          ? entity.position.getValue(now)
          : null;
        if (!pos) continue;
        const d = C.Cartesian3.distance(pos, target);
        if (d < bestDist) {
          bestDist = d;
          best = entity.id;
        }
      }
    }
    return best;
  },
  [Number(lon), Number(lat)],
);

if (aircraftId) {
  // Select the entity
  await page.evaluate(
    (id) => {
      window.__useSelection.getState().select(id);
    },
    aircraftId
  );

  // Wait for the magenta track polyline to render
  await page.waitForTimeout(6_000);
}

await page.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
