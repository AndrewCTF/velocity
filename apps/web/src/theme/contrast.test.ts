import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMES } from './schemes.js';
import {
  BLUEPRINT_FONT_MONO,
  BLUEPRINT_FONT_SANS,
  BLUEPRINT_HEXES,
  BLUEPRINT_VERSION,
  blueprintName,
} from './blueprint.js';

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
function parseBlockRaw(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8}|var\(--[\w-]+\))\s*;/g)) {
    const [, name, hex] = m;
    if (name && hex) out[name] = hex;
  }
  return out;
}

/** Same as parseBlock but also captures `--x: var(--y);` aliases, resolving
 *  them against the block itself and then the `:root` default. The ink tokens
 *  are written as `var(--ink-dark)` so the dark value has one home. */
function parseBlockResolved(selector: string): Record<string, string> {
  const root = parseBlockRaw(':root {');
  const own = parseBlockRaw(selector);
  const merged: Record<string, string> = { ...root, ...own };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    let cur: string | undefined = v;
    for (let i = 0; i < 4 && cur && cur.startsWith('var('); i++) {
      cur = merged[cur.slice(4, -1).trim()];
    }
    if (cur && cur.startsWith('#')) out[k] = cur;
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
  const tokens = parseBlockRaw(selector);
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

  // A hue like --accent is a FILL. It is chosen to HOLD ink, so the ink on it
  // is a separate token per scheme — `text-white` everywhere measured 2.14:1 on
  // Night watch's amber accent and 2.34:1 on High contrast's magenta, on live
  // controls. Every fill/ink pair here clears AA.
  it.each(SCHEMES.map((s) => [s.id] as const))('%s: ink on every solid fill clears AA', (id) => {
    const t = parseBlockResolved(selectorFor(id));
    for (const fill of ['accent', 'mag', 'alert', 'ok', 'warn']) {
      const bg = t[`--${fill}`];
      const fg = t[`--on-${fill}`];
      expect(bg, `${id}: --${fill} missing`).toBeTruthy();
      expect(fg, `${id}: --on-${fill} missing`).toBeTruthy();
      expect(
        ratio(fg as string, bg as string),
        `${id}: --on-${fill} on --${fill}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  // tailwind.config.js maps the TEXT utilities onto these lightened tiers, so
  // they carry body text on the panel substrate and must clear AA there.
  it.each(SCHEMES.map((s) => [s.id] as const))('%s: the -fg text tiers clear AA', (id) => {
    const t = parseBlockResolved(selectorFor(id));
    for (const tier of ['--accent-fg', '--warn-fg', '--alert-fg', '--ok-fg']) {
      const fg = t[tier];
      expect(fg, `${id}: ${tier} missing`).toBeTruthy();
      // These tiers are used ON their own tint (`bg-ok-bg text-ok`), which is
      // the harder surface than the plain substrate and is where the badge
      // failed. Composite the 16% tint and check that too.
      const tint = (base: string): string => {
        const fill = t[tier.replace('-fg', '')] as string;
        const mix = (a: string, b: string): string => {
          const [ra, ga, ba] = toRgb(a);
          const [rb, gb, bb] = toRgb(b);
          return (
            '#' +
            [
              [ra, rb],
              [ga, gb],
              [ba, bb],
            ]
              .map(([x, y]) =>
                Math.round((x as number) * 0.16 + (y as number) * 0.84)
                  .toString(16)
                  .padStart(2, '0'),
              )
              .join('')
          );
        };
        return mix(fill, base);
      };
      const worst = Math.min(
        ratio(fg as string, t['--bg-1'] as string),
        ratio(fg as string, t['--bg-2'] as string),
        ratio(fg as string, tint(t['--bg-1'] as string)),
        ratio(fg as string, tint(t['--bg-2'] as string)),
      );
      expect(worst, `${id}: ${tier} on the panel substrate and its own tint`).toBeGreaterThanOrEqual(AA);
    }
  });

  // Rows hover, and a hovered row is where the muted tier lives. The live
  // browser sweep cannot see this — a hover state is not in the DOM until
  // something is hovered — and it hid a real failure: Daylight's `--hover`
  // put gray1 at 4.39:1 on every hoverable row in the console.
  it.each(SCHEMES.map((s) => [s.id] as const))('%s: text on a hovered row clears AA', (id) => {
    const t = parseBlockResolved(selectorFor(id));
    const hover = t['--hover'];
    expect(hover, `${id}: --hover missing`).toBeTruthy();
    for (const tier of ['--txt-1', '--txt-2', '--txt-3', '--txt-4']) {
      expect(
        ratio(t[tier] as string, hover as string),
        `${id}: ${tier} on --hover`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  // `blueprint: true` is a claim about where every colour came from. Without a
  // check it is a name; with one it is a property. Two tokens are exempt and
  // both are exempt for a reason stated in tokens.css: --hover, because on
  // several of these substrates every in-ramp step failed the contrast floor
  // (the call gotham.css already documents for the default), and the selection
  // magenta, which is welded to the globe's selection polyline and is data.
  const OFF_RAMP = /^--(hover|mag|mag-dim|mag-line|mag-fg|ink-dark|on-|sev-low|scroll-)/;
  it.each(SCHEMES.filter((s) => s.blueprint).map((s) => [s.id] as const))(
    `%s: every token is a published Blueprint ${BLUEPRINT_VERSION} swatch`,
    (id) => {
      const own = parseBlockRaw(selectorFor(id));
      const strays: string[] = [];
      for (const [name, value] of Object.entries(own)) {
        if (OFF_RAMP.test(name)) continue;
        if (!BLUEPRINT_HEXES.has(value.toLowerCase())) strays.push(`${name}: ${value}`);
      }
      expect(strays, `${id}: not in the Blueprint ramp -> ${strays.join(', ')}`).toEqual([]);
    },
  );

  // Colour is half a design system. Blueprint names no webfont — it asks for
  // the platform UI font, which is why a Blueprint app looks native on every OS
  // — and a Palantir theme that keeps the console's own Inter is wearing the
  // palette over someone else's typeface. Compare token-for-token against the
  // stack vendored from the same package version.
  it.each(SCHEMES.filter((s) => s.blueprint).map((s) => [s.id] as const))(
    '%s: carries Blueprint\'s published font stack',
    (id) => {
      const sel = selectorFor(id);
      const open = CSS.indexOf('{', CSS.indexOf(sel));
      const body = CSS.slice(open + 1, CSS.indexOf('\n}', open));
      const decl = (name: string): string => {
        const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(body);
        expect(m, `${id}: --${name} not set`).toBeTruthy();
        return (m as RegExpExecArray)[1]!.replace(/\s+/g, ' ').replace(/'/g, '"').trim();
      };
      const want = BLUEPRINT_FONT_SANS.replace(/\s+/g, ' ').replace(/'/g, '"').trim();
      expect(decl('font-sans'), `${id}: --font-sans is not $pt-font-family`).toBe(want);
      // The label voice is the same grotesque, per the README: Palantir uses one
      // refined face throughout rather than a condensed second one.
      expect(decl('font-label'), `${id}: --font-label diverges from the body face`).toBe(want);
      expect(decl('font-mono')).toBe(BLUEPRINT_FONT_MONO);
    },
  );

  it('the vendored stack asks for no font the console does not ship', () => {
    // `$icons16-family` is in the published list so inline Blueprint icons
    // resolve. This console does not ship that icon font, so carrying the entry
    // would be a request nothing can satisfy.
    expect(BLUEPRINT_FONT_SANS).not.toContain('blueprint-icons');
    expect(BLUEPRINT_FONT_SANS.endsWith('sans-serif')).toBe(true);
  });

  it('at least one scheme per family carries the Blueprint claim', () => {
    for (const family of ['dark', 'light']) {
      expect(
        SCHEMES.some((s) => s.blueprint && s.family === family),
        `no ${family} Blueprint scheme`,
      ).toBe(true);
    }
  });

  it('names the Blueprint swatch each substrate token uses, so a drift is readable', () => {
    // Not an assertion so much as a record: if this ever prints something
    // unexpected the palette moved. Kept as a check that the names resolve.
    for (const s of SCHEMES.filter((x) => x.blueprint)) {
      const t = parseBlockRaw(selectorFor(s.id));
      for (const k of ['--bg-0', '--bg-1', '--bg-2', '--txt-0', '--accent']) {
        expect(blueprintName(t[k] as string), `${s.id} ${k} = ${t[k]}`).toBeTruthy();
      }
    }
  });

  it('a swatch matches the palette it advertises', () => {
    for (const s of SCHEMES) {
      const tokens = parseBlockRaw(selectorFor(s.id));
      expect(tokens['--bg-0']?.toLowerCase()).toBe(s.swatch.bg.toLowerCase());
      expect(tokens['--bg-2']?.toLowerCase()).toBe(s.swatch.panel.toLowerCase());
      expect(tokens['--accent']?.toLowerCase()).toBe(s.swatch.accent.toLowerCase());
    }
  });
});
