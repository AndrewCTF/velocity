import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Cesium from "cesium";
import "./mavenMap.css";
import { BpIcon } from "../shell/BpIcon.js";
import { MENUS, MENU_ITEMS, type MenuCtx } from "../shell/TitleBar.js";
import { LEVELS, LEVEL_COLOR, marking } from "../security/classification.js";
import { apiFetch, backendUrl } from "../transport/http.js";
import { useDetected } from "../situations/detectedStore.js";
import { useFilters, useSelection } from "../state/stores.js";
import { usePolReplay } from "../state/polReplayStore.js";
import { useAgent } from "../state/agent.js";
import { useInvestigation } from "../graph/investigationStore.js";
import { useContextMenu } from "./contextMenuStore.js";
import { useGeoScope } from "../state/geoScope.js";
import { useMaven } from "./mavenStore.js";
import {
  findEntity,
  readPosition,
  readProperties,
} from "../entity-panel/read.js";
import {
  followEntity,
  stopFollow,
  isFollowing,
  flyToPosition,
} from "./camera.js";
import { haversineKm } from "./projection.js";
import { planRoute } from "./routePlanner.js";
import { deriveFacets, bucketLabel } from "../explorer/facets.js";
import { defaultLayers } from "../registry/defaults.js";
import { mgrs } from "../slate/features/maven/geo.js";
import { toast } from "../shell/toast.js";

// The reference map-workspace page (gotham/maven/hero.html, feature rows M1,
// M2, M7, M8, M9, M10, M11, M13) as the Slate shell's Data-tab mode. Markup and
// CSS are the copy's (mavenMap.css, root class `.mv`); every value is read from
// the live stores, and every control runs an existing app action.

type Item = (typeof MENU_ITEMS)["File"][number];

// ── M2 · classification strip ─────────────────────────────────────────────
/** The deployment's marking as the reference strip prints it. Unclassified
 *  keeps the copy's green (#2e8250); a higher level takes its banner colour. */
export function mavenMarking(classification: string): {
  text: string;
  color: string;
} {
  const c = classification.toUpperCase();
  const lvl = c.startsWith("UNCLAS")
    ? 0
    : LEVELS.findIndex((l) => c.startsWith(l));
  if (lvl < 0) return { text: classification, color: "#2e8250" };
  return {
    text: marking(lvl, ["OSINT"]),
    color: lvl === 0 ? "#2e8250" : (LEVEL_COLOR[lvl] ?? "#2e8250"),
  };
}

// ── M1 · menus ────────────────────────────────────────────────────────────
// The reference names seven menus. The app's items are dealt into them by what
// they act on; nothing is added and nothing is dropped.
export const MAVEN_MENUS = [
  "File",
  "Edit",
  "View",
  "Insert",
  "Map",
  "Tools",
  "Help",
] as const;
const INSERT = [
  "Drop an annotation",
  "Annotations…",
  "Watchboxes…",
  "Edit the COP laydown",
];
const TOOLS = [
  "Measure a distance",
  "Select an area",
  "Stop drawing",
  "Field kit…",
  "Task a satellite",
];
const isMap = (l: string): boolean =>
  l.startsWith("Basemap · ") ||
  l === "Reset to top-down" ||
  l === "Zoom out to the whole globe";

export function mavenMenu(name: string): Item[] {
  const edit = MENU_ITEMS.Edit;
  const view = MENU_ITEMS.View;
  const pick = (list: Item[], keep: (l: string) => boolean): Item[] =>
    list
      .filter((i) => keep(i.label))
      .map((i, n) => (n === 0 ? { ...i, sep: false } : i));
  switch (name) {
    case "File":
      return MENU_ITEMS.File;
    case "Edit":
      return pick(edit, (l) => !INSERT.includes(l) && !TOOLS.includes(l));
    case "View":
      return pick(view, (l) => !isMap(l));
    case "Insert":
      return pick(edit, (l) => INSERT.includes(l));
    case "Map":
      return pick(view, isMap);
    case "Tools":
      return pick(edit, (l) => TOOLS.includes(l));
    default:
      return MENU_ITEMS.Support;
  }
}

/** Run an app menu item by its label (the tool buttons reuse them). */
export function runItem(label: string, ctx: MenuCtx): void {
  for (const m of MENUS) {
    const it = MENU_ITEMS[m].find((i) => i.label === label);
    if (!it) continue;
    const why = it.disabled?.(ctx) ?? null;
    if (why) toast.error(why);
    else it.run(ctx);
    return;
  }
}

export function MavenHeader({
  title,
  pinned,
  onPin,
  inbox,
  menu,
  onMenu,
  onMenuHover,
  onLauncher,
  ctx,
  live,
  onLive,
}: {
  title: string;
  pinned: boolean;
  onPin: () => void;
  inbox: number;
  menu: string | null;
  onMenu: (m: string, el: HTMLElement) => void;
  onMenuHover: (m: string, el: HTMLElement) => void;
  onLauncher: (el: HTMLElement) => void;
  ctx: MenuCtx;
  live: boolean;
  onLive: () => void;
}): JSX.Element {
  const widths = [38, 39, 45, 50, 42, 47, 40];
  return (
    <div className="mv mv-top">
      <button
        type="button"
        style={{ left: 10 }}
        aria-label="All apps"
        title="All apps"
        onClick={(e) => onLauncher(e.currentTarget)}
      >
        <BpIcon name="globe" size={18} />
        <BpIcon name="caret-down" size={9} />
      </button>
      <button
        type="button"
        className="mv-pill"
        style={{ left: 62 }}
        aria-label={`Inbox, ${inbox}`}
        title="Inbox"
        onClick={() => ctx.openInbox()}
      >
        <BpIcon name="inbox" size={12} />
        {inbox}
      </button>
      <span className="mv-vsep" style={{ left: 108 }} />
      <span style={{ left: 118, gap: 9 }}>
        <span className="mv-doc">
          <BpIcon name="map" size={10} />
        </span>
        <button
          type="button"
          className="mv-plain"
          title="Open another workspace"
          onClick={(e) => onLauncher(e.currentTarget)}
        >
          {title}
        </button>
        <button
          type="button"
          className="mv-plain"
          style={{ color: "var(--t2)" }}
          aria-pressed={pinned}
          aria-label={pinned ? "Unpin from the tabs" : "Pin to the tabs"}
          title="Pin this app to the tabs bar"
          onClick={onPin}
        >
          <BpIcon name={pinned ? "star" : "star-empty"} size={16} />
        </button>
        <button
          type="button"
          className="mv-plain"
          style={{ color: "var(--t2)" }}
          aria-label="Open another workspace"
          onClick={(e) => onLauncher(e.currentTarget)}
        >
          <BpIcon name="caret-down" size={9} />
        </button>
      </span>
      <span className="mv-vsep" style={{ left: 283 }} />
      <span
        style={{ left: 292, gap: 12 }}
        title="Classification marking from the server configuration"
      >
        <BpIcon name="shield" size={16} />
        <BpIcon name="tick" size={16} style={{ color: "#3ec27a" }} />
      </span>
      <span className="mv-vsep" style={{ left: 340 }} />
      <span style={{ left: 352, gap: 0 }}>
        {MAVEN_MENUS.map((m, i) => (
          <button
            key={m}
            type="button"
            className="mv-menu"
            style={{ width: widths[i] }}
            aria-expanded={menu === m}
            aria-haspopup="menu"
            onClick={(e) => onMenu(m, e.currentTarget)}
            onPointerEnter={(e) => onMenuHover(m, e.currentTarget)}
          >
            {m}
          </button>
        ))}
        <button
          type="button"
          className="mv-plain"
          style={{ color: "var(--t2)" }}
          aria-label="All apps"
          onClick={(e) => onLauncher(e.currentTarget)}
        >
          <BpIcon name="applications" size={16} />
        </button>
      </span>
      <button
        type="button"
        className="mv-tog"
        style={{ left: "auto", right: 288 }}
        aria-pressed={live}
        aria-label={live ? "Live: pause the clock" : "Held: resume live"}
        title={live ? "Live updates on" : "Live updates paused"}
        onClick={onLive}
      >
        <span className={live ? "mv-on" : undefined} />
      </button>
      <button
        type="button"
        style={{ left: "auto", right: 254, color: "#c6cdd0" }}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        onClick={() => runItem("Keyboard shortcuts", ctx)}
      >
        <BpIcon name="help" size={16} />
      </button>
      <button
        type="button"
        style={{ left: "auto", right: 224, color: "#c6cdd0" }}
        aria-label="Alerts"
        title="Alerts: the live rule-hit ticker"
        onClick={() => ctx.openAlerts()}
      >
        <BpIcon name="timeline-events" size={16} />
      </button>
      <button
        type="button"
        style={{ left: "auto", right: 164 }}
        title="Copy a link to this view"
        onClick={() => {
          void navigator.clipboard?.writeText(window.location.href);
          toast.ok("Link to this view copied");
        }}
      >
        Share
      </button>
      <button
        type="button"
        className="mv-search"
        style={{ left: "auto", right: 7 }}
        title="Search objects, places and commands (Ctrl K)"
        onClick={() => runItem("Command palette…", ctx)}
      >
        <BpIcon name="search" size={13} />
        Search
      </button>
    </div>
  );
}

// ── M13 · map graphics ────────────────────────────────────────────────────
// The reference hero's own graphics over real data: 25 km and 50 km range rings
// on the seaport nearest the detection, the anchorage outline around the
// detection's member vessels (their live positions), and the water-only route
// from that port to the next one.
function useMavenGraphics(viewer: Cesium.Viewer | null, on: boolean): void {
  const det = useDetected((s) => s.det);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !on || !det) return;
    const ds = new Cesium.CustomDataSource("__maven_graphics");
    // add() resolves later; removing before it lands would leak the source.
    const added = viewer.dataSources.add(ds);
    let alive = true;
    const red = Cesium.Color.fromCssColorString("#e0434e");
    const halo = {
      font: '600 13.5px "Source Sans 3", "Segoe UI", sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    };
    // Anchorage outline: convex hull of the members' live positions.
    const pts = det.members.flatMap((m) => {
      const e = findEntity(viewer, m.id);
      const p = e ? readPosition(e, viewer) : undefined;
      return p ? [[p.lon, p.lat] as [number, number]] : [];
    });
    let hullLabel: Cesium.Entity | null = null;
    const hull = convexHull(pts);
    if (hull.length >= 3) {
      ds.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            [...hull, hull[0]!].flat(),
          ),
          width: 2.2,
          clampToGround: true,
          material: Cesium.Color.fromCssColorString("#c6f02c"),
        },
      });
      const south = hull.reduce((m, q) => (q[1] < m[1] ? q : m));
      hullLabel = ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(south[0], south[1]),
        label: {
          ...halo,
          text: "Anchorage",
          fillColor: Cesium.Color.fromCssColorString("#e4ff9a"),
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 6),
        },
      });
    }
    const pad = 1.2;
    void apiFetch(
      `/api/places/ports?bbox=${det.lon - pad},${det.lat - pad},${det.lon + pad},${det.lat + pad}&limit=200`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(
        async (
          fc: {
            features?: {
              geometry: { coordinates: number[] };
              properties: { name?: string };
            }[];
          } | null,
        ) => {
          if (!alive || !fc) return;
          const ports = (fc.features ?? [])
            .map((f) => {
              const [lon = 0, lat = 0] = f.geometry.coordinates;
              return {
                lon,
                lat,
                name: f.properties.name ?? "Port",
                d: haversineKm(det.lat, det.lon, lat, lon),
              };
            })
            .sort((a, b) => a.d - b.d);
          const a = ports[0];
          if (!a) return;
          if (hullLabel?.label)
            hullLabel.label.text = new Cesium.ConstantProperty(
              `Anchorage near ${a.name}`,
            );
          for (const [r, dashed] of [
            [25, false],
            [50, true],
          ] as const) {
            ds.entities.add({
              position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat),
              ellipse: {
                semiMajorAxis: r * 1000,
                semiMinorAxis: r * 1000,
                material: red.withAlpha(dashed ? 0.1 : 0.22),
                height: 0,
              },
            });
            const ring: number[] = [];
            for (let b = 0; b <= 360; b += 3) {
              const rad = (b * Math.PI) / 180;
              const dLat = (r / 111.32) * Math.cos(rad);
              const dLon =
                ((r / 111.32) * Math.sin(rad)) /
                Math.cos((a.lat * Math.PI) / 180);
              ring.push(a.lon + dLon, a.lat + dLat);
            }
            ds.entities.add({
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray(ring),
                width: dashed ? 2 : 2.5,
                clampToGround: true,
                material: dashed
                  ? new Cesium.PolylineDashMaterialProperty({
                      color: red,
                      dashLength: 17,
                    })
                  : red,
              },
            });
          }
          ds.entities.add({
            position: Cesium.Cartesian3.fromDegrees(
              a.lon,
              a.lat - 50 / 111.32 + 0.05,
            ),
            label: {
              ...halo,
              font: '600 12px "Source Sans 3", "Segoe UI", sans-serif',
              text: `RANGE RING 25 KM · 50 KM · ${a.name.toUpperCase()}`,
              fillColor: Cesium.Color.fromCssColorString("#ffd0d4"),
            },
          });
          const b = ports.find(
            (p) => haversineKm(a.lat, a.lon, p.lat, p.lon) > 15,
          );
          if (!b) return;
          const route = await planRoute(
            [
              { lat: a.lat, lon: a.lon },
              { lat: b.lat, lon: b.lon },
            ],
            "naval",
          );
          if (!alive || viewer.isDestroyed()) return;
          ds.entities.add({
            name: `Route from ${a.name} to ${b.name}`,
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(
                route.coords.flat(),
              ),
              width: 2.5,
              clampToGround: true,
              material: new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.WHITE,
                dashLength: 9,
              }),
            },
          });
          viewer.scene.requestRender();
        },
      )
      .catch(() => undefined);
    viewer.scene.requestRender();
    return () => {
      alive = false;
      void added.then(() => {
        if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      });
    };
  }, [viewer, on, det]);
}

/** Monotone-chain convex hull of [lon, lat] points. */
export function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]): number =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lo: [number, number][] = [];
  for (const q of p) {
    while (
      lo.length >= 2 &&
      cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0
    )
      lo.pop();
    lo.push(q);
  }
  const up: [number, number][] = [];
  for (const q of [...p].reverse()) {
    while (
      up.length >= 2 &&
      cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0
    )
      up.pop();
    up.push(q);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

// ── M7 · map-click coordinate popover ─────────────────────────────────────
function CoordPopover({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element | null {
  const pop = useMaven((s) => s.pop);
  const [port, setPort] = useState<{ name: string; brg: number } | null>(null);
  const [portErr, setPortErr] = useState<string | null>(null);
  useEffect(() => {
    if (!pop) return;
    setPort(null);
    setPortErr(null);
    const pad = 1;
    let alive = true;
    void apiFetch(
      `/api/places/ports?bbox=${pop.lon - pad},${pop.lat - pad},${pop.lon + pad},${pop.lat + pad}&limit=200`,
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`Ports unavailable (HTTP ${r.status})`);
        return (await r.json()) as {
          features?: {
            geometry: { coordinates: number[] };
            properties: { name?: string };
          }[];
        };
      })
      .then((fc) => {
        if (!alive) return;
        const near = (fc.features ?? [])
          .map((f) => {
            const [lon = 0, lat = 0] = f.geometry.coordinates;
            return {
              lon,
              lat,
              name: f.properties.name ?? "port",
              d: haversineKm(pop.lat, pop.lon, lat, lon),
            };
          })
          .sort((a, b) => a.d - b.d)[0];
        if (!near) {
          setPortErr("No port within 100 km");
          return;
        }
        setPort({
          name: near.name,
          brg: bearing(near.lat, near.lon, pop.lat, pop.lon),
        });
      })
      .catch((e: unknown) => {
        if (alive)
          setPortErr(e instanceof Error ? e.message : "Ports unavailable");
      });
    return () => {
      alive = false;
    };
  }, [pop]);
  useEffect(() => {
    if (!pop) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") useMaven.getState().setPop(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pop]);
  const elev = useMemo(() => {
    if (!pop || !viewer || viewer.isDestroyed()) return null;
    const h = viewer.scene.globe.getHeight(
      Cesium.Cartographic.fromDegrees(pop.lon, pop.lat),
    );
    return h === undefined ? null : Math.max(0, h);
  }, [pop, viewer]);
  if (!pop) return null;
  const ll = `${Math.abs(pop.lat).toFixed(4)}${pop.lat >= 0 ? "N" : "S"} ${Math.abs(pop.lon).toFixed(4)}${pop.lon >= 0 ? "E" : "W"}`;
  const left = Math.min(pop.x + 10, window.innerWidth - 262);
  const top = Math.min(pop.y + 10, window.innerHeight - 130);
  return (
    <div
      className="mv mv-pop"
      role="dialog"
      aria-label={`Point ${ll}`}
      style={{ left, top }}
    >
      <div className="mv-r">
        <BpIcon name="map-marker" size={14} />
        <span className="mv-v">{ll}</span>
        <button
          type="button"
          className="mv-plain mv-end"
          aria-label="Copy coordinates"
          title="Copy coordinates"
          onClick={() => {
            void navigator.clipboard?.writeText(
              `${pop.lat.toFixed(5)},${pop.lon.toFixed(5)}`,
            );
            toast.ok("Coordinates copied");
          }}
        >
          <BpIcon name="locate" size={14} />
        </button>
      </div>
      <div className="mv-rule" />
      <div className="mv-r">
        <BpIcon name="mountain" size={14} style={{ color: "var(--t2)" }} />
        <span title="Terrain height under the point (sea reads 0)">
          {elev === null ? "n/a" : `${elev.toFixed(2)} m MSL`}
        </span>
        <span
          className="mv-end"
          title={
            port
              ? `Bearing from ${port.name} to this point`
              : (portErr ?? "Finding the nearest port")
          }
        >
          <BpIcon name="compass" size={14} style={{ color: "var(--t2)" }} />
          {port ? `${Math.round(port.brg)}°` : portErr ? "n/a" : "…"}
        </span>
      </div>
      <div className="mv-rule" />
      <div className="mv-r">
        <button
          type="button"
          className="mv-plain"
          aria-label="Centre the map here"
          title="Centre the map here"
          onClick={() =>
            viewer && flyToPosition(viewer, pop.lon, pop.lat, 60_000)
          }
        >
          <BpIcon name="locate" size={14} />
        </button>
        <button
          type="button"
          className="mv-plain"
          aria-label="Copy the MGRS reference"
          title={`MGRS ${mgrs(pop.lat, pop.lon)}`}
          onClick={() => {
            void navigator.clipboard?.writeText(mgrs(pop.lat, pop.lon));
            toast.ok("MGRS reference copied");
          }}
        >
          <BpIcon name="widget" size={14} />
        </button>
        <button
          type="button"
          className="mv-plain"
          aria-label="Create a geofence here"
          title="Create a geofence here"
          onClick={() => {
            void import("../watchbox/watchboxStore.js").then((m) =>
              m.useWatchboxes.getState().add({
                label: `Watchbox ${pop.lat.toFixed(1)},${pop.lon.toFixed(1)}`,
                center: { lat: pop.lat, lon: pop.lon },
                radiusKm: 25,
                rule: "enter",
              }),
            );
            useMaven.getState().setPop(null);
          }}
        >
          <BpIcon name="circle" size={14} />
        </button>
        <button
          type="button"
          className="mv-plain"
          aria-label="More actions"
          title="More actions"
          onClick={() => {
            useMaven.getState().setPop(null);
            useContextMenu.getState().openAt(pop.x, pop.y, pop.lat, pop.lon);
          }}
        >
          <BpIcon name="more" size={14} />
        </button>
        <button
          type="button"
          className="mv-plain mv-near"
          onClick={() => {
            useGeoScope.getState().setScope({
              lat: pop.lat,
              lon: pop.lon,
              radiusKm: 50,
              label: ll,
            });
            useMaven.getState().setPop(null);
          }}
        >
          <BpIcon name="geosearch" size={14} />
          Search nearby
        </button>
      </div>
    </div>
  );
}

function bearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

// ── M8 / M9 · map tool columns ────────────────────────────────────────────
export function MavenMapChrome({
  viewer,
  ctx,
  onMenu,
  onTimeline,
  onFeeds,
  objOpen,
}: {
  viewer: Cesium.Viewer | null;
  ctx: MenuCtx;
  onMenu: (m: string, el: HTMLElement) => void;
  onTimeline: () => void;
  onFeeds: () => void;
  objOpen: boolean;
}): JSX.Element {
  useMavenGraphics(viewer, true);
  const det = useDetected((s) => s.det);
  const [heading, setHeading] = useState(0);
  const [centre, setCentre] = useState<string>("");
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const read = (): void => {
      setHeading(Cesium.Math.toDegrees(viewer.camera.heading));
      const c = viewer.camera.pickEllipsoid(
        new Cesium.Cartesian2(
          viewer.canvas.clientWidth / 2,
          viewer.canvas.clientHeight / 2,
        ),
      );
      if (!c) return setCentre("");
      const g = Cesium.Cartographic.fromCartesian(c);
      setCentre(
        mgrs(
          Cesium.Math.toDegrees(g.latitude),
          Cesium.Math.toDegrees(g.longitude),
        ),
      );
    };
    read();
    return viewer.camera.moveEnd.addEventListener(read);
  }, [viewer]);
  const tool = (icon: string, label: string, run: () => void): ReactNode => (
    <button
      key={icon}
      type="button"
      className="mv-tbtn"
      aria-label={label}
      title={label}
      onClick={run}
    >
      <BpIcon name={icon} size={16} />
    </button>
  );
  const zoom = (f: number): void => {
    if (!viewer || viewer.isDestroyed()) return;
    const h = viewer.camera.positionCartographic.height;
    if (f > 0) viewer.camera.zoomIn(h * 0.5);
    else viewer.camera.zoomOut(h);
  };
  return (
    <div className="mv mv-chrome">
      <div className="mv-pills">
        <button
          type="button"
          className="mv-tbtn mv-w"
          aria-label="Map: basemap and view"
          title="Map: basemap and view"
          onClick={(e) => onMenu("Map", e.currentTarget)}
        >
          <BpIcon name="globe" size={16} />
          <BpIcon name="chevron-right" size={9} />
        </button>
        <button
          type="button"
          className="mv-tbtn mv-w"
          aria-label="Draw and measure tools"
          title="Draw and measure tools"
          onClick={(e) => onMenu("Tools", e.currentTarget)}
        >
          <BpIcon name="draw" size={16} />
          <BpIcon name="chevron-right" size={9} />
        </button>
      </div>
      <div className="mv-tools">
        {tool("zoom-to-fit", "Zoom to the detection", () => {
          if (viewer && det)
            flyToPosition(
              viewer,
              det.lon,
              det.lat,
              Math.max(60_000, det.r_km * 6000),
            );
          else toast.error("No detection is open");
        })}
        {tool("map-marker", "Drop an annotation", () =>
          runItem("Drop an annotation", ctx),
        )}
        {tool("camera", "Save this view as a PNG", () =>
          runItem("Save this view as a PNG", ctx),
        )}
        {tool("layout-grid", "Select an area", () =>
          runItem("Select an area", ctx),
        )}
        {tool("edit", "Annotations", () => runItem("Annotations…", ctx))}
        {tool("send-to-map", "Watchboxes", () => runItem("Watchboxes…", ctx))}
        {tool("path", "Measure a distance", () =>
          runItem("Measure a distance", ctx),
        )}
      </div>
      <button
        type="button"
        className="mv-compass"
        aria-label="Reset to north up"
        title={`Heading ${Math.round(((heading % 360) + 360) % 360)}°. Reset to north up`}
        onClick={() => runItem("Reset to top-down", ctx)}
      >
        <span style={{ transform: `rotate(${-heading}deg)` }}>
          N<br />▲
        </span>
      </button>
      <div className="mv-ref">
        <span>▲ True</span>
        <span>⦿ MGRS</span>
        <span>{centre}</span>
      </div>
      <div className="mv-zoom" style={{ right: objOpen ? 296 : 8 }}>
        {tool("zoom-in", "Zoom in", () => zoom(1))}
        {tool("zoom-out", "Zoom out", () => zoom(-1))}
      </div>
      <div className="mv-foot" style={{ right: objOpen ? 298 : 10 }}>
        <button
          type="button"
          className="mv-plain"
          aria-label="Aircraft: zoom out to the whole globe"
          title="Zoom out to the whole globe"
          onClick={() => runItem("Zoom out to the whole globe", ctx)}
        >
          <BpIcon name="airplane" size={16} />
        </button>
        <button
          type="button"
          className="mv-plain"
          aria-label="Find objects near here"
          title="Find objects near here"
          onClick={() => runItem("Find objects near here", ctx)}
        >
          <BpIcon name="th" size={16} />
        </button>
        <button
          type="button"
          className="mv-plain mv-tip"
          aria-label="View on timeline"
          data-tip="View on timeline"
          onClick={onTimeline}
        >
          <BpIcon name="time" size={16} />
        </button>
        <button
          type="button"
          className="mv-plain"
          aria-label="Feeds and system status"
          title="Feeds and system status"
          onClick={onFeeds}
        >
          <BpIcon name="antenna" size={16} />
        </button>
      </div>
      <div className="mv-strip2" style={{ right: objOpen ? 290 : 2 }}>
        <button
          type="button"
          className="mv-plain"
          aria-label="Alerts"
          title="Alerts"
          onClick={() => ctx.openAlerts()}
        >
          <BpIcon name="notifications" size={16} />
        </button>
        <button
          type="button"
          className="mv-plain"
          aria-label="Inbox"
          title="Inbox"
          onClick={() => ctx.openInbox()}
        >
          <BpIcon name="list" size={16} />
        </button>
        <button
          type="button"
          className="mv-plain"
          aria-label="Analyst console"
          title="Analyst console"
          onClick={() => runItem("Analyst console", ctx)}
        >
          <BpIcon name="comment" size={16} />
        </button>
      </div>
      <CoordPopover viewer={viewer} />
    </div>
  );
}

// ── M10 / M11 · selection panel ───────────────────────────────────────────
const SHIP = (
  <svg className="mv-s" width="32" height="32" viewBox="0 0 24 24" aria-hidden>
    <path d="M12 10.189V14" />
    <path d="M12 2v3" />
    <path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6" />
    <path d="M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76" />
    <path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />
  </svg>
);
const PLANE = (
  <svg className="mv-s" width="32" height="32" viewBox="0 0 24 24" aria-hidden>
    <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
  </svg>
);

function ago(ms: number | null): string {
  if (ms === null) return "n/a";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "a few seconds ago";
  if (s < 90) return "a minute ago";
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 5400) return "an hour ago";
  return `${Math.round(s / 3600)} hours ago`;
}
function fmtUtc(ms: number): string {
  return `${new Date(ms).toLocaleString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })} UTC`;
}
const tsOf = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v))
    return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

function Sec({
  icon,
  label,
  open,
  onToggle,
  children,
}: {
  icon: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="mv-sec"
        aria-expanded={open}
        onClick={onToggle}
      >
        <BpIcon name={icon} size={16} />
        {label}
        <span className="mv-cv">
          <BpIcon name={open ? "chevron-down" : "chevron-right"} size={12} />
        </span>
      </button>
      {open && children}
    </>
  );
}

export function MavenSelection({
  id,
  viewer,
  classification,
  onClose,
}: {
  id: string;
  viewer: Cesium.Viewer | null;
  classification: string;
  onClose: () => void;
}): JSX.Element {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 5000);
    return () => window.clearInterval(t);
  }, []);
  const ent = useMemo(
    () =>
      viewer && !viewer.isDestroyed() ? findEntity(viewer, id) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, id, tick],
  );
  const props = ent ? readProperties(ent) : {};
  const pos = ent && viewer ? readPosition(ent, viewer) : undefined;
  const kind = id.slice(0, id.indexOf(":"));
  const name =
    String(
      props["name"] ??
        props["callsign"] ??
        props["shipName"] ??
        props["registration"] ??
        ent?.name ??
        id.slice(id.indexOf(":") + 1),
    ).trim() || id;
  const seen = tsOf(
    props["t"] ?? props["ts"] ?? props["last_seen"] ?? props["seen_pos_ts"],
  );
  const dsName =
    (ent?.entityCollection?.owner as { name?: string } | undefined)?.name ?? "";
  const layer = defaultLayers.find((d) => d.id === dsName);
  const source = String(
    props["source"] ?? props["src"] ?? layer?.license ?? "n/a",
  );
  const [open, setOpen] = useState<Record<string, boolean>>({
    imagery: true,
    details: true,
    props: true,
    featured: true,
  });
  const flip = (k: string): void => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const [tiles, setTiles] = useState(false);
  const [following, setFollowing] = useState(false);
  const [hidden, setHidden] = useState(false);
  const facets = deriveFacets(props);
  const facet: ["vesselType" | "aircraftCategory", string] | null =
    facets.vesselType
      ? ["vesselType", facets.vesselType]
      : facets.aircraftCategory
        ? ["aircraftCategory", facets.aircraftCategory]
        : null;
  // Imagery preview: the satellite basemap tile pair around the contact.
  const z = 13;
  const tileXY = pos
    ? {
        x: ((pos.lon + 180) / 360) * 2 ** z,
        y:
          ((1 -
            Math.log(
              Math.tan((pos.lat * Math.PI) / 180) +
                1 / Math.cos((pos.lat * Math.PI) / 180),
            ) /
              Math.PI) /
            2) *
          2 ** z,
      }
    : null;
  const extra = Object.entries(props).filter(
    ([k, v]) =>
      !k.startsWith("__") && v !== null && v !== undefined && v !== "",
  );
  return (
    <aside className="mv mv-rp" aria-label="Selection">
      <div className="mv-hd">
        Selection
        <span className="mv-ics">
          <button
            type="button"
            className="mv-plain"
            aria-label="Fly to the selection"
            title="Fly to the selection"
            onClick={() =>
              viewer && pos && flyToPosition(viewer, pos.lon, pos.lat, 40_000)
            }
          >
            <BpIcon name="send-to-map" size={16} />
          </button>
          <button
            type="button"
            className="mv-plain"
            aria-pressed={following}
            aria-label={following ? "Stop following" : "Follow on the map"}
            title={following ? "Stop following" : "Follow on the map"}
            onClick={() => {
              if (!viewer) return;
              if (isFollowing(viewer, id)) {
                stopFollow(viewer);
                setFollowing(false);
              } else setFollowing(followEntity(viewer, id));
            }}
          >
            <BpIcon name="locate" size={16} />
          </button>
          <button
            type="button"
            className="mv-plain"
            aria-pressed={!hidden}
            aria-label={hidden ? "Show on the map" : "Hide on the map"}
            title={hidden ? "Show on the map" : "Hide on the map"}
            onClick={() => {
              if (!ent || !viewer) return;
              ent.show = hidden;
              setHidden(!hidden);
              viewer.scene.requestRender();
            }}
          >
            <BpIcon name={hidden ? "eye-off" : "eye-open"} size={16} />
          </button>
          <button
            type="button"
            className="mv-plain"
            aria-label="Close the selection"
            onClick={() => {
              if (hidden && ent) ent.show = true;
              onClose();
            }}
          >
            <BpIcon name="cross" size={16} />
          </button>
        </span>
      </div>
      <div className="mv-ent">
        {kind === "aircraft" ? PLANE : SHIP}
        <div>
          <b>{name}</b>
          <span>{ent ? "Live entity" : "Not on the map"}</span>
        </div>
      </div>
      <div className="mv-kv">
        <div>
          <span className="mv-k">Last updated</span>
          <span className="mv-v mv-u" title={seen ? fmtUtc(seen) : undefined}>
            {ago(seen)}
          </span>
        </div>
        <div>
          <span className="mv-k">Latest location</span>
          <span className="mv-v">
            {pos ? `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}` : "n/a"}
          </span>
        </div>
        <div>
          <span className="mv-k">Data source</span>
          <span className="mv-v">{source}</span>
        </div>
        <div>
          <span className="mv-k">Layer</span>
          <span className="mv-l">{layer?.title ?? (dsName || "n/a")}</span>
        </div>
        <div>
          <span className="mv-k">Classification</span>
          <span className="mv-v">{classification}</span>
        </div>
      </div>
      <div className="mv-actband">
        <button
          type="button"
          className="mv-act"
          aria-expanded={tiles}
          onClick={() => setTiles((v) => !v)}
        >
          Actions
          <BpIcon name="caret-down" size={9} />
        </button>
      </div>
      {tiles && (
        <div className="mv-tiles">
          <button
            type="button"
            onClick={() => usePolReplay.getState().play(id)}
            title="Replay this contact's last six hours from the archive"
          >
            <BpIcon name="history" size={16} />
            Load track history
          </button>
          <button
            type="button"
            onClick={() =>
              useAgent
                .getState()
                .ask(
                  `Analyze the track history of ${name} (${id}): where it has been, stops, speed changes, and anything unusual.`,
                )
            }
          >
            <BpIcon name="pulse" size={16} />
            Analyze track history
          </button>
          <button
            type="button"
            disabled={!facet}
            title={
              facet
                ? `Hide every ${bucketLabel(facet[0], facet[1])}`
                : "This contact carries no type to filter on"
            }
            onClick={() =>
              facet &&
              useFilters.getState().toggleClause(facet[0], facet[1], "not")
            }
          >
            <BpIcon name="filter" size={16} />
            Filter out
          </button>
          <button
            type="button"
            onClick={() => {
              const text = `${name} · ${id}${pos ? ` · ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}` : ""}`;
              void navigator.clipboard?.writeText(text);
              toast.ok("Copied for chat");
            }}
          >
            <BpIcon name="chat" size={16} />
            Share in chat
          </button>
        </div>
      )}
      <div className="mv-body">
        <Sec
          icon="satellite"
          label="Imagery preview"
          open={!!open.imagery}
          onToggle={() => flip("imagery")}
        >
          <div className="mv-prev">
            {tileXY ? (
              <>
                {[-1, 0, 1].flatMap((dx) =>
                  [-1, 0].map((dy) => {
                    const tx = Math.floor(tileXY.x) + dx;
                    const ty = Math.floor(tileXY.y) + dy;
                    return (
                      <img
                        key={`${dx},${dy}`}
                        alt=""
                        src={backendUrl(`/tiles/sat/${z}/${tx}/${ty}.jpg`)}
                        style={{
                          left: 135 + (tx - tileXY.x) * 256,
                          top: 120 + (ty - tileXY.y) * 256,
                        }}
                      />
                    );
                  }),
                )}
                <i className="mv-dot" />
              </>
            ) : (
              <span className="mv-none">No position to preview</span>
            )}
            <button
              type="button"
              className="mv-fs"
              aria-label="Fly the map to this contact"
              title="Fly the map to this contact"
              onClick={() =>
                viewer && pos && flyToPosition(viewer, pos.lon, pos.lat, 8_000)
              }
            >
              <BpIcon name="fullscreen" size={12} />
            </button>
          </div>
        </Sec>
        <Sec
          icon="link"
          label="Links"
          open={!!open.links}
          onToggle={() => flip("links")}
        >
          <button
            type="button"
            className="mv-row"
            onClick={() => useInvestigation.getState().searchAround(id)}
          >
            Search around in the graph
          </button>
        </Sec>
        <Sec
          icon="info-sign"
          label="Details"
          open={!!open.details}
          onToggle={() => flip("details")}
        >
          <div className="mv-props">
            <button
              type="button"
              className="mv-ph"
              aria-expanded={!!open.props}
              onClick={() => flip("props")}
            >
              <BpIcon name="properties" size={16} />
              Properties
              <span style={{ marginLeft: "auto", color: "#c6cdd0" }}>
                <BpIcon
                  name={open.props ? "chevron-down" : "chevron-right"}
                  size={12}
                />
              </span>
            </button>
            {open.props && (
              <>
                <button
                  type="button"
                  className="mv-sub"
                  aria-expanded={!!open.featured}
                  onClick={() => flip("featured")}
                >
                  FEATURED PROPERTIES
                  <span className="mv-cv">
                    <BpIcon
                      name={open.featured ? "chevron-down" : "chevron-right"}
                      size={9}
                    />
                  </span>
                </button>
                {open.featured && (
                  <div className="mv-pv">
                    <div className="mv-k">Timestamp</div>
                    <div className="mv-v">{seen ? fmtUtc(seen) : "n/a"}</div>
                  </div>
                )}
                <button
                  type="button"
                  className="mv-sub"
                  aria-expanded={!!open.additional}
                  onClick={() => flip("additional")}
                >
                  ADDITIONAL PROPERTIES
                  <span className="mv-cv">
                    <BpIcon
                      name={open.additional ? "chevron-down" : "chevron-right"}
                      size={9}
                    />
                  </span>
                </button>
                {open.additional && (
                  <div className="mv-pv">
                    {extra.map(([k, v]) => (
                      <div key={k} className="mv-pr">
                        <span className="mv-k">{k}</span>
                        <span className="mv-v">
                          {typeof v === "object"
                            ? JSON.stringify(v)
                            : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </Sec>
        <Sec
          icon="add"
          label="Enhancements"
          open={!!open.enh}
          onToggle={() => flip("enh")}
        >
          <button
            type="button"
            className="mv-row"
            onClick={() =>
              useAgent
                .getState()
                .ask(
                  `Enrich ${name} (${id}) from the registries: owner, flag, history, sanctions.`,
                )
            }
          >
            Enrich from the registries with AI
          </button>
        </Sec>
        <Sec
          icon="edit"
          label="Appearance"
          open={!!open.app}
          onToggle={() => flip("app")}
        >
          <button
            type="button"
            className="mv-row"
            onClick={() => {
              if (!ent || !viewer) return;
              ent.show = hidden;
              setHidden(!hidden);
              viewer.scene.requestRender();
            }}
          >
            {hidden ? "Show on the map" : "Hide on the map"}
          </button>
        </Sec>
      </div>
    </aside>
  );
}

/** Close the popover whenever the workspace mode or selection changes. */
export function useMavenMode(on: boolean): void {
  useEffect(() => {
    useMaven.getState().setOn(on);
    return () => useMaven.getState().setOn(false);
  }, [on]);
  const sel = useSelection((s) => s.selectedEntityId);
  useEffect(() => {
    if (sel) useMaven.getState().setPop(null);
  }, [sel]);
}
