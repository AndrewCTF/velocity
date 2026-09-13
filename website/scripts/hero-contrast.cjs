// Loop-wide hero contrast: pause the reel at every second, hide the type, and
// sample the brightest 2% of backdrop pixels inside each text box (the
// procedure CLIENT-NOTES records; a single-frame reading once reported 12.9:1
// for a frame that had not painted). Fails if any second drops under the floor.
//   node scripts/hero-contrast.cjs [pageUrl]
const { chromium } = require('playwright');
const URL = process.argv[2] || 'file:///home/andrew/Projects/OSINT/website/index.html';
const TARGETS = [['.hero-line', 3.0], ['.hero-sub', 4.5], ['.hero-ctas .btn.ghost', 4.5]];
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(URL, { waitUntil: 'load' }); await p.waitForTimeout(2500);
  const dur = await p.evaluate(() => new Promise((r) => { const v = document.getElementById('heroVideo'); v.classList.add('on'); if (v.duration) r(v.duration); else v.onloadedmetadata = () => r(v.duration); }));
  const boxes = await p.evaluate((T) => T.map(([sel]) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return { sel, x: r.x + 3, y: r.y + 3, w: r.width - 6, h: r.height - 6, color: getComputedStyle(e).color }; }), TARGETS); // 3px inset keeps a control's own border out of its sample
  await p.evaluate(() => { document.querySelector('.nav').style.visibility = 'hidden'; document.querySelectorAll('.hero-content, .hero-content *').forEach((e) => { e.style.transition = 'none'; e.style.color = 'transparent'; e.style.textShadow = 'none'; }); });
  const worst = Object.fromEntries(TARGETS.map(([s]) => [s, Infinity]));
  const worstAt = {};
  for (let t = 0.1; t < dur; t += 1) { // 0.1 not 0: at exactly 0 the poster can still be showing
    await p.evaluate((t) => new Promise((r) => { const v = document.getElementById('heroVideo'); v.pause(); v.currentTime = t; v.onseeked = () => requestAnimationFrame(() => requestAnimationFrame(r)); }), t);
    const png = await p.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } });
    // decode PNG in the page: simplest cross-tool path without extra deps
    const stats = await p.evaluate(async ({ png, boxes }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + png; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return boxes.map((bx) => {
        const d = g.getImageData(Math.round(bx.x), Math.round(bx.y), Math.max(1, Math.round(bx.w)), Math.max(1, Math.round(bx.h))).data;
        const L = []; for (let i = 0; i < d.length; i += 4) L.push([d[i], d[i + 1], d[i + 2]]);
        L.sort((a, b2) => (b2[0] * 2 + b2[1] * 7 + b2[2]) - (a[0] * 2 + a[1] * 7 + a[2]));
        const top = L.slice(0, Math.max(1, Math.floor(L.length * 0.02)));
        const m = top.reduce((a, q) => [a[0] + q[0], a[1] + q[1], a[2] + q[2]], [0, 0, 0]).map((v) => v / top.length);
        return { sel: bx.sel, bg: m, color: bx.color };
      });
    }, { png: png.toString('base64'), boxes });
    for (const s of stats) {
      const fg = s.color.match(/[\d.]+/g).map(Number);
      const a = fg.length > 3 ? fg[3] : 1;
      const bgL = lum(s.bg);
      const fgL = lum(fg.slice(0, 3).map((c, i) => c * a + s.bg[i] * (1 - a)));
      const ratio = (Math.max(fgL, bgL) + 0.05) / (Math.min(fgL, bgL) + 0.05);
      if (process.env.DEBUG && s.sel.includes('ghost')) console.log('t', t, 'bg', s.bg.map(Math.round), 'ratio', ratio.toFixed(2));
      if (ratio < worst[s.sel]) { worst[s.sel] = ratio; worstAt[s.sel] = t; }
    }
  }
  let ok = true;
  for (const [sel, need] of TARGETS) { const r = worst[sel]; const pass = r >= need; ok = ok && pass; console.log(`${pass ? 'PASS' : 'FAIL'} ${sel.padEnd(22)} worst ${r.toFixed(2)}:1 at t=${worstAt[sel]}s (need ${need})`); }
  console.log(`reel ${dur.toFixed(1)} s, ${Math.ceil(dur)} frames sampled`);
  await b.close(); process.exit(ok ? 0 : 1);
})();
