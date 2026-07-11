// Icon.tsx — icon component for the Normal dashboard chrome, backed by
// lucide-react (human-designed stroke icons, tree-shaken per import).
//
// The IconName union and Icon({ name, className }) signature are the stable
// API — consumers (LeftIconRail, LayerCatalog, layerCatalog.ts) key off it.
// 'jet' and 'heli' have no lucide equivalent, so those two keep the original
// hand-drawn path data as local components with the same props shape.

import type { ComponentType } from 'react';
import {
  Activity,
  Anchor,
  BarChart2,
  Bell,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Clock,
  Crosshair,
  FileText,
  Filter,
  Flame,
  Gauge,
  Globe,
  Hexagon,
  Image,
  Info,
  Layers,
  LayoutGrid,
  Map,
  MapPin,
  Maximize2,
  Minus,
  Moon,
  Pause,
  Plane,
  Play,
  Plus,
  Route,
  Rss,
  Satellite,
  Search,
  Settings,
  Ship,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Target,
  TriangleAlert,
  Waypoints,
  X,
  ShieldCheck,
  type LucideProps,
} from 'lucide-react';

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

// Original hand-drawn glyphs kept for the two aircraft silhouettes lucide
// doesn't carry. Same props contract as a lucide icon.
function LocalGlyph({ d, className }: { d: string; className?: string | undefined }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

const JET_D =
  'M12 2 13 9l8 5v2l-8-2 .2 4 2.3 1.6V22L12 21l-3.5.6v-1.4L10.8 18 11 14 3 16v-2l8-5 1-7z';
const HELI_D =
  'M4 5h16M12 5v3M7 11h8a3 3 0 0 1 3 3v1H8a4 4 0 0 1-4-4zM11 15v3H8m3 0h3M18 12l3-1';

const Jet = ({ className }: LucideProps) => (
  <LocalGlyph d={JET_D} className={className as string | undefined} />
);
const Heli = ({ className }: LucideProps) => (
  <LocalGlyph d={HELI_D} className={className as string | undefined} />
);

const ICONS: Record<IconName, ComponentType<LucideProps>> = {
  globe: Globe,
  map: Map,
  plane: Plane,
  jet: Jet,
  heli: Heli,
  ship: Ship,
  anchor: Anchor,
  satellite: Satellite,
  fire: Flame,
  quake: Activity,
  layers: Layers,
  feed: Rss,
  signal: BarChart2,
  sliders: SlidersHorizontal,
  filter: Filter,
  search: Search,
  settings: Settings,
  user: CircleUser,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  x: X,
  expand: Maximize2,
  crosshair: Crosshair,
  file: FileText,
  network: Waypoints,
  sparkle: Sparkles,
  bell: Bell,
  clock: Clock,
  target: Target,
  image: Image,
  play: Play,
  pause: Pause,
  'step-f': SkipForward,
  'step-b': SkipBack,
  bookmark: Bookmark,
  gauge: Gauge,
  shield: ShieldCheck,
  hexagon: Hexagon,
  route: Route,
  pin: MapPin,
  info: Info,
  warning: TriangleAlert,
  check: Check,
  plus: Plus,
  minus: Minus,
  grid: LayoutGrid,
  sun: Sun,
  moon: Moon,
};

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}): JSX.Element {
  const C = ICONS[name];
  return (
    <C
      className={className}
      strokeWidth={1.8}
      aria-hidden="true"
      focusable="false"
    />
  );
}
