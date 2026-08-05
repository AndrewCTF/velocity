// The colour schemes the console ships with.
//
// One entry per `:root[data-theme='<id>']` block in tokens.css (`dark` is the
// bare `:root` default). This list is what the View menu and Settings render,
// and what `contrast.test.ts` iterates, so a scheme cannot be added to the CSS
// and forgotten by the UI, or added here without a palette behind it — the test
// asserts the two agree.
//
// `swatch` is the three colours a picker needs to show what a scheme looks like
// without applying it: substrate, panel, accent. They are copies of the tokens,
// which is the one place duplication is worth it: reading a token's computed
// value requires the scheme to already be applied, and a picker has to draw all
// of them at once.

export type SchemeId =
  | 'dark'
  | 'midnight'
  | 'slate'
  | 'amber'
  | 'contrast'
  | 'light'
  | 'paper'
  | 'bp-dark'
  | 'bp-turquoise'
  | 'bp-indigo'
  | 'bp-light';

export interface Scheme {
  id: SchemeId;
  label: string;
  /** One line, stating when an operator would pick this one. */
  hint: string;
  family: 'dark' | 'light';
  /** True when every token comes from Palantir's published Blueprint ramp.
   *  `theme/contrast.test.ts` holds these to that claim swatch by swatch, so it
   *  is a checked property rather than a name. */
  blueprint?: true;
  swatch: { bg: string; panel: string; accent: string };
}

export const SCHEMES: readonly Scheme[] = [
  {
    id: 'dark',
    label: 'Warm ink',
    hint: 'The default. A warm dark grey, lifted off black so panels read as material.',
    family: 'dark',
    swatch: { bg: '#111418', panel: '#252a31', accent: '#2d72d2' },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    hint: 'Cool blue-black. The operations-room look, colder than the default.',
    family: 'dark',
    swatch: { bg: '#0b0f1a', panel: '#1a2233', accent: '#4c8dff' },
  },
  {
    id: 'slate',
    label: 'Slate',
    hint: 'Neutral graphite with a teal accent, so blue stays a data colour.',
    family: 'dark',
    swatch: { bg: '#14161a', panel: '#23272e', accent: '#16a394' },
  },
  {
    id: 'amber',
    label: 'Night watch',
    hint: 'Warm amber substrate for a darkened room. Threat hues stay distinct.',
    family: 'dark',
    swatch: { bg: '#0f0d0a', panel: '#201c15', accent: '#e0a838' },
  },
  {
    id: 'contrast',
    label: 'High contrast',
    hint: 'Near-black with a bright ramp and visible hairlines. Every tier clears AAA.',
    family: 'dark',
    swatch: { bg: '#000000', panel: '#141414', accent: '#3d8bfd' },
  },
  {
    id: 'light',
    label: 'Daylight',
    hint: 'Cool white. For a bright room or a projector.',
    family: 'light',
    swatch: { bg: '#f6f7f9', panel: '#edeff2', accent: '#215db0' },
  },
  {
    id: 'paper',
    label: 'Paper',
    hint: 'Warm light, print-adjacent, where Daylight reads clinical.',
    family: 'light',
    swatch: { bg: '#f7f3e9', panel: '#f2ede1', accent: '#1c5e8c' },
  },

  // ── Blueprint ─────────────────────────────────────────────────────────────
  // Palantir's design system is published as Blueprint, and this console's
  // grammar is already calibrated against it: `$pt-button-height: 30px` is what
  // pins the whole metric scale, and the README records the ramp as "Blueprint
  // 5.1.16 dark, with zero tokens outside it".
  //
  // The default scheme is close to that but not held to it — it has drifted a
  // hover, a magenta and a couple of threat hues off-ramp. These four ARE held
  // to it: `theme/blueprint.ts` carries the published swatches extracted from
  // the package, and the guard fails on any token that is not one of them,
  // apart from two exemptions it names.
  //
  // They are named for the design system, not for the products built on it.
  // Blueprint is what these palettes actually are, and a picker full of product
  // names would imply an affiliation this project does not have.
  {
    id: 'bp-dark',
    label: 'Blueprint dark',
    hint: "Palantir's published dark ramp, on the reference's own panel surface.",
    family: 'dark',
    blueprint: true,
    swatch: { bg: '#111418', panel: '#2f343c', accent: '#2d72d2' },
  },
  {
    id: 'bp-turquoise',
    label: 'Blueprint turquoise',
    hint: 'The same substrate, accented turquoise so blue stays a data colour.',
    family: 'dark',
    blueprint: true,
    swatch: { bg: '#111418', panel: '#2f343c', accent: '#00a396' },
  },
  {
    id: 'bp-indigo',
    label: 'Blueprint indigo',
    hint: 'The same substrate, accented with the hue reserved for model output.',
    family: 'dark',
    blueprint: true,
    swatch: { bg: '#111418', panel: '#2f343c', accent: '#7961db' },
  },
  {
    id: 'bp-light',
    label: 'Blueprint light',
    hint: "Palantir's published light surface: white panels on light grey.",
    family: 'light',
    blueprint: true,
    swatch: { bg: '#edeff2', panel: '#f6f7f9', accent: '#215db0' },
  },
];

export const SCHEME_IDS: readonly SchemeId[] = SCHEMES.map((s) => s.id);

export function isSchemeId(v: unknown): v is SchemeId {
  return typeof v === 'string' && (SCHEME_IDS as readonly string[]).includes(v);
}

export function schemeById(id: SchemeId): Scheme {
  // Non-null by construction: SchemeId is derived from this list.
  return SCHEMES.find((s) => s.id === id) as Scheme;
}
