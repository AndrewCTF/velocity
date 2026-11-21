#!/usr/bin/env node
// Network waterfall: record all /api/* request sizes + timings on map boot.
// Usage: node tools/perf/net_waterfall.mjs [--out=docs/media/walkthrough/net-waterfall.json] [--load-ms=20000]
// Requires dev servers: API :8000 + Vite :5173.
// Output: { requests: [...], big: [...], biggest: [...] } sorted by size desc.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

async function loadPlaywright() {
  const candidates = [
    '/home/andrew/Projects/OSINT-sec/tools/adsb-globe-feeder/node_modules/playwright/index.mjs',
    path.join(REPO, 'tools/adsb-globe-feeder/node_modules/playwright/index.mjs'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return import(p);
  throw new Error('playwright not found');
}
const { chromium } = await loadPlaywright();

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const OUT = args.out || path.join(REPO, 'docs/media/walkthrough/net-waterfall.json');
const LOAD_MS = Number(args['load-ms'] || 20000);
const BASE = process.env.BASE || 'http://127.0.0.1:5173';

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.addInitScript(() => {
  sessionStorage.setItem('velocity.devNoLogin', '1');
  localStorage.setItem('velocity.onboarded.v1', '1');
  localStorage.setItem('velocity.aiSetupSeen', '1');
  localStorage.setItem('velocity.openModeDismissed', '1');
});
const page = await ctx.newPage();

const requests = [];
const inflight = new Map(); // reqId -> start entry
let seq = 0;

page.on('request', (req) => {
  const url = req.url();
  if (!url.includes('/api/')) return;
  const id = ++seq;
  inflight.set(req, { id, url, method: req.method(), start: Date.now(), startPerf: performance.now?.() ?? Date.now() });
});

page.on('response', async (res) => {
  const req = res.request();
  const entry = inflight.get(req);
  if (!entry) return;
  inflight.delete(req);
  let sizeBytes = null;
  let sizeSource = 'none';
  try {
    const headers = res.headers();
    const cl = headers['content-length'] || headers['Content-Length'];
    if (cl) { sizeBytes = Number(cl); sizeSource = 'content-length'; }
  } catch {}
  // Fallback: measure body length when content-length absent (may throw on large/streamed)
  if (sizeBytes == null) {
    try {
      const buf = await res.body();
      sizeBytes = buf.length;
      sizeSource = 'body';
    } catch { sizeBytes = null; sizeSource = 'none'; }
  }
  let timing = null;
  try { timing = res.timing?.() ?? null; } catch {}
  requests.push({
    id: entry.id,
    url: entry.url,
    method: entry.method,
    status: res.status(),
    size_bytes: sizeBytes,
    size_source: sizeSource,
    size_mb: sizeBytes != null ? +(sizeBytes / 1048576).toFixed(4) : null,
    duration_ms: Date.now() - entry.start,
    started_at: entry.start,
    timestamp: new Date(entry.start).toISOString(),
    content_type: (() => { try { return res.headers()['content-type'] || null; } catch { return null; } })(),
    timing,
  });
});

page.on('requestfailed', (req) => {
  const entry = inflight.get(req);
  if (!entry) return;
  inflight.delete(req);
  requests.push({ id: entry.id, url: entry.url, method: entry.method, status: 0, error: req.failure()?.errorText || 'failed', size_bytes: null, size_source: 'none', size_mb: null, duration_ms: Date.now() - entry.start, started_at: entry.start, timestamp: new Date(entry.start).toISOString() });
});

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('.slate-shell', { timeout: 30000 }).catch(() => {});
await page.waitForFunction(() => !!window.__viewer && !!window.__useAppView, { timeout: 60000 }).catch(() => {});
for (const label of ['Skip', 'Dismiss', 'Close', 'Got it']) {
  const el = page.getByRole('button', { name: label }).first();
  if ((await el.count().catch(() => 0)) > 0) await el.click({ timeout: 2000 }).catch(() => {});
}
await page.waitForTimeout(LOAD_MS);
await page.waitForTimeout(1500);

requests.sort((a, b) => a.started_at - b.started_at);
const big = requests.filter((r) => r.size_bytes != null && r.size_bytes > 1048576);
const biggest = [...requests]
  .filter((r) => r.size_bytes != null)
  .sort((a, b) => b.size_bytes - a.size_bytes)
  .slice(0, 10)
  .map((r) => ({ url: r.url, size_mb: r.size_mb, size_bytes: r.size_bytes, duration_ms: r.duration_ms, status: r.status, method: r.method }));

const result = {
  generated_at: new Date().toISOString(),
  base: BASE,
  load_ms: LOAD_MS,
  request_count: requests.length,
  total_bytes: requests.reduce((s, r) => s + (r.size_bytes || 0), 0),
  requests,
  big,
  biggest,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`wrote ${OUT} requests=${requests.length} big=${big.length}`);
console.log(JSON.stringify({ biggest }, null, 2));
await browser.close();
