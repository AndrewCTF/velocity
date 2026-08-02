import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Icon } from '../normal/Icon.js';
import { LEFT_PANELS, RIGHT_PANELS, type LeftPanelId, type RightPanelId } from './panels.js';

// Console — the rebuilt shell.
//
// This is written FROM docs/mockups/console-2026-08, not derived from
// ConsoleShell. Two previous attempts opened the old shell and edited it toward
// the new one; both produced something that still read as the old UI, because
// starting from the old structure keeps the old structure. The old shell stays
// on disk untouched until this one is proven.
//
// The grammar, all of it measured rather than chosen (README.md in that folder
// carries the derivation):
//
//   40px  title bar     brand, menu, document, system state, marking pill
//   32px  tab strip     four NAMED panels, each on a number key
//   1fr   body          left panel | map | right dock, none sharing an edge
//   auto  action bar    the query as a sentence, and the verbs on it
//
// What is deliberately absent: the 26px saturated classification band (the
// marking is a pill in the bar) and the 158px pinned timeline footer (the
// timeline is a dock floating over the map). That is 184px of permanent chrome
// returned to the surface whose whole job is the map.

export interface ConsoleProps {
  /** Brand + menu + document title live left; system state lives right. */
  brand?: ReactNode;
  menu?: ReactNode;
  documentTitle?: ReactNode;
  systemState?: ReactNode;
  /** UNCLAS / EXERCISE. A pill, never a full-width band. */
  marking?: ReactNode;
  /** Content for each of the four named left panels. */
  /** Which named panel starts active. */
  initialPanel?: LeftPanelId;
  leftPanels: Partial<Record<LeftPanelId, ReactNode>>;
  /** Counts shown in the tab strip, so a panel is never opened to find it empty. */
  leftBadges?: Partial<Record<LeftPanelId, string>>;
  /** Anything not yet re-homed. Rendered under "More" so nothing can vanish. */
  extra?: ReactNode;
  extraCount?: number;
  /** The map well. Mounts once and never unmounts. */
  map: ReactNode;
  /** Floating over the map, bottom-anchored in flow so it cannot overlap. */
  dock?: ReactNode;
  /** Right dock content. */
  rightPanels: Partial<Record<RightPanelId, ReactNode>>;
  /** The query, rendered as English. */
  action?: ReactNode;
  /** Full-screen app surfaces render over the body. */
  overlay?: ReactNode;
  /** Full-bleed apps take the whole body and hide both rails. */
  bleed?: boolean;
}

const PANEL_ICON: Record<LeftPanelId, 'layers' | 'search' | 'chart' | 'info'> = {
  layers: 'layers',
  find: 'search',
  histogram: 'chart',
  info: 'info',
};

export function Console({
  brand,
  initialPanel = 'layers',
  menu,
  documentTitle,
  systemState,
  marking,
  leftPanels,
  leftBadges,
  extra,
  extraCount = 0,
  map,
  dock,
  rightPanels,
  action,
  overlay,
  bleed = false,
}: ConsoleProps): JSX.Element {
  const [left, setLeft] = useState<LeftPanelId | 'more'>(initialPanel);
  const [right, setRight] = useState<RightPanelId>('selection');

  const leftBody = left === 'more' ? extra : leftPanels[left];
  const rightBody = rightPanels[right];
  const rightTabs = RIGHT_PANELS.filter((p) => rightPanels[p.id] !== undefined);

  // A named panel that hosts several former panels shows them as inner tabs,
  // not as one column you scroll through. Measured before this existed: Info
  // was 11,336px of scroll in an 884px body (Feeds 1,104 + Chokepoints 1,835 +
  // ACARS 8,397) and More was 8,478px across seven sections. Thirteen screens
  // of stacked panel with no way to jump is the "reachable but invisible"
  // finding again, one level down. The reference does exactly this — Object
  // Explorer's `Types 47 · Properties 332 · Links 14 · Timeline` row is a tab
  // strip inside a panel.
  const sections = Children.toArray(leftBody).filter(
    (n): n is React.ReactElement<{ 'aria-label'?: string }> =>
      isValidElement(n) && typeof n.props['aria-label'] === 'string',
  );
  const sectioned = sections.length > 1;
  const [section, setSection] = useState(0);
  useEffect(() => {
    setSection(0);
  }, [left]);
  const activeSection = Math.min(section, sections.length - 1);

  // The map furniture anchored to the bottom of the map (scale bar, cursor and
  // selection coordinates, centre and altitude) clears the dock by reading the
  // dock's MEASURED height. Every previous version hard-coded it — 204px, 172px,
  // 16px, then 164px, then 126px — and every one of them was wrong the moment
  // the dock's content changed height, which is exactly how the coordinate
  // readout ended up underneath it again.
  const mapRef = useRef<HTMLElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = dockRef.current;
    const host = mapRef.current;
    if (!el || !host) return;
    const apply = (): void => {
      host.style.setProperty('--dock-clear', `${Math.round(el.getBoundingClientRect().height) + 10}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dock, bleed]);

  return (
    <div
      className="csl2"
      style={
        {
          // The map column already excludes both rails, so overlays inside it
          // must not offset past them a second time.
          '--rail-left-w': '0px',
          '--rail-right-w': '0px',
        } as CSSProperties
      }
    >
      <header className="csl2-title">
        {brand}
        {menu}
        {documentTitle}
        {/* No spacer here. TitleBar fills this row and owns its own left/right
            split via an internal flex-1; adding a second one pushed the brand
            and the File/Edit menus into the middle of the bar. A slot that
            hosts a full-width child must not also try to lay it out. */}
        {(brand || menu || documentTitle) && !systemState ? <span style={{ flex: 1 }} /> : null}
        {systemState}
        {marking}
      </header>

      <div className="csl2-tabs" role="tablist" aria-label="Map panels">
        {LEFT_PANELS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            className="csl2-tab"
            aria-selected={left === p.id}
            title={`${p.label} (${p.key})`}
            onClick={() => setLeft(p.id)}
          >
            <Icon name={PANEL_ICON[p.id]} className="h-3 w-3" />
            {p.label}
            {leftBadges?.[p.id] ? <span className="csl2-badge">{leftBadges[p.id]}</span> : null}
          </button>
        ))}
        {extraCount > 0 && (
          <button
            type="button"
            role="tab"
            className="csl2-tab"
            aria-selected={left === 'more'}
            title="Surfaces not yet re-homed"
            onClick={() => setLeft('more')}
          >
            More<span className="csl2-badge">{extraCount}</span>
          </button>
        )}
      </div>

      <div
        className="csl2-body"
        data-left={bleed ? '0' : '1'}
        data-right={bleed || rightTabs.length === 0 ? '0' : '1'}
      >
        {!bleed && (
          <aside className="csl2-panel" aria-label="Left panel">
            <div className="csl2-panel-head">
              {left === 'more' ? 'More' : LEFT_PANELS.find((p) => p.id === left)?.label}
              {sectioned ? (
                <span className="csl2-panel-head-count">
                  {activeSection + 1} of {sections.length}
                </span>
              ) : null}
            </div>
            {sectioned && (
              <div className="csl2-subtabs" role="tablist" aria-label="Panel sections">
                {sections.map((s, i) => (
                  <button
                    key={s.key ?? i}
                    type="button"
                    role="tab"
                    className="csl2-tab csl2-subtab"
                    aria-selected={activeSection === i}
                    onClick={() => setSection(i)}
                  >
                    {s.props['aria-label']}
                  </button>
                ))}
              </div>
            )}
            <div className="csl2-panel-body">
              {sectioned ? sections[activeSection] : (leftBody ?? <Empty />)}
            </div>
          </aside>
        )}

        <main className="csl2-map" aria-label="Map" ref={mapRef}>
          {map}
          {dock ? (
            <div className="csl2-dock" ref={dockRef}>
              {dock}
            </div>
          ) : null}
          {overlay}
        </main>

        {!bleed && rightTabs.length > 0 && (
          <aside className="csl2-panel" aria-label="Right panel">
            {/* The tab strip below IS this panel's header — but only when there
                is more than one tab to strip. With `selection` the single wired
                right panel, the strip never rendered and the column had no
                header at all, so the one panel the operator opens deliberately
                was the only unlabelled surface in the shell. */}
            {rightTabs.length === 1 && rightTabs[0] && (
              <div className="csl2-panel-head">{rightTabs[0].label}</div>
            )}
            {rightTabs.length > 1 && (
            <div className="csl2-tabs" style={{ borderBottom: '1px solid var(--line)' }}>
              {rightTabs.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  className="csl2-tab"
                  aria-selected={right === p.id}
                  onClick={() => setRight(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            )}
            <div className="csl2-panel-body">{rightBody ?? <Empty />}</div>
          </aside>
        )}
      </div>

      {action ? <div className="csl2-action">{action}</div> : null}
    </div>
  );
}

function Empty(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
      <Icon name="search" className="w-6 h-6 text-txt-3" />
      <div className="text-[13px] text-txt-1">Nothing to show here yet</div>
      <p className="max-w-[220px] text-[12px] leading-relaxed text-txt-3">
        This panel has no content wired to it. Pick another tab, or open the app that owns this
        surface.
      </p>
    </div>
  );
}
