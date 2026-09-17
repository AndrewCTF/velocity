// tar1090-format heatmap chunk decoder + chunk-key math. Pure: no DOM, no
// Cesium, no fetch — this is the client-side half of the binary contract in
// docs (Wave 0 replay plan): the backend proxies readsb's raw 16-byte-entry
// heatmap chunks unchanged (`GET /api/history/upstream/chunk`), and decoding
// happens here (and, off the main thread, in heatmapWorker.ts) exactly as
// tar1090's `html/script.js` `replayStep` does it.
//
// One chunk = 60 slices x 30s = one UTC half hour, ~10k aircraft, ~400k
// position rows, ~9 MB. Every entry is 16 bytes / four little-endian int32
// words: [hex, lat, lon, (alt:int16 | gs:int16)]. Three row shapes share that
// layout:
//   - separator: word0 === SEPARATOR. word1:word2 is a 64-bit (hi:lo) unsigned
//     epoch-ms timestamp for every row that follows, until the next separator;
//     word3's low 16 bits are the slice interval in ms (30000 normally).
//   - callsign/squawk: word1 (the lat slot) >= 1<<30. hex = word0 & 0xffffff
//     ('~' prefixed if bit 24 is set), squawk = word1 & 0xffff (decimal,
//     zero-padded to 4), callsign = 8 ASCII bytes living in words [i+2, i+3]
//     of THIS entry (byte offset 4*(i+2)), trimmed of trailing NUL/spaces.
//   - position: hex as above; addrtype = top 5 bits of word0 (bits 27-31);
//     lat/lon = word1/word2 / 1e6; alt = sign-extended low 16 bits of word3
//     (-123 = on the ground, -124 = unknown, else *25 feet); gs = sign-extended
//     high 16 bits of word3, /10 knots (-1 = unknown). Bearing is NOT in the
//     stream — `track` is the great-circle bearing from the previous fix seen
//     for that hex earlier in this same chunk, null for the first.

const SEPARATOR = 0x0e7f7c9d;
const CALLSIGN_LAT_MIN = 1 << 30; // 1_073_741_824 — marks a callsign/squawk row

export interface HeatmapPosition {
  hex: string; // 6-char lowercase hex, '~' prefixed when non-ICAO (TIS-B/MLAT track file)
  addrtype: number; // 0 adsb_icao,1 adsb_icao_nt,2 adsr_icao,3 tisb_icao,4 adsc,
  //                    5 mlat,6 other,7 mode_s,8 adsb_other,9 adsr_other,
  //                    10 tisb_trackfile,11 tisb_other,12 mode_ac
  lat: number;
  lon: number;
  alt: number | 'ground' | null; // feet; null = unknown
  gs: number | null; // knots; null = unknown
  t: number; // epoch ms, from the slice separator this row belongs to
  track: number | null; // derived great-circle bearing from this hex's prior fix in this chunk
}

export interface HeatmapCallsign {
  hex: string;
  squawk: string; // 4-digit decimal, zero-padded
  callsign: string; // trimmed; '' if none
  t: number; // epoch ms
}

export interface DecodedHeatmapChunk {
  positions: HeatmapPosition[];
  callsigns: HeatmapCallsign[];
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Decode a raw readsb heatmap chunk buffer. Throws if the byte length is not
 *  a multiple of 16 — every entry is a fixed 16 bytes, so a partial entry
 *  means the buffer is not a heatmap chunk at all. */
export function decodeHeatmapChunk(buf: ArrayBuffer): DecodedHeatmapChunk {
  if (buf.byteLength === 0 || buf.byteLength % 16 !== 0) {
    throw new Error(`heatmap chunk: invalid byteLength ${buf.byteLength} (not a positive multiple of 16)`);
  }
  const words = new Int32Array(buf);
  const uwords = new Uint32Array(buf);
  const bytes = new Uint8Array(buf);

  const positions: HeatmapPosition[] = [];
  const callsigns: HeatmapCallsign[] = [];
  const lastByHex = new Map<string, { lat: number; lon: number }>();

  let sliceTs = NaN;

  for (let i = 0; i < words.length; i += 4) {
    const w0 = words[i]!;
    const w1 = words[i + 1]!;
    const w3 = words[i + 3]!;

    if (w0 === SEPARATOR) {
      const hi = uwords[i + 1]!;
      const lo = uwords[i + 2]!;
      sliceTs = hi * 4294967296 + lo;
      // interval_ms = w3 & 0xffff is part of the contract but unused here —
      // the chunk-key/index math (below) derives slices from wall-clock time,
      // never from counting separators.
      continue;
    }

    const hexBits = w0 & 0xffffff;
    const hex = hexBits.toString(16).padStart(6, '0');
    const prefixed = (w0 & 0x1000000) !== 0 ? `~${hex}` : hex;

    if (w1 >= CALLSIGN_LAT_MIN) {
      const squawk = (w1 & 0xffff).toString(10).padStart(4, '0');
      const byteOff = 4 * (i + 2);
      const chars: string[] = [];
      for (let b = 0; b < 8; b++) {
        const c = bytes[byteOff + b]!;
        if (c === 0) break;
        chars.push(String.fromCharCode(c));
      }
      const callsign = chars.join('').replace(/\s+$/, '');
      callsigns.push({ hex: prefixed, squawk, callsign, t: sliceTs });
      continue;
    }

    const addrtype = (w0 >>> 27) & 0x1f;
    const lat = w1 / 1e6;
    const lon = words[i + 2]! / 1e6;
    const rawAlt = (w3 << 16) >> 16;
    const alt: number | 'ground' | null = rawAlt === -123 ? 'ground' : rawAlt === -124 ? null : rawAlt * 25;
    const rawGs = w3 >> 16;
    const gs = rawGs === -1 ? null : rawGs / 10;

    const prev = lastByHex.get(prefixed);
    const track = prev ? bearingDeg(prev.lat, prev.lon, lat, lon) : null;
    lastByHex.set(prefixed, { lat, lon });

    positions.push({ hex: prefixed, addrtype, lat, lon, alt, gs, t: sliceTs, track });
  }

  return { positions, callsigns };
}

// ── Chunk-key math ──────────────────────────────────────────────────────────
// A chunk key is `${day} ${index}`: index NN = 2*hourUTC + floor(minUTC/30),
// 0..47, one per UTC half hour.

export const CHUNK_MS = 30 * 60 * 1000;
export const CHUNKS_PER_DAY = 48;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD" in UTC for an epoch-ms instant. */
export function dayUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 0..47 half-hour index in UTC for an epoch-ms instant. */
export function chunkIndexUtc(ms: number): number {
  const d = new Date(ms);
  return 2 * d.getUTCHours() + Math.floor(d.getUTCMinutes() / 30);
}

export interface ChunkKey {
  day: string;
  index: number;
}

export function chunkKeyForMs(ms: number): ChunkKey {
  return { day: dayUtc(ms), index: chunkIndexUtc(ms) };
}

/** Epoch ms at the start of the half hour `${day} ${index}`. */
export function chunkStartMs(day: string, index: number): number {
  return Date.parse(`${day}T00:00:00Z`) + index * CHUNK_MS;
}

export function nextChunk(day: string, index: number): ChunkKey {
  if (index >= CHUNKS_PER_DAY - 1) {
    const nextDayMs = Date.parse(`${day}T00:00:00Z`) + 24 * 3600 * 1000;
    return { day: dayUtc(nextDayMs), index: 0 };
  }
  return { day, index: index + 1 };
}

export function prevChunk(day: string, index: number): ChunkKey {
  if (index <= 0) {
    const prevDayMs = Date.parse(`${day}T00:00:00Z`) - 24 * 3600 * 1000;
    return { day: dayUtc(prevDayMs), index: CHUNKS_PER_DAY - 1 };
  }
  return { day, index: index - 1 };
}
