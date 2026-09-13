// Build the seven carousel clips from real stock footage: one Pexels clip per
// tab, cut from its middle, graded with the hero reel's grade so the carousel
// and the hero read as one camera. Writes assets/tab-<slot>.mp4 (8 s loop,
// 1920x1080) and assets/tab-<slot>.jpg (poster, first frame after grade).
//
//   node scripts/build-tabs.mjs <clipsdir> <picks.json>
//
// picks.json: {"air":"air-12345", "space":{"id":"...","gamma":1.1}, ...} — the
// manifest slot-id chosen by eye from the contact sheet, so the choice is recorded
// and not re-guessed. A clip that should stay dark (night lights from orbit) sets
// its own gamma; the luma pull otherwise lifts it into a grey wash.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const [clipsArg, picksArg] = process.argv.slice(2);
const clips = resolve(clipsArg); const PICKS = JSON.parse(readFileSync(picksArg, 'utf8'));
const OUT = resolve('assets'); const SECS = 8;
const GRADE = 'eq=saturation=0.68:contrast=1.06:brightness=-0.02,'
  + "curves=master='0/0.03 0.22/0.15 0.55/0.48 0.85/0.78 1/0.90',"
  + 'colorbalance=rs=0.02:gs=0.0:bs=-0.03:rm=0.01:bm=-0.02:rh=0.05:gh=0.02:bh=-0.06,'
  + 'noise=alls=7:allf=t+u,vignette=PI/4.6';
const fit = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24,setsar=1';
const dur = (f) => parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString());
const luma = (f, at) => { const b = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', f, '-frames:v', '1', '-vf', 'scale=96:54,format=gray', '-f', 'rawvideo', '-']).stdout; return b.reduce((a, x) => a + x, 0) / b.length; };
// The slide card carries its own dark panel, so the carousel can sit a little
// brighter than the hero (66) and still keep the title legible.
const TARGET = 76;
const gammaFor = (l) => Math.min(1.9, Math.max(0.5, Math.pow(TARGET / Math.max(l, 1), 0.7)));
const run = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); } };

for (const [slot, pick] of Object.entries(PICKS)) {
  const id = typeof pick === 'string' ? pick : pick.id;
  const file = join(clips, id + '.mp4');
  if (!existsSync(file)) { console.error('missing', file); process.exit(1); }
  const d = dur(file); const secs = Math.min(SECS, d - 0.6); const inPoint = Math.max(0.3, d / 2 - secs / 2);
  const g = typeof pick === 'object' && pick.gamma ? pick.gamma : gammaFor(luma(file, inPoint + 1));
  const vf = `${fit},eq=gamma=${g.toFixed(2)},${GRADE}`;
  const mp4 = join(OUT, `tab-${slot}.mp4`), jpg = join(OUT, `tab-${slot}.jpg`);
  run(['-ss', String(inPoint), '-t', String(secs), '-i', file, '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  run(['-ss', '0.5', '-i', mp4, '-frames:v', '1', '-q:v', '3', jpg]);
  const chk = spawnSync('ffmpeg', ['-v', 'error', '-i', mp4, '-f', 'null', '-']).stderr.toString().trim();
  console.log(slot, id, `${secs.toFixed(1)}s in@${inPoint.toFixed(1)} gamma ${g.toFixed(2)}`, chk ? 'DECODE ERRORS' : 'decodes clean');
}
