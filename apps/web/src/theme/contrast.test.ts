import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMES } from './schemes.js';

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

/** `dark` is the bare `:root` default; every other scheme is an attribute block. */
const selectorFor = (id: string): string =>
  id === 'dark' ? ':root {' : `:root[data-theme='${id}'] {`;

describe.each(SCHEMES.map((s) => [selectorFor(s.id), s.id] as const))(
  'WCAG-AA text contrast — %s theme',
  (selector, _label) => {
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

  // A scheme is a COMPLETE palette, not a delta. Two whole-substrate tokens
  // were missed by the light theme when it shipped as one: `--hover` stayed at
  // the dark value, so every hoverable row flashed near-black on white. Each
  // scheme block must carry its own.
  it('overrides the substrate-dependent tokens it sits on', () => {
    // `dark` IS the default, so it defines them rather than overriding.
    const body = CSS.slice(CSS.indexOf('{', CSS.indexOf(selector)), CSS.indexOf('}', CSS.indexOf('{', CSS.indexOf(selector))));
    expect(body).toContain('--hover:');
    expect(body).toContain('--panel-bg:');
  });
  },
);

// The picker and the palettes must not drift apart: a scheme listed in
// schemes.ts with no CSS behind it renders as the previous scheme with a new
// name, and a CSS block no entry points at is unreachable.
describe('scheme registry', () => {
  it('every listed scheme has a palette in tokens.css', () => {
    for (const s of SCHEMES) expect(CSS).toContain(selectorFor(s.id));
  });

  it('every palette in tokens.css is listed', () => {
    const inCss = [...CSS.matchAll(/:root\[data-theme='([\w-]+)'\]\s*\{/g)].map((m) => m[1]);
    const listed = new Set<string>(SCHEMES.map((s) => s.id));
    // The scrollbar rules group several ids in one selector; those repeat ids
    // already listed, so a Set comparison is the right shape.
    for (const id of new Set(inCss)) expect(listed.has(id as string)).toBe(true);
  });

  it('a swatch matches the palette it advertises', () => {
    for (const s of SCHEMES) {
      const tokens = parseBlock(selectorFor(s.id));
      expect(tokens['--bg-0']?.toLowerCase()).toBe(s.swatch.bg.toLowerCase());
      expect(tokens['--bg-2']?.toLowerCase()).toBe(s.swatch.panel.toLowerCase());
      expect(tokens['--accent']?.toLowerCase()).toBe(s.swatch.accent.toLowerCase());
    }
  });
});
