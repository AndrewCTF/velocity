import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type * as Cesium from "cesium";
import { useMapTools } from "../globe/mapTools.js";
import "./slate.css";
import { useAuth } from "../auth/AuthContext.js";
import { isSupabaseConfigured } from "../transport/supabase.js";
import {
  APP_GROUPS,
  APP_META,
  useAppView,
  type AppId,
} from "../state/appView.js";
import { useAlerts, useSelection, useTime } from "../state/stores.js";
import { usePalette } from "../state/palette.js";
import { BpIcon } from "../shell/BpIcon.js";
import { APP_BADGE, APP_BP, APP_INK } from "../shell/appGlyphs.js";
import { MENUS, MENU_ITEMS, type MenuCtx } from "../shell/TitleBar.js";
import { LEFT_PANELS, type LeftPanelId } from "../shell/panels.js";
import type { ConsoleProps } from "../shell/Console.js";
import { toast } from "../shell/toast.js";
import { SlateSituations, useOpenSituation } from "./SlateSituations.js";
import { ErrorBoundary } from "../shell/ErrorBoundary.js";
import { SlateObject, isSlateObject } from "./features/object/SlateObject.js";
import { SlatePlaces } from "./features/places/SlatePlaces.js";
import { SituationObject } from "./features/situation/SituationObject.js";
import { TaskFlow } from "./features/tasking/TaskFlow.js";
import { MapFx } from "./features/mapfx/MapFx.js";
import { ObsPopover } from "./features/observation/ObsPopover.js";
import { ProjectToast } from "./features/observation/ProjectToast.js";
import { DocPins } from "./features/dossier/DocPins.js";
import { Dossier } from "./features/dossier/Dossier.js";
import { useDossier } from "./features/dossier/data.js";
import { OrderCounter } from "./features/tasking/orders.js";
import { ResolveToast, ReviewPrompt } from "./features/situation/flow.js";
import { GlobeFx } from "../globe/GlobeFx.js";
import {
  MavenHeader,
  MavenMapChrome,
  MavenSelection,
  mavenMarking,
  mavenMenu,
  useMavenMode,
} from "../globe/MavenMap.js";
import {
  ImageryWorkspace,
  useImageryView,
} from "./features/imagery/ImageryWorkspace.js";

// SlateShell: the reference workspace page (the copied hero frame) as the
// app's shell, element for element, wired to the live stores. Class names and
// pixel positions are the copy's (slate.css); this file only decides what is
// real in each slot. Rendered for the Slate scheme; every other scheme keeps
// shell/Console.tsx.

export interface SlateChrome {
  viewer?: Cesium.Viewer | null;
  classification?: string;
  inbox?: number;
  onOpenAlerts?: () => void;
  onOpenInbox?: () => void;
  onOpenSettings?: () => void;
}

type LeftTab = "situations" | LeftPanelId;

// The left frame's tabs are the reference's three: Situations, Ops (what the
// system is doing: feeds, chokepoints, ACARS, intel) and Data (the layers).
// Find and the histogram live on the rail's grey group; 1-4 still select
// Layers, Find, Histogram and Info as Support > Keyboard shortcuts says.
const PTABS = [
  { id: "info", short: "Ops", label: "Info", key: "4", icon: "tick" },
  { id: "layers", short: "Data", label: "Layers", key: "1", icon: "layers" },
] as const;
// The floating map tool column is not drawn in this shell (the reference map
// is bare), so the three of its actions no menu item named live here.
type ExtraItem = (typeof MENU_ITEMS)["Edit"][number];
const zoomBy = (v: Cesium.Viewer | null | undefined, inward: boolean): void => {
  if (!v || v.isDestroyed()) return;
  const h = v.camera.positionCartographic.height;
  if (inward) v.camera.zoomIn(h * 0.5);
  else v.camera.zoomOut(h);
};
const noGlobe = (c: MenuCtx): string | null =>
  c.viewer && !c.viewer.isDestroyed() ? null : "The globe is not running.";
const MOVE: ExtraItem = {
  label: "Move a marker",
  on: () => useMapTools.getState().tool === "move",
  run: () => useMapTools.getState().setTool("move"),
};
const ZOOM: ExtraItem[] = [
  {
    label: "Zoom in",
    sep: true,
    disabled: noGlobe,
    run: (c) => zoomBy(c.viewer, true),
  },
  { label: "Zoom out", disabled: noGlobe, run: (c) => zoomBy(c.viewer, false) },
];
const COP: ExtraItem = {
  label: "Shared COP…",
  sep: true,
  run: () => window.dispatchEvent(new Event("velocity:cop-toggle")),
};
const SLATE_EXTRA: Record<string, ExtraItem[]> = {
  Edit: [MOVE],
  View: [...ZOOM, COP],
  "mv:Tools": [MOVE],
  "mv:Map": ZOOM,
  "mv:View": [COP],
};

const RAIL_PANELS = [
  { id: "layers", label: "Layers", key: "1", icon: "folder-open" },
  { id: "find", label: "Find", key: "2", icon: "search" },
  {
    id: "histogram",
    label: "Histogram",
    key: "3",
    icon: "horizontal-bar-chart",
  },
] as const;

// The copy's document tabs: left edge and width per slot.
// The reference's five doc tabs (~255px each from x=359). They flow in a strip
// and shrink on narrow windows instead of sitting at fixed x positions.
const MAX_TABS = 5;
// The copy's rail: eight coloured app glyphs at these tops.
const RAIL_TOPS = [13, 56, 99, 142, 186, 229, 272, 315];
const RAIL_APPS: readonly AppId[] = [
  "map",
  "sim",
  "explorer",
  "reports",
  "foundry",
  "workflows",
  "graph",
  "investigate",
];

export function SlateShell({
  initialPanel,
  leftPanels,
  leftBadges,
  map,
  dock,
  rightPanels,
  action,
  overlay,
  bleed = false,
  onPanelWhileBleed,
  chrome = {},
}: ConsoleProps & { chrome?: SlateChrome }): JSX.Element {
  const app = useAppView((s) => s.app);
  const setApp = useAppView((s) => s.setApp);
  const selected = useSelection((s) => s.selectedEntityId);
  const alertCount = useAlerts((s) => s.alerts.length);
  const playing = useTime((s) => s.playing);
  const openSit = useOpenSituation();
  const imagery = useImageryView((s) => s.id);
  const dossierOpen = useDossier((s) => s.story !== null);

  const [left, setLeft] = useState<LeftTab>(
    initialPanel && initialPanel !== "layers" ? initialPanel : "situations",
  );
  const [pinned, setPinned] = useState<AppId[]>(["map", "graph", "explorer"]);
  const [menu, setMenu] = useState<string | null>(null);
  const [launcher, setLauncher] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [right, setRight] = useState<"selection" | "series">("selection");
  const [objOpen, setObjOpen] = useState(Boolean(selected));
  useEffect(() => setObjOpen(Boolean(selected)), [selected]);

  const popRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  const openTab = useCallback(
    (t: LeftTab): void => {
      setLeft(t);
      if (bleed) onPanelWhileBleed?.();
    },
    [bleed, onPanelWhileBleed],
  );

  // 1-4 select the four named panels, as Support > Keyboard shortcuts says.
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
      const p = LEFT_PANELS[Number(e.key) - 1];
      if (!p) return;
      e.preventDefault();
      openTab(p.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTab]);

  // Menus and the launcher close on Escape and on a click outside.
  useEffect(() => {
    if (!menu && !launcher) return;
    const onDown = (e: PointerEvent): void => {
      if (barRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setMenu(null);
      setLauncher(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
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

  // Bottom map furniture clears the dock by its measured height.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = dockRef.current;
    const host = rootRef.current;
    if (!el || !host) return;
    const apply = (): void =>
      host.style.setProperty(
        "--dock-clear",
        `${Math.round(el.getBoundingClientRect().height) + 10}px`,
      );
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dock, bleed]);

  const anchorFrom = (el: HTMLElement): { left: number; top: number } => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.bottom + 2 };
  };
  const ctx: MenuCtx = {
    viewer: chrome.viewer,
    openAlerts: () => chrome.onOpenAlerts?.(),
    openInbox: () => chrome.onOpenInbox?.(),
    openSettings: () => chrome.onOpenSettings?.(),
  };

  const tabs = pinned.includes(app) ? pinned : [...pinned, app];
  const togglePin = (id: AppId): void =>
    setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const title =
    app === "map" && openSit ? openSit.name : (APP_META[app]?.label ?? app);
  const classification = chrome.classification ?? "UNCLAS";

  // A named panel that hosts several former panels shows them as sections.
  const leftBody = left === "situations" ? null : (leftPanels[left] ?? null);
  const sections = Children.toArray(leftBody).filter(
    (n): n is React.ReactElement<{ "aria-label"?: string }> =>
      isValidElement<{ "aria-label"?: string }>(n) &&
      typeof n.props["aria-label"] === "string",
  );
  const [section, setSection] = useState(0);
  useEffect(() => setSection(0), [left]);
  const sectioned = sections.length > 1;
  const activeSection = Math.min(section, sections.length - 1);

  const showObj = !bleed && objOpen && rightPanels.selection !== undefined;
  // The Data tab is the reference map-workspace page: its strip, header, map
  // tools and selection panel replace the situation page's for as long as it
  // is open (one of each on screen, never both).
  const maven = left === "layers" && !bleed && app === "map";
  useMavenMode(maven);
  const strip = mavenMarking(classification);
  const mavenObj = maven && showObj && selected !== null;

  return (
    <div
      ref={rootRef}
      className="slate-shell"
      style={
        {
          "--rail-left-w": bleed ? "0px" : "452px",
          "--rail-right-w": mavenObj
            ? "296px"
            : !bleed && imagery && imagery === selected
              ? "calc(100vw - 891px)"
              : showObj || (!bleed && dossierOpen)
                ? "474px"
                : "0px",
        } as CSSProperties
      }
    >
      <div ref={barRef} className="contents">
        {/* The deployment's marking from /api/config. Never a literal. */}
        {maven ? (
          <div
            className="a banner mv-strip"
            style={{ background: strip.color }}
          >
            {strip.text}
          </div>
        ) : (
          <div className="a banner">{classification}</div>
        )}

        <div className="a tabsbar">
          <button
            type="button"
            className="sl-home"
            style={{ left: 12, color: "#eef2f3" }}
            onClick={() => setApp("map")}
            aria-label="Map"
            title="Map"
          >
            <BpIcon name="globe" size={20} />
          </button>
          <button
            type="button"
            className="gs"
            onClick={() => usePalette.getState().setOpen(true)}
            aria-label="Search and commands"
            title="Search objects, places and commands (Ctrl K)"
          >
            Search…<kbd>Ctrl K</kbd>
          </button>
          <button
            type="button"
            style={{ left: 313, color: "#dbe2e4" }}
            onClick={(e) => {
              setAnchor(anchorFrom(e.currentTarget));
              setLauncher((v) => !v);
              setMenu(null);
            }}
            aria-expanded={launcher}
            aria-label="All apps"
            title="All apps"
          >
            <BpIcon name="applications" size={16} />
          </button>
          <div className="sl-dtabs">
            {tabs.slice(0, MAX_TABS).map((id) => {
              return (
                <button
                  key={id}
                  type="button"
                  className={`dtab${id === app ? " on" : ""}`}
                  aria-current={id === app ? "page" : undefined}
                  title={APP_META[id]?.hint}
                  onClick={() => setApp(id)}
                >
                  <span
                    className="ai"
                    style={{ background: APP_BADGE[id] ?? "#5f6b7c" }}
                  >
                    <BpIcon name={APP_BP[id]} size={13} />
                  </span>
                  <span className="truncate">{APP_META[id]?.label ?? id}</span>
                </button>
              );
            })}
          </div>
          <OrderCounter />
          <button
            type="button"
            className="cnt"
            style={{ right: 44 }}
            onClick={() => chrome.onOpenAlerts?.()}
            aria-label={`Alerts, ${alertCount}`}
            title="Alerts: the live rule-hit ticker"
          >
            <BpIcon name="comment" size={20} />
            {alertCount}
          </button>
          <button
            type="button"
            className="cnt"
            style={{ right: 7 }}
            onClick={() => chrome.onOpenInbox?.()}
            aria-label={`Inbox, ${chrome.inbox ?? 0}`}
            title="Inbox: alerts triaged into unread, working and done"
          >
            <BpIcon name="inbox" size={20} />
            {chrome.inbox ?? 0}
          </button>
        </div>

        {maven && (
          <div className="a menu">
            <MavenHeader
              title={title}
              pinned={pinned.includes(app)}
              onPin={() => togglePin(app)}
              inbox={chrome.inbox ?? 0}
              menu={menu}
              onMenu={(m, el) => {
                setAnchor(anchorFrom(el));
                setMenu(menu === m ? null : m);
                setLauncher(false);
              }}
              onMenuHover={(m, el) =>
                setMenu((cur) => {
                  if (cur === null) return cur;
                  setAnchor(anchorFrom(el));
                  return m;
                })
              }
              onLauncher={(el) => {
                setAnchor(anchorFrom(el));
                setLauncher((v) => !v);
                setMenu(null);
              }}
              ctx={ctx}
              live={playing}
              onLive={() => useTime.getState().togglePlay()}
            />
          </div>
        )}
        <div className="a menu" style={maven ? { display: "none" } : undefined}>
          {MENUS.map((m, i) => (
            <button
              key={m}
              type="button"
              style={{ left: [13, 59, 107, 160][i] }}
              aria-expanded={menu === m}
              aria-haspopup="menu"
              onClick={(e) => {
                setAnchor(anchorFrom(e.currentTarget));
                setMenu(menu === m ? null : m);
                setLauncher(false);
              }}
              onPointerEnter={(e) => {
                const el = e.currentTarget;
                setMenu((cur) => {
                  if (cur === null) return cur;
                  setAnchor(anchorFrom(el));
                  return m;
                });
              }}
            >
              {m}
            </button>
          ))}
          <span className="sep" style={{ left: 237 }} />
          {/* The open document: the pin star, the app glyph, the title. The
              chevron opens the launcher. */}
          <span style={{ left: "50%", transform: "translate(-50%, -50%)", gap: 8 }}>
            <button
              type="button"
              className="sl-plain"
              style={{ color: "#aab4b8" }}
              aria-pressed={pinned.includes(app)}
              aria-label={
                pinned.includes(app)
                  ? `Unpin ${APP_META[app]?.label} from the tabs`
                  : `Pin ${APP_META[app]?.label} to the tabs`
              }
              title="Pin this app to the tabs bar"
              onClick={() => togglePin(app)}
            >
              <BpIcon
                name={pinned.includes(app) ? "star" : "star-empty"}
                size={16}
              />
            </button>
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                background: APP_BADGE[app] ?? "#2f7fd6",
                display: "grid",
                placeItems: "center",
              }}
            >
              <BpIcon name={APP_BP[app]} size={11} />
            </span>
            <button
              type="button"
              className="sl-plain"
              style={{ gap: 8 }}
              title={playing ? "Live" : "Held"}
              onClick={(e) => {
                setAnchor(anchorFrom(e.currentTarget));
                setLauncher((v) => !v);
                setMenu(null);
              }}
            >
              {title}
              <BpIcon
                name="chevron-down"
                size={12}
                style={{ color: "#aab4b8" }}
              />
            </button>
          </span>
          <Account />
          <span className="sep" style={{ left: "auto", right: 147 }} />
          <span
            style={{ left: "auto", right: 60, fontSize: 15, gap: 6 }}
            title="Classification marking from the server configuration"
          >
            <BpIcon name="shield" size={16} />
            {classification}
          </span>
          <button
            type="button"
            style={{ left: "auto", right: 2, color: "#aab4b8" }}
            onClick={() => window.location.reload()}
            aria-label="Reload the console"
            title="Reload the console"
          >
            <BpIcon name="refresh" size={16} />
          </button>
        </div>
      </div>

      {menu &&
        anchor &&
        createPortal(
          <div
            ref={popRef}
            role="menu"
            aria-label={menu}
            style={{ position: "fixed", left: anchor.left, top: anchor.top }}
            className="sl-pop"
          >
            {[
              ...(maven
                ? mavenMenu(menu)
                : (MENU_ITEMS[menu as (typeof MENUS)[number]] ?? [])),
              ...(SLATE_EXTRA[maven ? `mv:${menu}` : menu] ?? []),
            ].map((it) => {
              const why = it.disabled?.(ctx) ?? null;
              const checked = it.on?.(ctx) ?? false;
              return (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  disabled={why !== null}
                  {...(why ? { title: why } : {})}
                  className={it.sep ? "sep" : undefined}
                  onClick={() => {
                    it.run(ctx);
                    setMenu(null);
                  }}
                >
                  <BpIcon
                    name="tick"
                    size={12}
                    style={{ visibility: checked ? "visible" : "hidden" }}
                  />
                  <span className="lbl">{it.label}</span>
                  {it.hint && <span className="hint">{it.hint}</span>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}

      {launcher &&
        anchor &&
        createPortal(
          <div
            ref={popRef}
            role="menu"
            aria-label="Apps"
            style={{ position: "fixed", left: anchor.left, top: anchor.top }}
            className="sl-pop"
          >
            {APP_GROUPS.map((g) => (
              <div key={g.id}>
                <div className="grp">{g.label}</div>
                {g.apps.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setApp(id);
                      setLauncher(false);
                    }}
                  >
                    <BpIcon
                      name={APP_BP[id]}
                      size={14}
                      style={{ color: APP_INK[id] ?? "#c9d1d4" }}
                    />
                    <span className="lbl">{APP_META[id].label}</span>
                    {id === app && <span className="hint">open</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>,
          document.body,
        )}

      <nav className="a rail" aria-label="Apps and panels">
        {RAIL_APPS.map((id, i) => (
          <button
            key={id}
            type="button"
            className={id === app ? "on" : undefined}
            style={{ top: RAIL_TOPS[i], color: APP_INK[id] ?? "#c9d1d4" }}
            aria-current={id === app ? "page" : undefined}
            aria-label={`Open ${APP_META[id].label}`}
            title={`${APP_META[id].label} · ${APP_META[id].hint}`}
            onClick={() => setApp(id)}
          >
            <BpIcon name={APP_BP[id]} size={20} />
          </button>
        ))}
        {/* The grey group: the panels the left frame's tabs do not name. */}
        {RAIL_PANELS.map((r, i) => (
          <button
            key={r.id}
            type="button"
            className={left === r.id ? "on" : undefined}
            style={{ top: 381 + i * 33, color: "#c9d1d4" }}
            aria-label={`${r.label} (${r.key})`}
            title={`${r.label} (${r.key})`}
            onClick={() => openTab(r.id)}
          >
            <BpIcon name={r.icon} size={20} />
          </button>
        ))}
        <button
          type="button"
          style={{ top: 381 + 3 * 33 + 6, color: "#c9d1d4" }}
          aria-label={`Open ${APP_META.video.label}`}
          title={`${APP_META.video.label} · ${APP_META.video.hint}`}
          onClick={() => setApp("video")}
        >
          <BpIcon name="camera" size={20} />
        </button>
        <button
          type="button"
          style={{ top: "auto", bottom: 92, color: "#c9d1d4" }}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
          onClick={() =>
            toast.ok(
              "⌘K palette · ⌘J analyst console · A alerts · 1-4 left panels · Esc closes",
            )
          }
        >
          <BpIcon name="help" size={20} />
        </button>
        {isSupabaseConfigured && <RailAccount />}
        <button
          type="button"
          className={app === "ai" ? "on" : undefined}
          style={{ top: "auto", bottom: 8, color: "#32a467" }}
          aria-label={`Open ${APP_META.ai.label}`}
          title={`${APP_META.ai.label} · ${APP_META.ai.hint}`}
          onClick={() => setApp("ai")}
        >
          <BpIcon name="lightning" size={20} />
        </button>
      </nav>

      <div className="a map">
        <main className="csl2-map" aria-label="Map">
          {map}
          {dock ? (
            <div
              className="csl2-dock"
              ref={dockRef}
              style={bleed ? { visibility: "hidden" } : undefined}
            >
              {dock}
            </div>
          ) : null}
          {!bleed && <SlatePlaces viewer={chrome.viewer ?? null} />}
          {!bleed && <MapFx viewer={chrome.viewer ?? null} />}
          {!bleed && <DocPins viewer={chrome.viewer ?? null} />}
          {!bleed && <GlobeFx viewer={chrome.viewer ?? null} />}
          {maven && (
            <MavenMapChrome
              viewer={chrome.viewer ?? null}
              ctx={ctx}
              objOpen={mavenObj}
              onMenu={(m, el) => {
                setAnchor({
                  left: el.getBoundingClientRect().right + 4,
                  top: el.getBoundingClientRect().top,
                });
                setMenu(m);
                setLauncher(false);
              }}
              onTimeline={() =>
                document
                  .querySelector<HTMLButtonElement>(".slate-shell .tdock-clock")
                  ?.click()
              }
              onFeeds={() => openTab("info")}
            />
          )}
        </main>
        {overlay ? <div className="csl2-overlay">{overlay}</div> : null}
      </div>

      {!bleed && (
        <aside
          className={`a panel sit${left === "situations" ? "" : " sl-tall"}`}
          aria-label="Left panel"
        >
          <div className="ptabs">
            <span className="g">
              <BpIcon name="people" size={24} />
            </span>
            <div className="sl-ptabs" role="tablist" aria-label="Map panels">
              <button
                type="button"
                role="tab"
                aria-selected={left === "situations"}
                className={`t${left === "situations" ? " on" : ""}`}
                onClick={() => openTab("situations")}
              >
                <BpIcon name="info-sign" size={16} />
                Situations
              </button>
              {PTABS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={left === p.id}
                  aria-label={p.short}
                  title={`${p.short}: ${p.label} (${p.key})`}
                  className={`t${left === p.id ? " on" : ""}`}
                  onClick={() => openTab(p.id)}
                >
                  <BpIcon name={p.icon} size={16} />
                  {p.short}
                  {leftBadges?.[p.id] && p.id === "info" ? (
                    <span className="n">{leftBadges[p.id]}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          {left === "situations" ? (
            <SlateSituations viewer={chrome.viewer ?? null} />
          ) : (
            <div className="sl-body">
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
              <div className="sl-scroll">
                {sectioned ? sections[activeSection] : leftBody}
              </div>
            </div>
          )}
        </aside>
      )}

      {!bleed && (
        <ErrorBoundary label="Situation object">
          <SituationObject onExploreActions={() => openTab("situations")} />
        </ErrorBoundary>
      )}
      {!bleed && (
        <ErrorBoundary label="SAR tasking">
          <TaskFlow />
        </ErrorBoundary>
      )}
      {!bleed && (
        <ErrorBoundary label="Observation">
          <ObsPopover onPlan={() => openTab("situations")} />
          <ProjectToast />
          <ResolveToast />
          <ReviewPrompt />
        </ErrorBoundary>
      )}
      {!bleed && (
        <ErrorBoundary label="Dossier">
          <Dossier />
        </ErrorBoundary>
      )}

      {/* A port, vessel or aircraft opens the reference object panel; the
          full Selection and Series panels sit under its last band. */}
      {/* The split view's imagery half replaces the object panel for the
          vessel it was opened on. */}
      {!bleed && imagery && imagery === selected && (
        <ErrorBoundary label="Imagery workspace">
          <ImageryWorkspace viewer={chrome.viewer ?? null} />
        </ErrorBoundary>
      )}
      {mavenObj && selected && (
        <ErrorBoundary label="Selection panel">
          <MavenSelection
            key={selected}
            id={selected}
            viewer={chrome.viewer ?? null}
            classification={classification}
            onClose={() => setObjOpen(false)}
          />
        </ErrorBoundary>
      )}
      {showObj &&
        !maven &&
        selected &&
        isSlateObject(selected) &&
        imagery !== selected && (
          <aside className="a obj" aria-label="Right panel">
            <ErrorBoundary label="Object panel">
              <SlateObject
                key={selected}
                id={selected}
                viewer={chrome.viewer ?? null}
                onClose={() => setObjOpen(false)}
                selection={rightPanels.selection}
                series={rightPanels.series}
              />
            </ErrorBoundary>
          </aside>
        )}
      {showObj && !maven && !(selected && isSlateObject(selected)) && (
        <aside className="a obj" aria-label="Right panel">
          <div className="sl-otabs" role="tablist" aria-label="Inspector">
            {(["selection", "series"] as const)
              .filter((id) => rightPanels[id] !== undefined)
              .map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={right === id}
                  className={right === id ? "on" : undefined}
                  onClick={() => setRight(id)}
                >
                  {id === "selection" ? "Selection" : "Series"}
                </button>
              ))}
            <button
              type="button"
              className="x"
              aria-label="Close the inspector"
              onClick={() => setObjOpen(false)}
            >
              <BpIcon name="cross" size={16} />
            </button>
          </div>
          <div className="sl-scroll">{rightPanels[right]}</div>
        </aside>
      )}
    </div>
  );
}

/** The menu row's people slot: the signed-in user as an avatar.
 *  Nothing when the deployment has no accounts. */
function Account(): JSX.Element | null {
  if (!isSupabaseConfigured) return null;
  return <AccountInner />;
}
function AccountInner(): JSX.Element | null {
  const { user, loading, signOut } = useAuth();
  if (loading) return null;
  const pos: CSSProperties = { left: "auto", right: 166 };
  if (!user) return null; // the dashboard is gated behind /login
  const who = user.email ?? user.id.slice(0, 8);
  const initials = who.slice(0, 2).toUpperCase();
  return (
    <button
      type="button"
      style={{ ...pos, gap: 6, fontSize: 15 }}
      onClick={() => void signOut()}
      aria-label={`Sign out ${who}`}
      title={`Signed in as ${who}`}
    >
      <span className="av" style={{ background: "#2f7fd6" }}>
        {initials}
      </span>
      Sign out
    </button>
  );
}

function RailAccount(): JSX.Element | null {
  const { user, loading, signOut } = useAuth();
  if (loading) return null;
  const style: CSSProperties = {
    top: "auto",
    bottom: 59,
    color: "#c9d1d4",
  };
  if (!user) return null;
  const who = user.email ?? user.id.slice(0, 8);
  return (
    <button
      type="button"
      style={style}
      onClick={() => void signOut()}
      aria-label={`Sign out ${who}`}
      title={`Signed in as ${who}. Click to sign out.`}
    >
      <BpIcon name="user" size={20} />
    </button>
  );
}
