/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Per frontend.md §2/§3: the only saturated color in the UI belongs to data.
      // We expose tokens as CSS variables (see tokens.css) and reference them
      // here so Tailwind utilities like bg-bg-1 resolve to var(--bg-1).
      colors: {
        'bg-0': 'var(--bg-0)',
        'bg-1': 'var(--bg-1)',
        'bg-2': 'var(--bg-2)',
        'bg-3': 'var(--bg-3)',
        'bg-4': 'var(--bg-4)',
        line: 'var(--line)',
        'line-2': 'var(--line-2)',
        'txt-0': 'var(--txt-0)',
        'txt-1': 'var(--txt-1)',
        'txt-2': 'var(--txt-2)',
        'txt-3': 'var(--txt-3)',
        'txt-4': 'var(--txt-4)',
        accent: 'var(--accent)',
        'accent-dim': 'var(--accent-dim)',
        'accent-line': 'var(--accent-line)',
        warn: 'var(--warn)',
        'warn-bg': 'var(--warn-bg)',
        alert: 'var(--alert)',
        'alert-bg': 'var(--alert-bg)',
        ok: 'var(--ok)',
        mag: 'var(--mag)',
        'mag-dim': 'var(--mag-dim)',
        'mag-line': 'var(--mag-line)',
        'sev-low': 'var(--sev-low)',
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
