#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const chromePath = '/usr/bin/google-chrome-stable';
const profile = fs.mkdtempSync('/tmp/probe-');
const chrome = spawn(chromePath, ['--remote-debugging-port=9223','--no-first-run','--no-sandbox','--enable-gpu','--ignore-gpu-blocklist','--use-gl=angle','--use-angle=gl-egl','--user-data-dir='+profile,'about:blank'], { stdio: ['ignore','pipe','pipe'] });
chrome.stdout.on('data', (d) => process.stdout.write('[out] '+d));
chrome.stderr.on('data', (d) => process.stderr.write('[err] '+d));
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { const r = await fetch('http://127.0.0.1:9223/json/version'); const j = await r.json(); console.log('OK', j.Browser); break; } catch (e) { if (i===19) console.log('never up'); }
}
chrome.kill('SIGKILL');
