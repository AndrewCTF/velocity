import { chromium } from '/home/andrew/Projects/OSINT/tools/adsb-globe-feeder/node_modules/playwright-core/index.mjs';
const files = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1834, height: 1032 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', e => errs.push(String(e)));
for (const f of files) {
  await p.goto('file://' + process.cwd() + '/' + f, { waitUntil: 'networkidle' });
  await p.screenshot({ path: '_shots/' + f.replace('.html', '.png') });
  console.log('shot', f);
}
if (errs.length) console.log('CONSOLE ERRORS:', errs.slice(0, 5));
await b.close();
