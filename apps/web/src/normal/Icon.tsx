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
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Binoculars,
  Box,
  Building2,
  Calendar,
  Camera,
  ChartColumn,
  ChartLine,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Cloud,
  Compass,
  Copy,
  CornerDownLeft,
  Cpu,
  Database,
  Download,
  Droplet,
  Ellipsis,
  EllipsisVertical,
  Eye,
  EyeOff,
  Factory,
  FastForward,
  FileChartColumn,
  Film,
  Flag,
  Folder,
  GitBranch,
  GitFork,
  Hand,
  Helicopter,
  Inbox,
  Link2,
  List,
  Lock,
  Maximize,
  Menu,
  MessageSquare,
  Mountain,
  MousePointer2,
  Move,
  PanelLeft,
  PanelRight,
  PenTool,
  Pencil,
  Radar,
  Radio,
  RefreshCw,
  Rewind,
  Rocket,
  RotateCcw,
  RotateCw,
  Ruler,
  Save,
  Scan,
  Share2,
  Square,
  SquareCheckBig,
  SquarePen,
  Star,
  Table,
  Trash2,
  TrendingUp,
  Truck,
  Unlink,
  Upload,
  Users,
  Video,
  Waves,
  Wind,
  Workflow,
  Zap,
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
  | 'moon'
  | 'annotate'
  | 'around'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-up'
  | 'back-15'
  | 'binoculars'
  | 'box'
  | 'building'
  | 'calendar'
  | 'capture'
  | 'chart'
  | 'chart-line'
  | 'chevron-left'
  | 'chevron-up'
  | 'circle'
  | 'circle-alert'
  | 'circle-check'
  | 'circle-dot'
  | 'cloud'
  | 'compass'
  | 'copy'
  | 'cpu'
  | 'database'
  | 'download'
  | 'draw'
  | 'droplet'
  | 'enter'
  | 'external'
  | 'eye'
  | 'eye-off'
  | 'factory'
  | 'fast-forward'
  | 'file-chart'
  | 'film'
  | 'flag'
  | 'folder'
  | 'frame-b'
  | 'frame-f'
  | 'fwd-15'
  | 'hand'
  | 'helicopter'
  | 'inbox'
  | 'link'
  | 'list'
  | 'lock'
  | 'maximize'
  | 'measure'
  | 'menu'
  | 'message'
  | 'more'
  | 'more-v'
  | 'mountain'
  | 'move'
  | 'panel-left'
  | 'panel-right'
  | 'pencil'
  | 'radar'
  | 'radio'
  | 'refresh'
  | 'rewind'
  | 'rocket'
  | 'save'
  | 'scan'
  | 'select'
  | 'share'
  | 'square'
  | 'square-check'
  | 'star'
  | 'table'
  | 'transform'
  | 'trash'
  | 'trend'
  | 'truck'
  | 'unlink'
  | 'upload'
  | 'users'
  | 'video'
  | 'waves'
  | 'wind'
  | 'workflow'
  | 'zap';

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
  annotate: SquarePen,
  around: GitFork,
  'arrow-down': ArrowDown,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'back-15': RotateCcw,
  binoculars: Binoculars,
  box: Box,
  building: Building2,
  calendar: Calendar,
  capture: Camera,
  chart: ChartColumn,
  'chart-line': ChartLine,
  'chevron-left': ChevronLeft,
  'chevron-up': ChevronUp,
  circle: Circle,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  'circle-dot': CircleDot,
  cloud: Cloud,
  compass: Compass,
  copy: Copy,
  cpu: Cpu,
  database: Database,
  download: Download,
  draw: PenTool,
  droplet: Droplet,
  enter: CornerDownLeft,
  external: ArrowUpRight,
  eye: Eye,
  'eye-off': EyeOff,
  factory: Factory,
  'fast-forward': FastForward,
  'file-chart': FileChartColumn,
  film: Film,
  flag: Flag,
  folder: Folder,
  'frame-b': ChevronFirst,
  'frame-f': ChevronLast,
  'fwd-15': RotateCw,
  hand: Hand,
  helicopter: Helicopter,
  inbox: Inbox,
  link: Link2,
  list: List,
  lock: Lock,
  maximize: Maximize,
  measure: Ruler,
  menu: Menu,
  message: MessageSquare,
  more: Ellipsis,
  'more-v': EllipsisVertical,
  mountain: Mountain,
  move: Move,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  pencil: Pencil,
  radar: Radar,
  radio: Radio,
  refresh: RefreshCw,
  rewind: Rewind,
  rocket: Rocket,
  save: Save,
  scan: Scan,
  select: MousePointer2,
  share: Share2,
  square: Square,
  'square-check': SquareCheckBig,
  star: Star,
  table: Table,
  transform: GitBranch,
  trash: Trash2,
  trend: TrendingUp,
  truck: Truck,
  unlink: Unlink,
  upload: Upload,
  users: Users,
  video: Video,
  waves: Waves,
  wind: Wind,
  workflow: Workflow,
  zap: Zap,
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
