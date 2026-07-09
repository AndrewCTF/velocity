#!/usr/bin/env node
// Capture the live globe at a named view for visual-invariant checks
// (icons-not-dots, labels, selection). Needs the app running (vite :5173 +
// backend :8000) and playwright (reuses tools/adsb-globe-feeder's install).
//
//   node scripts/screenshot-globe.mjs [outfile] [lon] [lat] [heightMeters]
//
// Default view: Europe at 4,000 km — the CLAUDE.md verification view
// ("hundreds of category icons, not dots"). Compare shots across changes;
// headless renders via software raster, so this checks CONTENT, never fps.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'tools/adsb-globe-feeder/index.js'));
const { chromium } = require('playwright');

const [out = 'globe-europe.png', lon = '10', lat = '50', height = '4000000'] =
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
// Let feeds paint (poll cadence is 1 s; give icons a few cycles).
await page.waitForTimeout(10_000);
await page.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
