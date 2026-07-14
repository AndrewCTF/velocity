import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// WCAG-AA contrast guard (added 2026-07-13). The text ramp previously shipped
// muted tiers that failed AA (dark txt-3 2.81:1, txt-4 1.71:1) while carrying
// live text. This test parses tokens.css and asserts every text tier clears the
// AA bar for NORMAL text (4.5:1) against BOTH the panel bg (bg-1) and the lighter
// card bg (bg-2, where most dossier text actually sits) — in both themes. If a
// future palette tweak dims a tier below AA, this fails loud instead of silently
// regressing accessibility. See docs/decisions.md (typography & WCAG-AA pass).

// vitest runs with cwd = apps/web; tokens.css is the source of truth this guards.
const CSS = readFileSync(join(process.cwd(), 'src/theme/tokens.css'), 'utf8');

// Pull `--name: #hex;` decls out of a single `:root {…}` / `:root[…] {…}` block.
function parseBlock(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    const [, name, hex] = m;
    if (name && hex) out[name] = hex;
  }
  return out;
}

function toRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function relLum(hex: string): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = toRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(fg: string, bg: string): number {
  const a = relLum(fg);
  const b = relLum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;
// txt-4 is the dimmest live-text tier; hold it to AA too (it carries hints/notes,
// not only disabled controls, so it is NOT WCAG-exempt).
const TEXT_TIERS = ['--txt-0', '--txt-1', '--txt-2', '--txt-3', '--txt-4'] as const;

describe.each([
  [':root {', 'dark'],
  [":root[data-theme='light'] {", 'light'],
])('WCAG-AA text contrast — %s theme', (selector, _label) => {
  const tokens = parseBlock(selector);
  const tok = (name: string): string => {
    const v = tokens[name];
    if (!v) throw new Error(`token ${name} not found in ${selector}`);
    return v;
  };
  // Most panel/card text sits on bg-1 (rail) or bg-2 (card). Guard the harder one
  // per tier by taking the MINIMUM ratio across both surfaces.
  for (const tier of TEXT_TIERS) {
    it(`${tier} clears AA on both bg-1 and bg-2`, () => {
      const fg = tok(tier);
      const rBg1 = ratio(fg, tok('--bg-1'));
      const rBg2 = ratio(fg, tok('--bg-2'));
      expect(Math.min(rBg1, rBg2)).toBeGreaterThanOrEqual(AA);
    });
  }

  it('the muted ramp stays monotonic (txt-2 ≥ txt-3 ≥ txt-4 contrast)', () => {
    const c = (t: string): number => ratio(tok(t), tok('--bg-1'));
    expect(c('--txt-2')).toBeGreaterThanOrEqual(c('--txt-3'));
    expect(c('--txt-3')).toBeGreaterThanOrEqual(c('--txt-4'));
  });
});
