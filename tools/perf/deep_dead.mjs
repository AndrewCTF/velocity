#!/usr/bin/env node
// Deep drill dead controls: per button — React onClick prop presence,
// DOM diff, store diff, network during click, delayed (>1s) re-check.
// Classifies: rail-setApp-noop | dismiss-modal | truly-dead | async
// Writes deep-dead.json incrementally after each app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const OUT = path.join(REPO, 'docs/media/walkthrough/deep-dead.json');

const { chromium } = await import('/home/andrew/Projects/OSINT-sec/tools/adsb-globe-feeder/node_modules/playwright/index.mjs');
const APPS = process.env.ONLY ? process.env.ONLY.split(',') : ['reports','quiver','video','ai','models','vertex'];
const BASE = process.env.BASE || 'http://localhost:5173';

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.addInitScript(() => {
  sessionStorage.setItem('velocity.devNoLogin', '1');
  localStorage.setItem('velocity.onboarded.v1', '1');
  localStorage.setItem('velocity.aiSetupSeen', '1');
  localStorage.setItem('velocity.openModeDismissed', '1');
});
const page = await ctx.newPage();
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);
for (const label of ['Skip','Dismiss','Close','Got it']) {
  const el = page.getByRole('button', { name: label }).first();
  if ((await el.count().catch(() => 0)) > 0) await el.click({ timeout: 2000 }).catch(() => {});
}
await page.waitForTimeout(2000);

const results = process.env.KEEP ? (JSON.parse(fs.readFileSync(OUT, 'utf8')).apps.filter((a) => !APPS.includes(a.app))) : [];
function save() { fs.writeFileSync(OUT, JSON.stringify({ apps: results }, null, 1)); }

for (const app of APPS) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate((id) => { try { window.__useAppView?.getState?.()?.setApp?.(id); } catch {} }, app).catch(() => {});
    await page.waitForTimeout(5000).catch(() => {});
    try { if (page.isClosed()) break; } catch { break; }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
    let count = 0;
    try { count = await page.locator('button:not([disabled])').count(); } catch {}
    if (count > 10 || attempt === 1) break;
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(8000);
  }
  let infos = [];
  infos = await page.evaluate(() => {
    function hasOnClick(el) {
      for (const k of Object.keys(el)) {
        if (k.startsWith('__reactProps$')) {
          const p = el[k];
          if (p && (typeof p.onClick === 'function' || typeof p.onChange === 'function' || typeof p.onPointerDown === 'function')) return true;
        }
      }
      return false;
    }
    const btns = [...document.querySelectorAll('button:not([disabled])')].filter((el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    });
    return btns.map((el, i) => ({
      i,
      label: ((el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || `btn${i}`)).trim().replace(/\s+/g,' ').slice(0,60),
      onClick: hasOnClick(el),
      inRail: !!el.closest('.a.rail, nav, [class*="rail"], [class*="tabsbar"]'),
    }));
  });
  const netLog = [];
  const handler = (req) => netLog.push(req.url().slice(0, 120));
  page.on('request', handler);
  const rows = [];
  for (const info of infos) {
    const sigTurn = () => {
      const body = document.body.innerHTML;
      let h = 0; for (let i = 0; i < body.length; i++) h = (h * 31 + body.charCodeAt(i)) >>> 0;
      let store = '';
      try { store = JSON.stringify(window.__useAppView?.getState?.()?.app ?? '').slice(0, 400); } catch {}
      return { hash: h, dialogs: document.querySelectorAll('[role="dialog"], dialog[open], .modal, [class*="modal"], [class*="Modal"]').length, store };
    };
    const before = await page.evaluate(sigTurn).catch(() => ({}));
    netLog.length = 0;
    await page.locator('button:not([disabled])').nth(info.i).click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(250).catch(() => {});
    const mid = await page.evaluate(sigTurn).catch(() => ({}));
    await page.waitForTimeout(1200).catch(() => {});
    const after = await page.evaluate(sigTurn).catch(() => ({}));
    const net = [...netLog];
    const changedMid = mid.hash !== before.hash || mid.store !== before.store;
    const changedLate = after.hash !== mid.hash || after.store !== mid.store;
    const modalDismissed = mid.dialogs < before.dialogs;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(50).catch(() => {});
    let cls;
    if (modalDismissed) cls = 'dismiss-modal';
    else if (changedLate && !changedMid) cls = 'async';
    else if (info.inRail) cls = 'rail-setApp-noop';
    else if (!changedMid && !changedLate) cls = 'truly-dead';
    else cls = 'live-noop-class';
    rows.push({ idx: info.i, label: info.label, onClick: info.onClick, inRail: info.inRail, cls, net: net.slice(0,3), netN: net.length, changedMid, changedLate, dialogsBefore: before.dialogs, dialogsAfter: mid.dialogs });
  }
  page.off('request', handler);
  const trulyDead = rows.filter((r) => r.cls === 'truly-dead');
  const asyncs = rows.filter((r) => r.cls === 'async');
  console.log(`${app}: ${rows.length} swept, trulyDead=${trulyDead.length} async=${asyncs.length}`);
  for (const r of trulyDead) console.log(`  DEAD [${r.idx}] "${r.label}" onClick=${r.onClick} netN=${r.netN}`);
  results.push({ app, total: rows.length, trulyDead: trulyDead.length, asyncs: asyncs.length, rows });
  save();
}
await browser.close();
console.log(`saved ${OUT}`);
