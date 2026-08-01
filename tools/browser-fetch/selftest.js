#!/usr/bin/env node
// Runnable check for the one piece of non-obvious logic in index.js: the
// per-host pace gate. No framework, no browser, no network.
//
//   NODE_PATH=../adsb-globe-feeder/node_modules node selftest.js
'use strict';

const assert = require('assert');

process.env.BROWSER_PACE_MS = '120';
process.env.BROWSER_JITTER_MS = '40';
const { paced } = require('./index.js');

(async () => {
  // 1. A burst to one host is SERIALIZED (never two loads in flight) and every
  //    gap clears the floor. This is the whole reason the gate exists: a browser
  //    that opens four tabs of one site at once is not a person.
  const starts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const work = () => {
    starts.push(Date.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((r) => setTimeout(() => { inFlight -= 1; r('ok'); }, 20));
  };
  const results = await Promise.all([1, 2, 3, 4].map(() => paced('example.test', work)));

  assert.strictEqual(maxInFlight, 1, 'page loads to one host must not overlap');
  assert.deepStrictEqual(results, ['ok', 'ok', 'ok', 'ok']);
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    assert.ok(gap >= 120, `gap ${gap}ms is under the ${120}ms floor`);
  }
  // Jitter means the gaps must not all be identical — a metronome is a tell.
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(new Set(gaps).size > 1, `gaps ${gaps} show no jitter`);

  // 2. A failure must not wedge the host's queue. Before .then(run, run) the
  //    rejected chain swallowed every later request to that host.
  await paced('fail.test', () => Promise.reject(new Error('boom'))).then(
    () => assert.fail('should have rejected'),
    (e) => assert.strictEqual(e.message, 'boom')
  );
  assert.strictEqual(await paced('fail.test', () => Promise.resolve('recovered')), 'recovered');

  // 3. Hosts are paced independently — one slow site must not stall another.
  const t0 = Date.now();
  await Promise.all([paced('a.test', work), paced('b.test', work)]);
  assert.ok(Date.now() - t0 < 120, 'different hosts must not queue behind each other');

  // 4. Headful must pin the window system to X11. Chrome picks its Ozone
  //    backend automatically and WAYLAND_DISPLAY is inherited even inside
  //    xvfb-run, so without the pin a Chrome release that starts preferring
  //    Wayland would draw on the OPERATOR'S real desktop instead of the virtual
  //    one. Checked in a child process because HEADFUL is read at module load.
  const { execFileSync } = require('child_process');
  const probe =
    "const o=require('./index.js').launchOpts();" +
    "console.log(JSON.stringify({headless:o.headless,x11:o.args.includes('--ozone-platform=x11')}))";
  const headful = JSON.parse(
    execFileSync(process.execPath, ['-e', probe], {
      cwd: __dirname,
      env: { ...process.env, BROWSER_HEADFUL: '1' },
    }).toString()
  );
  assert.strictEqual(headful.headless, false, 'BROWSER_HEADFUL=1 must launch headful');
  assert.ok(headful.x11, 'headful must pin --ozone-platform=x11 or it can escape to the real desktop');

  const headless = JSON.parse(
    execFileSync(process.execPath, ['-e', probe], {
      cwd: __dirname,
      env: { ...process.env, BROWSER_HEADFUL: '0' },
    }).toString()
  );
  assert.strictEqual(headless.headless, true, 'default must stay headless');
  assert.ok(!headless.x11, 'the x11 pin belongs to headful only');

  console.log('browser-fetch selftest: ok');
  process.exit(0);
})();
