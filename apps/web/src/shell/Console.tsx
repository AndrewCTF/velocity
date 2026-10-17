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
import { Icon, type IconName } from "../normal/Icon.js";
import { useSelection } from "../state/stores.js";
import { BottomSheet } from "./BottomSheet.js";
import { usePhoneSheet } from "./phoneSheet.js";
import {
  LEFT_PANELS,
  RIGHT_PANELS,
  type LeftPanelId,
  type RightPanelId,
} from "./panels.js";
import { useIsMobile } from "./useIsMobile.js";

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
//
// At 767px and under (useIsMobile) that grammar does not fit and is not
// squeezed: measured on a Pixel 7 the map had 23% of the screen and 77 elements
// ran past the right edge. The phone is a map app: the map is the whole screen,
// a search pill and status chips float on its top edge, a tab bar sits under
// it, and every panel is a bottom sheet (BottomSheet) that can be dragged
// between stops with the map still live above it. Picking a contact raises its
// Selection sheet to a peek strip. The time dock is a sheet too, kept mounted
// (it installs the playback controller and drives the viewer clock).

/** A row in the phone's More sheet. */
export interface PhoneAction {
  label: string;
  icon: IconName;
  run: () => void;
  /** What it does, when the label alone does not say. */
  hint?: string;
  badge?: string | undefined;
}

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
  /** Phone only: opens the alert inbox, behind the tab bar's Alerts tab. */
  onOpenAlerts?: () => void;
  /** Phone only: rows the app adds to the More sheet. */
  phoneMore?: readonly PhoneAction[];
}

const PANEL_ICON: Record<LeftPanelId, "layers" | "search" | "chart" | "info"> =
  {
    layers: "layers",
    find: "search",
    histogram: "chart",
    info: "info",
  };

const RIGHT_ICON: Record<RightPanelId, "crosshair" | "chart-line"> = {
  selection: "crosshair",
  series: "chart-line",
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
  onOpenAlerts,
  phoneMore = [],
}: ConsoleProps): JSX.Element {
  const isMobile = useIsMobile();
  const [left, setLeft] = useState<LeftPanelId | "more">(initialPanel);
  const [right, setRight] = useState<RightPanelId>("selection");
  // Phone only: which bottom sheet is up (shell/phoneSheet.ts). One at a time;
  // the title bar's search pill and status chip open them too.
  const sheet = usePhoneSheet((s) => s.open);
  const showSheet = usePhoneSheet((s) => s.show);
  const tools = usePhoneSheet((s) => s.tools);
  const setTools = usePhoneSheet((s) => s.setTools);
  const setNoticeHost = usePhoneSheet((s) => s.setNoticeHost);

  // Selecting a panel. In full-bleed the panel column does not exist, so the
  // request also has to get the operator back to a surface that has one. On a
  // phone the panel is a sheet, and the left/right split does not exist at all.
  const openPanel = useCallback(
    (id: LeftPanelId | "more"): void => {
      setLeft(id);
      if (isMobile) showSheet(id === "more" ? "extra" : id);
      if (bleed) onPanelWhileBleed?.();
    },
    [bleed, isMobile, onPanelWhileBleed, showSheet],
  );

  // The time dock is a map surface, so asking for it from a full-bleed app
  // brings the map back first, the same as a panel does.
  const toggleTime = (): void => {
    if (bleed) {
      onPanelWhileBleed?.();
      showSheet("time");
    } else usePhoneSheet.getState().toggle("time");
  };

  // Picking a contact opens its Selection sheet; clearing it closes that sheet
  // again. Closing the sheet by hand leaves the selection alone: the contact
  // stays picked and its track stays drawn, the sheet is only the detail. A
  // full-bleed app has no map under a sheet, so entering one closes whatever is
  // up (the desktop equivalent unmounts the columns). The selector reads
  // nothing off a desktop, so a pick there does not render the console.
  const selected = useSelection((s) => (isMobile ? s.selectedEntityId : null));
  useEffect(() => {
    if (!isMobile) return;
    const { open, show } = usePhoneSheet.getState();
    if (bleed) show(null);
    else if (selected) show("selection");
    else if (open === "selection") show(null);
  }, [selected, isMobile, bleed]);

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

  // On a phone the open sheet says which left panel is showing: the search pill
  // opens Find straight through the sheet store, without passing openPanel.
  const leftSheet =
    isMobile && (sheet === "extra" || LEFT_PANELS.some((p) => p.id === sheet))
      ? sheet
      : null;
  const shownLeft: LeftPanelId | "more" =
    leftSheet === null
      ? left
      : leftSheet === "extra"
        ? "more"
        : (leftSheet as LeftPanelId);
  const leftBody = shownLeft === "more" ? extra : leftPanels[shownLeft];
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
  }, [shownLeft]);
  const activeSection = Math.min(section, sections.length - 1);
  // Built once, hosted twice: in the left panel's aside on a desktop and in the
  // panel's sheet on a phone. They are never both mounted, so each section
  // still renders once.
  const subtabs = sectioned ? (
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
          {s.props["aria-label"]}
        </button>
      ))}
    </div>
  ) : null;
  const leftContent = sectioned
    ? sections[activeSection]
    : (leftBody ?? <Empty />);

  // A sheet's body keeps the `.csl2-panel-body` wrapper the desktop columns give
  // it, so the rules written against that class (touch target sizes) reach the
  // sheets too.
  const phoneBody = (
    <>
      {subtabs}
      <div className="csl2-panel-body">{leftContent}</div>
    </>
  );

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
    // A phone's dock is a sheet over the map, not a strip on it: nothing sits
    // above it to clear, and a sheet that is open would push the readouts up by
    // its whole height for as long as it is.
    if (isMobile) {
      host.style.setProperty("--dock-clear", "10px");
      return;
    }
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
  }, [dock, bleed, isMobile]);

  // ── Phone chrome ──────────────────────────────────────────────────────────
  // The map is the screen. Everything else is a sheet that rises from the tab
  // bar and leaves the map live above it, or a control floating on the map's
  // top edge (the title bar's search pill and status chips).
  const closeSheet = useCallback(() => showSheet(null), [showSheet]);
  const tapPanel = (id: LeftPanelId): void =>
    sheet === id ? closeSheet() : openPanel(id);
  const tabs: { id: string; label: string; icon: IconName; run: () => void }[] =
    [
      {
        id: "layers",
        label: "Layers",
        icon: "layers",
        run: () => tapPanel("layers"),
      },
      {
        id: "find",
        label: "Find",
        icon: "search",
        run: () => tapPanel("find"),
      },
      ...(dock
        ? [
            {
              id: "time",
              label: "Time",
              icon: "clock" as const,
              run: toggleTime,
            },
          ]
        : []),
      ...(onOpenAlerts
        ? [
            {
              id: "alerts",
              label: "Alerts",
              icon: "bell" as const,
              run: () => {
                closeSheet();
                onOpenAlerts();
              },
            },
          ]
        : []),
      {
        id: "more",
        label: "More",
        icon: "more",
        run: () => usePhoneSheet.getState().toggle("more"),
      },
    ];
  const moreRows: PhoneAction[] = [
    ...(selected && sheet !== "selection"
      ? [
          {
            label: "Selection",
            icon: "crosshair" as const,
            run: () => showSheet("selection"),
          },
        ]
      : []),
    ...LEFT_PANELS.filter((p) => p.id !== "layers" && p.id !== "find").map(
      (p) => ({
        label: p.label,
        icon: PANEL_ICON[p.id],
        run: () => openPanel(p.id),
        badge: leftBadges?.[p.id],
      }),
    ),
    ...rightTabs
      .filter((p) => p.id !== "selection")
      .map((p) => ({
        label: p.label,
        icon: RIGHT_ICON[p.id],
        run: () => showSheet(p.id),
      })),
    ...(extraCount > 0
      ? [
          {
            label: "Not yet re-homed",
            icon: "more" as const,
            run: () => openPanel("more"),
            badge: String(extraCount),
          },
        ]
      : []),
    ...phoneMore,
    {
      label: tools ? "Hide map tools" : "Map tools",
      hint: "measure, area, pins, draw",
      icon: "measure",
      run: () => {
        setTools(!tools);
        closeSheet();
      },
    },
  ];
  const leftLabel =
    leftSheet === "extra"
      ? "Not yet re-homed"
      : (LEFT_PANELS.find((p) => p.id === leftSheet)?.label ?? "");
  const phoneChrome = isMobile ? (
    <>
      <div className="pfloat">
        {systemState}
        {marking}
      </div>
      <BottomSheet
        key={leftSheet ?? "none"}
        label={leftLabel}
        open={leftSheet !== null}
        onClose={closeSheet}
        focusInput={leftSheet === "find"}
      >
        {leftSheet ? phoneBody : null}
      </BottomSheet>
      {rightTabs.map((p) => (
        <BottomSheet
          key={p.id}
          label={p.label}
          open={sheet === p.id}
          onClose={closeSheet}
          detents={
            p.id === "selection" ? ["peek", "half", "full"] : ["half", "full"]
          }
        >
          <div className="csl2-panel-body">{rightPanels[p.id]}</div>
        </BottomSheet>
      ))}
      {dock ? (
        // Kept mounted: the dock installs the playback controller and drives
        // the viewer clock whether or not anyone is looking at it.
        <BottomSheet
          label="Time"
          open={sheet === "time"}
          onClose={closeSheet}
          keepMounted
        >
          <div className="csl2-dock" ref={dockRef}>
            {dock}
          </div>
        </BottomSheet>
      ) : null}
      <BottomSheet label="More" open={sheet === "more"} onClose={closeSheet}>
        <ul className="pmore">
          {moreRows.map((r) => (
            <li key={r.label}>
              <button type="button" onClick={r.run}>
                <Icon name={r.icon} className="h-[18px] w-[18px]" />
                <span className="pmore-label">
                  {r.label}
                  {r.hint ? <small>{r.hint}</small> : null}
                </span>
                {r.badge ? <span className="csl2-badge">{r.badge}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>
      {/* Kept mounted: banners elsewhere in the tree draw into this (PhoneNotice). */}
      <BottomSheet
        label="Notices"
        open={sheet === "notices"}
        onClose={closeSheet}
        keepMounted
      >
        <div className="pnotices" ref={setNoticeHost} />
      </BottomSheet>
    </>
  ) : null;

  return (
    <div
      className="csl2"
      // The CSS and the markup below read the same flag, so a layout that is a
      // phone in one cannot be a desktop in the other.
      data-phone={isMobile ? "" : undefined}
      style={
        {
          // The map column already excludes both rails, so overlays inside it
          // must not offset past them a second time.
          "--rail-left-w": "0px",
          "--rail-right-w": "0px",
        } as CSSProperties
      }
    >
      {!isMobile && (
        <header className="csl2-title">
          {brand}
          {menu}
          {documentTitle}
          {/* No spacer here. TitleBar fills this row and owns its own left/right
              split via an internal flex-1; adding a second one pushed the brand
              and the File/Edit menus into the middle of the bar. A slot that
              hosts a full-width child must not also try to lay it out. */}
          {(brand || menu || documentTitle) && !systemState ? (
            <span style={{ flex: 1 }} />
          ) : null}
          {systemState}
          {marking}
        </header>
      )}

      {!isMobile && (
        <div className="csl2-tabs" role="tablist" aria-label="Map panels">
          {LEFT_PANELS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              className="csl2-tab"
              aria-selected={left === p.id && !bleed}
              title={
                bleed
                  ? `${p.label} (${p.key}) · returns to the map, which is where this panel lives`
                  : `${p.label} (${p.key})`
              }
              onClick={() => openPanel(p.id)}
            >
              <Icon name={PANEL_ICON[p.id]} className="h-3 w-3" />
              {p.label}
              {leftBadges?.[p.id] ? (
                <span className="csl2-badge">{leftBadges[p.id]}</span>
              ) : null}
            </button>
          ))}
          {extraCount > 0 && (
            <button
              type="button"
              role="tab"
              className="csl2-tab"
              aria-selected={left === "more" && !bleed}
              title="Surfaces not yet re-homed"
              onClick={() => openPanel("more")}
            >
              More<span className="csl2-badge">{extraCount}</span>
            </button>
          )}
        </div>
      )}

      <div
        className="csl2-body"
        data-left={bleed || isMobile ? "0" : "1"}
        data-right={bleed || isMobile || rightTabs.length === 0 ? "0" : "1"}
      >
        {!bleed && !isMobile && (
          <aside className="csl2-panel" aria-label="Left panel">
            <div className="csl2-panel-head">
              {left === "more"
                ? "More"
                : LEFT_PANELS.find((p) => p.id === left)?.label}
              {sectioned ? (
                <span className="csl2-panel-head-count">
                  {activeSection + 1} of {sections.length}
                </span>
              ) : null}
            </div>
            {subtabs}
            <div className="csl2-panel-body">{leftContent}</div>
          </aside>
        )}

        <main className="csl2-map" aria-label="Map" ref={mapRef}>
          {map}
          {dock && !isMobile ? (
            <div className="csl2-dock" ref={dockRef}>
              {dock}
            </div>
          ) : null}
          {overlay}
          {phoneChrome}
        </main>

        {!bleed && !isMobile && rightTabs.length > 0 && (
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
              <div
                className="csl2-tabs"
                style={{ borderBottom: "1px solid var(--line)" }}
              >
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

      {isMobile ? (
        // The tab bar replaces the action bar. Its verbs are not lost: Clear
        // selection and Clear filters are in the title bar's menu, and the
        // contact-type filter is the Histogram panel's bars. Sizes are px: the
        // root font is 13px, so a rem class misses the 44px touch target.
        <nav className="ptabs" data-primary-nav aria-label="Map">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={sheet === t.id}
              onClick={t.run}
            >
              <Icon name={t.icon} className="h-[20px] w-[20px]" />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      ) : action ? (
        <div className="csl2-action">{action}</div>
      ) : null}
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
