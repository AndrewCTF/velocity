import { useEffect, useMemo, useState, type ReactNode, type PointerEvent as ReactPointerEvent, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import type { TabDef } from './TabbedPanel.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { useIsMobile } from './useIsMobile.js';
import { StatusDot, MicroLabel } from './instruments.js';
import { useConnection, useFeeds, useTime, useSim } from '../state/stores.js';

// Desktop: five-zone layout (frontend.md §4) — 42px command bar, globe with a
// 296px left rail + 336px right rail absolutely over it, 158px timeline footer.
// Mobile (<md): the globe is full-screen and every panel is reachable from a
// single hamburger → panel chooser, each opening full-screen. When leftTabs/
// rightTabs are provided the chooser lists EVERY tab individually (Ops, Layers,
// Imagery, …); otherwise it falls back to the two rails + timeline. Desktop and
// mobile chrome render exclusively so a panel (e.g. Timeline) mounts only once.

interface Props {
  top: ReactNode;
  globe: ReactNode;
  left: ReactNode;
  right: ReactNode;
  bottom: ReactNode;
  leftTabs?: TabDef[];
  rightTabs?: TabDef[];
  // Floating overlay docked to the LEFT edge of the globe band (just inside the
  // left rail, below the map-health strip). Rail-aware like MapHealthStrip so it
  // tracks a resized left rail. Used by the contextual selection action ribbon.
  overlayLeft?: ReactNode;
  // Icon-rail mode (design §6.1): the left rail is a fixed 44px icon column whose
  // flyouts FLOAT over the map (no resizer, no fixed-width push). The map keeps
  // ~full width; --rail-left-w resolves to 44 so map overlays dock past the rail.
  iconRail?: boolean;
  // Full-surface app overlay (design §6.1) rendered as a DIRECT child of <main>
  // (a sibling of the rails) so its z-index isn't capped by the z-0 globe wrapper.
  // Insets itself past the icon rail + inspector; the top bar + rails stay visible.
  mainOverlay?: ReactNode;
  // Full-bleed mode (APP_META chrome:'full' — e.g. Foundry): the timeline footer
  // row collapses to 0 and the right rail hides, so the mainOverlay app gets the
  // whole band. Both stay MOUNTED (Timeline drives the clock; ObjectInspector
  // holds selection effects) — only layout/a11y visibility changes. Desktop only.
  fullBleed?: boolean;
}

const ICON_RAIL_W = 44;

const RAIL_BG = 'rgba(8,10,15,0.95)';

// Resizable rails — widths persist to localStorage, clamped to sane bounds.
const LS_LEFT = 'csl.leftW';
const LS_RIGHT = 'csl.rightW';
const LEFT_MIN = 220;
const LEFT_MAX = 620;
const RIGHT_MIN = 260;
const RIGHT_MAX = 680;
const clampN = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
function readW(key: string, def: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : def;
  } catch {
    return def;
  }
}

// Thin draggable edge on a rail's INNER border. Drag updates the width live; the
// listeners attach to window so the drag survives the cursor leaving the handle.
function RailResizer({
  side,
  set,
}: {
  side: 'left' | 'right';
  set: (w: number) => void;
}): JSX.Element {
  const onDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    const move = (ev: PointerEvent): void => {
      const raw = side === 'left' ? ev.clientX : window.innerWidth - ev.clientX;
      set(clampN(raw, side === 'left' ? LEFT_MIN : RIGHT_MIN, side === 'left' ? LEFT_MAX : RIGHT_MAX));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      onPointerDown={onDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
      title="Drag to resize"
      className={`absolute top-0 bottom-0 ${side === 'left' ? 'right-0' : 'left-0'} w-[5px] cursor-col-resize z-30 hover:bg-accent-line/50 active:bg-accent-line/70`}
    />
  );
}

export function ConsoleShell({
  top,
  globe,
  left,
  right,
  bottom,
  leftTabs,
  rightTabs,
  overlayLeft,
  iconRail = false,
  mainOverlay,
  fullBleed = false,
}: Props): JSX.Element {
  const isMobile = useIsMobile();
  const bleed = fullBleed && !isMobile;
  const sim = useSim((s) => s.active);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [leftW, setLeftW] = useState(() => clampN(readW(LS_LEFT, 296), LEFT_MIN, LEFT_MAX));
  const [rightW, setRightW] = useState(() => clampN(readW(LS_RIGHT, 360), RIGHT_MIN, RIGHT_MAX));
  useEffect(() => {
    try {
      localStorage.setItem(LS_LEFT, String(leftW));
    } catch {
      /* ignore */
    }
  }, [leftW]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_RIGHT, String(rightW));
    } catch {
      /* ignore */
    }
  }, [rightW]);

  const timelinePanel: TabDef = { id: 'timeline', label: 'Timeline', content: bottom };
  const mobilePanels: TabDef[] =
    leftTabs || rightTabs
      ? [...(leftTabs ?? []), ...(rightTabs ?? []), timelinePanel]
      : [
          { id: 'left', label: 'Layers', content: left },
          { id: 'right', label: 'Selection', content: right },
          timelinePanel,
        ];
  const active = mobilePanels.find((p) => p.id === activeId) ?? null;

  return (
    <div
      className="csl h-screen w-screen overflow-hidden bg-bg-0 text-txt-0 grid"
      style={
        {
          gridTemplateRows: isMobile ? '26px 42px 1fr' : bleed ? '26px 42px 1fr 0px' : '26px 42px 1fr 158px',
          // Publish the live (resizable) rail widths so map-overlay workspaces
          // (ModeSurface) track the rail instead of hardcoding left-[296px] and
          // under-/over-lapping when the operator drags it (design §4 grammar #1).
          // Full-bleed publishes 0 so AppSurface stretches to the right edge;
          // rightW itself is untouched and restores when the flag drops.
          '--rail-left-w': `${iconRail ? ICON_RAIL_W : leftW}px`,
          '--rail-right-w': bleed ? '0px' : `${rightW}px`,
        } as CSSProperties
      }
    >
      {/* Persistent classification banner — top chrome (Gotham COP convention).
          UNCLASSIFIED (open sources); amber EXERCISE strip while the war-sim runs. */}
      <div
        className="row-start-1 flex items-center justify-center text-[10px] font-semibold tracking-[1.6px] uppercase select-none"
        style={{
          background: sim ? 'var(--cls-exercise-bg)' : 'var(--cls-unclas-bg)',
          color: sim ? 'var(--cls-exercise-fg)' : 'var(--cls-unclas-fg)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {sim
          ? 'Unclassified // Exercise — Simulated data · not real-world'
          : 'Unclassified // Open-source intelligence'}
      </div>
      <header
        className="row-start-2 border-b border-line-2 bg-bg-1 relative z-30 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }}
      >
        {top}
      </header>

      <main className="row-start-3 relative overflow-hidden">
        {/* globe fills the row (always mounted) */}
        <div className="absolute inset-0 z-0">{globe}</div>

        {/* full-surface app overlay (Explorer/Graph/…) — a direct <main> child so
            it stacks above the globe + its z-0-trapped overlays, while the icon
            rail (left) and inspector (right) stay visible beside it. */}
        {!isMobile && mainOverlay}

        {/* persistent Map-health strip — one hairline row consolidating the
            connection/WS, feed-health, and replay posture that were scattered
            across the command bar. Absolutely positioned so it adds no grid
            height (the 42/1fr/158 zones are untouched); pointer-events-none
            wrapper + pointer-events-auto pill so it never blocks globe drag.
            On desktop it floats between the rails (left 296 / right 336). */}
        <div
          className={`absolute top-1.5 z-[15] flex justify-center pointer-events-none ${isMobile ? 'inset-x-2' : ''}`}
          style={isMobile ? undefined : { left: (iconRail ? ICON_RAIL_W : leftW) + 10, right: rightW + 10 }}
        >
          <MapHealthStrip />
        </div>

        {/* contextual overlay (selection action ribbon) — docked left of the
            globe band, below the health strip, rail-aware so it tracks resize. */}
        {overlayLeft && (
          <div
            className="absolute z-[16] pointer-events-none"
            style={{ left: isMobile ? 8 : leftW + 10, top: 34 }}
          >
            {overlayLeft}
          </div>
        )}

        {/* ───────────────── desktop rails ───────────────── */}
        {!isMobile && (
          <>
            {iconRail ? (
              // Icon-rail mode: 44px column, overflow-visible so its flyout floats
              // over the map; no resizer. z above the map + AppSurface.
              <aside
                className="absolute left-0 top-0 bottom-0 border-r border-line-2 flex flex-col z-[var(--z-rail)]"
                aria-label="Tools"
                style={{ background: RAIL_BG, width: ICON_RAIL_W }}
              >
                {left}
              </aside>
            ) : (
              <aside
                className="absolute left-0 top-0 bottom-0 border-r border-line-2 overflow-hidden z-20 flex flex-col"
                aria-label="Layers"
                style={{ background: RAIL_BG, width: leftW }}
              >
                {left}
                <RailResizer side="left" set={setLeftW} />
              </aside>
            )}
            {right && (
              <aside
                className={`absolute right-0 top-0 bottom-0 border-l border-line-2 overflow-hidden z-20 flex-col ${bleed ? 'hidden' : 'flex'}`}
                aria-label="Selection"
                style={{ background: RAIL_BG, width: rightW }}
              >
                {right}
                <RailResizer side="right" set={setRightW} />
              </aside>
            )}
          </>
        )}

        {/* ───────────────── mobile chrome ───────────────── */}
        {isMobile && (
          <>
            {/* active panel — full-screen over the globe */}
            {active && (
              <div className="absolute inset-0 z-30 flex flex-col" style={{ background: RAIL_BG }}>
                <div
                  className="flex items-center justify-between border-b border-line-2 px-3 flex-none"
                  style={{ height: 40 }}
                >
                  <span className="mono text-[12px] text-txt-0">{active.label}</span>
                  <button
                    type="button"
                    onClick={() => setActiveId(null)}
                    className="mono text-[12px] text-txt-2 px-2 py-1 flex items-center gap-1"
                    aria-label="Close panel"
                  >
                    <X size={13} strokeWidth={1.75} aria-hidden /> Close
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <ErrorBoundary label={active.label}>{active.content}</ErrorBoundary>
                </div>
              </div>
            )}

            {/* panel chooser sheet */}
            {menuOpen && !active && (
              <div className="absolute inset-0 z-30">
                <button
                  type="button"
                  aria-label="Close menu"
                  onClick={() => setMenuOpen(false)}
                  className="absolute inset-0 bg-black/60"
                />
                <div
                  className="absolute left-0 right-0 bottom-0 max-h-[80%] overflow-y-auto border-t border-line-2 rounded-t-2xl p-2"
                  style={{ background: RAIL_BG }}
                >
                  <div className="mono text-[11px] text-txt-2 px-2 pt-2 pb-1">PANELS</div>
                  <div className="grid grid-cols-2 gap-2 p-1">
                    {mobilePanels.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setActiveId(p.id);
                          setMenuOpen(false);
                        }}
                        className="flex items-center gap-2 border border-line-2 rounded-md px-3 py-3 mono text-[12px] text-txt-0 text-left hover:border-accent-line"
                      >
                        {p.icon}
                        <span>{p.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* hamburger — opens the chooser (hidden while a panel is open) */}
            {!active && (
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="absolute bottom-3 left-3 z-40 mono text-[13px] px-4 py-2.5 rounded-md border border-line-2 text-txt-0 flex items-center gap-2"
                style={{ background: RAIL_BG }}
                aria-label="Open panels menu"
              >
                ☰ <span>Panels</span>
              </button>
            )}
          </>
        )}
      </main>

      {/* timeline footer — desktop only (mobile reaches it via the chooser).
          Full-bleed collapses the row (grid track is 0px) but keeps Timeline
          mounted so the clock/replay side effects never restart. */}
      {!isMobile && (
        <footer
          className={`row-start-4 border-t border-line-2 bg-bg-1 relative z-20 ${bleed ? 'overflow-hidden border-t-0' : ''}`}
          style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }}
          aria-hidden={bleed || undefined}
        >
          {bottom}
        </footer>
      )}
    </div>
  );
}

// ── Map-health strip ────────────────────────────────────────────────────────
// A compact, read-only consolidation of the three posture signals that already
// live in the stores: the /ws/alerts link state (useConnection), aggregate feed
// health (useFeeds), and the timeline replay posture (useTime.playing). One
// hairline-bordered pill row using the shared StatusDot/MicroLabel primitives —
// it OWNS no state and writes nothing, so it can never regress the live feeds or
// the globe. Each cell carries a title for the detail behind the dot.
function MapHealthStrip(): JSX.Element {
  const ws = useConnection((s) => s.ws);
  const feeds = useFeeds((s) => s.feeds);
  const playing = useTime((s) => s.playing);

  // Aggregate feed health: worst non-unknown status sets the dot; counts are real.
  const { feedTone, feedText, feedTitle } = useMemo(() => {
    const list = Object.values(feeds);
    const total = list.length;
    const green = list.filter((f) => f.status === 'green').length;
    const red = list.filter((f) => f.status === 'red').length;
    const amber = list.filter((f) => f.status === 'amber').length;
    const tone = total === 0 ? 'neutral' : red > 0 ? 'red' : amber > 0 ? 'amber' : 'green';
    const text = total === 0 ? 'no feeds' : `${green}/${total} live`;
    const title =
      total === 0
        ? 'No data feeds have reported yet'
        : `Feeds: ${green} live · ${amber} degraded · ${red} down (of ${total})`;
    return { feedTone: tone, feedText: text, feedTitle: title };
  }, [feeds]);

  const wsTone = ws === 'open' ? 'ok' : ws === 'connecting' ? 'neutral' : 'alert';
  const wsText = ws === 'open' ? 'live' : ws === 'connecting' ? '…' : 'down';
  const wsTitle =
    ws === 'open'
      ? 'Alert WebSocket (/ws/alerts) is live'
      : ws === 'connecting'
        ? 'Connecting to /ws/alerts…'
        : '/ws/alerts is down — alerts may be stale';

  // Replay posture: playing = the clock advances (live tracking); paused =
  // frozen / scrubbing a replay. The dot is informational (accent vs neutral).
  const clockText = playing ? 'live' : 'paused';
  const clockTone = playing ? 'ok' : 'neutral';
  const clockTitle = playing
    ? 'Timeline is advancing — tracking live time'
    : 'Timeline paused — frozen / replay posture';

  return (
    <div
      className="pointer-events-auto inline-flex items-center gap-3 h-[20px] px-2.5 rounded-sm border border-line-2 bg-bg-1/90 backdrop-blur-sm"
      role="status"
      aria-label="Map health"
      style={{ boxShadow: '0 1px 0 rgba(0,0,0,0.35)' }}
    >
      <span className="flex items-center gap-1.5" title={wsTitle}>
        <StatusDot tone={wsTone} />
        <MicroLabel>link</MicroLabel>
        <span className="mono text-[10px] text-txt-2">{wsText}</span>
      </span>
      <span className="h-2.5 w-px bg-line" aria-hidden="true" />
      <span className="flex items-center gap-1.5" title={feedTitle}>
        <StatusDot tone={feedTone} />
        <MicroLabel>feeds</MicroLabel>
        <span className="mono text-[10px] text-txt-2 tabular-nums">{feedText}</span>
      </span>
      <span className="h-2.5 w-px bg-line" aria-hidden="true" />
      <span className="flex items-center gap-1.5" title={clockTitle}>
        <StatusDot tone={clockTone} />
        <MicroLabel>clock</MicroLabel>
        <span className="mono text-[10px] text-txt-2">{clockText}</span>
      </span>
    </div>
  );
}
