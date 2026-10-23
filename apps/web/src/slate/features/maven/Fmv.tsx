import { useEffect, useMemo, useRef, useState } from "react";
import * as Cesium from "cesium";
import "./fmv.css";
import { create } from "zustand";
import { BpIcon } from "../../../shell/BpIcon.js";
import { toast } from "../../../shell/toast.js";
import { apiFetch } from "../../../transport/http.js";
import { useAppView } from "../../../state/appView.js";
import { useAlerts, useSelection, useTime } from "../../../state/stores.js";
import { useTargetBoard } from "../../../state/targetBoard.js";
import { boardLookup } from "../../pages/TargetBoard.js";
import { countGaps, type Coverage } from "../../../timeline/CoverageStrip.js";
import { mgrs, distNm } from "./geo.js";
import {
  makePlate,
  toPx,
  toLL,
  gsd,
  tiles,
  bounds,
  SPAN,
  TILE,
  type Plate,
} from "./fmvPlate.js";

// The video surface (reference rows M15 to M27): toolbar and icon rail,
// telemetry, two-up map and oblique pane, single pane with a docked minimap,
// detection legend, range ring, right-click menu, target nomination, live
// tracking brackets, coverage timeline and the detection chip. There is no
// video feed in this deployment, so the "video" is the app's own satellite
// tiles around a real position, drawn oblique by a CSS 3D transform, and every
// overlay is placed from latitude and longitude on that plate. Detections are
// the YOLO route's answer for the plate (its note is shown when it has none)
// plus the marks the operator adds by hand.

interface Det {
  id: string;
  lat: number;
  lon: number;
  cls: string;
  conf: number | null;
  by: "yolo" | "you";
}

const useMarks = create<{ marks: Det[]; add: (d: Det) => void }>((set) => ({
  marks: [],
  add: (d) => set((s) => ({ marks: [...s.marks, d] })),
}));

const p2 = (n: number): string => String(n).padStart(2, "0");
const MON = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const stamp = (ms: number): string => {
  const d = new Date(ms);
  return `${p2(d.getUTCDate())}${MON[d.getUTCMonth()]}${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
};
const llText = (lat: number, lon: number): string =>
  `${Math.abs(lat).toFixed(4)}${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}${lon >= 0 ? "E" : "W"}`;
const shortId = (id: string): string => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return String(h % 1000000).padStart(6, "0");
};

/** Live position and ADS-B pose of an entity on the globe. */
function readEntity(
  viewer: Cesium.Viewer | null,
  id: string,
): {
  lat: number;
  lon: number;
  name: string;
  altM: number | null;
  trk: number | null;
  kind: string;
} | null {
  const hit = boardLookup(viewer, id);
  const cart = hit?.ent.position?.getValue(
    viewer?.clock.currentTime ?? Cesium.JulianDate.now(),
  );
  if (!hit || !cart) return null;
  const g = Cesium.Cartographic.fromCartesian(cart);
  const t = viewer?.clock.currentTime ?? Cesium.JulianDate.now();
  const props = hit.ent.properties?.getValue(t) as
    Record<string, unknown> | undefined;
  const num = (v: unknown): number | null =>
    typeof v === "number" && isFinite(v) ? v : null;
  return {
    lat: Cesium.Math.toDegrees(g.latitude),
    lon: Cesium.Math.toDegrees(g.longitude),
    name: hit.ent.name || id,
    altM: num(props?.baro_alt_m) ?? num(props?.geo_alt_m),
    trk: num(props?.track_deg) ?? num(props?.cog) ?? num(props?.heading),
    kind: id.split(":")[0] ?? "object",
  };
}

function cameraCentre(viewer: Cesium.Viewer | null): [number, number] | null {
  if (!viewer || viewer.isDestroyed()) return null;
  const c = viewer.camera.pickEllipsoid(
    new Cesium.Cartesian2(
      viewer.canvas.clientWidth / 2,
      viewer.canvas.clientHeight / 2,
    ),
  );
  if (!c) return null;
  const g = Cesium.Cartographic.fromCartesian(c);
  return [
    Cesium.Math.toDegrees(g.latitude),
    Cesium.Math.toDegrees(g.longitude),
  ];
}

// ------------------------------------------------------------------ the plate

function PlateView({
  plate,
  w,
  h,
  k,
  tilt = 0,
  rot = 0,
  dets,
  showDets,
  sel,
  hover,
  setHover,
  ring,
  centre,
  gray,
  brackets,
  measure,
  onContext,
  onPick,
}: {
  plate: Plate;
  w: number;
  h: number;
  k: number;
  tilt?: number;
  rot?: number;
  dets: Det[];
  showDets: boolean;
  sel: string | null;
  hover: string | null;
  setHover: (id: string | null) => void;
  ring: { lat: number; lon: number; m: number } | null;
  centre: [number, number];
  gray?: boolean;
  brackets?: boolean;
  measure: [number, number][] | null;
  onContext: (lat: number, lon: number, cx: number, cy: number) => void;
  onPick: (lat: number, lon: number, id: string | null) => void;
}): JSX.Element {
  const [cx, cy] = toPx(plate, centre[0], centre[1]);
  const S = SPAN * TILE;
  const m = gsd(plate);
  const local = (e: React.MouseEvent): [number, number] => {
    const ne = e.nativeEvent;
    return toLL(plate, ne.offsetX, ne.offsetY);
  };
  const ringPx = ring
    ? (() => {
        const [x, y] = toPx(plate, ring.lat, ring.lon);
        return { x, y, r: ring.m / m };
      })()
    : null;
  return (
    <div className="pv" style={{ width: w, height: h, perspective: 1400 }}>
      <div
        className="pst"
        style={{
          width: S,
          height: S,
          left: w / 2 - cx,
          top: h / 2 - cy,
          transformOrigin: `${cx}px ${cy}px`,
          transform: `scale(${k}) rotateX(${tilt}deg) rotateZ(${rot}deg)`,
          filter: gray
            ? "grayscale(1) contrast(1.15) brightness(.8)"
            : "contrast(1.06)",
        }}
      >
        {tiles(plate).map((t) => (
          <img
            key={t.key}
            src={t.url}
            alt=""
            draggable={false}
            style={{ left: t.x, top: t.y }}
          />
        ))}
        <svg width={S} height={S} className="ovl" aria-hidden="true">
          {ringPx && (
            <g>
              <circle
                cx={ringPx.x}
                cy={ringPx.y}
                r={ringPx.r}
                fill="none"
                stroke="#6fa6b8"
                strokeWidth={1.6 / k}
              />
              <line
                x1={ringPx.x}
                y1={ringPx.y}
                x2={ringPx.x + ringPx.r}
                y2={ringPx.y}
                stroke="#6fa6b8"
                strokeWidth={1.4 / k}
              />
              <text
                x={ringPx.x + ringPx.r / 2}
                y={ringPx.y - 3 / k}
                fontSize={11 / k}
                fill="#c9d3d6"
                textAnchor="middle"
              >
                {ring!.m.toFixed(0)}m
              </text>
              {(["N", "E", "S", "W"] as const).map((d, i) => (
                <text
                  key={d}
                  x={ringPx.x + Math.sin((i * Math.PI) / 2) * ringPx.r}
                  y={ringPx.y - Math.cos((i * Math.PI) / 2) * ringPx.r + 4 / k}
                  fontSize={11 / k}
                  fill="#c9d3d6"
                  textAnchor="middle"
                  stroke="#0e1414"
                  strokeWidth={3 / k}
                  paintOrder="stroke"
                >
                  {d}
                </text>
              ))}
            </g>
          )}
          {measure &&
            measure.length === 2 &&
            (() => {
              const [a, b] = measure;
              const [x1, y1] = toPx(plate, a![0], a![1]);
              const [x2, y2] = toPx(plate, b![0], b![1]);
              return (
                <g>
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="#f3b723"
                    strokeWidth={2 / k}
                  />
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 - 4 / k}
                    fontSize={12 / k}
                    fill="#fff"
                    stroke="#000"
                    strokeWidth={3 / k}
                    paintOrder="stroke"
                    textAnchor="middle"
                  >
                    {(distNm(a![0], a![1], b![0], b![1]) * 1852).toFixed(0)} m
                  </text>
                </g>
              );
            })()}
          {showDets &&
            dets.map((d) => {
              const [x, y] = toPx(plate, d.lat, d.lon);
              const on = d.id === sel;
              const hv = d.id === hover;
              const hb = 6 / m; // a car is about 4.6 m long
              return (
                <g key={d.id}>
                  {(on || hv) && (
                    <rect
                      x={x - hb / 2}
                      y={y - hb}
                      width={hb}
                      height={hb * 2}
                      fill={
                        on ? "rgba(232,150,74,.35)" : "rgba(230,234,234,.35)"
                      }
                      stroke={on ? "#e8964a" : "#e6eaea"}
                      strokeWidth={1.2 / k}
                    />
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r={3 / k}
                    fill="#fff"
                    stroke="#111"
                    strokeWidth={1.2 / k}
                  />
                  {(on || hv) && (
                    <text
                      x={x - hb / 2}
                      y={y - hb - 3 / k}
                      fontSize={10 / k}
                      fill={on ? "#e8964a" : "#e6eaea"}
                      stroke="#000"
                      strokeWidth={2.5 / k}
                      paintOrder="stroke"
                    >
                      {shortId(d.id)}
                    </text>
                  )}
                </g>
              );
            })}
        </svg>
        <div
          className="hit"
          onContextMenu={(e) => {
            e.preventDefault();
            const [lat, lon] = local(e);
            onContext(lat, lon, e.clientX, e.clientY);
          }}
          onMouseMove={(e) => {
            if (!showDets) return;
            const [lat, lon] = local(e);
            const near = dets.find(
              (d) => distNm(d.lat, d.lon, lat, lon) * 1852 < 8,
            );
            setHover(near?.id ?? null);
          }}
          onClick={(e) => {
            const [lat, lon] = local(e);
            const near = showDets
              ? dets.find((d) => distNm(d.lat, d.lon, lat, lon) * 1852 < 8)
              : undefined;
            onPick(lat, lon, near?.id ?? null);
          }}
        />
      </div>
      {brackets && (
        <svg className="brk" width={w} height={h} aria-hidden="true">
          {[
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ].map(([dx, dy]) => {
            const bx = w / 2 + dx! * 60;
            const by = h / 2 + dy! * 56;
            return (
              <path
                key={`${dx}${dy}`}
                d={`M${bx} ${by - dy! * 26}V${by}H${bx - dx! * 26}`}
                fill="none"
                stroke="#f3f5f5"
                strokeWidth="3"
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ surface

type Layout = "two" | "single";
type LeftMode = "telemetry" | "nominate" | null;

export function MavenFmv({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
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
  // Narrow hosts keep a readable floor and let the layout reflow on W.
  const kz = Math.max(0.7, Math.min(size.w / 1920, size.h / 1080));
  const W = size.w / kz;
  const H = size.h / kz;

  const setApp = useAppView((s) => s.setApp);
  const selected = useSelection((s) => s.selectedEntityId);
  const select = useSelection((s) => s.select);
  const alerts = useAlerts((s) => s.alerts.length);
  const entries = useTargetBoard((s) => s.entries);
  const addTarget = useTargetBoard((s) => s.add);
  const time = useTime();
  const marks = useMarks((s) => s.marks);
  const addMark = useMarks((s) => s.add);

  const [layout, setLayout] = useState<Layout>("two");
  const [left, setLeft] = useState<LeftMode>("telemetry");
  const [oblique, setOblique] = useState(true);
  const [live, setLive] = useState(false);
  const [gray, setGray] = useState(false);
  const [legend, setLegend] = useState(true);
  const [showTl, setShowTl] = useState(true);
  const [minimap, setMinimap] = useState(true);
  const [settings, setSettings] = useState(false);
  const [tagMode, setTagMode] = useState(false);
  const [showDets, setShowDets] = useState(true);
  const [debug, setDebug] = useState(false);
  const [grid, setGrid] = useState(false);
  const [help, setHelp] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    lat: number;
    lon: number;
  } | null>(null);
  const [mapMenu, setMapMenu] = useState<null | "root" | "near">(null);
  const [measure, setMeasure] = useState<[number, number][] | null>(null);

  // The plate centre: the selected object, else the globe camera's centre.
  const [plate, setPlate] = useState<Plate | null>(null);
  const [subject, setSubject] = useState<ReturnType<typeof readEntity>>(null);
  const recentre = (): void => {
    const e = selected ? readEntity(viewer, selected) : null;
    setSubject(e);
    const c = e ? [e.lat, e.lon] : cameraCentre(viewer);
    if (c) setPlate(makePlate(c[0]!, c[1]!));
  };
  useEffect(recentre, [selected, viewer]);
  // Live: follow the object's own fixes.
  useEffect(() => {
    if (!live || !selected) return;
    const t = setInterval(() => {
      const e = readEntity(viewer, selected);
      if (!e) return;
      setSubject(e);
      setPlate((p) => {
        if (!p) return makePlate(e.lat, e.lon);
        const [x, y] = toPx(p, e.lat, e.lon);
        const edge = TILE * 1.5;
        return x < edge ||
          y < edge ||
          x > SPAN * TILE - edge ||
          y > SPAN * TILE - edge
          ? makePlate(e.lat, e.lon)
          : { ...p, lat: e.lat, lon: e.lon };
      });
    }, 2000);
    return () => clearInterval(t);
  }, [live, selected, viewer]);

  // Detections for the plate from the YOLO route; its note when it has none.
  const [yolo, setYolo] = useState<{
    dets: Det[];
    note: string | null;
    busy: boolean;
  }>({ dets: [], note: null, busy: false });
  const [runs, setRuns] = useState(0);
  useEffect(() => {
    if (!plate) return;
    let live2 = true;
    const [w, s, e, n] = bounds(plate);
    const date = new Date().toISOString().slice(0, 10);
    setYolo((y) => ({ ...y, busy: true }));
    apiFetch(
      `/api/imagery/detect?min_lon=${w.toFixed(5)}&min_lat=${s.toFixed(5)}&max_lon=${e.toFixed(5)}&max_lat=${n.toFixed(5)}&date=${date}`,
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`Detection unavailable (HTTP ${r.status})`);
        const j = (await r.json()) as {
          features?: Array<{
            id: string;
            geometry: { coordinates: [number, number] };
            properties: { cls?: string; conf?: number };
          }>;
          summary?: { note?: string };
        };
        if (!live2) return;
        setYolo({
          busy: false,
          note: j.summary?.note ?? null,
          dets: (j.features ?? []).map((f) => ({
            id: f.id,
            lon: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
            cls: String(f.properties.cls ?? "object"),
            conf: f.properties.conf ?? null,
            by: "yolo" as const,
          })),
        });
      })
      .catch((err: unknown) => {
        if (live2)
          setYolo({
            busy: false,
            dets: [],
            note:
              err instanceof Error && err.message.startsWith("Detection")
                ? err.message
                : "Detection route unreachable",
          });
      });
    return () => {
      live2 = false;
    };
    // Re-run on a new plate (not on a live re-centre inside it) or on request.
  }, [plate?.tx0, plate?.ty0, plate?.z, runs]); // eslint-disable-line react-hooks/exhaustive-deps

  const allDets = useMemo(() => [...yolo.dets, ...marks], [yolo.dets, marks]);
  const dets = allDets.filter((d) => !hidden.has(d.cls));
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of allDets) m.set(d.cls, (m.get(d.cls) ?? 0) + 1);
    return [...m.entries()];
  }, [allDets]);
  const selDet = allDets.find((d) => d.id === sel) ?? null;

  // Coverage of the history archive over the last 24 h (gaps hatched).
  const [cov, setCov] = useState<Coverage | null>(null);
  const [covErr, setCovErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = (): void => {
      apiFetch("/api/history/coverage?window_hours=24&bucket_hours=1")
        .then(async (r) => {
          if (!r.ok)
            throw new Error(`History coverage unavailable (HTTP ${r.status})`);
          const j = (await r.json()) as Coverage;
          if (alive) {
            setCov(j);
            setCovErr(null);
          }
        })
        .catch(
          (e: unknown) =>
            alive &&
            setCovErr(
              e instanceof Error ? e.message : "History coverage unreachable",
            ),
        );
    };
    pull();
    const t = setInterval(pull, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Nearby maps for the overlay chooser: chokepoints by distance.
  const [chokes, setChokes] = useState<
    Array<{ id: string; name: string; lat: number; lon: number }>
  >([]);
  useEffect(() => {
    if (mapMenu !== "near" || chokes.length) return;
    apiFetch("/api/maritime/chokepoints")
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          j: {
            features?: Array<{
              id: string;
              geometry: { coordinates: [number, number] };
              properties: { name: string };
            }>;
          } | null,
        ) => {
          if (j?.features)
            setChokes(
              j.features.map((f) => ({
                id: f.id,
                name: f.properties.name,
                lon: f.geometry.coordinates[0],
                lat: f.geometry.coordinates[1],
              })),
            );
        },
      )
      .catch(() => undefined);
  }, [mapMenu, chokes.length]);

  const elevation = (lat: number, lon: number): string => {
    if (
      !viewer ||
      viewer.isDestroyed() ||
      viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider
    )
      return "No DEM";
    const hgt = viewer.scene.globe.getHeight(
      Cesium.Cartographic.fromDegrees(lon, lat),
    );
    return hgt === undefined ? "No DEM tile loaded" : `${hgt.toFixed(2)} m`;
  };

  const exportFrame = (): void => {
    if (!plate) return;
    const S = SPAN * TILE;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const g = c.getContext("2d");
    if (!g) return;
    const imgs =
      host.current?.querySelectorAll<HTMLImageElement>(".pv .pst img") ?? [];
    for (const im of imgs)
      if (im.complete && im.naturalWidth)
        g.drawImage(
          im,
          parseFloat(im.style.left),
          parseFloat(im.style.top),
          TILE,
          TILE,
        );
    g.fillStyle = "#fff";
    for (const d of dets) {
      const [x, y] = toPx(plate, d.lat, d.lon);
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
    try {
      const a = document.createElement("a");
      a.href = c.toDataURL("image/png");
      a.download = `frame-${plate.lat.toFixed(4)}_${plate.lon.toFixed(4)}.png`;
      a.click();
    } catch {
      toast.warn("Frame export failed");
    }
  };

  const nominate = (id: string | null): void => {
    if (id) {
      const d = allDets.find((x) => x.id === id);
      if (d) {
        addTarget(`detection:${shortId(d.id)}`, {
          label: `Computer Vision Detection ${shortId(d.id)}`,
          kind: d.cls,
        });
        toast.ok("Detection nominated to the board");
        return;
      }
    }
    if (selected) {
      addTarget(selected, { label: subject?.name ?? selected });
      toast.ok("Nominated to the board");
    }
  };

  const onPick = (lat: number, lon: number, id: string | null): void => {
    setMenu(null);
    if (measure && measure.length === 1) {
      setMeasure([measure[0]!, [lat, lon]]);
      return;
    }
    if (tagMode) {
      addMark({
        id: `mark:${Date.now()}`,
        lat,
        lon,
        cls: "Vehicle",
        conf: null,
        by: "you",
      });
      return;
    }
    setSel(id);
  };
  const onContext = (lat: number, lon: number, x: number, y: number): void => {
    const r = host.current!.getBoundingClientRect();
    setMenu({ lat, lon, x: (x - r.left) / kz, y: (y - r.top) / kz });
  };

  const now = time.currentTime;
  const ringAt = selDet
    ? { lat: selDet.lat, lon: selDet.lon, m: 10 }
    : plate
      ? { lat: plate.lat, lon: plate.lon, m: 20 }
      : null;

  // ---- timeline geometry (frame units)
  const tl0 = (left ? 374 : 0) + 10;
  const tl1 = W - (legend ? 150 : 10);
  const winH = 24;
  const t1 = Date.now();
  const t0 = t1 - winH * 3600_000;
  const tx = (t: number): number => tl0 + ((t - t0) / (t1 - t0)) * (tl1 - tl0);
  const buckets = cov?.buckets ?? [];
  const gaps = countGaps(buckets);

  const leftW = left ? 374 : 0;
  const vx = leftW + 9;
  const vTop = 64;
  const vBot = showTl ? H - 138 : H;
  const plateOk = plate !== null;

  const ICONS: Array<[string, string, () => void, boolean]> = [
    [
      "tag",
      "Tag mode: click the video to mark a missed detection",
      () => setTagMode(!tagMode),
      tagMode,
    ],
    [
      "airplane",
      "Telemetry",
      () => setLeft(left === "telemetry" ? null : "telemetry"),
      left === "telemetry",
    ],
    [
      "th",
      "Target nomination",
      () => setLeft(left === "nominate" ? null : "nominate"),
      left === "nominate",
    ],
    ["time", "Timeline", () => setShowTl(!showTl), showTl],
    ["graph", "Open the link graph", () => setApp("graph"), false],
    ["notifications", "AI detections legend", () => setLegend(!legend), legend],
    ["locate", "Re-centre on the selected object", recentre, false],
  ];

  return (
    <div className="mfv" ref={host}>
      <div
        className="st"
        style={{
          width: W,
          height: H,
          transform: `scale(${kz})`,
          transformOrigin: "0 0",
        }}
      >
        {/* M2 / M15: header and toolbar */}
        <div className="top">
          <span className="logo">
            <BpIcon name="lightning" />
          </span>
          <button
            type="button"
            className="pill"
            title="Alerts in the live ticker"
            onClick={() => setApp("map")}
          >
            <BpIcon name="inbox" />
            {alerts}
          </button>
          <span className="fttl">
            {subject ? `FMV · ${subject.name}` : "FMV · map centre"}
          </span>
          <BpIcon name="shield" className="sh" />
          <button
            type="button"
            onClick={exportFrame}
            title="File: export this frame as PNG"
          >
            File
          </button>
          <button
            type="button"
            onClick={() => setLayout(layout === "two" ? "single" : "two")}
            title="View: two-up or single pane"
          >
            View
          </button>
          <button
            type="button"
            onClick={() => setHelp(!help)}
            title="Help: what is on this surface"
          >
            Help
          </button>
          <span className={`fchip${live ? " live" : ""}`}>
            {live ? "Live track" : "Archived imagery"}
          </span>
          <span className="srch">
            <BpIcon name="search" />
            <input
              placeholder="Search"
              aria-label="Search detections"
              onChange={(e) => {
                const q = e.target.value.toLowerCase();
                const hit = allDets.find(
                  (d) =>
                    shortId(d.id).includes(q) ||
                    d.cls.toLowerCase().includes(q),
                );
                setSel(q && hit ? hit.id : null);
              }}
            />
          </span>
        </div>
        <div className="row2">
          {ICONS.map(([ic, t, fn, on]) => (
            <button
              key={ic}
              type="button"
              className={`ib${on ? " on" : ""}`}
              title={t}
              aria-label={t}
              aria-pressed={on}
              onClick={fn}
            >
              <BpIcon name={ic} />
            </button>
          ))}
          <button
            type="button"
            className={`tag${tagMode ? " on" : ""}`}
            aria-pressed={tagMode}
            onClick={() => setTagMode(!tagMode)}
            title="Tag mode"
          >
            <BpIcon name="tag" />
            Tag
          </button>
          <button
            type="button"
            className="ib"
            title="Single pane"
            onClick={() => setLayout("single")}
          >
            <BpIcon name="fullscreen" />
          </button>
          <button
            type="button"
            className="ib"
            title="Map and video side by side"
            onClick={() => setLayout("two")}
          >
            <BpIcon name="desktop" />
          </button>
          <button
            type="button"
            className={`ib${minimap ? " on" : ""}`}
            title="Minimap"
            onClick={() => setMinimap(!minimap)}
          >
            <BpIcon name="layout-grid" />
          </button>
          <span className="ts">
            {help
              ? "Archive satellite tiles around a real position; no sensor video"
              : stamp(now)}
          </span>
          <span className="rt">
            <button
              type="button"
              className={`cube${oblique ? "" : " off"}`}
              title={oblique ? "Oblique view on" : "Oblique view off"}
              aria-pressed={oblique}
              onClick={() => setOblique(!oblique)}
            >
              <BpIcon name="cube" />
            </button>
            <button
              type="button"
              className="ib"
              title="Full screen"
              onClick={() => void host.current?.requestFullscreen?.()}
            >
              <BpIcon name="fullscreen" />
            </button>
            <button
              type="button"
              className={`ib${settings ? " on" : ""}`}
              title="Video settings"
              onClick={() => setSettings(!settings)}
            >
              <BpIcon name="wrench" />
            </button>
            <button
              type="button"
              className={`bolt${live ? " on" : ""}`}
              title={
                subject
                  ? "Live: follow the selected object's fixes"
                  : "Select an object with a live fix on the map to track it"
              }
              disabled={!subject && !live}
              onClick={() => setLive(!live)}
            >
              <BpIcon name="lightning" />
            </button>
            <button
              type="button"
              className="aif"
              onClick={() => setRuns((n) => n + 1)}
              title="Run detection again on this plate"
            >
              {yolo.busy ? "Detecting…" : "AI Feedback"}
            </button>
          </span>
        </div>

        {/* video panes */}
        {!plateOk && (
          <p className="nopl" style={{ left: vx, top: vTop + 40 }}>
            Select an object on the map, or point the map at a place, then press
            Re-centre.
          </p>
        )}
        {plateOk && layout === "two" && (
          <>
            <div
              className="pane"
              style={{
                left: vx,
                top: vTop,
                width: (W - vx) * 0.49,
                height: vBot - vTop,
              }}
            >
              <PlateView
                plate={plate}
                w={(W - vx) * 0.49}
                h={vBot - vTop}
                k={1.6}
                dets={dets}
                showDets={showDets}
                sel={sel}
                hover={hover}
                setHover={setHover}
                ring={null}
                centre={[plate.lat, plate.lon]}
                measure={measure}
                onContext={onContext}
                onPick={onPick}
              />
              <div className="mhd">
                <b>{subject?.name ?? "Map centre"}</b>
                <span>☀ {llText(plate.lat, plate.lon)}</span>
              </div>
              <button
                type="button"
                className="omap"
                aria-expanded={mapMenu !== null}
                onClick={() => setMapMenu(mapMenu ? null : "root")}
              >
                <BpIcon name="map" />
                Open map
                <BpIcon name="caret-down" />
              </button>
              {mapMenu && (
                <div className="mmenu">
                  <button
                    type="button"
                    onClick={() => {
                      setShowDets(!showDets);
                      setMapMenu(null);
                    }}
                  >
                    <BpIcon name={showDets ? "remove" : "add"} />
                    {showDets ? "Remove overlay" : "Add overlay"}
                  </button>
                  <button type="button" onClick={() => setApp("map")}>
                    <BpIcon name="map" />
                    Choose existing map
                  </button>
                  <button
                    type="button"
                    className={mapMenu === "near" ? "on" : ""}
                    onClick={() => setMapMenu("near")}
                  >
                    <BpIcon name="map-create" />
                    Nearby maps
                    <BpIcon name="caret-right" />
                  </button>
                  <button
                    type="button"
                    disabled
                    title="Saved maps need the board API"
                  >
                    <BpIcon name="add" />
                    Create new
                  </button>
                  {mapMenu === "near" && (
                    <div className="sub">
                      {chokes.length === 0 && (
                        <span className="none">Loading chokepoints…</span>
                      )}
                      {[...chokes]
                        .sort(
                          (a, b) =>
                            distNm(plate.lat, plate.lon, a.lat, a.lon) -
                            distNm(plate.lat, plate.lon, b.lat, b.lon),
                        )
                        .slice(0, 7)
                        .map((c) => (
                          <button
                            type="button"
                            key={c.id}
                            title={`${distNm(plate.lat, plate.lon, c.lat, c.lon).toFixed(0)} nm away`}
                            onClick={() => {
                              setSubject(null);
                              setPlate(makePlate(c.lat, c.lon));
                              setMapMenu(null);
                            }}
                          >
                            <BpIcon name="map" />
                            {c.name}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div
              className="pane"
              style={{
                left: vx + (W - vx) * 0.51,
                top: vTop + (vBot - vTop) * 0.25,
                width: (W - vx) * 0.49 - 10,
                height: (vBot - vTop) * 0.5,
              }}
            >
              <PlateView
                plate={plate}
                w={(W - vx) * 0.49 - 10}
                h={(vBot - vTop) * 0.5}
                k={2.4}
                tilt={oblique ? 46 : 0}
                rot={0}
                dets={dets}
                showDets={showDets}
                sel={sel}
                hover={hover}
                setHover={setHover}
                ring={ringAt}
                centre={[plate.lat, plate.lon]}
                gray={gray}
                brackets={live}
                measure={measure}
                onContext={onContext}
                onPick={onPick}
              />
            </div>
          </>
        )}
        {plateOk && layout === "single" && (
          <div
            className="pane"
            style={{
              left: vx,
              top: vTop + 8,
              width: W - vx - 10,
              height: vBot - vTop - 12,
            }}
          >
            <PlateView
              plate={plate}
              w={W - vx - 10}
              h={vBot - vTop - 12}
              k={3.2}
              tilt={oblique ? 42 : 0}
              dets={dets}
              showDets={showDets}
              sel={sel}
              hover={hover}
              setHover={setHover}
              ring={ringAt}
              centre={
                selDet && !live
                  ? [selDet.lat, selDet.lon]
                  : [plate.lat, plate.lon]
              }
              gray={gray}
              brackets={live}
              measure={measure}
              onContext={onContext}
              onPick={onPick}
            />
            {minimap && (
              <div className="inset">
                <PlateView
                  plate={plate}
                  w={184}
                  h={83}
                  k={0.32}
                  dets={[]}
                  showDets={false}
                  sel={null}
                  hover={null}
                  setHover={() => undefined}
                  ring={null}
                  centre={[plate.lat, plate.lon]}
                  measure={null}
                  onContext={onContext}
                  onPick={onPick}
                />
                <span className="fp" />
              </div>
            )}
          </div>
        )}

        {/* M27: chip for the selected detection or object */}
        {plateOk && (selDet || subject) && (
          <div className="dchip" style={{ left: vx + 16, top: vBot - 70 }}>
            <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
              <path
                d="M12 1 L23 12 L12 23 L1 12Z"
                fill="#e6606e"
                stroke="#0e1112"
                strokeWidth="1.6"
              />
              <rect
                x="7.5"
                y="8.5"
                width="9"
                height="7"
                fill="none"
                stroke="#0e1112"
                strokeWidth="1.2"
              />
            </svg>
            <span>
              <b>{selDet ? "Computer Vision Detection" : subject!.name}</b>
              <small>
                {selDet
                  ? `${selDet.cls} · ${selDet.by === "you" ? "marked by you" : `YOLO ${Math.round((selDet.conf ?? 0) * 100)}%`}`
                  : subject!.kind}
                <i />
                UNCLAS
              </small>
            </span>
          </div>
        )}

        {/* M21: right-click menu */}
        {menu && (
          <div
            className="ctx"
            style={{
              left: Math.min(menu.x, W - 330),
              top: Math.min(menu.y, H - 380),
            }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              title="Copy the coordinate"
              onClick={() => {
                void navigator.clipboard?.writeText(
                  grid ? mgrs(menu.lat, menu.lon) : llText(menu.lat, menu.lon),
                );
                setMenu(null);
              }}
            >
              <BpIcon name="locate" />
              {grid ? mgrs(menu.lat, menu.lon) : llText(menu.lat, menu.lon)}
              <span
                className="end"
                title="Switch between lat/lon and MGRS"
                onClick={(e) => {
                  e.stopPropagation();
                  setGrid(!grid);
                }}
              >
                <BpIcon name="settings" />
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              title="Terrain height under the point"
              onClick={() => setMenu(null)}
            >
              <BpIcon name="mountain" />
              {elevation(menu.lat, menu.lon)}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMeasure([[menu.lat, menu.lon]]);
                setMenu(null);
                toast.info("Click the second point");
              }}
            >
              <BpIcon name="arrows-horizontal" />
              Measure distance
            </button>
            <button
              type="button"
              role="menuitem"
              className="hl"
              onClick={() => {
                const near = allDets.find(
                  (d) => distNm(d.lat, d.lon, menu.lat, menu.lon) * 1852 < 15,
                );
                if (near || selected) nominate(near?.id ?? null);
                else {
                  addTarget(
                    `point:${menu.lat.toFixed(5)},${menu.lon.toFixed(5)}`,
                    {
                      label: `Point ${llText(menu.lat, menu.lon)}`,
                      kind: "point",
                    },
                  );
                  toast.ok("Point nominated to the board");
                }
                setMenu(null);
              }}
            >
              <BpIcon name="target" />
              Nominate to board
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                addMark({
                  id: `mark:${Date.now()}`,
                  lat: menu.lat,
                  lon: menu.lon,
                  cls: "Vehicle",
                  conf: null,
                  by: "you",
                });
                setMenu(null);
              }}
            >
              <BpIcon name="add" />
              Mark missed detection(s)
            </button>
            <span className="na">
              {yolo.note ??
                (yolo.dets.length
                  ? `${yolo.dets.length} detections on this plate`
                  : "No actions available")}
            </span>
            <hr />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setDebug(!debug);
                setMenu(null);
              }}
            >
              <BpIcon name="bug" />
              {debug ? "Disable debugging info" : "Enable debugging info"}
            </button>
          </div>
        )}
        {menu && (
          <div
            className="scrim"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
        )}
        {debug && plate && (
          <pre className="dbg" style={{ left: vx + 10, top: vTop + 10 }}>
            {`plate z${plate.z} tiles ${plate.tx0}..${plate.tx0 + SPAN - 1} x ${plate.ty0}..${plate.ty0 + SPAN - 1}\nGSD ${gsd(plate).toFixed(2)} m/px\ndetections ${yolo.dets.length} yolo, ${marks.length} marked`}
          </pre>
        )}

        {/* left column: M16 telemetry, M19 minimap card, M22 nomination */}
        {left && (
          <aside className="lp" style={{ bottom: showTl ? 138 : 0 }}>
            {(layout === "single" || left === "nominate") && plate && (
              <div className="mm">
                <PlateView
                  plate={plate}
                  w={374}
                  h={181}
                  k={0.42}
                  dets={dets}
                  showDets={showDets}
                  sel={sel}
                  hover={null}
                  setHover={() => undefined}
                  ring={null}
                  centre={[plate.lat, plate.lon]}
                  measure={null}
                  onContext={onContext}
                  onPick={onPick}
                />
                <div className="mmh">
                  <BpIcon name="chevron-down" />
                  <span>
                    <b>{subject?.name ?? "Plate"} AOI</b>
                    <small>☀ This device | UNCLAS</small>
                  </span>
                </div>
                <div className="mmf">
                  <button type="button" title="Re-centre" onClick={recentre}>
                    <BpIcon name="locate" />
                  </button>
                  <button
                    type="button"
                    title="Single pane"
                    onClick={() =>
                      setLayout(layout === "two" ? "single" : "two")
                    }
                  >
                    <BpIcon name="fullscreen" />
                  </button>
                  <button
                    type="button"
                    title="Open the map"
                    onClick={() => setApp("map")}
                  >
                    <BpIcon name="map" />
                  </button>
                  <button
                    type="button"
                    title="Debugging info"
                    onClick={() => setDebug(!debug)}
                  >
                    <BpIcon name="info-sign" />
                  </button>
                </div>
              </div>
            )}
            {left === "telemetry" ? (
              <div className="tel">
                <div className="h">
                  <BpIcon name="airplane" />
                  Telemetry
                  <span className="end">
                    <button
                      type="button"
                      title="Target nomination"
                      onClick={() => setLeft("nominate")}
                    >
                      <BpIcon name="th" />
                    </button>
                    <button
                      type="button"
                      title="Video settings"
                      onClick={() => setSettings(!settings)}
                    >
                      <BpIcon name="cog" />
                    </button>
                    <button
                      type="button"
                      title="Close"
                      onClick={() => setLeft(null)}
                    >
                      <BpIcon name="cross" />
                    </button>
                  </span>
                </div>
                <svg
                  className="ac"
                  viewBox="-150 -90 300 140"
                  aria-hidden="true"
                  style={{
                    transform:
                      subject?.trk != null ? `rotate(0deg)` : undefined,
                  }}
                >
                  <ellipse
                    cx="0"
                    cy="0"
                    rx="107"
                    ry="31"
                    fill="none"
                    stroke="#4a6a9a"
                    strokeWidth="1.5"
                  />
                  <line x1="-107" y1="0" x2="107" y2="0" stroke="#4a6a9a" />
                  <line x1="0" y1="-48" x2="0" y2="31" stroke="#4a6a9a" />
                  <path
                    d="M-92 -22 L-20 -37 L-8 -33 L-60 -26 L-8 -30 L52 -44 L92 -62 L96 -58 L40 -30 L22 -22 L-4 -20 L-52 -14 Z"
                    fill="#aeb6b9"
                  />
                  <path
                    d="M-60 -26 L-8 -30 L40 -30 L50 -24 L-20 -16 Z"
                    fill="#d3d9db"
                  />
                  <text
                    x="-122"
                    y="5"
                    fontSize="16"
                    fontWeight="600"
                    fill="#e6eaea"
                    textAnchor="middle"
                  >
                    W
                  </text>
                  <text
                    x="122"
                    y="5"
                    fontSize="16"
                    fontWeight="600"
                    fill="#e6eaea"
                    textAnchor="middle"
                  >
                    E
                  </text>
                  <text
                    x="0"
                    y="40"
                    fontSize="16"
                    fontWeight="600"
                    fill="#e6eaea"
                    textAnchor="middle"
                  >
                    S
                  </text>
                </svg>
                <div className="nm">
                  Notional model - may not reflect actual aircraft type
                </div>
                <div className="fkv">
                  <span>Oblique view</span>
                  <button
                    type="button"
                    className={`tg${oblique ? " on" : ""}`}
                    aria-pressed={oblique}
                    onClick={() => setOblique(!oblique)}
                    title="Draw the plate oblique (no sensor pose: a fixed 46 degree view)"
                  >
                    <i />
                  </button>
                  <span>Source</span>
                  <span>
                    {subject && subject.kind === "aircraft"
                      ? "ADS-B"
                      : "Velocity"}
                  </span>
                </div>
                <div className="sec">PLATFORM</div>
                <div className="fkv">
                  <span>Altitude (MSL)</span>
                  <span>
                    {subject?.altM != null
                      ? `${Math.round(subject.altM * 3.28084)} ft`
                      : "n/a"}
                  </span>
                  <span>Heading</span>
                  <span>
                    {subject?.trk != null
                      ? `${Math.round(subject.trk)}°`
                      : "n/a"}
                  </span>
                  <span>Pitch</span>
                  <span>n/a</span>
                  <span>Roll</span>
                  <span>n/a</span>
                  <span>Location</span>
                  <span>{plate ? llText(plate.lat, plate.lon) : "n/a"}</span>
                </div>
                <div className="sec">SENSOR</div>
                <div className="fkv">
                  <span>Type</span>
                  <span>
                    {plate
                      ? `Esri imagery z${plate.z} (${gsd(plate).toFixed(2)} m/px)`
                      : "n/a"}
                  </span>
                  <span>Relative Azimuth</span>
                  <span>n/a</span>
                  <span>Relative Roll</span>
                  <span>n/a</span>
                  <span>Relative Elevation</span>
                  <span>{oblique ? "46° (drawn)" : "90° (nadir)"}</span>
                  <span>SPI Location</span>
                  <span>{plate ? mgrs(plate.lat, plate.lon) : "n/a"}</span>
                  <span>SPI Elevation</span>
                  <span>{plate ? elevation(plate.lat, plate.lon) : "n/a"}</span>
                </div>
              </div>
            ) : (
              <div className="nom">
                <div className="h">
                  <BpIcon name="target" />
                  Target Nomination
                  <span className="end">
                    <button
                      type="button"
                      title="Telemetry"
                      onClick={() => setLeft("telemetry")}
                    >
                      <BpIcon name="cross" />
                    </button>
                  </span>
                </div>
                <div className="r">
                  Targets
                  <button
                    type="button"
                    className="wb"
                    onClick={() => setApp("targeting")}
                  >
                    Open in Workbench
                    <BpIcon name="arrow-top-right" />
                  </button>
                  <button
                    type="button"
                    className="nt"
                    disabled={!sel && !selected}
                    title={
                      sel || selected
                        ? "Add the selected detection or object to the board"
                        : "Select a detection or an object first"
                    }
                    onClick={() => nominate(sel)}
                  >
                    <BpIcon name="target" />
                    Nominate target
                  </button>
                </div>
                <div className="r">Board</div>
                <div className="bd">
                  <i />
                  My board
                </div>
                <div className="lst">
                  {entries.map((e) => (
                    <button
                      type="button"
                      key={e.id}
                      className="it"
                      onClick={() => select(e.entityId)}
                    >
                      <BpIcon name="locate" />
                      <span>
                        <b>{e.label ?? e.entityId}</b>
                        <small>
                          {(e.kind ?? e.entityId.split(":")[0]) as string} •{" "}
                          {e.classification.replace("UNCLASSIFIED", "UNCLAS")}
                        </small>
                      </span>
                    </button>
                  ))}
                  {allDets.map((d) => (
                    <button
                      type="button"
                      key={d.id}
                      className={`it${d.id === sel ? " on" : ""}`}
                      onClick={() => setSel(d.id)}
                      onMouseEnter={() => setHover(d.id)}
                      onMouseLeave={() => setHover(null)}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="24"
                        height="24"
                        aria-hidden="true"
                      >
                        <path
                          d="M12 1 L23 12 L12 23 L1 12Z"
                          fill="#e0505e"
                          stroke="#101414"
                          strokeWidth="1.4"
                        />
                        <circle
                          cx="12"
                          cy="12"
                          r="5"
                          fill="none"
                          stroke="#101414"
                          strokeWidth="1.4"
                        />
                      </svg>
                      <span>
                        <b>Detection {shortId(d.id)}</b>
                        <small>{d.cls} • UNCLAS</small>
                      </span>
                    </button>
                  ))}
                  {entries.length === 0 && allDets.length === 0 && (
                    <p className="none">
                      {yolo.note ? `${yolo.note}. ` : ""}No targets or
                      detections yet. Right-click the video to mark one.
                    </p>
                  )}
                </div>
              </div>
            )}
            <button
              type="button"
              className="vs"
              onClick={() => setSettings(!settings)}
            >
              <BpIcon name="cog" />
              Video settings
              <BpIcon name={settings ? "caret-down" : "caret-up"} />
            </button>
            {settings && (
              <div className="vset">
                <label>
                  <input
                    type="checkbox"
                    checked={gray}
                    onChange={(e) => setGray(e.target.checked)}
                  />{" "}
                  Grayscale (styled, not thermal)
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={oblique}
                    onChange={(e) => setOblique(e.target.checked)}
                  />{" "}
                  Oblique view
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showDets}
                    onChange={(e) => setShowDets(e.target.checked)}
                  />{" "}
                  Detection overlay
                </label>
              </div>
            )}
          </aside>
        )}

        {/* M23 / M26: timeline over the history archive's real coverage */}
        {showTl && (
          <div className="ftl" style={{ width: W }}>
            <span className="box" style={{ left: tl0 }}>
              {new Date(now).toISOString().slice(0, 10)}
            </span>
            <span className="box" style={{ left: tl0 + 89 }}>
              {new Date(now).toISOString().slice(11, 19)}
              <i>Z</i>
            </span>
            <span
              className="tr"
              style={{ left: Math.max(tl0 + 200, (tl0 + tl1) / 2 - 230) }}
            >
              <button
                type="button"
                title="Back one hour"
                onClick={() => time.setCurrentTime(now - 3600_000)}
              >
                <BpIcon name="fast-backward" />
              </button>
              <button
                type="button"
                title="Back one second"
                onClick={() => time.setCurrentTime(now - 1000)}
              >
                <BpIcon name="step-backward" />
              </button>
              <button
                type="button"
                title="Playback speed"
                onClick={() =>
                  time.setMultiplier(
                    time.multiplier >= 60 ? 1 : time.multiplier * 2,
                  )
                }
              >
                {time.multiplier}x
              </button>
              <button
                type="button"
                title="Back 15 seconds"
                onClick={() => time.setCurrentTime(now - 15000)}
              >
                <BpIcon name="undo" />
                15s
              </button>
              <button type="button" className="pp" onClick={time.togglePlay}>
                <BpIcon name={time.playing ? "pause" : "play"} />
                {time.playing ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                title="Forward 15 seconds"
                onClick={() =>
                  time.setCurrentTime(Math.min(Date.now(), now + 15000))
                }
              >
                15s
                <BpIcon name="redo" />
              </button>
              <button
                type="button"
                title="Forward one hour"
                onClick={() =>
                  time.setCurrentTime(Math.min(Date.now(), now + 3600_000))
                }
              >
                <BpIcon name="fast-forward" />
              </button>
              <button
                type="button"
                className={live ? "lv" : "ar"}
                title={
                  live ? "Following the object's live fixes" : "Jump to now"
                }
                onClick={() => time.setCurrentTime(Date.now())}
              >
                {live ? "Live" : "Archived"}
              </button>
            </span>
            {Array.from({ length: 9 }, (_, i) => t0 + (i * (t1 - t0)) / 8).map(
              (t) => (
                <span key={t} className="tick" style={{ left: tx(t) - 30 }}>
                  {new Date(t).toISOString().slice(11, 16)}
                </span>
              ),
            )}
            <span
              className="cov"
              style={{ left: tl0, width: tl1 - tl0 }}
              title={
                covErr ??
                (cov
                  ? `${buckets.length - gaps} of ${buckets.length} hours recorded`
                  : "loading coverage")
              }
            >
              {buckets.map((b) => (
                <i
                  key={b.t}
                  className={b.count > 0 ? "rec" : "gap"}
                  style={{
                    left: tx(b.t * 1000) - tl0,
                    width: (3600_000 / (t1 - t0)) * (tl1 - tl0),
                  }}
                />
              ))}
            </span>
            <span
              className="cur"
              style={{ left: Math.max(tl0, Math.min(tl1 - 49, tx(now))) }}
            >
              {new Date(now).toISOString().slice(11, 19)}
            </span>
            {covErr && (
              <span className="err" style={{ left: tl0 + 8 }}>
                {covErr}
              </span>
            )}
          </div>
        )}

        {/* M24: AI detections legend */}
        {legend && (
          <div
            className="leg"
            style={{ left: W - 145, top: showTl ? H - 133 : H - 140 }}
          >
            <div className="h">
              AI detections
              <button
                type="button"
                aria-label="Close"
                onClick={() => setLegend(false)}
              >
                <BpIcon name="cross" />
              </button>
            </div>
            {counts.map(([cls, n]) => (
              <label key={cls}>
                <input
                  type="checkbox"
                  checked={!hidden.has(cls)}
                  onChange={() =>
                    setHidden((s) => {
                      const x = new Set(s);
                      if (x.has(cls)) x.delete(cls);
                      else x.add(cls);
                      return x;
                    })
                  }
                />
                {cls}
                <b>{n}</b>
              </label>
            ))}
            {counts.length === 0 && (
              <p>
                {yolo.busy
                  ? "detecting…"
                  : (yolo.note ?? "No detections on this plate")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
