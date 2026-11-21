#!/usr/bin/env node
// Tile edge check: load at zoom levels 0,3,6,9,12,15,18, screenshot each into
// docs/media/walkthrough/tile-zooms/, report holes (failed tile requests or
// black pixels where imagery should be).
// Slate default mode = esri-imagery (direct, keyless, CORS-open); also covers
// /tiles/proxy stack by requesting 2d-dark at z0 as a control tile probe.
// Camera height for slippy zoom z (256px tiles, equator): h_m = C / 2^z where
// C = 40075016.686 * screenH / 256 (meters per pixel at z0 scaled by width).
// Cesium GlobeCanvas camera height is measured from ellipsoid surface; use
// WebMercator projection zoom via viewer.camera.setView with Cartesian3
// longitude/latitude/height, height = h_m, top-down.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const OUT = path.join(REPO, 'docs/media/walkthrough/tile-zooms');
fs.mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  const candidates = [
    '/home/andrew/Projects/OSINT-sec/tools/adsb-globe-feeder/node_modules/playwright/index.mjs',
    path.join(REPO, 'tools/adsb-globe-feeder/node_modules/playwright/index.mjs'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return await import(p);
  throw new Error('playwright not found');
}
const { chromium } = await loadPlaywright();

// --- PNG decoder: 8-bit RGB/RGBA non-interlaced only ---
function decodePng(buf) {
  if (!buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('not png');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) throw new Error(`unsupported png bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  const bpp = colorType === 2 ? 3 : 4;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const row = raw.slice(pos, pos + stride); pos += stride;
    const out = px.slice(y * stride, (y + 1) * stride);
    const up = y > 0 ? px.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0, b = up[i], c = i >= bpp ? up[i - bpp] : 0;
      let v = row[i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      out[i] = v;
    }
  }
  return { w, h, bpp, px };
}

function analyzeScreenshot(file) {
  const { w, h, bpp, px } = decodePng(fs.readFileSync(file));
  // grid 8x8 cells, count near-black cells (R,G,B < 12)
  const gx = 8, gy = 8, cw = Math.floor(w / gx), ch = Math.floor(h / gy);
  let blackCells = 0; const blackCellList = [];
  for (let cy = 0; cy < gy; cy++) {
    for (let cx = 0; cx < gx; cx++) {
      let black = 0, total = 0;
      for (let y = cy * ch; y < (cy + 1) * ch; y += 4) {
        for (let x = cx * cw; x < (cx + 1) * cw; x += 4) {
          total++;
          const i = (y * w + x) * bpp;
          if (px[i] < 12 && px[i + 1] < 12 && px[i + 2] < 12) black++;
        }
      }
      if (total && black / total > 0.85) { blackCells++; blackCellList.push(`${cx},${cy}:${(100 * black / total).toFixed(0)}%`); }
    }
  }
  return { w, h, zoomMax: blackCells === 0 ? 'none' : blackCells, blackCells, blackCellList };
}

const BASE = process.env.BASE || 'http://localhost:5173';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});

const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); // eslint-disable-line
await ctx.addInitScript(() => {
  sessionStorage.setItem('velocity.devNoLogin', '1');
  sessionStorage.setItem('velocity.aiSetupSeen', '1');
  localStorage.setItem('velocity.onboarded.v1', '1');
  localStorage.setItem('velocity.aiSetupSeen', '1');
  localStorage.setItem('velocity.openModeDismissed', '1');
});
const page = await ctx.newPage();

const holes = [];
const results = [];
const failedTiles = [];

page.on('requestfailed', (r) => {
  const u = r.url();
  if (/\/tiles?\//.test(u) || /tile\//.test(u) || /arcgisonline/.test(u)) failedTiles.push({ url: u.slice(0, 160), error: r.failure()?.errorText || '' });
});
page.on('response', (r) => {
  const u = r.url();
  if (/\/tiles?\//.test(u) || /arcgisonline/.test(u)) {
    if (r.status() >= 400) failedTiles.push({ url: u.slice(0, 160), error: `HTTP ${r.status()}` });
  }
});

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('.slate-shell', { timeout: 30000 }).catch(() => {});
await page.waitForFunction(() => !!window.__viewer, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);
// dismiss any modal that dims the globe (dark ground + blur would pass hole check)
for (const label of ['Skip', 'Dismiss', 'Close', 'Got it']) {
  const el = page.getByRole('button', { name: label }).first();
  if ((await el.count().catch(() => 0)) > 0) await el.click({ timeout: 2000 }).catch(() => {});
}
await page.waitForTimeout(2000);

const viewInfo = await page.evaluate(() => {
  const v = window.__viewer;
  if (!v) return null;
  const c = v.camera.positionCartographic;
  const layers = [];
  const layersList = v.scene.imageryLayers;
  return { heightM: v.camera.positionCartographic?.height, layers: layersList.length, hasViewer: true };
}).catch(() => null);
console.log('viewer:', JSON.stringify(viewInfo));

// camera heights for slippy zooms: meters above surface for 1920x1080 view.
// vertical FOV ~50deg Cesium default; using web-mercator approximation:
// height(z) = 156543.03 * cos(lat) / 2^z * (1080/256) (meters/pixel at 256px tiles scaled to viewport height)
const zooms = [0, 3, 6, 9, 12, 15, 18];
for (const z of zooms) {
  console.error(`>> z${z}`);
  // 156543.03 m/px at z0 equator for 256px tiles; scale by viewport height/256
  const h = (156543.03 / Math.pow(2, z)) * (1080 / 256); // ~660km at z0
  await page.evaluate(({ h }) => {
    const v = window.__viewer; if (!v) return;
    const C = window.__Cesium; const Cesium = C.default || C;
    // top-down over lon 10, lat 50 (Europe, landsat coverage)
    v.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(10, 50, h),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    v.scene.requestRender();
  }, { h }).catch(() => {});
  await page.waitForTimeout(2500);
  // per-zoom modal may reappear; dismiss before screenshot
  for (const label of ['Skip', 'Dismiss', 'Close', 'Got it']) {
    const el = page.getByRole('button', { name: label }).first();
    if ((await el.count().catch(() => 0)) > 0) await el.click({ timeout: 1500 }).catch(() => {});
  }
  await page.waitForTimeout(600);
  await page.evaluate(() => { const v = window.__viewer; if (v) v.scene.requestRender(); }).catch(() => {});
  await page.waitForTimeout(600);
  const file = path.join(OUT, `z${z}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  let analysis = null;
  try { analysis = analyzeScreenshot(file); } catch (e) { analysis = { error: String(e).slice(0, 120) }; }
  const failedAtZoom = failedTiles.slice(-12);
  results.push({ zoom: z, heightM: Math.round(h), file: `docs/media/walkthrough/tile-zooms/z${z}.png`, blackCells: analysis?.blackCells ?? null, blackCellList: analysis?.blackCellList || [], headerOk: true });
  console.log(`z${z} h=${Math.round(h)}m blackCells=${analysis?.blackCells} cells=${(analysis?.blackCellList || []).join('|')} failedRecent=${failedAtZoom.length}`);
  if (analysis?.blackCells >= 2) holes.push({ zoom: z, kind: 'black-cells', cells: analysis.blackCellList });
}

// control: direct /tiles proxy fetch probe at one tile per zoom (lat 50,lon10)
const tileProbe = await page.evaluate(async () => {
  const out = [];
  for (let z = 0; z <= 18; z += 3) {
    const n = Math.pow(2, z);
    const latRad = 50 * Math.PI / 180;
    const x = Math.floor((10 + 180) / 360 * n);
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    for (const fam of ['basemap', 'sat']) {
      const ext = fam === 'sat' ? 'jpg' : 'png';
      const url = `/tiles/${fam}/${z}/${x}/${y}.${ext}`;
      try {
        const r = await fetch(url, { method: 'GET' });
        out.push({ z, fam, x, y, status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength });
      } catch (e) { out.push({ z, fam, x, y, error: String(e).slice(0, 80) }); }
    }
  }
  return out;
}).catch(() => []);
console.log('tileProbe:', JSON.stringify(tileProbe));

for (const p of tileProbe) {
  if (p.status && p.status >= 400) holes.push({ zoom: p.z, kind: `proxy-${p.fam}-http-${p.status}`, tile: `${p.x},${p.y}` });
}
const failedDedup = [...new Map(failedTiles.map(t => [t.url + t.error, t])).values()];
for (const t of failedDedup.slice(0, 10)) holes.push({ kind: 'request-failed', url: t.url, error: t.error });

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, tileProbe, failedTiles: failedDedup }, null, 1));
await browser.close();

const out = { holes };
console.log(JSON.stringify(out));
process.exit(holes.length ? 1 : 0);
