import { useState, type ReactNode } from 'react';
import type { TabDef } from './TabbedPanel.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { useIsMobile } from './useIsMobile.js';

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
}

const RAIL_BG = 'rgba(8,10,15,0.95)';

export function ConsoleShell({
  top,
  globe,
  left,
  right,
  bottom,
  leftTabs,
  rightTabs,
}: Props): JSX.Element {
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

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
      style={{ gridTemplateRows: isMobile ? '42px 1fr' : '42px 1fr 158px' }}
    >
      <header
        className="row-start-1 border-b border-line-2 bg-bg-1 relative z-30 overflow-x-auto"
        style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }}
      >
        {top}
      </header>

      <main className="row-start-2 relative overflow-hidden">
        {/* globe fills the row (always mounted) */}
        <div className="absolute inset-0 z-0">{globe}</div>

        {/* ───────────────── desktop rails ───────────────── */}
        {!isMobile && (
          <>
            <aside
              className="absolute left-0 top-0 bottom-0 w-[296px] border-r border-line-2 overflow-hidden z-20 flex flex-col"
              aria-label="Layers"
              style={{ background: RAIL_BG }}
            >
              {left}
            </aside>
            <aside
              className="absolute right-0 top-0 bottom-0 w-[336px] border-l border-line-2 overflow-hidden z-20 flex flex-col"
              aria-label="Selection"
              style={{ background: RAIL_BG }}
            >
              {right}
            </aside>
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
                    className="mono text-[12px] text-txt-2 px-2 py-1"
                    aria-label="Close panel"
                  >
                    ✕ Close
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

      {/* timeline footer — desktop only (mobile reaches it via the chooser) */}
      {!isMobile && (
        <footer
          className="row-start-3 border-t border-line-2 bg-bg-1 relative z-20"
          style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }}
        >
          {bottom}
        </footer>
      )}
    </div>
  );
}
