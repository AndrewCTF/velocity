// E12 to E15: the simulation page, laid out natively, in its globe state
// (E12-E14) and zoomed ring state (E15). Satellites, passes, the sky plot, the
// ground track and the sightline are SGP4 from /api/space/gp; sunlight is solar
// geometry at the AOI; the sweep card is /api/intel/sar/sweep; globe markers are
// live chokepoints and EMSC quakes. The globe plate is painted here from the
// Natural Earth image, as _eu_data.py did, at 2x and scaled to its pane.
import { useEffect, useMemo, useRef } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
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
import { EuBar } from "./Bar.js";
import { along } from "./layout.js";
import type { Go } from "./SatMap.js";
import equirect from "./fb-equirect.jpg";

const VW = 648;
const VH = 430;
const SS = 2; // canvas supersampling: the plate is drawn at 2x and scaled to its pane
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

/** Plate, graticule, tracks, ring, sightline, markers, drawn at SS x the 648x430 frame. */
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
      const img = g.createImageData(VW * SS, VH * SS);
      paintGlobe(eq, img.data, VW * SS, VH * SS, b, v.R * SS, v.cx * SS, v.cy * SS, sun, v.tint, v.haze);
      g.putImageData(img, 0, 0);
      const line = (pts: V3[], col: string, w: number): void => {
        g.strokeStyle = col;
        g.lineWidth = w * SS;
        for (const run of visibleRuns(pts, b, v.R * SS, v.cx * SS, v.cy * SS)) {
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
        const [x, y, d] = proj(llaEcef(m.lat, m.lon), b, v.R * SS, v.cx * SS, v.cy * SS);
        if (d > 0 && x > 6 && x < VW * SS - 6 && y > 6 && y < VH * SS - 6) {
          g.beginPath();
          g.arc(x, y, 3 * SS, 0, 2 * Math.PI);
          g.fillStyle = "rgb(120,190,250)";
          g.fill();
          g.strokeStyle = "rgb(20,40,70)";
          g.lineWidth = SS;
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
      width={VW * SS}
      height={VH * SS}
      role="img"
      aria-label={state === "globe" ? "Globe with the selected pass" : "AOI azimuth ring"}
      style={{ filter: `brightness(${state === "globe" ? 0.82 : 0.78}) saturate(${state === "globe" ? 0.85 : 0.7})` }}
    />
  );
}

const NONE = "\u2014"; // no value reported
const WIN = 6 * 3600;

/** Azimuth/elevation sky plot of the pass, in a 240x224 viewBox. */
function PolarPlot({ sky }: { sky: { az: number; el: number }[] }): JSX.Element {
  const R = 100;
  const ox = 120;
  const oy = 112;
  const pt = (a: number, e: number): [number, number] => [ox + ((R * (90 - e)) / 90) * Math.sin((a * Math.PI) / 180), oy - ((R * (90 - e)) / 90) * Math.cos((a * Math.PI) / 180)];
  const pts = sky.map((s) => pt(s.az, s.el));
  const p0 = pts[0];
  return (
    <svg viewBox="0 0 240 224" role="img" aria-label="Sky plot of the selected pass" style={{ width: "100%", maxHeight: 260 }}>
      <circle cx={ox} cy={oy} r={R} fill="none" stroke="#7aa6e8" strokeWidth="1" />
      {[30, 45, 60, 75].map((el) => (
        <circle key={el} cx={ox} cy={oy} r={((R * (90 - el)) / 90).toFixed(1)} fill="none" stroke="#6a96d8" strokeWidth=".8" />
      ))}
      {[0, 45, 90, 135].map((az) => {
        const a = (az * Math.PI) / 180;
        return <line key={az} x1={ox + R * Math.sin(a)} y1={oy - R * Math.cos(a)} x2={ox - R * Math.sin(a)} y2={oy + R * Math.cos(a)} stroke="#6a96d8" strokeWidth=".8" />;
      })}
      {[30, 45, 60].map((el) => {
        const r = (R * (90 - el)) / 90;
        return (
          <text key={el} x={ox + r * 0.7 + 3} y={oy - r * 0.7 - 1} fontSize={10} fill="#8ab2ee">{`${el}\u00b0`}</text>
        );
      })}
      {p0 && (
        <>
          <polyline points={pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")} fill="none" stroke="#f0a43c" strokeWidth="1.6" />
          <circle cx={p0[0]} cy={p0[1]} r="3" fill="#f0a43c" />
          <text x={p0[0] - 6} y={p0[1] - 4} fontSize={10} textAnchor="end" fill="#f0c43c">{`${sky[0]!.az.toFixed(0)}\u00b0`}</text>
        </>
      )}
    </svg>
  );
}

export function SimPage({
  state,
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
  plan: Plan | null;
  gpRes: Res<unknown> | null;
  gpTotal: number | null;
  sweep: SweepAoi | null;
  sweepRes: Res<unknown> | null;
  chokes: Choke[];
  quakes: Mark[];
  now: number;
  rerun: () => void;
  go: Go;
}): JSX.Element {
  const best = plan?.best ?? null;
  const v = VIEWS[state];
  const marks = useMemo(() => [...chokes.map((c) => ({ lat: c.lat, lon: c.lon, name: c.name })), ...quakes], [chokes, quakes]);
  const sky = useMemo(() => (best ? passSky(best) : []), [best]);
  const satWhy = gpRes && !gpRes.ok ? unavailable("Satellite elements", gpRes) : plan ? "No SAR pass over the AOI in the next 9 h" : "Propagating satellites\u2026";
  const win0 = plan?.win0 ?? now - Math.trunc(2.7 * 3600);
  const pct = (t: number): string => `${(100 * along(t, win0, WIN)).toFixed(2)}%`;
  // label anchor: the satellite on the globe, the AOI on the ring
  let label: { x: number; y: number; dot: boolean } | null = null;
  if (best) {
    const b = orthoBasis(...centreOf(v));
    const [ax, ay] = proj(llaEcef(...AOI), b, v.R, v.cx, v.cy);
    const S = satEcef(best.tle, [best.t0])[0];
    const [sx, sy] = S ? proj(S, b, v.R, v.cx, v.cy) : [NaN, NaN];
    const [lx, ly] = state === "globe" ? [sx + 6, sy - 8] : [ax - 90, ay - 24];
    if (Number.isFinite(lx) && Number.isFinite(ly)) label = { x: lx, y: ly, dot: state === "globe" && Number.isFinite(sx) };
    if (label && label.dot) label = { ...label, x: sx, y: sy };
  }
  // sunlight bar: real solar elevation at the AOI, sampled every 5 min
  const sun: [number, number][] = [];
  let run: number | null = null;
  for (let t = win0; t <= win0 + WIN + 300; t += 300) {
    const up = t <= win0 + WIN && solarElev(t, ...AOI) > 0;
    if (up && run === null) run = t;
    if (!up && run !== null) {
      if (t - 300 > run) sun.push([run, t - 300]);
      run = null;
    }
  }
  return (
    <div className="eux">
      <EuBar go={go} here={state} crumb="Simulation">
        <span className="eux-seg" role="group" aria-label="View">
          <button type="button" className="eu-btn" aria-label="Globe" title="Globe" aria-pressed={state === "globe"} onClick={() => go("globe")}>
            <BpIcon name="globe-network" size={14} />
            Globe
          </button>
          <button type="button" className="eu-btn" aria-label="AOI ring" title="AOI ring" aria-pressed={state === "ring"} onClick={() => go("ring")}>
            <BpIcon name="ring" size={14} />
            AOI ring
          </button>
        </span>
        {state === "ring" && (
          <button type="button" className="eu-btn" aria-label="Zoom out to the globe" title="Zoom out to the globe" onClick={() => go("globe")}>
            <BpIcon name="zoom-out" size={14} />
            Zoom out
          </button>
        )}
      </EuBar>
      <div className="eux-main">
        <aside className="eux-side eux-left" aria-label="Simulation parameters" style={{ flexBasis: "clamp(240px, 17vw, 340px)" }}>
          <div className="eux-h">
            <BpIcon name="settings" size={14} />
            Simulation Parameters
          </div>
          <h3 className="eux-sub">Satellite Criteria</h3>
          <div className="eux-card">
            <p>{plan && gpTotal !== null ? `Currently working with ${plan.sarCount} of ${gpTotal.toLocaleString("en-US")}` : satWhy}</p>
            <p>
              satellites where <b>Constellation</b> is SAR
            </p>
          </div>
          <h3 className="eux-sub">Required Parameters</h3>
          <div className="eux-card">
            <small>Area of Interest</small>
            <p>Strait of Hormuz</p>
            <small>Mission Time Window</small>
            <p>{`From ${UTC(win0, "%d %b %Y %H:%MZ")} for 6 hours`}</p>
          </div>
          <h3 className="eux-sub">Exploration Type</h3>
          <div className="eux-seg">
            <button type="button" className="eu-btn" aria-pressed="true" aria-label="Monitoring" title="Monitoring">
              Monitoring
            </button>
            <button type="button" className="eu-btn" aria-label="Mission Planning" title="Mission planning is not available" disabled>
              Mission Planning
            </button>
          </div>
          <p className="eu-dim">
            A monitoring exploration lists every pass of the selected satellites over the area of interest for the entire window selected above, with elevation, azimuth and sunlight at the area for each pass.
          </p>
          <span className="eu-gap" />
          <button type="button" className="eu-btn" aria-label="Simulate" title="Simulate" onClick={rerun}>
            <BpIcon name="play" size={14} />
            Simulate
          </button>
          <button type="button" className="eu-btn" aria-label="View results" title="View results" onClick={() => go(state === "globe" ? "ring" : "globe")}>
            <BpIcon name="arrow-right" size={14} />
            View results
          </button>
        </aside>
        <div className="eux-col">
          <div className="eux-globe">
            <div className="eux-gbox">
              <GlobeView state={state} plan={plan} now={now} marks={marks} />
              {best && label && (
                <>
                  {label.dot && <span className="eux-dot" style={{ left: `${(100 * label.x) / VW}%`, top: `${(100 * label.y) / VH}%` }} />}
                  <span className="eux-glab" style={{ left: `${(100 * (label.dot ? label.x + 8 : label.x)) / VW}%`, top: `${(100 * (label.dot ? label.y + 4 : label.y)) / VH}%` }}>
                    {best.name}
                  </span>
                </>
              )}
              {!best && <span className="eux-gmsg">{satWhy}</span>}
            </div>
          </div>
          <div className="eux-tl" aria-label="Mission timeline">
            <span className="eux-tl-lab">
              <BpIcon name="satellite" size={12} />
              SAR
            </span>
            <div className="eux-tl-row">
              {(plan?.passes ?? [])
                .filter((q) => q.peak >= 35)
                .map((p) => (
                  <i key={`${p.norad}.${p.t0}`} title={`${p.name} ${UTC(p.t0, "%H:%MZ")}`} style={{ left: pct(p.t0), width: 4, background: p.name.includes("CAPELLA") ? "#8fc43c" : "#4fa86a" }} />
                ))}
              {best && <i title={`Selected pass ${UTC(best.t0, "%H:%MZ")}`} style={{ left: pct(best.t0), width: 2, background: "#f2f6fa" }} />}
            </div>
            <span className="eux-tl-lab">
              <BpIcon name="flash" size={12} />
              Sunlight
            </span>
            <div className="eux-tl-row">
              {sun.map(([a, z]) => (
                <i key={a} style={{ left: pct(a), width: `${(100 * (z - a)) / WIN}%`, background: "#e0b82c" }} />
              ))}
            </div>
            <span />
            <div className="eux-tl-hours">
              {Array.from({ length: 7 }, (_, h) => (
                <span key={h} style={{ left: `${(100 * h) / 6}%` }}>
                  {UTC(win0 + h * 3600, "%H:%M")}
                </span>
              ))}
            </div>
          </div>
        </div>
        <aside className="eux-side eux-right" aria-label="Sweep and satellite">
          <div className="eux-h">
            <BpIcon name="geosearch" size={14} />
            Strait of Hormuz
          </div>
          <h3 className="eux-sub">SAR Sweeps</h3>
          {sweep ? (
            <div className="eux-card">
              <div className="eux-kv">
                <span>Latest capture</span>
                <span>{UTC(sweep.swept_at, "%-d %b %Y %H:%M")}</span>
              </div>
              <div className="eux-kv">
                <span>Detections</span>
                <span>{sweep.detections}</span>
              </div>
              <div className="eux-kv">
                <span>Dark</span>
                <span>{sweep.dark_candidates}</span>
              </div>
              <small>
                {sweep.dark_candidates === 0
                  ? "No dark-vessel candidates found for this AOI."
                  : `${sweep.dark_candidates} detections have no AIS match.`}
              </small>
            </div>
          ) : (
            <p className="eu-note">{sweepRes?.ok ? "No sweep of this AOI yet" : unavailable("SAR sweep", sweepRes)}</p>
          )}
          <h3 className="eux-sub">Selected pass</h3>
          {best ? (
            <div className="eux-card">
              <h3>{best.name}</h3>
              <small>{`${best.norad || NONE} \u00b7 ${operatorOf(best.name)}`}</small>
              <PolarPlot sky={sky} />
              <div className="eux-kv">
                <span>Start</span>
                <span>{UTC(best.t0, "%b %d %Y %H:%M:%SZ")}</span>
              </div>
              <div className="eux-kv">
                <span>End</span>
                <span>{UTC(best.t1, "%b %d %Y %H:%M:%SZ")}</span>
              </div>
            </div>
          ) : (
            <p className="eu-note">{satWhy}</p>
          )}
        </aside>
      </div>
    </div>
  );
}
