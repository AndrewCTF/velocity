// Cut and grade the hero reel: stock sub-clips (source-clips.mjs) interleaved
// with chrome-free product inserts (shoot-product.cjs), one uniform grade so
// thirty sources read as one world. Hard cuts only; palantir's reel has none
// of the dissolves a template would add.
//
//   node scripts/build-reel.mjs <clipsDir> <productDir> <out.mp4>
//
// The cut is the CUT table below, kept in the repo so the reel is reproducible.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [clips, product, out] = process.argv.slice(2);
if (!out) { console.error('usage: build-reel.mjs <clipsDir> <productDir> <out.mp4>'); process.exit(2); }
const tmp = join(clips, '..', 'reel-tmp'); mkdirSync(tmp, { recursive: true });

// [source, seconds]. Stock is "slot-<pexelsId>", product is a shoot name.
// In-point is mid-clip for stock (skips fades), 0.4 s for product.
const CUT = [
  ['atc-tower-32001457', 1.3], ['aircraft-5703847', 1.0], ['aircraft-5608153', 1.2], ['ocean-33762469', 1.0],
  ['@hero-med', 1.4],
  ['harbour-4499159', 1.1], ['ship-34043280', 1.2], ['ocean-30537976', 0.9], ['harbour-3075997', 1.1], ['ship-2943126', 1.0],
  ['console-36392564', 1.0],
  ['@hero-gulf', 1.4],
  ['launch-7615677', 1.2], ['orbit-38594546', 1.2], ['radar-33885210', 1.0], ['orbit-39025985', 1.1],
  ['wildfire-31129960', 1.1], ['cables-33717724', 0.9],
  ['@hero-asia', 1.4],
  ['storm-6065794', 1.1], ['datacenter-5028622', 1.0], ['cables-32333921', 0.9], ['console-5647327', 1.0],
  ['coast-39104194', 1.2], ['drone-3723537', 1.0],
  ['@hero-orbit', 1.4],
  ['ship-35200489', 1.0], ['wildfire-31130093', 1.1], ['atc-tower-29006443', 1.0], ['coast-37557938', 1.2], ['datacenter-9573897', 1.0],
];

// One grade. Desaturate, lift blacks a touch and roll the highlights (nothing
// clips to white under the headline), warm highlights / cool shadows, grain,
// vignette. Product inserts get a 1.25x centre crop so the chrome-free globe
// reads as a frame from the same camera, not a screen recording.
const GRADE = 'eq=saturation=0.68:contrast=1.06:brightness=-0.02,'
  + "curves=master='0/0.03 0.22/0.15 0.55/0.48 0.85/0.78 1/0.90',"
  + 'colorbalance=rs=0.02:gs=0.0:bs=-0.03:rm=0.01:bm=-0.02:rh=0.05:gh=0.02:bh=-0.06,'
  + 'noise=alls=7:allf=t+u,vignette=PI/4.6';
const fit = (zoom = 1) => `scale=${1920 * zoom}:${1080 * zoom}:force_original_aspect_ratio=increase,crop=1920:1080,fps=24,setsar=1`;

const dur = (f) => parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString());
// Mean luma of one frame at thumbnail scale (0-255). Thirty sources come in at
// anything from 2 to 90; a shared grade cannot fix that, so each clip is
// gamma-pulled toward the band first (palantir's reel measures ~46 at this
// scale; the headline needs the top of the frame dark, so aim a little under).
const luma = (f, at) => { const b = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', f, '-frames:v', '1', '-vf', 'scale=96:54,format=gray', '-f', 'rawvideo', '-']).stdout; return b.reduce((a, x) => a + x, 0) / b.length; };
const TARGET = 66; // raw, before the grade pulls ~40% out; lands near 40 after
const gammaFor = (l) => Math.min(1.9, Math.max(0.5, Math.pow(TARGET / Math.max(l, 1), 0.7)));
const parts = [];
const used = [];
for (const [src, secs] of CUT) {
  let file, inPoint, zoom;
  if (src.startsWith('@')) {
    file = join(product, src.slice(1) + '.mp4');
    if (!existsSync(file)) { console.warn('missing product insert, skipped:', src); continue; }
    inPoint = 0.4; zoom = 1.25;
  } else {
    const name = readdirSync(clips).find((f) => f === src + '.mp4');
    if (!name) { console.warn('missing stock clip, skipped:', src); continue; }
    file = join(clips, name);
    const d = dur(file); inPoint = Math.max(0.3, d / 2 - secs / 2); zoom = 1;
  }
  const part = join(tmp, parts.length.toString().padStart(2, '0') + '.ts');
  const l0 = luma(file, inPoint + secs / 2), g = gammaFor(l0);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(inPoint), '-t', String(secs), '-i', file,
    '-an', '-vf', `${fit(zoom)},eq=gamma=${g.toFixed(2)},${GRADE}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-f', 'mpegts', part]);
  if (r.status !== 0) { console.error('ffmpeg failed on', src, r.stderr.toString()); process.exit(1); }
  parts.push(part); used.push({ src, secs, inPoint, luma: Math.round(l0), gamma: +g.toFixed(2) });
  console.log(src, secs + 's', 'luma', Math.round(l0), 'gamma', g.toFixed(2));
}
const list = join(tmp, 'concat.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
  '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
writeFileSync(join(clips, '..', 'reel-cut.json'), JSON.stringify(used, null, 1));
const total = used.reduce((a, u) => a + u.secs, 0);
console.log(`${used.length} shots, ${total.toFixed(1)} s -> ${out}`);
