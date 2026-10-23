// E12 to E15: the simulation frame (meta_frame() in _build_features.py), crop
// 507,162 905x510, in its globe state (E12-E14) and zoomed ring state (E15).
// Satellites, passes, the sky plot, the ground track and the sightline are SGP4
// from /api/space/gp; sunlight is solar geometry at the AOI; the sweep card is
// /api/intel/sar/sweep; globe markers are live chokepoints and EMSC quakes. The
// globe plate is painted here from the Natural Earth image, as _eu_data.py did.
import { useEffect, useMemo, useRef } from "react";
import { A, I, T, Hit, circ, frag, hexlogo, type N } from "./ui.js";
import {
  AOI,
  RE,
  UTC,
  llaEcef,
  orthoBasis,
  paintGlobe,
  passSky,
  periodS,
  proj,
  satEcef,
  solarElev,
  solveCentre,
  sphereCircle,
  subsolar,
  unavailable,
  visibleRuns,
  type Choke,
  type Plan,
  type Res,
  type SweepAoi,
  type V3,
} from "./data.js";
import equirect from "./fb-equirect.jpg";

const VW = 648;
const VH = 430;
const MB = "#103662";
interface View {
  R: number;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
  tint: V3;
  trackW: number;
  haze: number;
}
const VIEWS: Record<"globe" | "ring", View> = {
  globe: { R: 470, cx: 483, cy: 268, tx: 323, ty: 216, tint: [90, 96, 130], trackW: 1, haze: 0 },
  ring: { R: 900, cx: 483, cy: 268, tx: 191, ty: 219, tint: [120, 104, 140], trackW: 2, haze: 0.45 },
};
const centreCache = new Map<string, [number, number]>();
const centreOf = (v: View): [number, number] => {
  const k = `${v.R},${v.tx},${v.ty}`;
  if (!centreCache.has(k)) centreCache.set(k, solveCentre(v.R, v.cx, v.cy, v.tx, v.ty));
  return centreCache.get(k)!;
};
const surf = (P: V3): V3 => {
  const n = Math.hypot(...P);
  return [(P[0] / n) * RE, (P[1] / n) * RE, (P[2] / n) * RE];
};
const operatorOf = (name: string): string =>
  name.includes("CAPELLA") ? "Capella Space" : name.includes("ICEYE") ? "ICEYE" : name.includes("UMBRA") ? "Umbra" : name.includes("SENTINEL") ? "ESA Copernicus" : "SAR";

let plate: Promise<ImageData> | null = null;
const loadPlate = (): Promise<ImageData> =>
  (plate ??= new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas");
      c.width = im.width;
      c.height = im.height;
      const g = c.getContext("2d")!;
      g.drawImage(im, 0, 0);
      res(g.getImageData(0, 0, im.width, im.height));
    };
    im.onerror = rej;
    im.src = equirect;
  }));

export interface Mark {
  lat: number;
  lon: number;
  name: string;
}

/** render_view() of _eu_data.py: plate, graticule, tracks, ring, sightline, markers. */
function GlobeView({ state, plan, now, marks }: { state: "globe" | "ring"; plan: Plan | null; now: number; marks: Mark[] }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = VIEWS[state];
  useEffect(() => {
    let live = true;
    void loadPlate().then((eq) => {
      const cv = ref.current;
      if (!live || !cv) return;
      const g = cv.getContext("2d")!;
      const b = orthoBasis(...centreOf(v));
      const [d0, l0] = subsolar(now);
      const r = Math.PI / 180;
      const sun: V3 = [Math.cos(d0 * r) * Math.cos(l0 * r), Math.cos(d0 * r) * Math.sin(l0 * r), Math.sin(d0 * r)];
      const img = g.createImageData(VW, VH);
      paintGlobe(eq, img.data, VW, VH, b, v.R, v.cx, v.cy, sun, v.tint, v.haze);
      g.putImageData(img, 0, 0);
      const line = (pts: V3[], col: string, w: number): void => {
        g.strokeStyle = col;
        g.lineWidth = w;
        for (const run of visibleRuns(pts, b, v.R, v.cx, v.cy)) {
          g.beginPath();
          run.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.stroke();
        }
      };
      for (let lat = -75; lat < 90; lat += 10) line(Array.from({ length: 181 }, (_, i) => llaEcef(lat, -180 + i * 2)), "rgba(230,238,246,.11)", 1);
      for (let lon = -180; lon < 180; lon += 10) line(Array.from({ length: 91 }, (_, i) => llaEcef(-90 + i * 2, lon)), "rgba(230,238,246,.11)", 1);
      const best = plan?.best;
      if (best) {
        const tt2 = Array.from({ length: 260 }, (_, i) => best.t0 - 3000 + i * 30);
        const per = periodS(best.tle);
        const track = (ts: number[]): V3[] => satEcef(best.tle, ts).filter((p): p is V3 => !!p).map(surf);
        line(track(tt2), "rgba(236,150,60,.92)", v.trackW);
        // the next revolution, SGP4-propagated one orbital period later
        line(track(tt2.map((t) => t + per)), "rgba(236,150,60,.43)", 1);
      }
      const ang = (500 / RE) * (180 / Math.PI);
      line(sphereCircle(AOI[0], AOI[1], ang, 181), "rgba(205,215,225,.88)", 2);
      const [cen, east, north] = orthoBasis(AOI[0], AOI[1]);
      for (let k = 0; k < 360; k += 5) {
        const t = (k * Math.PI) / 180;
        const at = (a: number): V3 =>
          [0, 1, 2].map((i) => RE * (Math.cos(a * r) * cen[i]! + Math.sin(a * r) * (Math.sin(t) * east[i]! + Math.cos(t) * north[i]!))) as V3;
        line([at(k % 30 ? ang * 0.93 : ang * 0.88), at(ang)], "rgba(205,215,225,.84)", 1);
      }
      if (best) {
        const S = satEcef(best.tle, [best.t0])[0];
        if (S) {
          const T0 = llaEcef(...AOI);
          line(Array.from({ length: 60 }, (_, i) => [0, 1, 2].map((k) => T0[k]! + ((S[k]! - T0[k]!) * i) / 59) as V3), "rgb(200,230,80)", 3);
        }
      }
      for (const m of marks) {
        const [x, y, d] = proj(llaEcef(m.lat, m.lon), b, v.R, v.cx, v.cy);
        if (d > 0 && x > 6 && x < VW - 6 && y > 6 && y < VH - 6) {
          g.beginPath();
          g.arc(x, y, 3, 0, 2 * Math.PI);
          g.fillStyle = "rgb(120,190,250)";
          g.fill();
          g.strokeStyle = "rgb(20,40,70)";
          g.lineWidth = 1;
          g.stroke();
        }
      }
    });
    return () => {
      live = false;
    };
  }, [v, plan, now, marks]);
  return (
    <canvas
      ref={ref}
      width={VW}
      height={VH}
      aria-label={state === "globe" ? "Globe with the selected pass" : "AOI azimuth ring"}
      style={{ position: "absolute", left: 0, top: 0, width: VW, height: VH, filter: `brightness(${state === "globe" ? 0.82 : 0.78}) saturate(${state === "globe" ? 0.85 : 0.7})` }}
    />
  );
}

function polarPlot(cx: number, cy: number, R: number, sky: { az: number; el: number }[]): N {
  const ox = R + 20;
  const oy = R + 12;
  const pt = (a: number, e: number): [number, number] => [ox + ((R * (90 - e)) / 90) * Math.sin((a * Math.PI) / 180), oy - ((R * (90 - e)) / 90) * Math.cos((a * Math.PI) / 180)];
  const pts = sky.map((s) => pt(s.az, s.el));
  const p0 = pts[0];
  const s: N[] = [
    <svg key="polar" aria-hidden style={{ left: cx - R - 20, top: cy - R - 12, width: 2 * R + 40, height: 2 * R + 24, overflow: "visible" }}>
      <circle cx={ox} cy={oy} r={R} fill="none" stroke="#7aa6e8" strokeWidth="1" />
      {[30, 45, 60, 75].map((el) => (
        <circle key={el} cx={ox} cy={oy} r={((R * (90 - el)) / 90).toFixed(1)} fill="none" stroke="#6a96d8" strokeWidth=".8" />
      ))}
      {[0, 45, 90, 135].map((az) => {
        const a = (az * Math.PI) / 180;
        return <line key={az} x1={ox + R * Math.sin(a)} y1={oy - R * Math.cos(a)} x2={ox - R * Math.sin(a)} y2={oy + R * Math.cos(a)} stroke="#6a96d8" strokeWidth=".8" />;
      })}
      {p0 ? (
        <>
          <polyline points={pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")} fill="none" stroke="#f0a43c" strokeWidth="1.4" />
          <circle cx={p0[0]} cy={p0[1]} r="2.4" fill="#f0a43c" />
          <path d={`M${p0[0] - 1} ${p0[1] - 6} l-3 -5 h6z`} fill="#f0c43c" />
        </>
      ) : null}
    </svg>,
  ];
  for (const [el, lab] of [
    [30, "30°"],
    [45, "45°"],
    [60, "60°"],
  ] as const) {
    const r = (R * (90 - el)) / 90;
    s.push(T(cx + r * 0.7 + 3, cy - r * 0.7 - 1, lab, 3.8, "#8ab2ee", 400, "l", 0));
  }
  if (p0 && sky[0]) s.push(T(p0[0] + cx - R - 20 - 6, p0[1] + cy - R - 12 - 2, `${sky[0].az.toFixed(0)}°`, 3.8, "#f0c43c", 400, "r", 0));
  return frag(s);
}

export function MetaFrame({
  state,
  setState,
  plan,
  gpRes,
  gpTotal,
  sweep,
  sweepRes,
  chokes,
  quakes,
  now,
  rerun,
  go,
}: {
  state: "globe" | "ring";
  setState: (s: "globe" | "ring") => void;
  plan: Plan | null;
  gpRes: Res<unknown> | null;
  gpTotal: number | null;
  sweep: SweepAoi | null;
  sweepRes: Res<unknown> | null;
  chokes: Choke[];
  quakes: Mark[];
  now: number;
  rerun: () => void;
  go: () => void;
}): N {
  const best = plan?.best ?? null;
  const v = VIEWS[state];
  const marks = useMemo(() => [...chokes.map((c) => ({ lat: c.lat, lon: c.lon, name: c.name })), ...quakes], [chokes, quakes]);
  const sky = useMemo(() => (best ? passSky(best) : []), [best]);
  const satWhy = gpRes && !gpRes.ok ? unavailable("Satellite elements", gpRes) : plan ? "No SAR pass over the AOI in the next 9 h" : "Propagating satellites…";
  const win0 = plan?.win0 ?? now - Math.trunc(2.7 * 3600);
  const s: N[] = [
    A(507, 162, 905, 510, "background:#082236"),
    <div key="map" style={{ left: 762, top: 162, width: 648, height: 430, overflow: "hidden", background: "#04060c" }}>
      <GlobeView state={state} plan={plan} now={now} marks={marks} />
    </div>,
  ];
  if (best) {
    const b = orthoBasis(...centreOf(v));
    const [ax, ay] = proj(llaEcef(...AOI), b, v.R, v.cx, v.cy);
    const S = satEcef(best.tle, [best.t0])[0];
    const [sx, sy] = S ? proj(S, b, v.R, v.cx, v.cy) : [NaN, NaN];
    const [lx, ly] = state === "globe" ? [762 + sx - 40, 162 + sy + 2] : [762 + ax - 78, 162 + ay - 18];
    if (Number.isFinite(lx)) s.push(T(lx, ly, best.name, 4.6, "#f2f4f6", 400, "l", 0));
    if (state === "globe" && Number.isFinite(sx)) s.push(circ(762 + sx, 162 + sy, 2.6, "#f2f4f6"));
  } else s.push(T(1086, 200, satWhy, 7, "#f2f6fa", 600, "c", 0));
  // panel
  s.push(
    A(537, 162, 224, 430, "background:#0e2e52"),
    A(537, 162, 224, 35, `background:${MB}`),
    I("settings", 553, 179, 11, "#a8c8f0"),
    T(566, 179.5, "Simulation Parameters", 11, "#e8f0f8", 400, "l", 0),
    I("chevron-left", 739, 179, 8, "#c8dcf4"),
    T(544, 212.5, "Satellite Criteria", 9.5, "#e0eaf4", 400, "l", 0),
    A(545, 227, 208, 38, "background:#163a5c"),
    T(552, 241, plan && gpTotal !== null ? `Currently working with ${plan.sarCount} of ${gpTotal.toLocaleString("en-US")}` : satWhy, 7.4, "#e8f0f8", 400, "l", 0),
    T(552, 257, <>satellites where <b>Constellation</b> is</>, 7.4, "#e8f0f8", 400, "l", 0),
    A(681, 251, 18, 10, "background:#1e4a80;border-radius:2px"),
    T(690, 256.5, "SAR", 4.8, "#6a96d8", 400, "c", 0),
    I("edit", 733, 248, 8, "#a8c8f0"),
    T(544, 300.5, "Required Parameters", 9.5, "#e0eaf4", 400, "l", 0),
    T(544, 321, "Area of Interest *", 6.8, "#e8f0f8", 700, "l", 0),
    T(551, 341, "Strait of Hormuz", 8.6, "#d0def0", 400, "l", 0),
    I("edit", 721, 341, 7.5, "#a8c8f0"),
    I("cross", 742, 341, 7.5, "#a8c8f0"),
    T(544, 365, "Mission Time Window *", 6.8, "#e8f0f8", 700, "l", 0),
    T(544, 386, "From", 6.6, "#e8f0f8", 400, "l", 0),
    T(580, 386, UTC(win0, "%d %b %Y %H:%MZ"), 6.6, "#f2f6fa", 700, "l", 0),
    T(679, 386, "for", 6.6, "#e8f0f8", 400, "l", 0),
    A(697, 377, 56, 19, "border:1px solid #3a6aa8;border-radius:2px;box-sizing:border-box"),
    T(702, 386.5, "6 Hours", 6.4, "#7aa0d0", 400, "l", 0),
    I("double-caret-vertical", 743, 386, 7, "#c8dcf4"),
    A(545, 407, 208, 1, "background:#1a4070"),
    T(544, 418.5, "Exploration Type", 9.5, "#e0eaf4", 400, "l", 0),
    A(545, 433, 88, 22, "background:#16457a"),
    T(589, 444.5, "Monitoring", 6.8, "#6a9ae0", 400, "c", 0),
    T(690, 444.5, "Mission Planning", 6.8, "#a8c4ea", 400, "c", 0),
  );
  [
    "A monitoring exploration lists every pass of the selected",
    "satellites over the area of interest for the entire",
    "window selected above, with elevation, azimuth and",
    "sunlight at the area for each pass.",
  ].forEach((ln, i) => s.push(T(545, 468 + i * 12.8, ln, 6.1, "#7e9cc4", 400, "l", 0, "font-style:italic")));
  s.push(
    A(545, 523, 208, 1, "background:#1a4070"),
    T(544, 541.5, "Monitoring Parameters", 9, "#e0eaf4", 400, "l", 0),
    A(537, 556, 224, 1, "background:#0a2646"),
    A(547, 566, 101, 16, "background:#2e6ed0"),
    T(589, 574.5, "Simulate", 6.8, "#f2f6fa", 400, "c", 0),
    I("caret-right", 617, 574.5, 6, "#f2f6fa"),
    Hit(547, 566, 101, 16, "Simulate", rerun),
    A(651, 566, 101, 16, "background:#2c6ecc"),
    T(690, 574.5, "View Results", 6.8, "#f2f6fa", 400, "c", 0),
    I("arrow-right", 729, 574.5, 8, "#f2f6fa"),
    Hit(651, 566, 101, 16, "View results", () => setState(state === "globe" ? "ring" : "globe")),
    // rail
    A(508, 162, 29, 510, "background:#0a2a4a"),
    hexlogo(520, 179, 5, "#e8f0f8"),
    Hit(512, 171, 18, 18, "Gaia home", go),
    A(512, 205, 20, 20, "background:#1e4a80;border-radius:2px"),
  );
  for (const [yc, ic, on] of [
    [215, "globe-network", 1],
    [244, "ring", 0],
    [272, "timeline-line-chart", 0],
    [309, "filter", 1],
    [337, "settings", 1],
    [366, "satellite", 1],
    [394, "globe", 1],
    [430, "play", 1],
    [513, "cloud", 1],
    [538, "lightbulb", 1],
    [562, "lock", 1],
  ] as const)
    s.push(I(ic, 521, yc, 9, on ? "#a8c8f0" : "#4a6a90"));
  s.push(
    Hit(512, 205, 20, 20, "Globe", () => setState("globe")),
    Hit(512, 234, 20, 20, "AOI ring", () => setState("ring")),
    A(512, 328, 20, 20, "background:#1e4a80;border-radius:2px"),
    I("settings", 521, 337, 9, "#d0e4fa"),
    A(509, 585, 27, 27, "border:1px solid #6a96d8;border-radius:50%;box-sizing:border-box"),
    T(522.5, 594, "N", 4.4, "#8ab2ee", 400, "c", 0),
    T(522.5, 620, state === "globe" ? "0°" : "5°", 5.4, "#c8dcf4", 400, "c", 0),
    A(513, 631, 20, 20, "border-left:1px solid #6a96d8;border-bottom:1px solid #6a96d8;box-sizing:border-box;background:#14335a"),
    T(522.5, 660, state === "globe" ? "9°" : "10°", 5.4, "#c8dcf4", 400, "c", 0),
  );
  if (state === "ring") s.push(I("add", 522, 640, 11, "#f2f6fa"), Hit(513, 631, 20, 20, "Zoom out to the globe", () => setState("globe")));
  // sweep card
  s.push(A(1161, 168, 248, 190, "background:#1d457a"), T(1168, 188, "Strait of Hormuz", 14, "#e8f0f8", 400, "l", 0), T(1168, 221, "SAR Sweeps", 9.5, "#e0eaf4", 400, "l", 0));
  if (sweep)
    s.push(
      A(1168, 237, 234, 46, "background:#1b4276"),
      T(1172, 246, "Latest Capture:", 6.6, "#f2f6fa", 700, "l", 0),
      T(1172, 258.5, "Date:", 6.4, "#9ab6dc", 400, "l", 0),
      T(1195, 258.5, UTC(sweep.swept_at, "%-d %b %Y %H:%M"), 6.4, "#f2f6fa", 400, "l", 0),
      T(1172, 272, "Status:", 6.4, "#9ab6dc", 400, "l", 0),
      I("tick", 1213, 272, 7, "#4ac08a"),
      T(1222, 272, "SUCCESS", 6.4, "#4ac08a", 400, "l", 0),
      T(1168, 304.5, "Detections", 6.6, "#f2f6fa", 400, "l", 0),
      A(1204, 299, 12, 11, "background:#2a5a96;border-radius:5px;font-size:5.2px;color:#cfe0f6;display:grid;place-items:center", String(sweep.detections)),
      A(1168, 312, 52, 1.5, "background:#e8f0f8"),
      T(1233, 304.5, "Dark", 6.6, "#9ab6dc", 400, "l", 0),
      A(1256, 299, 12, 11, "background:#2a5a96;border-radius:5px;font-size:5.2px;color:#cfe0f6;display:grid;place-items:center", String(sweep.dark_candidates)),
      ...(sweep.dark_candidates === 0
        ? [T(1285, 333, 'No dark-vessel candidates found for this AOI. View the "Detections"', 5.9, "#cfe0f6", 400, "c", 0), T(1285, 346, "tab to see all of its detections.", 5.9, "#cfe0f6", 400, "c", 0)]
        : [T(1285, 333, `${sweep.dark_candidates} detections have no AIS match. View the "Dark"`, 5.9, "#cfe0f6", 400, "c", 0), T(1285, 346, "tab to see the candidates.", 5.9, "#cfe0f6", 400, "c", 0)]),
    );
  else s.push(T(1285, 280, sweepRes?.ok ? "No sweep of this AOI yet" : unavailable("SAR sweep", sweepRes), 7, "#cfe0f6", 400, "c", 0));
  // satellite card
  s.push(A(1161, 366, 248, 226, "background:#1d457a"));
  if (best)
    s.push(
      T(1168, 385, best.name, 12, "#e8f0f8", 400, "l", 0),
      T(1168, 401.5, `${best.norad} · ${operatorOf(best.name)}`, 5.8, "#9ab6dc", 400, "l", 0),
      I("satellite", 1384, 389, 22, "#f2f6fa"),
      polarPlot(1283, 484, 55, sky),
      A(1168, 558, 232, 13, "background:#0a1822"),
      A(1168, 558, 1, 13, "background:#e8f0f8"),
      T(1168, 580, UTC(best.t0, "%b %d %Y %H:%M:%SZ").toUpperCase(), 5.6, "#e8f0f8", 400, "l", 0),
      T(1398, 580, UTC(best.t1, "%b %d %Y %H:%M:%SZ").toUpperCase(), 5.6, "#e8f0f8", 400, "r", 0),
    );
  else s.push(I("satellite", 1384, 389, 22, "#f2f6fa"), T(1285, 480, satWhy, 6.6, "#cfe0f6", 400, "c", 0));
  // timeline
  const X0 = 620;
  const X1 = 1412;
  const tx = (t: number): number => X0 + ((t - win0) / (6 * 3600)) * (X1 - X0);
  s.push(
    A(537, 592, 875, 80, "background:#082236"),
    A(537, 592, 875, 1, "background:#0f3358"),
    T(979, 602, UTC(best?.t0 ?? now, "%b %d %Y %H:%M:%SZ").toUpperCase(), 9.2, "#e8f0f8", 400, "c", 0),
    I("play", 1068, 602, 7, "#e8f0f8"),
    T(1081, 602.5, "60x", 5.4, "#c8dcf4", 400, "l", 0),
    I("step-forward", 1110, 602, 7, "#e8f0f8"),
    T(1121, 602.5, "Go Live", 5.4, "#c8dcf4", 400, "l", 0),
    I("arrows-horizontal", 551, 602, 8, "#5a96e0"),
    T(561, 602.5, "6h", 5.6, "#4a76b0", 400, "l", 0),
  );
  for (const [yc, ic, lab, col] of [
    [616.5, "sweep", "SAR", "#a8c8f0"],
    [626.5, "repeat", "Revisit", "#8ac080"],
    [637, "wind", "Sunlight", "#e0c040"],
  ] as const)
    s.push(I(ic, 550, yc, 6, col), T(562, yc + 0.5, lab, 5.2, col, 400, "l", 0));
  s.push(A(X0, 623, X1 - X0, 1, "background:#4ac08a"));
  for (const p of (plan?.passes ?? []).filter((q) => q.peak >= 35))
    s.push(A(tx(p.t0) - 1.5, 613, 3, 10, `background:${p.name.includes("CAPELLA") ? "#8fc43c" : "#4fa86a"};border-radius:1px`));
  // sunlight bar: real solar elevation at the AOI, sampled every 5 min
  let run: number | null = null;
  for (let t = win0; t <= win0 + 6 * 3600 + 300; t += 300) {
    const up = t <= win0 + 6 * 3600 && solarElev(t, ...AOI) > 0;
    if (up && run === null) run = t;
    if (!up && run !== null) {
      const xa = Math.max(X0, tx(run));
      const xb = Math.min(X1, tx(t - 300));
      if (xb > xa) s.push(A(xa, 635, xb - xa, 3, "background:#e0b82c"));
      run = null;
    }
  }
  for (let h = 0; h < 7; h++) {
    const t = win0 + h * 3600;
    s.push(A(tx(t), 650, 1, 6, "background:#12385c"), T(tx(t), 668, UTC(t, "%H:%M"), 4.8, "#2a5a8c", 400, "c", 0));
  }
  if (best) s.push(A(tx(best.t0), 607, 1.2, 65, "background:#f2f6fa"));
  s.push(A(1410, 162, 3, 510, "background:#04060a"));
  return frag(s);
}
