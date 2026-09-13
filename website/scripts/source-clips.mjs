// Source real stock footage for the hero reel from the Pexels Video API.
//
// palantir.com's hero is ~60 real-world shots at ~1 s each, dark and low-key,
// one light source per frame, the product shown small on a device. The reel
// this feeds is the same grammar. Nothing here is generated; every clip is
// licensed under the Pexels licence (free use, no credit required).
//
//   node scripts/source-clips.mjs reel.json [outdir]
//
// Key: PEXELS_KEY env or ~/.pexels-key. Writes <outdir>/manifest.json with
// the id, page URL, chosen file and duration per slot, so the cut is
// reproducible from the manifest and never from memory.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';

const [configPath, outArg] = process.argv.slice(2);
if (!configPath) { console.error('usage: source-clips.mjs <reel.json> [outdir]'); process.exit(2); }
const KEY = process.env.PEXELS_KEY?.trim() || readFileSync(join(homedir(), '.pexels-key'), 'utf8').trim();
const SLOTS = JSON.parse(readFileSync(configPath, 'utf8'));
const OUT = resolve(outArg || join(dirname(resolve(configPath)), 'clips'));
mkdirSync(OUT, { recursive: true });

// Stock search returns adjacent subjects for domain vocabulary. Anything that
// reads as a customer, an endorsement or a person's face is out; the site's
// authenticity rule bans invented affiliation and palantir itself carries a
// no-endorsement disclaimer under its hero.
const BANNED = ['soldier', 'military', 'army', 'navy', 'air force', 'logo', 'brand', 'flag',
  'portrait', 'face', 'woman', 'man ', 'people', 'crowd', 'wedding', 'party', 'cartoon',
  'animation', 'render', '3d', 'text', 'title', 'presentation'];

const api = async (u) => {
  const r = await fetch(u, { headers: { Authorization: KEY } });
  if (!r.ok) throw new Error(`pexels ${r.status} ${u}`);
  return r.json();
};
// Best file: widest at or above 1920, mp4, landscape.
const bestFile = (v) => v.video_files
  .filter((f) => f.file_type === 'video/mp4' && f.width >= 1920 && f.width > f.height)
  .sort((a, b) => b.width - a.width)[0];

const manifest = [];
const used = new Set();
for (const s of SLOTS) {
  const pool = new Map();
  for (const q of s.queries) {
    const j = await api(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=30&orientation=landscape&size=large`);
    for (const v of j.videos || []) {
      if (used.has(v.id) || v.duration < 3 || v.duration > 60) continue;
      const alt = (v.url + ' ' + (v.tags || []).join(' ')).toLowerCase().replace(/-/g, ' ');
      if (BANNED.some((b) => alt.includes(b)) || (s.ban || []).some((b) => alt.includes(b))) continue;
      const hits = (s.want || []).filter((w) => alt.includes(w)).length;
      if (!hits) continue;
      const f = bestFile(v);
      if (!f) continue;
      pool.set(v.id, { v, f, score: hits * 2 + (f.width >= 2560 ? 1 : 0) });
    }
  }
  const pick = [...pool.values()].sort((a, b) => b.score - a.score).slice(0, s.take || 1);
  if (!pick.length) { console.warn(`NO MATCH for slot ${s.slot}`); continue; }
  for (const { v, f } of pick) {
    used.add(v.id);
    const file = join(OUT, `${s.slot}-${v.id}.mp4`);
    if (!existsSync(file)) {
      const r = await fetch(f.link);
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    manifest.push({ slot: s.slot, id: v.id, url: v.url, width: f.width, height: f.height, duration: v.duration, file });
    console.log(s.slot, v.id, `${f.width}x${f.height}`, `${v.duration}s`, v.url);
  }
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`${manifest.length} clips -> ${OUT}`);
