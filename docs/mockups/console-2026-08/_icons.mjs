// _icons.mjs — build the inlined SVG sprite from lucide-react's own path data.
//
// Why this exists: the previous mockup set drew its icons as emoji characters,
// which is what the operator called a shortcut. lucide-react is already a
// dependency of apps/web (package.json:23) and apps/web/src/normal/Icon.tsx
// already maps 46 of these names. Extracting the same path data means the
// mockup and the app render identical geometry, with no runtime dependency and
// no CDN — the pages stay openable over file://.
//
// NAMES below is the app's own map from normal/Icon.tsx:142-191, plus the names
// the mockups need for surfaces that are still emoji in the app today.
//
// Run: node _icons.mjs
//
// It writes _sprite.svg itself rather than relying on shell redirection. The
// earlier `node _icons.mjs > _sprite.svg 2>&1` form appended the progress line
// to the END of the file, which then rendered as a stray text node at the top
// of every page. A tool that can be invoked wrongly eventually is.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LUCIDE = join(HERE, '../../../apps/web/node_modules/lucide-react/dist/esm/icons');

// name-in-mockup -> lucide icon file (kebab-case, without .mjs)
// The first block is verbatim from apps/web/src/normal/Icon.tsx:142-191.
const NAMES = {
  globe: 'globe', map: 'map', plane: 'plane', ship: 'ship', anchor: 'anchor',
  satellite: 'satellite', fire: 'flame', quake: 'activity', layers: 'layers',
  feed: 'rss', signal: 'chart-no-axes-column', sliders: 'sliders-horizontal',
  filter: 'filter', search: 'search', settings: 'settings', user: 'circle-user',
  'chevron-down': 'chevron-down', 'chevron-right': 'chevron-right', x: 'x',
  expand: 'maximize-2', crosshair: 'crosshair', file: 'file-text',
  network: 'waypoints', sparkle: 'sparkles', bell: 'bell', clock: 'clock',
  target: 'target', image: 'image', play: 'play', pause: 'pause',
  'step-f': 'skip-forward', 'step-b': 'skip-back', bookmark: 'bookmark',
  gauge: 'gauge', shield: 'shield-check', hexagon: 'hexagon', route: 'route',
  pin: 'map-pin', info: 'info', warning: 'triangle-alert', check: 'check',
  plus: 'plus', minus: 'minus', grid: 'layout-grid', sun: 'sun', moon: 'moon',

  // Transport — the row read off tmp/palantir/parts/video-transport.png.
  rewind: 'rewind', 'fast-forward': 'fast-forward', 'back-15': 'rotate-ccw',
  'fwd-15': 'rotate-cw', 'frame-b': 'chevron-first', 'frame-f': 'chevron-last',
  radio: 'radio',

  // Chrome + navigation.
  'chevron-left': 'chevron-left', 'chevron-up': 'chevron-up', menu: 'menu',
  more: 'ellipsis', 'more-v': 'ellipsis-vertical', 'arrow-right': 'arrow-right',
  'arrow-left': 'arrow-left', 'arrow-up': 'arrow-up', 'arrow-down': 'arrow-down',
  external: 'arrow-up-right', enter: 'corner-down-left', refresh: 'refresh-cw',
  'panel-left': 'panel-left', 'panel-right': 'panel-right', save: 'save',
  star: 'star', share: 'share-2', lock: 'lock', maximize: 'maximize',

  // The seven map tools (docs/dashboard-redesign-2026-08.md §2.2 rule 4).
  select: 'mouse-pointer-2', hand: 'hand', around: 'git-fork', draw: 'pen-tool',
  measure: 'ruler', capture: 'camera', annotate: 'square-pen', trash: 'trash-2',
  scan: 'scan', move: 'move',

  // Data marks and analysis.
  chart: 'chart-column', trend: 'trending-up', 'chart-line': 'chart-line',
  table: 'table', database: 'database', transform: 'git-branch',
  copy: 'copy', box: 'box', workflow: 'workflow', list: 'list',
  calendar: 'calendar', link: 'link-2', unlink: 'unlink',

  // Entity and layer categories that are emoji registries today
  // (EntityPanel.tsx:794-820, SituationPanel.tsx:49-54).
  helicopter: 'helicopter', rocket: 'rocket', truck: 'truck', users: 'users',
  building: 'building-2', factory: 'factory', radar: 'radar', waves: 'waves',
  wind: 'wind', cloud: 'cloud', mountain: 'mountain', zap: 'zap',
  droplet: 'droplet', flag: 'flag', 'circle-dot': 'circle-dot',
  circle: 'circle', square: 'square', 'square-check': 'square-check-big',
  eye: 'eye', 'eye-off': 'eye-off', inbox: 'inbox', folder: 'folder',
  message: 'message-square', download: 'download', upload: 'upload',
  pencil: 'pencil', video: 'video', film: 'film', cpu: 'cpu',
  'circle-alert': 'circle-alert', 'circle-check': 'circle-check',
  compass: 'compass', binoculars: 'binoculars', 'file-chart': 'file-chart-column',
};

// The two silhouettes lucide has no equivalent for. Verbatim from
// normal/Icon.tsx:130-133 so the mockup does not invent a third variant.
const LOCAL = {
  jet: 'M12 2 13 9l8 5v2l-8-2 .2 4 2.3 1.6V22L12 21l-3.5.6v-1.4L10.8 18 11 14 3 16v-2l8-5 1-7z',
  heli: 'M4 5h16M12 5v3M7 11h8a3 3 0 0 1 3 3v1H8a4 4 0 0 1-4-4zM11 15v3H8m3 0h3M18 12l3-1',
};

function attrs(o) {
  return Object.entries(o)
    .filter(([k]) => k !== 'key')
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join(' ');
}

const symbols = [];
const missing = [];

for (const [name, file] of Object.entries(NAMES)) {
  const path = join(LUCIDE, `${file}.mjs`);
  if (!existsSync(path)) {
    missing.push(`${name} -> ${file}.mjs`);
    continue;
  }
  // The module body is `const __iconNode = [ ... ];` with unquoted keys.
  // Slicing to the terminator and eval-ing the literal is enough here: the
  // input is a vendored, licensed source file, not user data.
  // Two shapes ship in the same package: pretty-printed over many lines, and
  // collapsed onto one. Anchoring on the next statement handles both. A third
  // shape is a pure alias (filter -> funnel, waves -> waves-horizontal), which
  // is one re-export hop away.
  let src = readFileSync(path, 'utf8');
  const alias = /export \{ default \} from '\.\/([\w-]+)\.mjs'/.exec(src);
  if (alias) src = readFileSync(join(LUCIDE, `${alias[1]}.mjs`), 'utf8');
  const m = /const __iconNode = ([\s\S]*?);\nconst /.exec(src);
  if (!m) {
    missing.push(`${name} -> could not parse ${file}.mjs`);
    continue;
  }
  const nodes = eval(m[1]); // eslint-disable-line no-eval
  const body = nodes.map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join('');
  symbols.push(`<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`);
}

for (const [name, d] of Object.entries(LOCAL)) {
  symbols.push(`<symbol id="i-${name}" viewBox="0 0 24 24"><path d="${d}"/></symbol>`);
}

if (missing.length) {
  console.error(`_icons.mjs: ${missing.length} unresolved:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

// fill=none + stroke=currentColor once on the root; every symbol inherits.
writeFileSync(
  join(HERE, '_sprite.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">` +
    `<defs>${symbols.join('')}</defs></svg>\n`,
);
console.error(`_icons.mjs: ${symbols.length} symbols -> _sprite.svg`);
