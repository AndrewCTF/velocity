// Cinematic establishing plates via OpenRouter, in the register the reference
// set actually uses: palantir.com's hero is blue-hour aerial footage of a city,
// not a product shot. These are ATMOSPHERE for the domains Velocity tracks
// (air, sea, orbit) and they claim nothing. Product proof stays in the real
// captures of the running app.
//
// Usage: node scripts/generate-bands.mjs [jobName ...]
// Reads OPENROUTER_API_KEY from website/.env. Never hardcode the key here.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8').split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const KEY = env.OPENROUTER_API_KEY;
if (!KEY) { console.error('OPENROUTER_API_KEY missing from website/.env'); process.exit(1); }
const MODEL = process.env.BAND_MODEL || 'google/gemini-3-pro-image';

// The grade, held constant so the set reads as one world: blue hour, cool sky
// against warm sodium and window light, filmic and desaturated, real places.
// Photographic brief, not a cinematic one. "Cinematic" pushes these models
// toward over-processed HDR, which is exactly the tell. Ask instead for the
// conditions of a real exposure: a named focal length, the grain of a real
// sensor at dusk, motion blur from a real shutter, and the imperfections a
// clean render never has.
const WORLD = [
  'WIDESCREEN 16:9 LANDSCAPE PHOTOGRAPH, 1792 pixels wide by 1024 pixels tall. The frame is much wider than it is tall. Do not return a square image.',
  'A real photograph taken on a full-frame DSLR, 85mm lens, 1/60s at ISO 1600.',
  'The camera is out in the open air with a clear unobstructed view. Nothing in the foreground, no window frame, no door frame, no aircraft or vehicle interior, no struts, no glass, no reflections of a cabin.',
  'Visible sensor noise in the shadows, slight motion blur on moving vehicles, mild chromatic aberration at the frame edges, gentle lens vignetting.',
  'Overcast blue hour, flat even ambient light, no dramatic sunset, no sun flare, no god rays.',
  'Colours muted and slightly green in the shadows the way an uncorrected raw file looks. Not HDR, not tone-mapped, not oversaturated.',
  'Ordinary and unremarkable rather than epic. Slightly imperfect framing, as if one frame from a working photographer.',
  'No text, no watermark, no signage, no company logos, no aircraft liveries, no people in the foreground.',
].join(' ');

const JOBS = {
  // No aircraft in the near field. Airframe geometry is what these models get
  // wrong: the first attempt put a wing through a fuselage, detached an engine
  // and dropped a tailplane. Runway furniture has no such anatomy to break.
  'band-air-world': `${WORLD} Subject: an empty runway and taxiway at a large airport at dusk, photographed from the grass at the edge of the airfield, camera low and close to the ground. Wet black asphalt filling the lower half, white centreline and threshold markings, rows of amber edge lights and blue taxiway lights receding to a vanishing point. Flat green grass either side. On the far horizon, small and distant, the low silhouette of a terminal and a control tower against the overcast sky. No aircraft anywhere in the frame.`,
  'band-sea-world': `${WORLD} Subject: a working container terminal seen from the top of a gantry crane at dusk, looking along the quay. One feeder container ship alongside, a second crane further down the quay, blocks of weathered rusty containers, puddled asphalt, a few trucks. Grey water on the left, plain industrial sheds behind. The full width of the quay runs across the frame.`,
  'band-orbit-world': `${WORLD} Subject: a photograph looking straight down and out at the night side of Earth from low orbit, nothing in the foreground at all. Below, a coastline picked out in fine amber city lights under scattered cloud, the thin blue-green airglow of the atmosphere on the horizon against black space. 21:9 crop.`,
};

const names = process.argv.slice(2).filter((a) => JOBS[a]);
const todo = names.length ? names : Object.keys(JOBS);

for (const name of todo) {
  process.stdout.write(`${name} ... `);
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content: [{ type: 'text', text: JOBS[name] }] }],
    }),
  });
  if (!res.ok) { console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); continue; }
  const json = await res.json();
  const img = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!img) { console.log('no image in response:', JSON.stringify(json).slice(0, 220)); continue; }
  const b64 = img.split(',')[1];
  const out = resolve(root, 'assets', `${name}.png`);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`saved ${(Buffer.from(b64, 'base64').length / 1024).toFixed(0)} KB -> ${out}`);
}
