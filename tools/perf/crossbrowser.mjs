#!/usr/bin/env node
// Cross-browser smoke: Firefox + WebKit via Playwright if installed.
// Output: docs/media/walkthrough/crossbrowser.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const BASE = process.env.BASE || 'http://localhost:5173';
const OUT = path.join(REPO, 'docs/media/walkthrough/crossbrowser.json');
const PW = path.join(REPO, 'tools/adsb-globe-feeder/node_modules/playwright/lib/server/registry/index.js');
const { chromium } = await import(path.join(REPO, 'tools/adsb-globe-feeder/node_modules/playwright/index.mjs'));
const pw = await import(path.join(REPO, 'tools/adsb-globe-feeder/node_modules/playwright/index.mjs'));

const browsers = {};
async function run(name, launchFn) {
  const started = Date.now();
  try {
    const browser = await launchFn();
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await ctx.addInitScript(() => {
      sessionStorage.setItem('velocity.devNoLogin', '1');
      localStorage.setItem('velocity.onboarded.v1', '1');
      localStorage.setItem('velocity.aiSetupSeen', '1');
      localStorage.setItem('velocity.openModeDismissed', '1');
    });
    const page = await ctx.newPage();
    const consoleErrors = [], pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('.slate-shell', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const hasShell = await page.evaluate(() => !!document.querySelector('.slate-shell'));
    await page.screenshot({ path: path.join(REPO, 'docs/media/walkthrough/crossbrowser-' + name + '.png') }).catch(() => {});
    browsers[name] = { ok: true, hasShell, consoleErrors: consoleErrors.slice(0, 20), pageErrors: pageErrors.slice(0, 20), durationMs: Date.now() - started };
    await browser.close();
  } catch (e) {
    browsers[name] = { ok: false, error: String(e).slice(0, 500), durationMs: Date.now() - started };
  }
}

// Firefox: playwright firefox build not in ~/.cache/ms-playwright; try system firefox binary.
await run('firefox', () => pw.firefox.launch({ executablePath: '/usr/bin/firefox', args: ['--no-first-run'] }));
// WebKit: no playwright webkit build installed (~/.cache/ms-playwright has only chromium) and no system webkit binary.
await run('webkit', () => pw.webkit.launch());

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ browsers, base: BASE, generated: new Date().toISOString() }, null, 1));
console.log(JSON.stringify(browsers, null, 1));
