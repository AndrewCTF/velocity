// Executable guards for the operator-decided invariants in CLAUDE.md.
// Each test cites the decision it enforces (full history: docs/decisions.md).
// A failure here means a sacred behavior regressed — fix the code, or revoke
// the decision deliberately by changing BOTH the test and CLAUDE.md.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('CLAUDE.md sacred behaviors (source-scan guards)', () => {
  it('GlobeCanvas viewer opts keep requestRenderMode:true + maximumRenderTimeChange:0', () => {
    // Decision 2026-06: requestRenderMode saves GPU; maximumRenderTimeChange 0
    // is what makes SampledPositionProperty interpolation play smoothly.
    const s = read('globe/GlobeCanvas.tsx');
    expect(s).toMatch(/requestRenderMode:\s*true/);
    expect(s).toMatch(/maximumRenderTimeChange:\s*0[,\s]/);
  });

  it('PollGeoJsonAdapter never calls removeAll (upsert-by-id)', () => {
    // Decision 2026-06: removeAll()+add() re-creates entities every poll —
    // contacts blink and the motion model resets.
    expect(read('globe/adapters/PollGeoJsonAdapter.ts')).not.toContain('.removeAll(');
  });

  it('aircraft/vessel category styling keeps its SVG palette, no bare points', () => {
    // Decision: every contact renders as its category SVG icon, never a dot.
    const s = read('globe/adapters/styles.ts');
    const palette = [
      '#facc15', // airliner
      '#2dd4bf', // private
      '#c084fc', // helicopter
      '#93c5fd', // glider
      '#f59e0b', // military
      '#ef4444', // emergency / SAR / dark vessel
      '#14b8a6', // cargo
      '#d97706', // tanker
    ];
    for (const c of palette) expect(s, `missing category color ${c}`).toContain(c);
    expect(s).not.toContain('PointGraphics');
  });

  it('HistoryPlayback interpolates between recorded fixes for both aircraft and vessel replay tracks (sanctioned, docs/decisions.md 2026-07-11)', () => {
    // Decision "Replay motion: interpolation between recorded fixes is
    // sanctioned (2026-07-11)": replay draws only RECORDED REAL fixes and
    // glides between them for both kinds — scoped away from the live-path
    // no-synthesis rule. This must fail loud if a future edit "fixes" replay
    // to teleport (swaps in a CallbackProperty/held position) for either
    // kind, before HistoryPlayback.test.ts's behavioral assertions even run.
    const s = read('globe/HistoryPlayback.ts');
    expect(s).toMatch(/new Cesium\.SampledPositionProperty\(\)/);
    expect(s).toMatch(/LinearApproximation/);
    expect(s).not.toContain('CallbackProperty');
    expect(s).not.toContain('ConstantPositionProperty');
  });

  it('every new WebSocket() wraps its URL in withWsKey()', () => {
    // Decision (CLAUDE.md Auth): raw sockets bypass auth; withWsKey is mandatory.
    for (const file of walk(SRC)) {
      const s = readFileSync(file, 'utf8');
      let i = s.indexOf('new WebSocket(');
      while (i !== -1) {
        expect(
          s.slice(i, i + 250),
          `${file}: new WebSocket without withWsKey()`,
        ).toContain('withWsKey(');
        i = s.indexOf('new WebSocket(', i + 1);
      }
    }
  });
});
