import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../normal/Icon.js";
import { useAuth } from "../auth/AuthContext.js";
import { isSupabaseConfigured } from "../transport/supabase.js";
import {
  useAppView,
  APP_META,
  APP_GROUPS,
  type AppId,
} from "../state/appView.js";
import { BottomSheet } from "./BottomSheet.js";
import { useIsMobile } from "./useIsMobile.js";
import { usePhoneSheet } from "./phoneSheet.js";
import {
  useEntityStats,
  setStatsViewer,
  acquireStats,
} from "../globe/entityStats.js";
import { perfSnapshot } from "../globe/perf.js";
import { flyToGlobal, resetToTopDown } from "../globe/camera.js";
import { viewerCenter } from "../globe/center.js";
import { useMapTools } from "../globe/mapTools.js";
import { useLiveHidden } from "../globe/liveVisibility.js";
import { useAgent } from "../state/agent.js";
import {
  useAlerts,
  useConnection,
  useFilters,
  useImagery,
  useSelection,
  useTime,
} from "../state/stores.js";
import { BASEMAP_OPTIONS } from "../globe/basemaps.js";
import { useFloatingPanels } from "../state/floatingPanels.js";
import { usePalette } from "../state/palette.js";
import { useSettings } from "../state/settings.js";
import { useTheme } from "../state/theme.js";
import { SCHEMES } from "../theme/schemes.js";
import { useUiMode } from "../state/uiMode.js";
import { openMapToolPanel } from "./panels/MapToolPanels.js";
import { toast } from "./toast.js";
import { BpIcon } from "./BpIcon.js";
import { APP_BADGE, APP_BP } from "./appGlyphs.js";
import type * as Cesium from "cesium";

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

// Four menus, as the reference window has. The drawing tools (once Collect)
// are edits to the map and live in Edit; the window items (once Window) are
// views and live in View; Help is Support.
export const MENUS = ["File", "Edit", "View", "Support"] as const;

// Document tab widths and the gaps before them, as measured on the reference
// tabs bar (235 / 260 / 265, gaps 10 / 15). Later tabs repeat the last pair.
const TAB_W = [235, 260, 265];
const TAB_GAP = [0, 10, 15];

/** Alert-socket state as a dot. `connecting` is amber rather than green: a
 *  socket that has not opened yet is not carrying alerts. */
const WS_DOT: Record<string, string> = {
  open: "bg-ok",
  connecting: "bg-warn",
  closed: "bg-alert",
  error: "bg-alert",
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

export interface MenuCtx {
  viewer: Cesium.Viewer | null | undefined;
  openAlerts: () => void;
  openInbox: () => void;
  openSettings: () => void;
}

export const MENU_ITEMS: Record<(typeof MENUS)[number], MenuItem[]> = {
  File: [
    {
      label: "Command palette…",
      hint: "⌘K",
      run: () => usePalette.getState().setOpen(true),
    },
    {
      label: "Find objects near here",
      run: () => useAppView.getState().setApp("explorer"),
      sep: true,
    },
    {
      label: "New report",
      run: () => useAppView.getState().setApp("reports"),
    },
    {
      label: "Open Foundry datasets",
      run: () => useAppView.getState().setApp("foundry"),
    },
    {
      label: "Save this view as a PNG",
      sep: true,
      disabled: (c) =>
        c.viewer && !c.viewer.isDestroyed()
          ? null
          : "The globe is not running.",
      run: (c) => {
        const v = c.viewer;
        if (!v || v.isDestroyed()) return;
        // Cesium only guarantees the buffer is intact during a render, so ask
        // for one and read the canvas in the same frame.
        v.render();
        const url = v.canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = url;
        a.download = "velocity-view.png";
        a.click();
      },
    },
    { label: "Settings…", sep: true, run: (c) => c.openSettings() },
  ],
  Edit: [
    {
      label: "Clear selection",
      disabled: () =>
        useSelection.getState().selectedEntityId
          ? null
          : "Nothing is selected.",
      run: () => useSelection.getState().select(null),
    },
    {
      label: "Clear filters",
      disabled: () =>
        useFilters.getState().clauses.length > 0 ? null : "No filters are set.",
      run: () => useFilters.getState().clear(),
    },
    {
      label: "Clear the alert buffer",
      sep: true,
      disabled: () =>
        useAlerts.getState().alerts.length > 0 ? null : "The buffer is empty.",
      run: () => useAlerts.getState().clear(),
    },
    {
      label: "Copy the camera centre",
      sep: true,
      disabled: (c) =>
        c.viewer && !c.viewer.isDestroyed()
          ? null
          : "The globe is not running.",
      run: (c) => {
        const p = viewerCenter(c.viewer ?? null);
        if (p)
          void navigator.clipboard?.writeText(
            `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`,
          );
      },
    },
    {
      label: "Measure a distance",
      sep: true,
      run: () => useMapTools.getState().setTool("measure"),
    },
    {
      label: "Select an area",
      run: () => useMapTools.getState().setTool("area"),
    },
    {
      label: "Drop an annotation",
      run: () => useMapTools.getState().setTool("annotate"),
    },
    { label: "Stop drawing", run: () => useMapTools.getState().setTool("pan") },
    {
      label: "Annotations…",
      sep: true,
      run: () => openMapToolPanel("annotate"),
    },
    { label: "Watchboxes…", run: () => openMapToolPanel("watch") },
    { label: "Field kit…", run: () => openMapToolPanel("field") },
    {
      label: "Task a satellite",
      sep: true,
      run: () => useUiMode.getState().setMode("tasking"),
    },
    {
      label: "Edit the COP laydown",
      run: () => useUiMode.getState().setMode("cop"),
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
      sep: i > 0 && s.family === "light" && SCHEMES[i - 1]?.family === "dark",
      on: () => useTheme.getState().mode === s.id,
      run: () => useTheme.getState().setMode(s.id),
    })),
    {
      label: "Next colour scheme",
      hint: "⇧T",
      sep: true,
      run: () => useTheme.getState().toggle(),
    },
    // The basemap. The picker lived only in CommandBar, which this bar
    // replaced, so every basemap but the default was unreachable in this shell
    // — including the two proxied stacks. Generated from BASEMAP_OPTIONS for
    // the same reason the schemes are: a basemap cannot be added to the globe
    // and left with no way to choose it.
    ...BASEMAP_OPTIONS.map((b, i) => ({
      label: `Basemap · ${b.label}`,
      sep: i === 0,
      on: () => useImagery.getState().mode === b.value,
      run: () => useImagery.getState().setMode(b.value),
      ...(b.unavailable ? { disabled: b.unavailable } : {}),
    })),
    {
      label: "Reset to top-down",
      sep: true,
      disabled: (c) =>
        c.viewer && !c.viewer.isDestroyed()
          ? null
          : "The globe is not running.",
      run: (c) => {
        if (c.viewer) resetToTopDown(c.viewer);
      },
    },
    {
      label: "Zoom out to the whole globe",
      disabled: (c) =>
        c.viewer && !c.viewer.isDestroyed()
          ? null
          : "The globe is not running.",
      run: (c) => {
        if (c.viewer) flyToGlobal(c.viewer);
      },
    },
    {
      label: "Corroborated contacts only",
      sep: true,
      on: () => useSettings.getState().corroboratedOnly,
      run: () =>
        useSettings
          .getState()
          .set("corroboratedOnly", !useSettings.getState().corroboratedOnly),
    },
    {
      label: "Assess the selection with AI",
      on: () => useSettings.getState().selectionAiEnabled,
      run: () =>
        useSettings
          .getState()
          .set(
            "selectionAiEnabled",
            !useSettings.getState().selectionAiEnabled,
          ),
    },
    { label: "Inbox", sep: true, run: (c) => c.openInbox() },
    { label: "Alerts", hint: "A", run: (c) => c.openAlerts() },
    {
      label: "Analyst console",
      hint: "⌘J",
      sep: true,
      run: () => useAgent.getState().toggle(),
    },
    {
      label: "Re-dock every floating panel",
      sep: true,
      disabled: () =>
        Object.keys(useFloatingPanels.getState().panels).length > 0
          ? null
          : "Nothing is floating right now.",
      run: () => {
        const { panels, redock } = useFloatingPanels.getState();
        for (const id of Object.keys(panels)) redock(id);
      },
    },
    {
      label: "Close the workspace overlay",
      disabled: () =>
        useUiMode.getState().mode ? null : "No workspace is open.",
      run: () => useUiMode.getState().setMode(null),
    },
  ],
  Support: [
    {
      label: "Keyboard shortcuts",
      run: () =>
        toast.ok(
          "⌘K palette · ⌘J analyst console · A alerts · 1-4 left panels · Esc closes",
        ),
    },
    {
      label: "Read the docs",
      sep: true,
      run: () =>
        window.open(
          "https://github.com/AndrewCTF/velocity#readme",
          "_blank",
          "noreferrer",
        ),
    },
    {
      label: "Report a problem",
      run: () =>
        window.open(
          "https://github.com/AndrewCTF/velocity/issues",
          "_blank",
          "noreferrer",
        ),
    },
  ],
};

/** One icon per app. The launcher drew the same `hexagon` fourteen times, so
 *  the icon column carried no information at all and the list could only be
 *  read word by word. */
export const APP_ICON: Record<AppId, IconName> = {
  map: "globe",
  ai: "sparkle",
  explorer: "chart",
  graph: "network",
  investigate: "search",
  targeting: "target",
  video: "film",
  sim: "radar",
  reports: "file",
  foundry: "database",
  workflows: "route",
  city: "building",
  country: "flag",
  markets: "chart-line",
  models: "cpu",
  quiver: "chart-line",
  vertex: "network",
  workshop: "grid",
};

export function TitleBar({
  classification = "UNCLAS",
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
  // Where the open dropdown should be painted. The header clips its overflow
  // (that is what keeps the control row from growing a scrollbar), so a dropdown
  // rendered inside it is 40px tall and looks like nothing happened — the menus
  // highlighted and opened and the operator saw an empty bar. They are portalled
  // to the body and positioned against the trigger's rect instead.
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );
  const popRef = useRef<HTMLDivElement | null>(null);
  const anchorFrom = (el: HTMLElement): { left: number; top: number } => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.bottom + 2 };
  };
  // Live state behind the document line. Subscribed, not read once, so "live /
  // held" and the socket dot change when the thing they describe changes.
  const playing = useTime((s) => s.playing);
  // A replay runs the clock too, over the past, with the live map hidden.
  const replaying = useLiveHidden();
  const notices = usePhoneSheet((s) => s.notices);
  const showSheet = usePhoneSheet((s) => s.show);
  const phoneSheet = usePhoneSheet((s) => s.open);
  const currentTime = useTime((s) => s.currentTime);
  const ws = useConnection((s) => s.ws);
  const clock = new Date(currentTime).toISOString().slice(11, 19) + "Z";
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
      setRenderMs(typeof v === "number" && v > 0 ? v : null);
    }, 1000);
    return () => window.clearInterval(t);
  }, []);
  const alertCount = useAlerts((st) => st.alerts.length) || alerts;
  const [launcher, setLauncher] = useState(false);
  // Phone: the whole bar folds into one Menu button (see PhoneMenu below).
  const isMobile = useIsMobile();
  const activeApp = useAppView((s) => s.app);
  const setApp = useAppView((s) => s.setApp);
  const [pinned, setPinned] = useState<AppId[]>(["map", "graph", "explorer"]);

  const togglePin = (id: AppId): void =>
    setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  // A dropdown that only closes when you pick something is a trap. Escape and a
  // click anywhere outside both close the menu bar and the app launcher.
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu && !launcher) return;
    const onDown = (e: PointerEvent): void => {
      if (barRef.current?.contains(e.target as Node)) return;
      // The dropdown is portalled to the body, so it is NOT inside barRef.
      if (popRef.current?.contains(e.target as Node)) return;
      setMenu(null);
      setLauncher(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Stop the globe's own Escape handlers from also firing on a keystroke the
      // operator aimed at this menu.
      e.stopPropagation();
      setMenu(null);
      setLauncher(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu, launcher]);

  // The document line. It used to be a hardcoded amber square, a fixed title
  // and a green check reading "Saved" — three pieces of chrome that were true
  // of nothing. It said Saved on a console that saves nothing, which is the
  // fabricated-state failure this repo bans in the map and had left sitting in
  // the window frame.
  //
  // Now: what you are looking at, whether the clock is live or held, and
  // whether the alert socket is actually up. Every value is read from the store
  // that owns it. Built once because the desktop bar and the phone strip both
  // carry it.
  const docLine = (
    <span
      className="ml-3 flex min-w-0 flex-1 items-center justify-center gap-2"
      title={
        replaying
          ? "Replaying the past. Live contacts are hidden until you return to live."
          : playing
            ? "The clock is running at real time; contacts advance as fixes arrive."
            : "The clock is held. Contacts stay at the fix they had when you paused."
      }
    >
      <span
        className={`h-[10px] w-[10px] shrink-0 rounded-[1px] ${replaying ? "bg-accent" : playing ? "bg-ok" : "bg-warn"}`}
        aria-hidden
      />
      <span className="truncate text-[13px] font-semibold text-txt-0">
        {documentTitle ?? APP_META[activeApp]?.label ?? "Live map"}
      </span>
      <span className="mono shrink-0 tabular-nums text-[12px] text-txt-2">
        {clock}
      </span>
      <span className="shrink-0 text-[12px] text-txt-3">
        {replaying ? "replay" : playing ? "live" : "held"}
      </span>
      <span
        className={`h-[6px] w-[6px] shrink-0 rounded-full ${WS_DOT[ws] ?? "bg-bg-4"}`}
        title={`Alert socket: ${ws}`}
        aria-label={`Alert socket ${ws}`}
      />
    </span>
  );

  // The marking, as a pill. A full-width saturated band was 26px of screen
  // spent on one word, and the loudest thing on a data surface.
  const pill = (
    <span
      className="csl2-clas ml-2"
      data-kind={exercise ? "exercise" : "unclas"}
    >
      <Icon name="shield" className="h-3 w-3" />
      {exercise ? "EXERCISE" : classification}
    </span>
  );

  // On a phone the bar is not a bar. It floats on the map's top edge as a map
  // app's does: the menu, a search pill, the marking, and under them one chip
  // for the clock (tap it for Time) and one for notices when there are any.
  // The six menus, the app launcher, inbox, alerts, settings and the account
  // chip are all in the Menu sheet; as a strip they were ~860px of 20px controls
  // in a 412px window.
  if (isMobile)
    return (
      <div ref={barRef} className="contents">
        <div className="pfloat-row">
          <nav aria-label="Application" data-primary-nav className="contents">
            <button
              type="button"
              onClick={() => usePhoneSheet.getState().toggle("menu")}
              aria-label="Menu"
              aria-haspopup="dialog"
              aria-expanded={phoneSheet === "menu"}
              className="pround"
            >
              <Icon name="menu" className="h-[20px] w-[20px]" />
            </button>
          </nav>
          <button
            type="button"
            className="psearch"
            onClick={() => showSheet("find")}
          >
            <Icon name="search" className="h-[18px] w-[18px] shrink-0" />
            <span>Search planes, ships</span>
          </button>
          {pill}
        </div>
        <div className="pfloat-chips">
          <button
            type="button"
            className="pchip"
            onClick={() => showSheet("time")}
            title={
              replaying
                ? "Replaying the past. Open Time to return to live."
                : "Open Time"
            }
          >
            <span
              className={`h-[8px] w-[8px] shrink-0 rounded-full ${replaying ? "bg-accent" : playing ? "bg-ok" : "bg-warn"}`}
              aria-hidden
            />
            {documentTitle ?? APP_META[activeApp]?.label ?? "Live map"}
            <span className="mono tabular-nums">{clock}</span>
            <span>{replaying ? "replay" : playing ? "live" : "held"}</span>
          </button>
          {notices > 0 && (
            <button
              type="button"
              className="pchip"
              data-tone="warn"
              onClick={() => showSheet("notices")}
            >
              <Icon name="warning" className="h-[14px] w-[14px]" />
              {notices === 1 ? "1 notice" : `${notices} notices`}
            </button>
          )}
        </div>
        <PhoneMenu
          open={phoneSheet === "menu"}
          onClose={() => showSheet(null)}
          ctx={ctx}
          activeApp={activeApp}
          setApp={setApp}
        />
      </div>
    );

  // Every app the operator pinned is a document tab, plus the open app when it
  // is not pinned, so the tab row always names what is on screen.
  const tabs = pinned.includes(activeApp) ? pinned : [...pinned, activeApp];

  return (
    // `display: contents` — a DOM node the outside-click test can ask about,
    // with no box of its own. Its children are the shell's grid items: banner,
    // tabs bar, menu row and document line (console.css grid areas).
    <div ref={barRef} className="contents">
      {/* The deployment's own marking from /api/config (settings.classification),
          as the full-width band of the reference shell. Never a literal. */}
      <div className="csl2-banner" data-kind={exercise ? "exercise" : "unclas"}>
        {exercise ? "EXERCISE" : classification}
      </div>

      <div className="csl2-tabsbar">
        {/* Rail-top glyph: home to the map. The live contact count and frame
            cost ride in its tooltip; the bar itself carries no gauges, as the
            reference bar carries none. */}
        <button
          type="button"
          className="csl2-home"
          onClick={() => setApp("map")}
          aria-label="Map"
          title={`Map · ${counted.toLocaleString()} contacts in view${
            renderMs !== null ? ` · ${renderMs.toFixed(1)} ms a frame` : ""
          }`}
        >
          <BpIcon name="globe" size={20} />
        </button>
        <button
          type="button"
          className="csl2-search"
          onClick={() => usePalette.getState().setOpen(true)}
          aria-label="Search and commands"
          title="Search objects, places and commands (Ctrl K)"
        >
          <span>Search…</span>
          <kbd>Ctrl K</kbd>
        </button>
        {/* The apps, behind one launcher; the pinned ones are also tabs. */}
        <button
          type="button"
          className="csl2-launch"
          onClick={(e) => {
            setAnchor(anchorFrom(e.currentTarget));
            setLauncher((v) => !v);
          }}
          aria-expanded={launcher}
          aria-label="All apps"
          title="All apps"
        >
          <BpIcon name="applications" size={16} />
        </button>
        {tabs.map((id, i) => (
          <button
            key={id}
            type="button"
            className="csl2-dtab"
            style={{
              width: TAB_W[i] ?? 260,
              marginLeft: TAB_GAP[i] ?? 15,
            }}
            aria-current={id === activeApp ? "page" : undefined}
            title={APP_META[id]?.hint}
            onClick={() => setApp(id)}
          >
            <span
              className="csl2-dtab-ico"
              style={{ background: APP_BADGE[id] ?? "#5f6b7c" }}
              aria-hidden
            >
              <BpIcon name={APP_BP[id] ?? "application"} size={13} />
            </span>
            <span className="truncate">{APP_META[id]?.label ?? id}</span>
          </button>
        ))}

        {/* Icon over count, as the reference stacks them: the alert ticker
            and the triage inbox. */}
        <div className="csl2-sys">
          <button
            type="button"
            className="csl2-cnt"
            onClick={onOpenAlerts}
            title="Alerts: the live rule-hit ticker"
            aria-label={`Alerts, ${alertCount}`}
          >
            <BpIcon name="comment" size={20} />
            <span>{alertCount}</span>
          </button>
          {onOpenInbox && (
            <button
              type="button"
              className="csl2-cnt"
              onClick={onOpenInbox}
              title="Inbox: alerts triaged into unread, working and done"
              aria-label={`Inbox, ${inbox}`}
            >
              <BpIcon name="inbox" size={20} />
              <span>{inbox}</span>
            </button>
          )}
        </div>
      </div>

      {/* Real words. File / Edit / View is the single most recognisable thing
          about a window and it costs 30px once. */}
      <nav className="csl2-menu" aria-label="Application">
        {MENUS.map((m) => (
          <div key={m} className="relative">
            <button
              type="button"
              onClick={(e) => {
                setAnchor(anchorFrom(e.currentTarget));
                setMenu(menu === m ? null : m);
              }}
              // Once one menu is open, hovering the next opens it, the way every
              // real menu bar behaves.
              onPointerEnter={(e) => {
                const el = e.currentTarget;
                setMenu((cur) => {
                  if (cur === null) return cur;
                  setAnchor(anchorFrom(el));
                  return m;
                });
              }}
              aria-expanded={menu === m}
              aria-haspopup="menu"
              className={`h-[28px] rounded-sm px-[9px] text-[16px] ${
                menu === m
                  ? "bg-(--hover) text-txt-0"
                  : "text-txt-1 hover:bg-(--hover)"
              }`}
            >
              {m}
            </button>
            {menu === m &&
              anchor &&
              createPortal(
                <div
                  ref={popRef}
                  role="menu"
                  aria-label={m}
                  style={{
                    position: "fixed",
                    left: anchor.left,
                    top: anchor.top,
                  }}
                  className="z-(--z-dropdown) max-h-[70vh] w-[264px] overflow-auto rounded-sm border border-line-2 bg-bg-2 py-1 shadow-(--sh-pop)"
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
                          it.sep ? "mt-1 border-t border-line pt-[7px]" : ""
                        } ${
                          why
                            ? "cursor-not-allowed text-txt-3"
                            : "text-txt-1 hover:bg-(--hover) hover:text-txt-0"
                        }`}
                      >
                        <Icon
                          name="check"
                          className={`h-3 w-3 shrink-0 ${checked ? "text-accent-fg" : "invisible"}`}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {it.label}
                        </span>
                        {it.hint && (
                          <span className="mono shrink-0 text-txt-3">
                            {it.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}
          </div>
        ))}
      </nav>

      {launcher &&
        anchor &&
        createPortal(
          <div
            ref={popRef}
            style={{ position: "fixed", left: anchor.left, top: anchor.top }}
            className="z-(--z-dropdown) max-h-[70vh] w-[260px] overflow-auto rounded-sm border border-line-2 bg-bg-2 py-1 shadow-(--sh-pop)"
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
            {APP_GROUPS.filter((g) =>
              g.apps.some((id) => !pinned.includes(id)),
            ).map((g) => (
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
          </div>,
          document.body,
        )}

      {/* The document line, centred as the reference has it. What you are
          looking at, whether the clock is live or held, and whether the alert
          socket is up; every value read from the store that owns it. It once
          was a hardcoded amber square, a fixed title and "Saved" on a console
          that saves nothing. The star is the app pin the tabs bar shows. */}
      <div className="csl2-mid">
        <button
          type="button"
          className="csl2-star"
          aria-pressed={pinned.includes(activeApp)}
          aria-label={
            pinned.includes(activeApp)
              ? `Unpin ${APP_META[activeApp]?.label ?? activeApp} from the tabs`
              : `Pin ${APP_META[activeApp]?.label ?? activeApp} to the tabs`
          }
          title="Pin this app to the tabs bar"
          onClick={() => togglePin(activeApp)}
        >
          <BpIcon
            name={pinned.includes(activeApp) ? "star" : "star-empty"}
            size={16}
          />
        </button>
        <span className="csl2-mid-ico" aria-hidden>
          <BpIcon name={APP_BP[activeApp] ?? "application"} size={11} />
        </span>
        {/* The title, then the clock state as a dot: live green, held amber,
            and the alert socket in the tooltip. Every value is read from the
            store that owns it. */}
        <button
          type="button"
          className="csl2-mid-title"
          onClick={(e) => {
            setAnchor(anchorFrom(e.currentTarget));
            setLauncher((v) => !v);
          }}
          aria-expanded={launcher}
          title={`${playing ? "Live" : "Held"} · ${clock} · alert socket ${ws}. Open another app.`}
        >
          <span className="truncate">
            {documentTitle ?? APP_META[activeApp]?.label ?? "Live map"}
          </span>
          <BpIcon
            name="chevron-down"
            size={12}
            className="text-(--csl2-mute)"
          />
        </button>
        <span
          className={`h-[6px] w-[6px] shrink-0 rounded-full ${playing ? (WS_DOT[ws] ?? "bg-bg-4") : "bg-warn"}`}
          aria-label={`${playing ? "live" : "held"}, alert socket ${ws}`}
        />
      </div>

      {docLine}
      <div className="csl2-doc">
        <SignInChip />
        <span className="csl2-vsep" aria-hidden />
        {/* The deployment's marking from /api/config, as the reference's
            right-hand shield. Never a literal. */}
        {pill}
        <button
          type="button"
          className="csl2-refresh"
          onClick={() => window.location.reload()}
          aria-label="Reload the console"
          title="Reload the console"
        >
          <BpIcon name="refresh" size={16} />
        </button>
      </div>
    </div>
  );
}

/** Account state is window chrome. It used to be a chip pinned over the map at
 *  top-10 right-3, which is the compass rose's corner, so the two overlapped. */
function SignInChip(): JSX.Element | null {
  const { user, loading, signOut } = useAuth();
  if (!isSupabaseConfigured || loading) return null;
  if (!user) return null; // the dashboard is gated behind /login
  // The visible word is the action (ASVS V7.4.4): a chip showing only the email
  // did not say that clicking it ends the session. The account stays in the
  // tooltip and the accessible name. Same width budget as the email it
  // replaces, so the title bar does not overflow.
  const who = user.email ?? user.id.slice(0, 8);
  return (
    <button
      type="button"
      onClick={() => void signOut()}
      title={`Signed in as ${who}`}
      aria-label={`Sign out ${who}`}
      className="flex h-6 shrink-0 items-center gap-[5px] rounded-sm px-2 text-[12px] text-txt-2 hover:bg-(--hover)"
    >
      <Icon name="user" className="h-3 w-3" />
      <span>Sign out</span>
    </button>
  );
}

function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
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
        active
          ? "bg-accent-dim text-accent-fg"
          : "text-txt-1 hover:bg-(--hover)"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        title={meta?.hint}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <Icon
          name={APP_ICON[id] ?? "hexagon"}
          className={`h-3 w-3 shrink-0 ${active ? "text-accent-fg" : "text-txt-3"}`}
        />
        <span className="truncate">{meta?.label ?? id}</span>
      </button>
      <button
        type="button"
        onClick={onStar}
        aria-label={
          starred ? `Unpin ${meta?.label ?? id}` : `Pin ${meta?.label ?? id}`
        }
        className={starred ? "text-warn" : "text-bg-4 group-hover:text-txt-3"}
      >
        <Icon name="star" className="h-3 w-3" />
      </button>
    </div>
  );
}

// ── Phone ────────────────────────────────────────────────────────────────────

/** One row of the phone menu. 44px in px, not `h-11`: the root font is 13px, so
 *  the rem class is 36px and misses the touch target. */
const PHONE_ROW =
  "flex min-h-[48px] w-full items-center gap-3 rounded-sm px-4 text-left text-[15px] text-txt-1 hover:bg-(--hover)";

/** What the desktop bar spreads across six menus, an app launcher, three icon
 *  buttons and an account chip, in the one sheet the phone's Menu button opens:
 *  the 2D map, the apps, then every menu with the same items and the same
 *  commands. Nothing is invented and nothing is dropped; a menu hint (⌘K) is the
 *  one thing left off, because a phone has no key to press. A bottom sheet in
 *  the map well like every other phone surface, opened at full height. */
function PhoneMenu({
  open,
  onClose,
  ctx,
  activeApp,
  setApp,
}: {
  open: boolean;
  onClose: () => void;
  ctx: MenuCtx;
  activeApp: AppId;
  setApp: (id: AppId) => void;
}): JSX.Element | null {
  const well = usePhoneSheet((s) => s.mapWell);
  if (!well) return null;
  return createPortal(
    <BottomSheet label="Menu" open={open} onClose={onClose} initial="full">
      <div className="flex flex-col py-1">
        <Link to="/2d" onClick={onClose} className={PHONE_ROW}>
          <Icon name="map" className="h-[16px] w-[16px] shrink-0 text-txt-3" />
          2D map
          <span className="ml-auto truncate text-[12px] text-txt-3">
            lighter on a weak GPU
          </span>
        </Link>
        <Group label="Apps">
          {APP_GROUPS.flatMap((g) => g.apps).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setApp(id);
                onClose();
              }}
              title={APP_META[id]?.hint}
              className={`${PHONE_ROW} ${id === activeApp ? "bg-accent-dim text-accent-fg" : ""}`}
            >
              <Icon
                name={APP_ICON[id] ?? "hexagon"}
                className="h-[16px] w-[16px] shrink-0"
              />
              {APP_META[id]?.label ?? id}
            </button>
          ))}
        </Group>
        {MENUS.map((m) => (
          <Group key={m} label={m}>
            {MENU_ITEMS[m].map((it) => {
              const why = it.disabled?.(ctx) ?? null;
              const checked = it.on?.(ctx) ?? false;
              return (
                <button
                  key={it.label}
                  type="button"
                  disabled={why !== null}
                  {...(why ? { title: why } : {})}
                  onClick={() => {
                    it.run(ctx);
                    onClose();
                  }}
                  className={`${PHONE_ROW} ${why ? "cursor-not-allowed text-txt-3" : ""}`}
                >
                  <Icon
                    name="check"
                    className={`h-3 w-3 shrink-0 ${checked ? "text-accent-fg" : "invisible"}`}
                  />
                  <span className="min-w-0 flex-1">{it.label}</span>
                </button>
              );
            })}
          </Group>
        ))}
        <PhoneAccount onDone={onClose} />
      </div>
    </BottomSheet>,
    well,
  );
}

/** Sign in or out, as a menu row. SignInChip is the desktop bar's version of
 *  this and its 20px chip is not a phone target. Same rule as there: the visible
 *  word is the action (ASVS V7.4.4), the account stays in the accessible name. */
function PhoneAccount({ onDone }: { onDone: () => void }): JSX.Element | null {
  const { user, loading, signOut } = useAuth();
  if (!isSupabaseConfigured || loading) return null;
  if (!user)
    return (
      <Link to="/login" onClick={onDone} className={`${PHONE_ROW} mt-2`}>
        <Icon name="user" className="h-[16px] w-[16px] shrink-0 text-txt-3" />
        Sign in
      </Link>
    );
  const who = user.email ?? user.id.slice(0, 8);
  return (
    <button
      type="button"
      onClick={() => {
        onDone();
        void signOut();
      }}
      aria-label={`Sign out ${who}`}
      className={`${PHONE_ROW} mt-2`}
    >
      <Icon name="user" className="h-[16px] w-[16px] shrink-0 text-txt-3" />
      Sign out
      <span className="ml-auto truncate text-[12px] text-txt-3">{who}</span>
    </button>
  );
}
