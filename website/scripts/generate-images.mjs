// Generate the site's staged imagery via OpenRouter (image model set in website/.env).
// Usage: node scripts/generate-images.mjs [jobName ...]   (no args = all jobs)
// Reads OPENROUTER_API_KEY from website/.env. Never hardcode the key here.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const KEY = env.OPENROUTER_API_KEY;
const MODEL = env.OPENROUTER_IMAGE_MODEL;
if (!KEY) { console.error('OPENROUTER_API_KEY missing from website/.env'); process.exit(1); }

const media = resolve(root, '..', 'docs', 'media');
const mime = p => ({ '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg' }[extname(p)]);
const dataUrl = p => `data:${mime(p)};base64,${readFileSync(p).toString('base64')}`;

// One lighting world for the whole set: low warm key light, cool blue screen glow,
// dark stone and brushed metal, dusk. Photorealistic, editorial, no people unless stated.
const WORLD = 'Photorealistic editorial photograph, cinematic but restrained. Lighting world: dim room at dusk, one low warm practical light, cool blue glow from screens, deep shadows. Materials: dark honed stone, brushed metal, matte black. No visible brand logos or trademarks anywhere (laptop lids are blank), no readable text other than what appears on the provided screenshot, no people unless stated. Shot on a full-frame camera, 35mm lens, shallow depth of field, high dynamic range, muted colors.';

const JOBS = {
  'gen-hero': {
    input: resolve(media, 'hero-europe-density.png'),
    prompt: `${WORLD} Wide 21:9 hero image: a modern thin laptop with a completely blank dark lid sits open on a massive honed dark-grey stone desk. The laptop screen shows EXACTLY the provided screenshot (a dark 3D globe interface dense with small aircraft icons over Europe), reproduced faithfully, bright and legible, the only bright element in the frame. Do NOT add any large watermark words, country names or text overlays across the map on the screen; the screen shows only the fine UI of the provided screenshot. Around it: the stone surface fills the foreground with subtle texture, a dark out-of-focus operations room behind, faint cool window light far left. Composition: laptop right of center, generous empty stone in the left half for headline text overlay. Very dark overall so white text will sit on the left side.`,
  },
  'gen-desk-wide': {
    input: resolve(media, 'hero-world.jpeg'),
    prompt: `${WORLD} Wide 21:9 image: a night operations desk seen from a three-quarter angle. One large external monitor shows EXACTLY the provided screenshot (a dark 3D globe with global aircraft traffic), faithfully reproduced. On the desk: a closed notebook, a printed aeronautical chart partially visible, a plain mug. Background falls to near black. The monitor glow is the key light. Composition low and wide, monitor in upper right two-thirds, dark foreground desk across the bottom for text overlay.`,
  },
  'gen-stone-texture': {
    prompt: `${WORLD} Abstract macro texture plate, 21:9: honed dark basalt stone surface lit by a single raking warm light from the far left fading into near-black on the right. Fine mineral grain, one faint natural fissure running diagonally. No objects, no text. Extremely dark, usable as a website background band behind light text.`,
  },
  'gen-evidence': {
    prompt: `${WORLD} Still life, 4:3: on dark honed stone, a printed maritime chart of a strait with a hand-drawn route line, a small matte-black portable hard drive on top of it, and a metal ruler. Overhead warm raking light, deep shadows. All printed text on the chart is soft-focus and unreadable. Evokes evidence handling and archives. No logos, no readable words.`,
  },
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(JOBS);

for (const name of names) {
  const job = JOBS[name];
  if (!job) { console.error(`unknown job ${name}`); continue; }
  const content = [{ type: 'text', text: job.prompt }];
  if (job.input) content.push({ type: 'image_url', image_url: { url: dataUrl(job.input) } });
  console.log(`[${name}] requesting...`);
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, modalities: ['image', 'text'], messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) { console.error(`[${name}] HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`); continue; }
  const body = await res.json();
  const images = body.choices?.[0]?.message?.images ?? [];
  if (!images.length) { console.error(`[${name}] no images in response: ${JSON.stringify(body).slice(0, 400)}`); continue; }
  const url = images[0].image_url?.url ?? images[0].url;
  const m = /^data:image\/(\w+);base64,(.+)$/s.exec(url);
  if (!m) { console.error(`[${name}] unexpected image url format`); continue; }
  const out = resolve(root, 'assets', `${name}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
  writeFileSync(out, Buffer.from(m[2], 'base64'));
  console.log(`[${name}] saved ${out} (${Buffer.from(m[2], 'base64').length} bytes)`);
}
