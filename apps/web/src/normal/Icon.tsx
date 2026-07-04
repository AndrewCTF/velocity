// Icon.tsx — tiny inline-SVG icon component for the Normal dashboard chrome.
//
// Self-contained: no runtime deps. The geometry below is a static, author-controlled
// port of /tmp/gotham/assets/icons.js (24×24, stroke-based, inherits currentColor).
// Because every entry in ICONS is a hard-coded string literal in this file — never
// user input, never fetched — rendering it via dangerouslySetInnerHTML on a <g> is
// safe (no XSS surface). React cannot parse raw SVG-markup strings as JSX children,
// so the inner-markup-string + <g dangerouslySetInnerHTML> pattern is the idiomatic
// way to drive a single <svg> shell from a path-data table.
//
// Uses the global JSX namespace (React 18 classic runtime), matching the rest of
// the codebase (e.g. shell/instruments.tsx) — no React import is needed here.

export type IconName =
  | 'globe'
  | 'map'
  | 'plane'
  | 'jet'
  | 'heli'
  | 'ship'
  | 'anchor'
  | 'satellite'
  | 'fire'
  | 'quake'
  | 'layers'
  | 'feed'
  | 'signal'
  | 'sliders'
  | 'filter'
  | 'search'
  | 'settings'
  | 'user'
  | 'chevron-down'
  | 'chevron-right'
  | 'x'
  | 'expand'
  | 'crosshair'
  | 'file'
  | 'network'
  | 'sparkle'
  | 'bell'
  | 'clock'
  | 'target'
  | 'image'
  | 'play'
  | 'pause'
  | 'step-f'
  | 'step-b'
  | 'bookmark'
  | 'gauge'
  | 'shield'
  | 'hexagon'
  | 'route'
  | 'pin'
  | 'info'
  | 'warning'
  | 'check'
  | 'plus'
  | 'minus'
  | 'grid'
  | 'sun'
  | 'moon';

// Static, author-controlled inner-SVG markup keyed by icon name. Ported verbatim
// from the design sprite (icons.js). NOT user-supplied — safe for dangerouslySetInnerHTML.
const ICONS: Record<IconName, string> = {
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.5 2.8 15 0 18M12 3c-2.8 2.5-2.8 15 0 18"/>',
  map: '<path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  plane:
    '<path d="M12 3c.9 0 1.4 1 1.4 2.4V9l7 4v2l-7-2v4l2 1.4V20l-3.4-1L9 20v-1.6L11 17v-4l-7 2v-2l7-4V5.4C11 4 11.5 3 12 3z"/>',
  jet: '<path d="M12 2 13 9l8 5v2l-8-2 .2 4 2.3 1.6V22L12 21l-3.5.6v-1.4L10.8 18 11 14 3 16v-2l8-5 1-7z"/>',
  heli:
    '<path d="M4 5h16M12 5v3"/><path d="M7 11h8a3 3 0 0 1 3 3v1H8a4 4 0 0 1-4-4z"/><path d="M11 15v3H8m3 0h3"/><path d="M18 12l3-1"/>',
  ship: '<path d="M4 13h16l-2 6H6l-2-6z"/><path d="M6 13V8h9l3 5M9 8V5h3"/>',
  anchor:
    '<circle cx="12" cy="5" r="2"/><path d="M12 7v13M5 12a7 7 0 0 0 14 0M5 12H3m16 0h2"/>',
  satellite:
    '<path d="m6 10 4-4 4 4-4 4z"/><path d="m3 7 3 3M14 18l3-3M14 6l4-4 2 2-4 4M16 8l2 2"/><path d="M14 14a4 4 0 0 1-4 4"/>',
  fire: '<path d="M12 3c1 3-2 4-2 7a2 2 0 0 0 4 0c0-1 0-2-.5-3 2 1.5 3.5 4 3.5 6a5 5 0 0 1-10 0c0-3.5 3-5 5-10z"/>',
  quake: '<path d="M2 12h4l2-7 4 14 3-9 2 5h5"/>',
  layers:
    '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5M3 18l9 5 9-5" opacity=".6"/>',
  feed: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
  signal: '<path d="M4 20v-4M9 20v-8M14 20v-12M19 20V4"/>',
  sliders:
    '<path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4 12H1m22 0h-3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  expand: '<path d="M9 4H4v5M20 9V4h-5M4 15v5h5M15 20h5v-5"/>',
  crosshair:
    '<circle cx="12" cy="12" r="8"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  network:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5 11 16M16 7.5 13 16M8 6h8"/>',
  sparkle:
    '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  target:
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  image:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4 18 5-5 3.5 3 3-2.5L21 17"/>',
  play: '<path d="M7 5v14l12-7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  'step-f': '<path d="M6 5v14l9-7z" fill="currentColor" stroke="none"/><path d="M18 5v14"/>',
  'step-b': '<path d="M18 5v14l-9-7z" fill="currentColor" stroke="none"/><path d="M6 5v14"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4z"/>',
  gauge:
    '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 14l4-4"/><circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  hexagon: '<path d="M12 2 21 7v10l-9 5-9-5V7z"/>',
  route:
    '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h7a3 3 0 0 1 0 6H10a3 3 0 0 0 0 6h7"/>',
  pin: '<path d="M12 22s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8v.5"/>',
  warning: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4m0 3v.5"/>',
  check: '<path d="m5 12 5 5 9-11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4 12H2m20 0h-2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
};

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}): JSX.Element {
  const cls = `ic ${className ?? ''}`.trim();
  return (
    <svg
      className={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Static, author-controlled markup — safe (see file header). */}
      <g dangerouslySetInnerHTML={{ __html: ICONS[name] }} />
    </svg>
  );
}
