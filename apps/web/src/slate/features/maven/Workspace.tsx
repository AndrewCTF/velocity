import { useEffect, useMemo, useRef, useState } from "react";
import * as Cesium from "cesium";
import "./maven.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import { useAppView } from "../../../state/appView.js";
import { useImagery, useSelection } from "../../../state/stores.js";
import { useTargetBoard } from "../../../state/targetBoard.js";
import {
  followEntity,
  stopFollow,
  isFollowing,
} from "../../../globe/camera.js";
import {
  useWs,
  useFixes,
  useRecs,
  useNow,
  titleOf,
  kindOf,
  type Fix,
} from "./ui.js";
import { rank, type Asset, type Ranked } from "./recommend.js";
import { useWatchTaskings } from "./taskings.js";
import { LeftPanel, MetricsDialog, type Draft } from "./Panels.js";
import { GanttStrip, DetailStrip } from "./Strip.js";
import { ObjectPanel } from "./ObjectPanel.js";
import { destination, distNm, mgrs, zClock, zDate } from "./geo.js";

// The watch workspace (reference page rows M36 to M54): rail, the left column
// of Panels.tsx, a floating header over the map, view controls, status row,
// the bottom strip and the object side panel. The stage is transparent over
// the live globe; the rings and pairing lines are drawn on an unzoomed SVG by
// projecting real positions through the Cesium camera.

const FRAME_H = 737; // the copy's frame height, in its own units
const RAD = Math.PI / 180;

type Pt = { x: number; y: number };

function useProjector(
  viewer: Cesium.Viewer | null | undefined,
  host: HTMLElement | null,
): [(lat: number, lon: number) => Pt | null, number] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    let raf = 0;
    const bump = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setTick((n) => n + 1);
      });
    };
    const off = viewer.scene.postRender.addEventListener(bump);
    viewer.scene.requestRender();
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [viewer]);
  const proj = (lat: number, lon: number): Pt | null => {
    if (!viewer || viewer.isDestroyed() || !host) return null;
    const cart = Cesium.Cartesian3.fromDegrees(lon, lat);
    // Behind the horizon when the camera sits below the point's tangent plane.
    const toCam = Cesium.Cartesian3.subtract(
      viewer.camera.positionWC,
      cart,
      new Cesium.Cartesian3(),
    );
    if (Cesium.Cartesian3.dot(toCam, cart) < 0) return null;
    const p = viewer.scene.cartesianToCanvasCoordinates(cart);
    if (!p) return null;
    const c = viewer.canvas.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return { x: p.x + c.left - h.left, y: p.y + c.top - h.top };
  };
  return [proj, tick];
}

function ring(
  proj: (lat: number, lon: number) => Pt | null,
  lat: number,
  lon: number,
  nm: number,
): string {
  let d = "";
  for (let b = 0; b <= 360; b += 6) {
    const [la, lo] = destination(lat, lon, b, nm);
    const p = proj(la, lo);
    if (!p) return "";
    d += `${d ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return d + "Z";
}

function Label({
  p,
  text,
  halo,
  dy = -9,
}: {
  p: Pt;
  text: string;
  halo: string;
  dy?: number;
}): JSX.Element {
  return (
    <text
      x={p.x}
      y={p.y + dy}
      textAnchor="middle"
      fontSize="11"
      fontWeight="600"
      fill="#fff"
      stroke={halo}
      strokeWidth="3.6"
      paintOrder="stroke"
      strokeLinejoin="round"
      fontFamily="Source Sans 3, sans-serif"
    >
      {text}
    </text>
  );
}

function Overlay({
  viewer,
  host,
  fixes,
  names,
  target,
  ranked,
  picked,
  taskAsset,
}: {
  viewer: Cesium.Viewer | null | undefined;
  host: HTMLElement | null;
  fixes: Map<string, Fix>;
  names: Map<string, string>;
  target: string | null;
  ranked: Ranked[];
  picked: Asset | undefined;
  taskAsset: Asset | undefined;
}): JSX.Element | null {
  const mode = useWs((s) => s.mode);
  const on = useWs((s) => s.overlays);
  const [proj] = useProjector(viewer, host);
  if (!on) return null;
  const t = target ? fixes.get(target) : undefined;
  const tp = t ? proj(t.lat, t.lon) : null;
  const out: JSX.Element[] = [];

  // Rings first so dots and labels sit on top.
  if (t && mode === "targets") {
    for (let i = 1; i <= 9; i++) {
      const d = ring(proj, t.lat, t.lon, 0.75 * i);
      if (d)
        out.push(
          <path
            key={`r${i}`}
            d={d}
            fill={i === 9 ? "rgba(214,120,140,.10)" : "none"}
            stroke="#ecc3ca"
            strokeWidth={i === 9 ? 1.5 : 0.9}
            strokeOpacity={i === 9 ? 0.95 : 0.7}
          />,
        );
    }
  }
  const air =
    mode === "create" ? picked : mode === "taskings" ? taskAsset : undefined;
  if (
    t &&
    air &&
    air.kind === "air" &&
    air.lat !== undefined &&
    air.lon !== undefined
  ) {
    const ap = proj(air.lat, air.lon);
    if (mode === "create") {
      for (let i = 1; i <= 4; i++) {
        const d = ring(proj, air.lat, air.lon, 4.5 * i);
        if (d)
          out.push(
            <path
              key={`a${i}`}
              d={d}
              fill="none"
              stroke="#e8ecee"
              strokeWidth="1.6"
              strokeOpacity={i === 4 ? 0.95 : 0.75}
            />,
          );
      }
      for (let i = 1; i <= 8; i++) {
        const d = ring(proj, t.lat, t.lon, 2.5 * i);
        if (d)
          out.push(
            <path
              key={`t${i}`}
              d={d}
              fill={i === 8 ? "rgba(214,120,140,.12)" : "none"}
              stroke="#f0a6b4"
              strokeWidth={i === 8 ? 2.4 : 1.3}
              strokeOpacity={i === 8 ? 0.95 : 0.7}
            />,
          );
      }
      if (air.trk != null && ap) {
        const [hl, ho] = destination(air.lat, air.lon, air.trk, 18);
        const hp = proj(hl, ho);
        if (hp)
          out.push(
            <line
              key="hd"
              x1={ap.x}
              y1={ap.y}
              x2={hp.x}
              y2={hp.y}
              stroke="#e8ecee"
              strokeWidth="1.2"
            />,
          );
      }
    }
    if (ap && tp) {
      const nm = distNm(t.lat, t.lon, air.lat, air.lon);
      out.push(
        <line
          key="pair"
          x1={tp.x}
          y1={tp.y}
          x2={ap.x}
          y2={ap.y}
          stroke={mode === "create" ? "#e8ecee" : "#b9c8f0"}
          strokeWidth={mode === "create" ? 1.2 : 1.6}
          strokeDasharray={mode === "create" ? "4 3" : undefined}
        />,
        <Label
          key="nm"
          p={{ x: (tp.x + ap.x) / 2 + 22, y: (tp.y + ap.y) / 2 + 9 }}
          text={`${nm.toFixed(1)}nm`}
          halo="#0e1412"
        />,
      );
    }
    if (ap)
      out.push(
        <rect
          key="abox"
          x={ap.x - 5}
          y={ap.y - 4.5}
          width="10"
          height="9"
          fill="none"
          stroke="#e8a0b0"
          strokeWidth="1.2"
        />,
        <Label key="alab" p={ap} text={air.label} halo="#000" dy={-11} />,
      );
  }
  // M43: straight bearings from the four best live aircraft to the item.
  if (t && tp && mode === "rec") {
    ranked
      .filter((r) => r.asset.kind === "air")
      .slice(0, 4)
      .forEach((r) => {
        const a = r.asset;
        const ap =
          a.lat !== undefined && a.lon !== undefined
            ? proj(a.lat, a.lon)
            : null;
        if (!ap) return;
        out.push(
          <line
            key={`l${a.id}`}
            x1={tp.x}
            y1={tp.y}
            x2={ap.x}
            y2={ap.y}
            stroke="#d6dcde"
            strokeWidth="1.2"
            strokeOpacity=".85"
          />,
          <rect
            key={`b${a.id}`}
            x={ap.x - 5}
            y={ap.y - 4.5}
            width="10"
            height="9"
            fill="none"
            stroke="#c8d0d4"
            strokeWidth="1.2"
          />,
          <Label key={`n${a.id}`} p={ap} text={a.label} halo="#000" dy={-10} />,
        );
      });
  }
  for (const [id, f] of fixes) {
    const p = proj(f.lat, f.lon);
    if (!p) continue;
    const sel = id === target;
    out.push(
      <circle
        key={`d${id}`}
        cx={p.x}
        cy={p.y}
        r={sel ? 3.8 : 3}
        fill="#d9314f"
        stroke="#ecc3ca"
        strokeWidth="1"
      />,
      <Label
        key={`t${id}`}
        p={p}
        text={names.get(id) ?? f.name}
        halo="#a03a52"
        dy={sel ? -11 : -8}
      />,
    );
  }
  return (
    <svg className="ov" aria-hidden="true">
      {out}
    </svg>
  );
}

const emptyDraft = (): Draft => ({
  taskType: "",
  plan: "",
  planCount: 0,
  startMs: Date.now(),
  totMs: null,
  security: "",
});

export function Workspace({
  viewer,
  onBoard,
}: {
  viewer: Cesium.Viewer | null | undefined;
  onBoard: () => void;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1600, h: 900 });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const k = Math.max(1, Math.min(1920 / 1313, size.h / FRAME_H));
  const W = size.w / k;
  const H = size.h / k;

  // The reference workspace sits on a dark basemap: switch to Esri's keyless
  // dark canvas while the workspace is open and hand the operator's choice
  // back on the way out.
  useEffect(() => {
    const prev = useImagery.getState().mode;
    if (prev !== "esri-dark") useImagery.getState().setMode("esri-dark");
    return () => {
      if (useImagery.getState().mode === "esri-dark" && prev !== "esri-dark")
        useImagery.getState().setMode(prev);
    };
  }, []);

  const ws = useWs();
  const set = ws.set;
  const setApp = useAppView((s) => s.setApp);
  const select = useSelection((s) => s.select);
  const entries = useTargetBoard((s) => s.entries);
  const load = useTargetBoard((s) => s.load);
  const fixes = useFixes(viewer);
  const taskings = useWatchTaskings((s) => s.taskings);
  const weights = useWatchTaskings((s) => s.weights);
  const continuous = useWatchTaskings((s) => s.continuous);
  const now = useNow();

  // Same probe as the board: a keyless deployment answers 401 and the board
  // lives on this device only.
  const [api, setApi] = useState<number | "down" | null>(null);
  useEffect(() => {
    let live = true;
    apiFetch("/api/targets/board")
      .then((r) => {
        if (!live) return;
        setApi(r.status);
        if (r.ok) void load();
      })
      .catch(() => live && setApi("down"));
    return () => {
      live = false;
    };
  }, [load]);
  const apiNote =
    api === null || api === 200
      ? null
      : api === "down"
        ? "Board API unreachable. Entries stay on this device."
        : `Board API unavailable (HTTP ${api}). Entries stay on this device.`;

  // Default to the first board item, as the reference opens on a selection.
  useEffect(() => {
    if (ws.target && entries.some((e) => e.entityId === ws.target)) return;
    const first = entries.find((e) => fixes.has(e.entityId)) ?? entries[0];
    set({ target: first?.entityId ?? null });
  }, [entries, fixes, ws.target, set]);

  const entry = entries.find((e) => e.entityId === ws.target);
  const fix = ws.target ? fixes.get(ws.target) : undefined;
  const recs = useRecs(ws.target, fix, ws.mode !== "targets");

  const [opt, setOpt] = useState(0);
  const liveRanked = useMemo(
    () => rank([...recs.air, ...recs.sat], weights),
    [recs.air, recs.sat, weights],
  );
  const frozen = useRef<Ranked[]>([]);
  const ranked = useMemo(() => {
    if (continuous || frozen.current.length === 0) frozen.current = liveRanked;
    return frozen.current;
    // `opt` re-ranks on demand when continuous optimisation is off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRanked, continuous, opt]);
  useEffect(() => {
    if (!continuous) frozen.current = liveRanked;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opt]);

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  useEffect(() => {
    if (ws.mode === "create") setDraft(emptyDraft());
  }, [ws.mode, ws.target]);
  const picked = ranked.find((r) => r.asset.id === ws.draftAsset) ?? ranked[0];
  const active = taskings.find((t) => t.id === ws.activeTask);
  const taskAsset = active
    ? (recs.air.find((a) => a.id === active.asset.id) ?? active.asset)
    : undefined;

  // Toasts close themselves.
  useEffect(() => {
    if (!ws.toast) return;
    const t = setTimeout(() => set({ toast: null }), 4000);
    return () => clearTimeout(t);
  }, [ws.toast, set]);

  // Camera: centre the item, tilt 43 degrees while a tasking is drafted.
  const fly = (tilt: number, extra?: { lat: number; lon: number }): void => {
    if (!viewer || viewer.isDestroyed() || !fix) return;
    const pts = [Cesium.Cartesian3.fromDegrees(fix.lon, fix.lat)];
    if (extra) pts.push(Cesium.Cartesian3.fromDegrees(extra.lon, extra.lat));
    const bs = Cesium.BoundingSphere.fromPoints(pts);
    // The reference frames span about 250 km top-down and 400 km tilted.
    const range = Math.max(bs.radius * 4, tilt > 5 ? 340_000 : 220_000);
    viewer.camera.flyToBoundingSphere(bs, {
      offset: new Cesium.HeadingPitchRange(0, -(90 - tilt) * RAD, range),
      duration: 0.9,
    });
  };
  const pickedAir =
    picked?.asset.kind === "air" && picked.asset.lat !== undefined
      ? { lat: picked.asset.lat, lon: picked.asset.lon! }
      : undefined;
  const lastFly = useRef<string>("");
  useEffect(() => {
    if (!fix) return;
    const key = `${ws.target}|${ws.mode === "create" ? "c" : "f"}`;
    if (lastFly.current === key) return;
    lastFly.current = key;
    fly(
      ws.mode === "create" ? 43 : 0,
      ws.mode === "create" ? pickedAir : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.target, ws.mode, fix !== undefined]);

  // Live camera facts for the view controls.
  const cam = viewer && !viewer.isDestroyed() ? viewer.camera : null;
  const tilt = cam ? Math.round(90 + cam.pitch / RAD) : 0;
  const heading = cam ? cam.heading / RAD : 0;
  const following =
    viewer && !viewer.isDestroyed() ? isFollowing(viewer, ws.target) : false;
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(
    null,
  );
  const [grid, setGrid] = useState(false);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const c = viewer.canvas;
    const move = (e: PointerEvent): void => {
      const r = c.getBoundingClientRect();
      const p = viewer.camera.pickEllipsoid(
        new Cesium.Cartesian2(e.clientX - r.left, e.clientY - r.top),
      );
      if (!p) return setCursor(null);
      const g = Cesium.Cartographic.fromCartesian(p);
      setCursor({ lat: g.latitude / RAD, lon: g.longitude / RAD });
    };
    const leave = (): void => setCursor(null);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerleave", leave);
    return () => {
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerleave", leave);
    };
  }, [viewer]);
  const setTilt = (deg: number): void => {
    if (!viewer || viewer.isDestroyed()) return;
    const c = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(
        viewer.canvas.clientWidth / 2,
        viewer.canvas.clientHeight / 2,
      ),
    );
    if (!c) return;
    const range = Cesium.Cartesian3.distance(viewer.camera.positionWC, c);
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(c, 1), {
      offset: new Cesium.HeadingPitchRange(
        viewer.camera.heading,
        -(90 - deg) * RAD,
        range,
      ),
      duration: 0.5,
    });
  };
  const fitAll = (): void => {
    if (!viewer || viewer.isDestroyed() || fixes.size === 0) return;
    const bs = Cesium.BoundingSphere.fromPoints(
      [...fixes.values()].map((f) =>
        Cesium.Cartesian3.fromDegrees(f.lon, f.lat),
      ),
    );
    bs.radius = Math.max(bs.radius, 20_000);
    viewer.camera.flyToBoundingSphere(bs, { duration: 0.8 });
  };

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries)
      m.set(e.entityId, titleOf(e, fixes.get(e.entityId)));
    return m;
  }, [entries, fixes]);

  const lw = ws.collapsed ? 33 : 275;
  const objW = ws.objOpen && entry ? 405 : 0;
  const mapMid = lw + (W - lw - objW) / 2;
  const stripOn =
    ws.strip &&
    (ws.mode === "create" ||
      (ws.mode === "taskings" && !!active) ||
      taskings.some(
        (t) => t.targetId === ws.target && t.status !== "rejected",
      ));
  const stripW = W - (ws.collapsed ? 43 : 285) - objW;
  const nowLabel = `${zDate(now)} ${zClock(now)}`;

  const rail: Array<[string, string, () => void, boolean?]> = [
    [
      "menu-open",
      "Collapse the panel",
      () => set({ collapsed: !ws.collapsed }),
    ],
    [
      "target",
      "Targets",
      () => set({ mode: "targets" }),
      ws.mode === "targets",
    ],
    [
      "route",
      "Taskings",
      () => set({ mode: "taskings" }),
      ws.mode === "taskings",
    ],
    [
      "timeline-bar-chart",
      "Show or hide the Gantt strip",
      () => set({ strip: !ws.strip }),
      ws.strip,
    ],
    ["graph", "Open the link graph", () => setApp("graph")],
  ];
  const rail2: Array<[string, string, () => void]> = [
    ["satellite", "Asset recommender", () => set({ mode: "rec" })],
    ["search", "Search targets", () => set({ mode: "targets" })],
    ["database", "Open Explorer", () => setApp("explorer")],
    ["book", "Open Reports", () => setApp("reports")],
    ["settings", "Recommender metrics", () => set({ metrics: true })],
  ];

  return (
    <div className="mvw" ref={host}>
      <Overlay
        viewer={viewer}
        host={host.current}
        fixes={fixes}
        names={names}
        target={ws.target}
        ranked={ranked}
        picked={picked?.asset}
        taskAsset={taskAsset}
      />
      <div className="st" style={{ width: W, height: H, zoom: k }}>
        <nav className="mv-rail" aria-label="Workspace rail">
          <button
            type="button"
            className="logo"
            title="Back to the board"
            onClick={onBoard}
          >
            <BpIcon name="lightning" />
          </button>
          {rail.map(([ic, t, fn, on]) => (
            <button
              key={ic}
              type="button"
              className={on ? "on" : ""}
              title={t}
              aria-label={t}
              onClick={fn}
            >
              <BpIcon name={ic} />
            </button>
          ))}
          <span className="sp" />
          {rail2.map(([ic, t, fn]) => (
            <button
              key={ic}
              type="button"
              title={t}
              aria-label={t}
              onClick={fn}
            >
              <BpIcon name={ic} />
            </button>
          ))}
          <button
            type="button"
            className="bot"
            title="Back to the map"
            aria-label="Back to the map"
            onClick={() => setApp("map")}
          >
            <BpIcon
              name="globe"
              style={{ width: 12, height: 12, color: "#f3f5f5" }}
            />
          </button>
        </nav>
        <span className="gut" />
        {!ws.collapsed && (
          <LeftPanel
            entries={entries}
            fixes={fixes}
            ranked={ranked}
            recs={recs}
            apiNote={apiNote}
            onBoard={onBoard}
            draft={draft}
            setDraft={setDraft}
          />
        )}

        {entry && (
          <div className="hdr" style={{ left: mapMid }}>
            <span className="tg">
              <BpIcon name="target" />
            </span>
            <span className="nm">
              <b>{titleOf(entry, fix)}</b>
              <span>
                {kindOf(entry)}
                {fix ? "" : ", no live fix"}
              </span>
            </span>
            <button
              type="button"
              className="ib"
              title="Centre on the target"
              disabled={!fix}
              onClick={() => fly(tilt)}
            >
              <BpIcon name="locate" />
            </button>
            <button
              type="button"
              className="ib"
              title="Fit the target and its asset"
              disabled={!fix}
              onClick={() =>
                fly(
                  tilt,
                  ws.mode === "taskings" && taskAsset?.lat !== undefined
                    ? { lat: taskAsset.lat, lon: taskAsset.lon! }
                    : pickedAir,
                )
              }
            >
              <BpIcon name="zoom-to-fit" />
            </button>
            <button
              type="button"
              className="ib"
              title="Target details"
              aria-pressed={ws.objOpen}
              onClick={() => set({ objOpen: !ws.objOpen })}
            >
              <BpIcon name="book" />
            </button>
            <button
              type="button"
              className="ib go"
              title="Recommend assets"
              onClick={() => set({ mode: "rec" })}
            >
              <BpIcon name="play" />
            </button>
            <button
              type="button"
              className="ta"
              onClick={() => set({ mode: "create" })}
            >
              Task asset →
            </button>
            <button
              type="button"
              className="mv-x"
              title="Clear the selection"
              onClick={() => {
                set({ target: null, objOpen: false });
                select(null);
              }}
            >
              <BpIcon name="cross" />
            </button>
          </div>
        )}

        <div className="vc" style={{ right: 8 + objW }}>
          <button
            type="button"
            className={ws.overlays ? "on" : ""}
            aria-pressed={ws.overlays}
            title="Rings and lines"
            onClick={() => set({ overlays: !ws.overlays })}
          >
            <BpIcon name="layers" />
          </button>
          <button type="button" title="Fit every target" onClick={fitAll}>
            <BpIcon name="polygon-filter" />
          </button>
          <button
            type="button"
            className="mv-n"
            title="North up"
            style={{ transform: `rotate(${-heading}deg)` }}
            onClick={() => {
              if (!viewer || viewer.isDestroyed()) return;
              viewer.camera.setView({
                orientation: {
                  heading: 0,
                  pitch: viewer.camera.pitch,
                  roll: 0,
                },
              });
            }}
          >
            N
          </button>
          <button
            type="button"
            className={following ? "on" : ""}
            aria-pressed={following}
            title={
              following ? "Stop following the target" : "Follow the target"
            }
            disabled={!ws.target}
            onClick={() => {
              if (!viewer || viewer.isDestroyed() || !ws.target) return;
              if (following) stopFollow(viewer);
              else followEntity(viewer, ws.target);
            }}
          >
            <BpIcon name="lock" />
          </button>
          <button
            type="button"
            title={tilt > 5 ? "Top-down" : "Tilt 43 degrees"}
            onClick={() => setTilt(tilt > 5 ? 0 : 43)}
          >
            <BpIcon name="rect-width" />
          </button>
          <span className="ang">{tilt}°</span>
          <span
            className="tilt"
            role="slider"
            aria-label="Camera tilt"
            aria-valuemin={0}
            aria-valuemax={80}
            aria-valuenow={tilt}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") setTilt(Math.min(80, tilt + 5));
              if (e.key === "ArrowDown") setTilt(Math.max(0, tilt - 5));
            }}
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setTilt(
                Math.round(
                  Math.max(0, Math.min(1, (r.bottom - e.clientY) / r.height)) *
                    80,
                ),
              );
            }}
          >
            <i style={{ height: `${Math.min(100, (tilt / 80) * 100)}%` }} />
          </span>
        </div>

        <div className="sr" style={{ right: objW, bottom: stripOn ? 220 : 0 }}>
          <button
            type="button"
            title="Centre on the target"
            disabled={!fix}
            onClick={() => fly(tilt)}
          >
            <BpIcon name="locate" />
          </button>
          <span className="xy">
            {cursor
              ? grid
                ? mgrs(cursor.lat, cursor.lon)
                : `${cursor.lat.toFixed(3)}, ${cursor.lon.toFixed(3)}`
              : "N/A"}
          </span>
          <button
            type="button"
            className={grid ? "on" : ""}
            aria-pressed={grid}
            title="Cursor in MGRS"
            onClick={() => setGrid(!grid)}
          >
            <BpIcon name="settings" />
          </button>
          <button
            type="button"
            className={ws.strip ? "on" : ""}
            aria-pressed={ws.strip}
            title="Gantt strip"
            onClick={() => set({ strip: !ws.strip })}
          >
            <BpIcon name="rect-height" />
          </button>
          <button
            type="button"
            title="Target details"
            disabled={!entry}
            onClick={() => set({ objOpen: !ws.objOpen })}
          >
            <BpIcon name="target" />
          </button>
          <span className="clk">
            {nowLabel}
            <span>Z</span>
          </span>
          <button
            type="button"
            className="pn"
            title="Collapse the panel"
            onClick={() => set({ collapsed: !ws.collapsed })}
          >
            <BpIcon name="panel" />
          </button>
        </div>

        {stripOn &&
          (ws.mode === "taskings" && active ? (
            <DetailStrip
              t={active}
              w={stripW}
              pos={{ left: W - objW - stripW, right: objW }}
              fix={fixes.get(active.targetId)}
            />
          ) : (
            <GanttStrip
              w={stripW}
              pos={{ left: W - objW - stripW, right: objW }}
              draft={ws.mode === "create" ? draft : null}
              setDraft={setDraft}
              picked={picked}
            />
          ))}

        {ws.objOpen && entry && <ObjectPanel e={entry} fix={fix} />}

        {ws.toast && (
          <div className="toast" role="status" style={{ left: mapMid }}>
            <span className="ok">
              <BpIcon name="tick" />
            </span>
            {ws.toast}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => set({ toast: null })}
            >
              <BpIcon name="cross" />
            </button>
          </div>
        )}

        {ws.metrics && (
          <MetricsDialog
            left={mapMid}
            top={H / 2}
            onOptimize={() => {
              frozen.current = liveRanked;
              setOpt((n) => n + 1);
            }}
          />
        )}
      </div>
    </div>
  );
}
