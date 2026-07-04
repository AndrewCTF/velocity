// Convert a Gaussian-splat .ply → .spz (Niantic, ~10x smaller, full SH preserved)
// using Spark's transcodeSpz, so the in-app Spark viewer can stream the FULL
// splat (no opacity cap). Runs in node (data-only path: parse + quantize + gzip).
import fs from 'node:fs';
import { transcodeSpz, SplatFileType } from '@sparkjsdev/spark';
const [inP, outP] = process.argv.slice(2);
if (!inP || !outP) { console.error('usage: ply2spz.mjs <in.ply> <out.spz>'); process.exit(2); }
const ply = fs.readFileSync(inP);
const u8 = new Uint8Array(ply.buffer, ply.byteOffset, ply.byteLength);
const res = await transcodeSpz({ inputs: [{ fileBytes: u8, fileType: SplatFileType.PLY }] });
fs.writeFileSync(outP, res.fileBytes);
console.log('SPZ_OK', outP, (res.fileBytes.length / 1048576).toFixed(1), 'MB');
