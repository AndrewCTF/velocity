/** A token colour that still works when Tailwind's `/NN` opacity modifier is
 *  applied to it.
 *
 *  A bare `var(--bg-1)` does not. Tailwind cannot decompose an opaque hex held
 *  in a custom property, so every `bg-bg-1/95`, `bg-bg-2/60`, `border-line/40`
 *  in the codebase compiled to `rgba(0,0,0,0)` — fully TRANSPARENT, not
 *  95% opaque. Measured in the running app: `getComputedStyle` on a
 *  `bg-bg-1/95` element returned `rgba(0, 0, 0, 0)`, across 85 call sites, so
 *  every floating banner, popover and dock had no background and the globe read
 *  straight through the text on top of it.
 *
 *  color-mix keeps the tokens as plain hex (raw `var(--bg-1)` in CSS files
 *  keeps working, and both themes stay one list) while giving Tailwind
 *  something it can apply an alpha to. */
const token = (name) => ({ opacityValue }) =>
  opacityValue === undefined
    ? `var(${name})`
    : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Per frontend.md §2/§3: the only saturated color in the UI belongs to data.
      // We expose tokens as CSS variables (see tokens.css) and reference them
      // here so Tailwind utilities like bg-bg-1 resolve to var(--bg-1).
      // `textColor` is split out from `colors` for the semantic hues. A hue like
      // --accent is a FILL: bg-accent must be it, and text-accent must NOT,
      // because the fill is chosen to hold ink rather than to be ink. Measured
      // in the browser: text-accent on the panel substrate is 3.46:1 under the
      // default scheme and 2.63:1 under Paper, both under AA, on live text (the
      // analyst-console caret, the "details" link in the coverage banner).
      // Mapping the TEXT utility onto the matching --*-fg tier fixes every one
      // of the ~30 call sites at once and cannot drift back.
      textColor: ({ theme }) => ({
        ...theme('colors'),
        accent: token('--accent-fg'),
        warn: token('--warn-fg'),
        alert: token('--alert-fg'),
        ok: token('--ok-fg'),
      }),
      colors: {
        'bg-0': token('--bg-0'),
        'bg-1': token('--bg-1'),
        'bg-2': token('--bg-2'),
        'bg-3': token('--bg-3'),
        'bg-4': token('--bg-4'),
        line: token('--line'),
        'line-2': token('--line-2'),
        'txt-0': token('--txt-0'),
        'txt-1': token('--txt-1'),
        'txt-2': token('--txt-2'),
        'txt-3': token('--txt-3'),
        'txt-4': token('--txt-4'),
        accent: token('--accent'),
        'accent-dim': token('--accent-dim'),
        'accent-line': token('--accent-line'),
        'accent-fg': token('--accent-fg'),
        warn: token('--warn'),
        'warn-bg': token('--warn-bg'),
        'warn-line': token('--warn-line'),
        'warn-fg': token('--warn-fg'),
        alert: token('--alert'),
        'alert-bg': token('--alert-bg'),
        'alert-line': token('--alert-line'),
        'alert-fg': token('--alert-fg'),
        ok: token('--ok'),
        'ok-bg': token('--ok-bg'),
        'ok-line': token('--ok-line'),
        'ok-fg': token('--ok-fg'),
        mag: token('--mag'),
        'mag-dim': token('--mag-dim'),
        'mag-line': token('--mag-line'),
        'mag-fg': token('--mag-fg'),
        'sev-low': token('--sev-low'),
      },
      fontFamily: {
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
        sans: ['Inter', '"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        label: ['Inter', '"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
      },
    },
  },
  plugins: [],
};
