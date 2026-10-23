import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "../normal/Icon.js";
import { useSelection } from "../state/stores.js";
import { AppRail } from "./AppRail.js";
import type { SlateChrome } from "../slate/SlateShell.js";
import { BpIcon } from "./BpIcon.js";
import {
  LEFT_PANELS,
  RIGHT_PANELS,
  type LeftPanelId,
  type RightPanelId,
} from "./panels.js";

// Console — the rebuilt shell.
//
// This is written FROM docs/mockups/console-2026-08, not derived from
// ConsoleShell. Two previous attempts opened the old shell and edited it toward
// the new one; both produced something that still read as the old UI, because
// starting from the old structure keeps the old structure. The old shell stays
// on disk untouched until this one is proven.
//
// The grammar (2026-10-23), copied from the reference workspace shell the
// operator chose as the app UI (gotham/_kit/gotham-shell.css; comments only):
//
//   16px  banner        the deployment marking, centred
//   40px  tabs bar      app launcher, search, one tab per pinned app, counts
//   36px  menu row      File..Help, the action sentence, the document line
//   42px  rail          the four named panels as icons, each on a number key
//   rest  map           full width; panels and the time dock FLOAT over it
//
// The earlier console-2026-08 grammar (pill marking, named tab strip, docked
// panel columns, bottom action bar) is in docs/mockups/console-2026-08.

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
  /** Called when a panel is asked for while a full-bleed app has the body.
   *
   *  Without this the tab strip stayed rendered and clickable over Foundry, AI,
   *  Workflows, City, Country and Markets — six of the fourteen apps — while
   *  `bleed` had already removed the panel column, so all five tabs took the
   *  selected state and showed nothing. Five dead controls in the most
   *  prominent strip in the shell is the "chrome that lies" failure the menu
   *  bar was fixed for; the strip is where an operator goes to get back to the
   *  map, so asking for a panel now returns them to it. */
  onPanelWhileBleed?: () => void;
  /** Window-chrome wiring the Slate shell draws itself (slate/SlateShell);
   *  this console takes the same values through `systemState`. */
  chrome?: SlateChrome;
}

// Blueprint glyphs for the four panels: the rail's grey group and the panel
// tab row both draw them.
const PANEL_BP: Record<LeftPanelId, string> = {
  layers: "layers",
  find: "search",
  histogram: "horizontal-bar-chart",
  info: "info-sign",
};

export function Console({
  brand,
  initialPanel = "layers",
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
  onPanelWhileBleed,
}: ConsoleProps): JSX.Element {
  const [left, setLeft] = useState<LeftPanelId | "more">(initialPanel);
  const [right, setRight] = useState<RightPanelId>("selection");
  // The landing view is the map with one panel, as the reference opens. The
  // inspector opens with a selection and closes with it; the rail's Inspector
  // toggle opens it by hand (Series has no selection to wait for).
  const selected = useSelection((s) => s.selectedEntityId);
  const [rightShown, setRightShown] = useState(Boolean(selected));
  useEffect(() => {
    setRightShown(Boolean(selected));
  }, [selected]);

  // Selecting a panel. In full-bleed the panel column does not exist, so the
  // request also has to get the operator back to a surface that has one.
  const openPanel = useCallback(
    (id: LeftPanelId | "more"): void => {
      setLeft(id);
      if (bleed) onPanelWhileBleed?.();
    },
    [bleed, onPanelWhileBleed],
  );

  // 1-4 select the four named panels, 5 the More parking lot. The Help menu has
  // advertised "1-4 left panels" since the rebuild and nothing was ever
  // listening, so the tooltip on every tab named a key that did nothing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      )
        return;
      const i = Number(e.key);
      if (!Number.isInteger(i) || i < 1 || i > LEFT_PANELS.length + 1) return;
      const target = LEFT_PANELS[i - 1]?.id ?? "more";
      if (target === "more" && !extraCount) return;
      e.preventDefault();
      openPanel(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // openPanel closes over `bleed` and `onPanelWhileBleed`; rebind when either
    // changes so the key never routes to a column that is no longer there.
  }, [openPanel, extraCount]);

  const leftBody = left === "more" ? extra : leftPanels[left];
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
    (n): n is React.ReactElement<{ "aria-label"?: string }> =>
      isValidElement<{ "aria-label"?: string }>(n) &&
      typeof n.props["aria-label"] === "string",
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
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = dockRef.current;
    const host = bodyRef.current;
    if (!el || !host) return;
    const apply = (): void => {
      host.style.setProperty(
        "--dock-clear",
        `${Math.round(el.getBoundingClientRect().height) + 10}px`,
      );
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dock, bleed]);

  const showLeft = !bleed;
  const canRight = !bleed && rightTabs.length > 0;
  const showRight = canRight && rightShown;

  return (
    <div
      className="csl2"
      style={
        {
          // The panels float OVER the map now, so map overlays that dock past a
          // rail (legend, toolbar, coordinate readouts) read the panel's outer
          // width here rather than 0.
          "--rail-left-w": showLeft ? "calc(var(--g-left) + 15px)" : "0px",
          "--rail-right-w": showRight ? "calc(var(--g-right) + 15px)" : "0px",
        } as CSSProperties
      }
    >
      {/* `display: contents`: TitleBar emits the banner, the tabs bar and the
          menu row as separate grid items, so the header has no box of its own. */}
      <header className="csl2-title">
        {brand}
        {menu}
        {documentTitle}
        {systemState}
        {marking}
      </header>

      {/* The rail. The four named panels as icons, each on a number key; the
          name is the accessible label and the tooltip, so the tab is still
          found by name. */}
      <div className="csl2-rail">
      <div
        className="csl2-rail-group"
        role="tablist"
        aria-label="Map panels"
        aria-orientation="vertical"
      >
        {LEFT_PANELS.map((p, i) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            className="csl2-rtab"
            style={{ top: 381 + i * 33 }}
            aria-selected={left === p.id && !bleed}
            aria-label={p.label}
            title={
              bleed
                ? `${p.label} (${p.key}) · returns to the map, which is where this panel lives`
                : `${p.label} (${p.key})`
            }
            onClick={() => openPanel(p.id)}
          >
            <BpIcon name={PANEL_BP[p.id]} size={20} />
            {leftBadges?.[p.id] ? (
              <span className="csl2-rbadge">{leftBadges[p.id]}</span>
            ) : null}
          </button>
        ))}
        {extraCount > 0 && (
          <button
            type="button"
            role="tab"
            className="csl2-rtab"
            style={{ top: 381 + LEFT_PANELS.length * 33 }}
            aria-selected={left === "more" && !bleed}
            aria-label="More"
            title="Surfaces not yet re-homed"
            onClick={() => openPanel("more")}
          >
            <BpIcon name="more" size={20} />
            <span className="csl2-rbadge">{extraCount}</span>
          </button>
        )}
      </div>
        {canRight && (
          <button
            type="button"
            className="csl2-rtab"
            style={{ top: 381 + (LEFT_PANELS.length + 1) * 33 + 26 }}
            aria-pressed={rightShown}
            aria-label="Inspector"
            title="Inspector: the selection and its series"
            onClick={() => setRightShown((v) => !v)}
          >
            <BpIcon name="panel-stats" size={20} />
          </button>
        )}
        <div className="csl2-apps">
          <AppRail />
        </div>
      </div>

      <div
        className="csl2-body"
        ref={bodyRef}
        data-left={showLeft ? "1" : "0"}
        data-right={showRight ? "1" : "0"}
      >
        <main className="csl2-map" aria-label="Map">
          {map}
          {dock ? (
            <div className="csl2-dock" ref={dockRef}>
              {dock}
            </div>
          ) : null}
        </main>

        {/* App surfaces fill the span BETWEEN the floating panels, so a panel
            never covers the app the operator just opened. */}
        {overlay ? <div className="csl2-overlay">{overlay}</div> : null}

        {showLeft && (
          <aside className="csl2-panel csl2-panel-l" aria-label="Left panel">
            {/* The panel's own tab row (`k-ptabs`): icon + name, 3px underline.
                Buttons, not tabs: the rail's tablist is the one tab set, and
                this row is the same four doors drawn where the eye already is. */}
            <div className="csl2-ptabs">
              <span className="csl2-ptab-g" aria-hidden>
                <BpIcon name="people" size={24} />
              </span>
              {left === "more" ? (
                <span className="csl2-ptab" aria-current="true">
                  <BpIcon name="more" size={16} />
                  More
                </span>
              ) : (
                LEFT_PANELS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="csl2-ptab"
                    aria-current={left === p.id ? "true" : undefined}
                    onClick={() => openPanel(p.id)}
                  >
                    <BpIcon name={PANEL_BP[p.id]} size={16} />
                    {p.label}
                  </button>
                ))
              )}
              {sectioned ? (
                <span className="csl2-panel-head-count">
                  {activeSection + 1} of {sections.length}
                </span>
              ) : null}
            </div>
            {/* The query as a sentence and its verbs belong to the layers it
                filters, not to the window's menu row. */}
            {left === "layers" && action ? (
              <div className="csl2-action">{action}</div>
            ) : null}
            {sectioned && (
              <div
                className="csl2-subtabs"
                role="tablist"
                aria-label="Panel sections"
              >
                {sections.map((s, i) => (
                  <button
                    key={s.key ?? i}
                    type="button"
                    role="tab"
                    className="csl2-tab csl2-subtab"
                    aria-selected={activeSection === i}
                    onClick={() => setSection(i)}
                  >
                    {s.props["aria-label"]}
                  </button>
                ))}
              </div>
            )}
            <div className="csl2-panel-body">
              {sectioned ? sections[activeSection] : (leftBody ?? <Empty />)}
            </div>
          </aside>
        )}

        {showRight && (
          <aside className="csl2-panel csl2-panel-r" aria-label="Right panel">
            {/* The tab strip below IS this panel's header — but only when there
                is more than one tab to strip. With one tab it is a title row,
                so the panel is never an unlabelled surface. */}
            {rightTabs.length === 1 && rightTabs[0] && (
              <div className="csl2-panel-head">{rightTabs[0].label}</div>
            )}
            {rightTabs.length > 1 && (
              <div className="csl2-tabs" role="tablist" aria-label="Inspector">
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
    </div>
  );
}

function Empty(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
      <Icon name="search" className="w-6 h-6 text-txt-3" />
      <div className="text-[13px] text-txt-1">Nothing to show here yet</div>
      <p className="max-w-[220px] text-[12px] leading-relaxed text-txt-3">
        This panel has no content wired to it. Pick another tab, or open the app
        that owns this surface.
      </p>
    </div>
  );
}
