import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../normal/Icon.js';
import { useAuth } from '../auth/AuthContext.js';
import { isSupabaseConfigured } from '../transport/supabase.js';
import { useAppView, APP_META, APP_GROUPS, type AppId } from '../state/appView.js';
import { useEntityStats, setStatsViewer, acquireStats } from '../globe/entityStats.js';
import { perfSnapshot } from '../globe/perf.js';
import { flyToGlobal, resetToTopDown } from '../globe/camera.js';
import { viewerCenter } from '../globe/center.js';
import { useMapTools } from '../globe/mapTools.js';
import { useAgent } from '../state/agent.js';
import { useAlerts, useConnection, useFilters, useSelection, useTime } from '../state/stores.js';
import { useDashboardMode } from '../state/dashboardMode.js';
import { useFloatingPanels } from '../state/floatingPanels.js';
import { usePalette } from '../state/palette.js';
import { useSettings } from '../state/settings.js';
import { useTheme } from '../state/theme.js';
import { SCHEMES } from '../theme/schemes.js';
import { useUiMode } from '../state/uiMode.js';
import { openMapToolPanel } from './panels/MapToolPanels.js';
import { toast } from './toast.js';
import type * as Cesium from 'cesium';

// TitleBar — built from docs/mockups/console-2026-08 (`.titlebar`).
//
// It replaces CommandBar in the shell's first row. CommandBar put fifteen app
// tabs in the title row, so the console showed TWO tab systems stacked: the app
// switcher above and the four named panels below. Two rows of tabs that mean
// different things, adjacent, is the overlap.
//
// The apps move behind one launcher, which is what the reference does and what
// docs/dashboard-redesign-2026-08.md §2.2 rule 2 already specified. Starred
// entries lift to the top so the four an operator uses daily are not found by
// reading past ten they never open.

function Spark({ series, tone }: { series: number[]; tone: string }): JSX.Element | null {
  if (series.length < 2) return null;
  const lo = Math.min(...series), hi = Math.max(...series), rng = hi - lo || 1;
  const pts = series
    .map((v, i) => `${(i / (series.length - 1)) * 40},${12 - ((v - lo) / rng) * 10}`)
    .join(' ');
  return (
    <svg width="40" height="12" viewBox="0 0 40 12" aria-hidden="true" className="opacity-80">
      <polyline points={pts} fill="none" stroke={tone} strokeWidth="1.2" />
    </svg>
  );
}

/** Keeps the last N samples of a live value for the sparklines. */
function useSeries(value: number | null, n = 24): number[] {
  const ref = useRef<number[]>([]);
  const [, bump] = useState(0);
  useEffect(() => {
    if (value === null || !Number.isFinite(value)) return;
    ref.current = [...ref.current, value].slice(-n);
    bump((x) => x + 1);
  }, [value, n]);
  return ref.current;
}

const MENUS = ['File', 'Edit', 'View', 'Collect', 'Window', 'Help'] as const;

/** Alert-socket state as a dot. `connecting` is amber rather than green: a
 *  socket that has not opened yet is not carrying alerts. */
const WS_DOT: Record<string, string> = {
  open: 'bg-ok',
  connecting: 'bg-warn',
  closed: 'bg-alert',
  error: 'bg-alert',
};

// Every item below runs a real command against a real store. The six menu
// buttons used to set a `menu` state that nothing read: they highlighted, they
// flipped `aria-expanded`, and no dropdown was ever rendered. Six controls that
// look like the most recognisable thing about a window and do nothing are worse
// than no menu bar, because they teach the operator that the chrome lies.
//
// Nothing here is invented. Where an item would need a capability that does not
// exist, the item is not in the list.

interface MenuItem {
  label: string;
  /** Shown right-aligned. Only for keys something actually binds. */
  hint?: string;
  run: (ctx: MenuCtx) => void;
  /** Renders a check when true, so toggles state what they are. */
  on?: (ctx: MenuCtx) => boolean;
  /** A hairline above this item. */
  sep?: boolean;
  /** Greyed out with the reason in a tooltip. */
  disabled?: (ctx: MenuCtx) => string | null;
}

interface MenuCtx {
  viewer: Cesium.Viewer | null | undefined;
  openAlerts: () => void;
  openInbox: () => void;
  openSettings: () => void;
}

const MENU_ITEMS: Record<(typeof MENUS)[number], MenuItem[]> = {
  File: [
    {
      label: 'Command palette…',
      hint: '⌘K',
      run: () => usePalette.getState().setOpen(true),
    },
    {
      label: 'Find objects near here',
      run: () => useAppView.getState().setApp('explorer'),
      sep: true,
    },
    {
      label: 'New report',
      run: () => useAppView.getState().setApp('reports'),
    },
    {
      label: 'Open Foundry datasets',
      run: () => useAppView.getState().setApp('foundry'),
    },
    {
      label: 'Save this view as a PNG',
      sep: true,
      disabled: (c) => (c.viewer && !c.viewer.isDestroyed() ? null : 'The globe is not running.'),
      run: (c) => {
        const v = c.viewer;
        if (!v || v.isDestroyed()) return;
        // Cesium only guarantees the buffer is intact during a render, so ask
        // for one and read the canvas in the same frame.
        v.render();
        const url = v.canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = 'velocity-view.png';
        a.click();
      },
    },
    { label: 'Settings…', sep: true, run: (c) => c.openSettings() },
  ],
  Edit: [
    {
      label: 'Clear selection',
      disabled: () => (useSelection.getState().selectedEntityId ? null : 'Nothing is selected.'),
      run: () => useSelection.getState().select(null),
    },
    {
      label: 'Clear filters',
      disabled: () => (useFilters.getState().clauses.length > 0 ? null : 'No filters are set.'),
      run: () => useFilters.getState().clear(),
    },
    {
      label: 'Clear the alert buffer',
      sep: true,
      disabled: () => (useAlerts.getState().alerts.length > 0 ? null : 'The buffer is empty.'),
      run: () => useAlerts.getState().clear(),
    },
    {
      label: 'Copy the camera centre',
      sep: true,
      disabled: (c) => (c.viewer && !c.viewer.isDestroyed() ? null : 'The globe is not running.'),
      run: (c) => {
        const p = viewerCenter(c.viewer ?? null);
        if (p) void navigator.clipboard?.writeText(`${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
      },
    },
  ],
  View: [
    // One item per scheme, checked when active, rather than the old two-item
    // Light/Dark pair. The list is generated from theme/schemes.ts so a scheme
    // can never be added to the CSS and left unreachable from the menu.
    ...SCHEMES.map((s, i) => ({
      label: s.label,
      // A hairline before the first light-family entry, so the two families
      // read as two groups without a heading the menu has no room for.
      sep: i > 0 && s.family === 'light' && SCHEMES[i - 1]?.family === 'dark',
      on: () => useTheme.getState().mode === s.id,
      run: () => useTheme.getState().setMode(s.id),
    })),
    {
      label: 'Next colour scheme',
      hint: '⇧T',
      sep: true,
      run: () => useTheme.getState().toggle(),
    },
    {
      label: 'Command layout',
      sep: true,
      on: () => useDashboardMode.getState().mode === 'professional',
      run: () => useDashboardMode.getState().setMode('professional'),
    },
    {
      label: 'Field layout',
      on: () => useDashboardMode.getState().mode === 'normal',
      run: () => useDashboardMode.getState().setMode('normal'),
    },
    {
      label: 'Reset to top-down',
      sep: true,
      disabled: (c) => (c.viewer && !c.viewer.isDestroyed() ? null : 'The globe is not running.'),
      run: (c) => {
        if (c.viewer) resetToTopDown(c.viewer);
      },
    },
    {
      label: 'Zoom out to the whole globe',
      disabled: (c) => (c.viewer && !c.viewer.isDestroyed() ? null : 'The globe is not running.'),
      run: (c) => {
        if (c.viewer) flyToGlobal(c.viewer);
      },
    },
    {
      label: 'Corroborated contacts only',
      sep: true,
      on: () => useSettings.getState().corroboratedOnly,
      run: () => useSettings.getState().set('corroboratedOnly', !useSettings.getState().corroboratedOnly),
    },
    {
      label: 'Assess the selection with AI',
      on: () => useSettings.getState().selectionAiEnabled,
      run: () =>
        useSettings.getState().set('selectionAiEnabled', !useSettings.getState().selectionAiEnabled),
    },
  ],
  Collect: [
    { label: 'Measure a distance', run: () => useMapTools.getState().setTool('measure') },
    { label: 'Select an area', run: () => useMapTools.getState().setTool('area') },
    { label: 'Drop an annotation', run: () => useMapTools.getState().setTool('annotate') },
    { label: 'Stop drawing', run: () => useMapTools.getState().setTool('pan') },
    { label: 'Annotations…', sep: true, run: () => openMapToolPanel('annotate') },
    { label: 'Watchboxes…', run: () => openMapToolPanel('watch') },
    { label: 'Field kit…', run: () => openMapToolPanel('field') },
    {
      label: 'Task a satellite',
      sep: true,
      run: () => useUiMode.getState().setMode('tasking'),
    },
    { label: 'Edit the COP laydown', run: () => useUiMode.getState().setMode('cop') },
  ],
  Window: [
    { label: 'Inbox', run: (c) => c.openInbox() },
    { label: 'Alerts', hint: 'A', run: (c) => c.openAlerts() },
    { label: 'Analyst console', hint: '⌘J', sep: true, run: () => useAgent.getState().toggle() },
    {
      label: 'Re-dock every floating panel',
      sep: true,
      disabled: () =>
        Object.keys(useFloatingPanels.getState().panels).length > 0
          ? null
          : 'Nothing is floating right now.',
      run: () => {
        const { panels, redock } = useFloatingPanels.getState();
        for (const id of Object.keys(panels)) redock(id);
      },
    },
    {
      label: 'Close the workspace overlay',
      disabled: () => (useUiMode.getState().mode ? null : 'No workspace is open.'),
      run: () => useUiMode.getState().setMode(null),
    },
  ],
  Help: [
    {
      label: 'Keyboard shortcuts',
      run: () =>
        toast.ok('⌘K palette · ⌘J analyst console · A alerts · 1-4 left panels · Esc closes'),
    },
    {
      label: 'Read the docs',
      sep: true,
      run: () => window.open('https://github.com/AndrewCTF/velocity#readme', '_blank', 'noreferrer'),
    },
    {
      label: 'Report a problem',
      run: () => window.open('https://github.com/AndrewCTF/velocity/issues', '_blank', 'noreferrer'),
    },
  ],
};

/** One icon per app. The launcher drew the same `hexagon` fourteen times, so
 *  the icon column carried no information at all and the list could only be
 *  read word by word. */
const APP_ICON: Record<AppId, IconName> = {
  map: 'globe',
  ai: 'sparkle',
  explorer: 'chart',
  graph: 'network',
  investigate: 'search',
  targeting: 'target',
  video: 'film',
  sim: 'radar',
  reports: 'file',
  foundry: 'database',
  workflows: 'route',
  city: 'building',
  country: 'flag',
  markets: 'chart-line',
};

export function TitleBar({
  classification = 'UNCLAS',
  // No default: the console never passes one, so a literal here meant the bar
  // read "Live map" while the operator was looking at Foundry. Falling through
  // to the active app's own label keeps the line true without a prop.
  documentTitle,
  viewer,
  exercise = false,
  alerts = 0,
  inbox = 0,
  onOpenAlerts,
  onOpenInbox,
  onOpenSettings,
}: {
  classification?: string;
  exercise?: boolean;
  documentTitle?: string;
  viewer?: Cesium.Viewer | null;
  alerts?: number;
  inbox?: number;
  onOpenAlerts?: () => void;
  onOpenInbox?: () => void;
  onOpenSettings?: () => void;
}): JSX.Element {
  const [menu, setMenu] = useState<string | null>(null);
  // Live state behind the document line. Subscribed, not read once, so "live /
  // held" and the socket dot change when the thing they describe changes.
  const playing = useTime((s) => s.playing);
  const currentTime = useTime((s) => s.currentTime);
  const ws = useConnection((s) => s.ws);
  const clock = new Date(currentTime).toISOString().slice(11, 19) + 'Z';
  const ctx: MenuCtx = {
    viewer,
    openAlerts: () => onOpenAlerts?.(),
    openInbox: () => onOpenInbox?.(),
    openSettings: () => onOpenSettings?.(),
  };
  const counted = useEntityStats((st) => st.counted);
  useEffect(() => {
    if (!viewer) return;
    setStatsViewer(viewer);
    return acquireStats();
  }, [viewer]);
  const [renderMs, setRenderMs] = useState<number | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => {
      const snap = perfSnapshot();
      const v = snap?.renderMsEMA;
      setRenderMs(typeof v === 'number' && v > 0 ? v : null);
    }, 1000);
    return () => window.clearInterval(t);
  }, []);
  const contactSeries = useSeries(counted);
  const msSeries = useSeries(renderMs);
  const [launcher, setLauncher] = useState(false);
  const activeApp = useAppView((s) => s.app);
  const setApp = useAppView((s) => s.setApp);
  const [pinned, setPinned] = useState<AppId[]>(['map', 'graph', 'explorer', 'reports']);

  const togglePin = (id: AppId): void =>
    setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  // A dropdown that only closes when you pick something is a trap. Escape and a
  // click anywhere outside both close the menu bar and the app launcher.
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu && !launcher) return;
    const onDown = (e: PointerEvent): void => {
      if (barRef.current?.contains(e.target as Node)) return;
      setMenu(null);
      setLauncher(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Stop the globe's own Escape handlers from also firing on a keystroke the
      // operator aimed at this menu.
      e.stopPropagation();
      setMenu(null);
      setLauncher(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu, launcher]);

  return (
    // `display: contents` — a DOM node the outside-click test can ask about,
    // with no box of its own, so the header's flex layout is unchanged.
    <div ref={barRef} className="contents">
      <span className="flex items-center gap-[7px] pr-[14px] text-[13px] font-semibold tracking-[0.2px] text-txt-0">
        <Icon name="hexagon" className="h-4 w-4 text-accent-fg" />
        Velocity
      </span>

      {/* Real words. File / Edit / View is the single most recognisable thing
          about a window and it costs 30px once. */}
      <nav className="relative flex items-center" aria-label="Application">
        {MENUS.map((m) => (
          <div key={m} className="relative">
            <button
              type="button"
              onClick={() => setMenu(menu === m ? null : m)}
              // Once one menu is open, hovering the next opens it, the way every
              // real menu bar behaves.
              onPointerEnter={() => setMenu((cur) => (cur === null ? cur : m))}
              aria-expanded={menu === m}
              aria-haspopup="menu"
              className={`h-[30px] rounded-sm px-[9px] text-[12px] ${
                menu === m ? 'bg-[var(--hover)] text-txt-0' : 'text-txt-1 hover:bg-[var(--hover)]'
              }`}
            >
              {m}
            </button>
            {menu === m && (
              <div
                role="menu"
                aria-label={m}
                className="absolute left-0 top-[32px] z-[var(--z-dropdown)] max-h-[70vh] w-[264px] overflow-auto rounded-sm border border-line-2 bg-bg-2 py-1 shadow-[var(--sh-pop)]"
              >
                {MENU_ITEMS[m].map((it) => {
                  const why = it.disabled?.(ctx) ?? null;
                  const checked = it.on?.(ctx) ?? false;
                  return (
                    <button
                      key={it.label}
                      type="button"
                      role="menuitem"
                      disabled={why !== null}
                      {...(why ? { title: why } : {})}
                      onClick={() => {
                        it.run(ctx);
                        setMenu(null);
                      }}
                      className={`flex w-full items-center gap-2 px-[10px] py-[5px] text-left text-[12px] ${
                        it.sep ? 'mt-1 border-t border-line pt-[7px]' : ''
                      } ${
                        why
                          ? 'cursor-not-allowed text-txt-3'
                          : 'text-txt-1 hover:bg-[var(--hover)] hover:text-txt-0'
                      }`}
                    >
                      <Icon
                        name="check"
                        className={`h-3 w-3 shrink-0 ${checked ? 'text-accent-fg' : 'invisible'}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{it.label}</span>
                      {it.hint && <span className="mono shrink-0 text-txt-3">{it.hint}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* The apps, behind one launcher rather than fifteen tabs in the bar. */}
      <button
        type="button"
        onClick={() => setLauncher((v) => !v)}
        aria-expanded={launcher}
        className="ml-2 flex h-6 items-center gap-[6px] rounded-sm px-2 text-[12px] text-txt-1 hover:bg-[var(--hover)]"
      >
        <Icon name="grid" className="h-3 w-3" />
        {APP_META[activeApp]?.label ?? 'Apps'}
        <Icon name="chevron-down" className="h-3 w-3" />
      </button>

      {/* The document line. It used to be a hardcoded amber square, a fixed
          title and a green check reading "Saved" — three pieces of chrome that
          were true of nothing. It said Saved on a console that saves nothing,
          which is the fabricated-state failure this repo bans in the map and
          had left sitting in the window frame.

          Now: what you are looking at, whether the clock is live or held, and
          whether the alert socket is actually up. Every value is read from the
          store that owns it. */}
      <span
        className="ml-3 flex min-w-0 flex-1 items-center justify-center gap-2"
        title={
          playing
            ? 'The clock is running at real time; contacts advance as fixes arrive.'
            : 'The clock is held. Contacts stay at the fix they had when you paused.'
        }
      >
        <span
          className={`h-[10px] w-[10px] shrink-0 rounded-[1px] ${playing ? 'bg-ok' : 'bg-warn'}`}
          aria-hidden
        />
        <span className="truncate text-[13px] font-semibold text-txt-0">
          {documentTitle ?? APP_META[activeApp]?.label ?? 'Live map'}
        </span>
        <span className="mono shrink-0 tabular-nums text-[12px] text-txt-2">{clock}</span>
        <span className="shrink-0 text-[12px] text-txt-3">{playing ? 'live' : 'held'}</span>
        <span
          className={`h-[6px] w-[6px] shrink-0 rounded-full ${WS_DOT[ws] ?? 'bg-bg-4'}`}
          title={`Alert socket: ${ws}`}
          aria-label={`Alert socket ${ws}`}
        />
      </span>

      {launcher && (
        <div
          className="absolute left-[220px] top-[40px] z-[var(--z-dropdown)] max-h-[70vh] w-[260px] overflow-auto rounded-sm border border-line-2 bg-bg-2 py-1 shadow-[var(--sh-pop)]"
          role="menu"
        >
          <Group label="Pinned">
            {pinned.map((id) => (
              <AppRow
                key={id}
                id={id}
                starred
                active={id === activeApp}
                onOpen={() => {
                  setApp(id);
                  setLauncher(false);
                }}
                onStar={() => togglePin(id)}
              />
            ))}
          </Group>
          {APP_GROUPS.filter((g) => g.apps.some((id) => !pinned.includes(id))).map((g) => (
            <Group key={g.label} label={g.label}>
              {g.apps
                .filter((id) => !pinned.includes(id))
                .map((id) => (
                  <AppRow
                    key={id}
                    id={id}
                    active={id === activeApp}
                    onOpen={() => {
                      setApp(id);
                      setLauncher(false);
                    }}
                    onStar={() => togglePin(id)}
                  />
                ))}
            </Group>
          ))}
        </div>
      )}

      <span
        className="flex shrink-0 items-center gap-[6px] px-2 text-[12px] text-txt-2"
        title="Contacts counted in the current view"
      >
        <span className="mono tabular-nums text-txt-1">{counted.toLocaleString()}</span>
        <Spark series={contactSeries} tone="var(--accent-fg)" />
      </span>
      {renderMs !== null && (
        <span
          className="flex shrink-0 items-center gap-[6px] px-2 text-[12px] text-txt-2"
          title="Cost of a painted frame. Under requestRenderMode a frame is only drawn when something asks for one, so renders-per-second reads low on an idle globe that is perfectly fast. Frame COST is the honest signal; 16.7 ms is one 60 Hz frame."
        >
          <span
            className={`mono tabular-nums ${renderMs > 16.7 ? 'text-warn-fg' : 'text-txt-1'}`}
          >
            {renderMs.toFixed(1)} ms
          </span>
          <Spark series={msSeries} tone={renderMs > 16.7 ? 'var(--warn)' : 'var(--ok)'} />
        </span>
      )}
      {/* Inbox, the `titlebar / inbox` slot `panels.ts` records for the old rail
          item. It was never built, so `byHome` dropped the triage inbox and the
          only thing left on this row was the alerts drawer, which is a different
          surface: alerts are the live ticker, the inbox is what you have not
          worked yet. Two slots were recorded because there are two things. */}
      {onOpenInbox && (
        <button
          type="button"
          onClick={onOpenInbox}
          title="Inbox: alerts triaged into unread, working and done"
          className="flex h-6 items-center gap-[5px] rounded-sm px-2 text-[12px] text-txt-2 hover:bg-[var(--hover)]"
        >
          <Icon name="inbox" className="h-3 w-3" />
          {inbox > 0 && <span className="mono text-accent-fg">{inbox}</span>}
        </button>
      )}
      <button
        type="button"
        onClick={onOpenAlerts}
        title="Alerts: the live rule-hit ticker"
        className="flex h-6 items-center gap-[5px] rounded-sm px-2 text-[12px] text-txt-2 hover:bg-[var(--hover)]"
      >
        <Icon name="bell" className="h-3 w-3" />
        {alerts > 0 && <span className="mono text-alert-fg">{alerts}</span>}
      </button>

      <SignInChip />

      <button
        type="button"
        onClick={onOpenSettings}
        title="Settings: dashboard, aircraft motion and API keys"
        className="flex h-6 items-center gap-[5px] rounded-sm px-2 text-[12px] text-txt-2 hover:bg-[var(--hover)]"
      >
        <Icon name="settings" className="h-3 w-3" />
        Settings
      </button>

      {/* The marking, as a pill. A full-width saturated band was 26px of screen
          spent on one word, and the loudest thing on a data surface. */}
      <span className="csl2-clas ml-2" data-kind={exercise ? 'exercise' : 'unclas'}>
        <Icon name="shield" className="h-3 w-3" />
        {exercise ? 'EXERCISE' : classification}
      </span>
    </div>
  );
}

/** Account state is window chrome. It used to be a chip pinned over the map at
 *  top-10 right-3, which is the compass rose's corner, so the two overlapped. */
function SignInChip(): JSX.Element | null {
  const { user, loading, signOut } = useAuth();
  if (!isSupabaseConfigured || loading) return null;
  if (!user) {
    return (
      <Link
        to="/login"
        className="flex h-6 shrink-0 items-center rounded-sm border border-accent-line px-2 text-[12px] text-accent-fg hover:bg-[var(--hover)]"
      >
        Sign in
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void signOut()}
      title={user.email ?? user.id}
      className="flex h-6 shrink-0 items-center gap-[5px] rounded-sm px-2 text-[12px] text-txt-2 hover:bg-[var(--hover)]"
    >
      <Icon name="user" className="h-3 w-3" />
      <span className="max-w-[110px] truncate">{user.email ?? user.id.slice(0, 8)}</span>
    </button>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <>
      <div className="px-[14px] pb-[3px] pt-[6px] text-[12px] uppercase tracking-[0.6px] text-txt-3">
        {label}
      </div>
      {children}
    </>
  );
}

function AppRow({
  id,
  active,
  starred = false,
  onOpen,
  onStar,
}: {
  id: AppId;
  active: boolean;
  starred?: boolean;
  onOpen: () => void;
  onStar: () => void;
}): JSX.Element {
  const meta = APP_META[id];
  return (
    <div
      className={`group flex h-[26px] items-center gap-2 px-[14px] text-[12px] ${
        active ? 'bg-accent-dim text-accent-fg' : 'text-txt-1 hover:bg-[var(--hover)]'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        title={meta?.hint}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <Icon
          name={APP_ICON[id] ?? 'hexagon'}
          className={`h-3 w-3 shrink-0 ${active ? 'text-accent-fg' : 'text-txt-3'}`}
        />
        <span className="truncate">{meta?.label ?? id}</span>
      </button>
      <button
        type="button"
        onClick={onStar}
        aria-label={starred ? `Unpin ${meta?.label ?? id}` : `Pin ${meta?.label ?? id}`}
        className={starred ? 'text-warn' : 'text-bg-4 group-hover:text-txt-3'}
      >
        <Icon name="star" className="h-3 w-3" />
      </button>
    </div>
  );
}
