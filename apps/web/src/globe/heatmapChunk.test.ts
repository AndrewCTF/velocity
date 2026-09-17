import { describe, expect, it } from 'vitest';
import {
  decodeHeatmapChunk,
  chunkIndexUtc,
  dayUtc,
  chunkKeyForMs,
  chunkStartMs,
  nextChunk,
  prevChunk,
} from './heatmapChunk.js';

// Builds a synthetic readsb heatmap chunk by hand: two 30s slices, a
// callsign/squawk row, a '~' non-ICAO position with a chosen addrtype, a
// ground-altitude sentinel, an unknown-altitude sentinel, and an unknown
// ground-speed sentinel — exercising every row shape the format spec names.
function packAltGs(alt: number, gs: number): number {
  return ((gs & 0xffff) << 16) | (alt & 0xffff);
}

interface Entry {
  word0: number;
  word1: number;
  word2: number;
  word3: number;
}

function buildChunk(entries: Entry[]): ArrayBuffer {
  const buf = new ArrayBuffer(entries.length * 16);
  const view = new DataView(buf);
  entries.forEach((e, i) => {
    const off = i * 16;
    view.setInt32(off, e.word0, true);
    view.setInt32(off + 4, e.word1, true);
    view.setInt32(off + 8, e.word2, true);
    view.setInt32(off + 12, e.word3, true);
  });
  return buf;
}

function separatorEntry(tsMs: number, intervalMs: number): Entry {
  const hi = Math.floor(tsMs / 4294967296);
  const lo = tsMs % 4294967296;
  return { word0: 0x0e7f7c9d, word1: hi | 0, word2: lo | 0, word3: intervalMs };
}

/** A callsign/squawk entry. The 8-byte callsign lives in words 2+3 of THIS
 *  entry, set afterward via the DataView directly (buildChunk only knows
 *  about int32 words, ASCII bytes need byte-level access). */
function writeCallsignBytes(buf: ArrayBuffer, entryIndex: number, text: string): void {
  const bytes = new Uint8Array(buf);
  const off = 16 * entryIndex + 8; // byte offset 4*(i+2) where i = entryIndex*4
  for (let b = 0; b < 8; b++) bytes[off + b] = b < text.length ? text.charCodeAt(b) : 0;
}

const TS0 = Date.UTC(2024, 5, 1, 12, 0, 0);
const INTERVAL_MS = 30_000;
const TS1 = TS0 + INTERVAL_MS;

describe('decodeHeatmapChunk', () => {
  it('decodes a separator, a callsign row, and two position slices of the same hex', () => {
    const entries: Entry[] = [
      separatorEntry(TS0, INTERVAL_MS),
      // Callsign/squawk row: hex a1b2c3, squawk 1234, no '~' prefix.
      { word0: 0xa1b2c3, word1: (1 << 30) | 1234, word2: 0, word3: 0 },
      // Position 1: '~' prefixed hex (non-ICAO), addrtype 5 (mlat),
      // on the ground (-123), unknown ground speed (-1).
      {
        word0: 0x1000000 | (5 << 27) | 0xdead2f,
        word1: Math.round(51.5 * 1e6),
        word2: Math.round(-0.12 * 1e6),
        word3: packAltGs(-123, -1),
      },
      separatorEntry(TS1, INTERVAL_MS),
      // Position 2: same hex, different fix -> derived track; unknown
      // altitude (-124), known ground speed (250 -> 25.0 kt).
      {
        word0: 0x1000000 | (5 << 27) | 0xdead2f,
        word1: Math.round(51.6 * 1e6),
        word2: Math.round(-0.1 * 1e6),
        word3: packAltGs(-124, 250),
      },
    ];
    const buf = buildChunk(entries);
    writeCallsignBytes(buf, 1, 'UAL123');

    const decoded = decodeHeatmapChunk(buf);

    expect(decoded.callsigns).toHaveLength(1);
    expect(decoded.callsigns[0]).toMatchObject({ hex: 'a1b2c3', squawk: '1234', callsign: 'UAL123', t: TS0 });

    expect(decoded.positions).toHaveLength(2);
    const [p1, p2] = decoded.positions;

    expect(p1!.hex).toBe('~dead2f');
    expect(p1!.addrtype).toBe(5);
    expect(p1!.lat).toBeCloseTo(51.5, 5);
    expect(p1!.lon).toBeCloseTo(-0.12, 5);
    expect(p1!.alt).toBe('ground');
    expect(p1!.gs).toBeNull();
    expect(p1!.t).toBe(TS0);
    expect(p1!.track).toBeNull(); // first fix for this hex in the chunk

    expect(p2!.hex).toBe('~dead2f');
    expect(p2!.alt).toBeNull(); // -124 sentinel
    expect(p2!.gs).toBeCloseTo(25.0, 5);
    expect(p2!.t).toBe(TS1);
    expect(p2!.track).not.toBeNull(); // derived from p1 -> p2
    expect(p2!.track).toBeGreaterThanOrEqual(0);
    expect(p2!.track).toBeLessThan(360);
  });

  it('decodes a normal (non-ground, non-tilde) position and a real altitude/ground-speed value', () => {
    const entries: Entry[] = [
      separatorEntry(TS0, INTERVAL_MS),
      {
        word0: 0x00abcdef, // addrtype 0 (adsb_icao), no '~' bit
        word1: Math.round(40.0 * 1e6),
        word2: Math.round(-74.0 * 1e6),
        word3: packAltGs(1400, 450), // 1400*25=35000 ft, 450/10=45.0 kt
      },
    ];
    const decoded = decodeHeatmapChunk(buildChunk(entries));
    expect(decoded.positions).toHaveLength(1);
    const p = decoded.positions[0]!;
    expect(p.hex).toBe('abcdef');
    expect(p.addrtype).toBe(0);
    expect(p.alt).toBe(35_000);
    expect(p.gs).toBeCloseTo(45.0, 5);
  });

  it('rejects a buffer whose length is not a multiple of 16', () => {
    expect(() => decodeHeatmapChunk(new ArrayBuffer(15))).toThrow();
    expect(() => decodeHeatmapChunk(new ArrayBuffer(0))).toThrow();
  });
});

describe('chunk-key math', () => {
  it('derives the 0..47 half-hour index from a UTC Date', () => {
    expect(chunkIndexUtc(Date.UTC(2024, 5, 1, 0, 0, 0))).toBe(0);
    expect(chunkIndexUtc(Date.UTC(2024, 5, 1, 0, 29, 59))).toBe(0);
    expect(chunkIndexUtc(Date.UTC(2024, 5, 1, 0, 30, 0))).toBe(1);
    expect(chunkIndexUtc(Date.UTC(2024, 5, 1, 12, 0, 0))).toBe(24);
    expect(chunkIndexUtc(Date.UTC(2024, 5, 1, 23, 59, 59))).toBe(47);
  });

  it('formats the UTC day and combines it with the index', () => {
    expect(dayUtc(Date.UTC(2024, 5, 1, 23, 59, 0))).toBe('2024-06-01');
    expect(chunkKeyForMs(Date.UTC(2024, 5, 1, 23, 59, 0))).toEqual({ day: '2024-06-01', index: 47 });
  });

  it('chunkStartMs is the inverse of chunkKeyForMs at a half-hour boundary', () => {
    const ms = Date.UTC(2024, 5, 1, 4, 30, 0);
    const key = chunkKeyForMs(ms);
    expect(chunkStartMs(key.day, key.index)).toBe(ms);
  });

  it('nextChunk/prevChunk step within a day and roll over at the edges', () => {
    expect(nextChunk('2024-06-01', 10)).toEqual({ day: '2024-06-01', index: 11 });
    expect(nextChunk('2024-06-01', 47)).toEqual({ day: '2024-06-02', index: 0 });
    expect(prevChunk('2024-06-01', 11)).toEqual({ day: '2024-06-01', index: 10 });
    expect(prevChunk('2024-06-01', 0)).toEqual({ day: '2024-05-31', index: 47 });
  });
});
