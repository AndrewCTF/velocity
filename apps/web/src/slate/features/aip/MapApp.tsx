// Map app: features A54-A59 as a native layout over the scene-hormuz plate (the
// same scene fit as the light map in data.ts). The plate fills its pane and is
// redrawn at the pane's own pixel size (MapView). Live layers: the Hormuz box,
// GPS-jamming cells (/api/jamming/nacp), AIS positions (/api/maritime/vessels),
// SAR candidates (/api/intel/dark-vessels/sar), registry matches
// (/api/sanctions/vessels), recorded vessel tracks (/api/history/tracks) for
// the 2-sigma ellipses, a Sentinel-2 chip (/api/imagery/chip) and the
// nominate_target action.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "../../../transport/http.js";
import { Ico, type FoundryNav } from "./pg.js";
import { DkPage, cnt } from "./dk.js";
import {
  inHormuz,
  sancRows,
  sarRows,
  sarTitle,
  scenePx,
  unavailable,
  useJson,
  type FC,
  type Sanc,
  type SancP,
  type Sar,
  type SarFC,
} from "./data.js";
import { age, ell, km, mgrs, type WItem } from "./dataB.js";
import sceneHormuz from "./sceneHormuz.jpg";

const SCENE_W = 1882;
const SCENE_H = 1242;
const KM_PX = (111.32 * Math.cos((25.8 * Math.PI) / 180)) / 579.0603917238906;
const HZ_BOX: [number, number][] = [
  [53.5, 24.2],
  [58.8, 24.2],
  [58.8, 27.8],
  [53.5, 27.8],
];
const MIN_FIXES = 20;
// scene px shown at the pane centre, and the scene region each view must cover
const OVERVIEW = { cx: 700, cy: 760, rw: 1494, rh: 816 };
const LAYER_REGION: [number, number] = [364, 231];
const ENTITY_REGION: [number, number] = [420, 267];

/** Screen px per scene px so a rw x rh scene region covers a w x h pane. */
export const coverK = (w: number, h: number, rw: number, rh: number): number =>
  Math.max(w / rw, h / rh);

/** scene px (cx, cy) shown at pane centre at k screen px per scene px (the builder's MapView), pane origin 0,0 */
export class MapView {
  constructor(
    public w: number,
    public h: number,
    public cx: number,
    public cy: number,
    public k: number,
  ) {}
  px(px: number, py: number): [number, number] {
    return [
      this.w / 2 + (px - this.cx) * this.k,
      this.h / 2 + (py - this.cy) * this.k,
    ];
  }
  ll(lon: number, lat: number): [number, number] {
    const [a, b] = scenePx(lon, lat);
    return this.px(a, b);
  }
  inside(a: number, b: number, m = 0): boolean {
    return m < a && a < this.w - m && m < b && b < this.h - m;
  }
  kmPx(d: number): number {
    return (d / KM_PX) * this.k;
  }
  image(): JSX.Element {
    const [x, y] = this.px(0, 0);
    return (
      <image
        href={sceneHormuz}
        x={x}
        y={y}
        width={SCENE_W * this.k}
        height={SCENE_H * this.k}
        preserveAspectRatio="none"
      />
    );
  }
}

interface Track {
  id: string;
  pts: [number, number, number][]; // lon, lat, t
  e: [number, number, number, number, number];
}
interface Live {
  sanc: Sanc[];
  hz: Sanc[];
  sar: Sar[];
  sarDate: string | null;
  vessels: [number, number][];
  jam: { ring: number[][]; pct: number }[];
  choke: number[] | null;
  tracks: Track[];
  tracksErr: string | null;
  ready: Record<LayerKey | "trk", boolean>;
}

const poly = (pts: [number, number][]): string =>
  pts.map(([a, b]) => `${a.toFixed(0)},${b.toFixed(0)}`).join(" ");
const halo = {
  paintOrder: "stroke",
  stroke: "#000",
  strokeWidth: 3,
  strokeLinejoin: "round",
} as const;

/** Pane size in px, kept current as the pane reflows. */
function useSize(): [
  React.RefObject<HTMLDivElement | null>,
  { w: number; h: number },
] {
  const ref = useRef<HTMLDivElement>(null);
  const [sz, setSz] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = (): void =>
      setSz({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, sz];
}

const LAYERS = [
  ["box", "Hormuz watch box"],
  ["jam", "GPS jamming cells"],
  ["ais", "Live feed: AIS vessels"],
  ["sar", "SAR dark candidates"],
  ["reg", "Registry matches"],
  ["line", "Largest SAR hull to Hormuz chokepoint"],
] as const;
type LayerKey = (typeof LAYERS)[number][0];

function Hit({
  x,
  y,
  r,
  label,
  onClick,
}: {
  x: number;
  y: number;
  r: number;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="mp-hit"
      aria-label={label}
      title={label}
      style={{ left: x - r, top: y - r, width: 2 * r, height: 2 * r }}
      onClick={onClick}
    />
  );
}

// ── A55 canvas ───────────────────────────────────────────────────────────────
function Canvas({
  d,
  v,
  show,
  onSar,
  onCount,
}: {
  d: Live;
  v: MapView;
  show: Set<LayerKey>;
  onSar: (s: Sar) => void;
  onCount: (n: number) => void;
}): JSX.Element {
  const els: ReactNode[] = [];
  const hits: ReactNode[] = []; // drawn last: the overlays above a marker must not swallow its click
  let n = 0;
  if (show.has("box")) {
    els.push(
      <polygon
        key="box"
        points={poly(HZ_BOX.map(([a, b]) => v.ll(a, b)))}
        fill="rgba(70,120,210,.22)"
        stroke="#8ab4f8"
        strokeWidth={1.5}
      />,
    );
    n++;
  }
  if (show.has("jam")) {
    let any = false;
    d.jam.forEach((j, i) => {
      const q = j.ring.map((c) => v.ll(c[0]!, c[1]!));
      if (!q.some(([a, b]) => v.inside(a, b))) return;
      any = true;
      els.push(
        <polygon
          key={`j${i}`}
          points={poly(q)}
          fill="rgba(220,70,80,.30)"
          stroke="#ff7b86"
          strokeWidth={1.6}
        />,
      );
      const cx = q.reduce((a, p) => a + p[0], 0) / q.length;
      const cy = q.reduce((a, p) => a + p[1], 0) / q.length;
      if (v.inside(cx, cy, 30))
        els.push(
          <text
            key={`jt${i}`}
            x={cx}
            y={cy}
            fontSize={12}
            fill="#fff"
            textAnchor="middle"
            style={halo}
          >
            GPS jamming {Math.round(j.pct)}% bad
          </text>,
        );
    });
    if (any) n++;
  }
  if (show.has("ais")) {
    const dots = d.vessels
      .map(([lon, lat]) => v.ll(lon, lat))
      .filter(([a, b]) => v.inside(a, b, 4));
    if (dots.length) {
      n++;
      dots.forEach(([a, b], i) =>
        els.push(
          <circle
            key={`v${i}`}
            cx={a}
            cy={b}
            r={2.4}
            fill="#e8f040"
            fillOpacity={0.85}
          />,
        ),
      );
    }
  }
  if (show.has("sar")) {
    let any = false;
    for (const sr of d.sar) {
      const [a, b] = v.ll(...sr.xy);
      if (!v.inside(a, b, 10)) continue;
      any = true;
      els.push(
        <rect
          key={`s${sr.id}`}
          x={a - 8}
          y={b - 8}
          width={16}
          height={16}
          fill="rgba(255,170,60,.15)"
          stroke="#ffb347"
          strokeWidth={2}
        />,
        <text
          key={`st${sr.id}`}
          x={a}
          y={b + 24}
          fontSize={11}
          fill="#fff"
          textAnchor="middle"
          style={halo}
        >
          {sarTitle(sr)}
        </text>,
      );
      hits.push(
        <Hit
          key={`sh${sr.id}`}
          x={a}
          y={b}
          r={12}
          label={`Open the Sentinel-2 chip at ${sarTitle(sr)}`}
          onClick={() => onSar(sr)}
        />,
      );
    }
    if (any) n++;
  }
  if (show.has("reg")) {
    let any = false;
    for (const sc of d.hz) {
      const [a, b] = v.ll(...sc.xy);
      if (!v.inside(a, b, 10)) continue;
      any = true;
      els.push(
        <polygon
          key={`r${sc.mmsi}`}
          points={`${a},${b - 10} ${a + 10},${b} ${a},${b + 10} ${a - 10},${b}`}
          fill="#f0707a"
          fillOpacity={0.92}
          stroke="#3a1a1e"
          strokeWidth={1.3}
        />,
        <text
          key={`rt${sc.mmsi}`}
          x={a}
          y={b + 24}
          fontSize={11}
          fill="#fff"
          textAnchor="middle"
          style={halo}
        >{`Track ${String(sc.mmsi).slice(-4)} ${sc.cls}`}</text>,
      );
    }
    if (any) n++;
  }
  const longest = [...d.sar].sort((p, q) => q.lengthM - p.lengthM)[0];
  if (show.has("line") && longest && d.choke) {
    const a = longest.xy;
    const b = d.choke.slice(0, 2);
    const [xa, ya] = v.ll(a[0], a[1]);
    const [xb, yb] = v.ll(b[0]!, b[1]!);
    const dkm = km(a, b);
    els.push(
      <line
        key="ln"
        x1={xa}
        y1={ya}
        x2={xb}
        y2={yb}
        stroke="#000"
        strokeWidth={2}
      />,
    );
    for (let i = 1; i <= Math.floor(dkm / 5); i++) {
      const f = (i * 5) / dkm;
      const tx = xa + (xb - xa) * f;
      const ty = ya + (yb - ya) * f;
      els.push(
        <circle key={`tc${i}`} cx={tx} cy={ty} r={2.6} fill="#f0e020" />,
        <text
          key={`tt${i}`}
          x={tx + 4}
          y={ty - 4}
          fontSize={11}
          fill="#f0e020"
          style={halo}
        >
          {i * 5}
        </text>,
      );
    }
    els.push(
      <circle key="la" cx={xa} cy={ya} r={3} fill="#000" />,
      <circle key="lb" cx={xb} cy={yb} r={3} fill="#000" />,
      <text
        key="ld"
        x={(xa + xb) / 2 + 6}
        y={(ya + yb) / 2 + 14}
        fontSize={12}
        fill="#f0e020"
        style={halo}
      >
        {dkm.toFixed(2)} km
      </text>,
      <circle
        key="lc"
        cx={xb}
        cy={yb}
        r={15}
        fill="rgba(76,127,212,.10)"
        stroke="#8ab4f8"
        strokeWidth={2}
      />,
    );
    n++;
  }
  useEffect(() => onCount(n), [n, onCount]);
  return (
    <>
      <svg
        className="mp-svg"
        width={v.w}
        height={v.h}
        aria-label="Map plate"
        role="img"
      >
        <rect width={v.w} height={v.h} fill="#0c1a26" />
        {v.image()}
        {els}
      </svg>
      {hits}
    </>
  );
}

// ── A56 layer selection ──────────────────────────────────────────────────────
function pickView(
  tracks: Track[],
  w: number,
  h: number,
  k: number,
): [number, number] {
  let best: [number, number, number] | null = null;
  for (let gx = 200; gx < 1500; gx += 25)
    for (let gy = 350; gy < 1150; gy += 25) {
      const v = new MapView(w, h, gx, gy, k);
      let c = 0;
      for (const t of tracks) {
        const [a, b] = v.ll(t.e[0], t.e[1]);
        if (v.inside(a, b, 60)) c++;
      }
      if (!best || c > best[0]) best = [c, gx, gy];
    }
  return [best![1], best![2]];
}
const ellipse = (
  key: string,
  v: MapView,
  e: Track["e"],
  fill: string,
  sw: number,
): JSX.Element => {
  const [a, b] = v.ll(e[0], e[1]);
  return (
    <ellipse
      key={key}
      cx={a}
      cy={b}
      rx={v.kmPx(e[2])}
      ry={v.kmPx(e[3])}
      transform={`rotate(${-e[4]} ${a} ${b})`}
      fill={fill}
      stroke="#d8ea3c"
      strokeWidth={sw}
      strokeOpacity={0.9}
    />
  );
};
const fmtShort = (t: number): string => {
  const d = new Date(t * 1000);
  const m = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getUTCMonth()];
  return `${m} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
};

function LayerPlate({
  d,
  w,
  h,
  onEntity,
}: {
  d: Live;
  w: number;
  h: number;
  onEntity: (t: Track) => void;
}): JSX.Element {
  // no recorded track to frame: show the overview region rather than a blown-up crop
  const k = d.tracks.length
    ? coverK(w, h, ...LAYER_REGION)
    : coverK(w, h, OVERVIEW.rw, OVERVIEW.rh);
  const [cx, cy] = d.tracks.length
    ? pickView(d.tracks, w, h, k)
    : [OVERVIEW.cx, OVERVIEW.cy];
  const v = new MapView(w, h, cx, cy, k);
  const els: ReactNode[] = [];
  const hits: ReactNode[] = [];
  for (const t of d.tracks) {
    const [a, b] = v.ll(t.e[0], t.e[1]);
    if (!v.inside(a, b, -150)) continue;
    els.push(ellipse(`e${t.id}`, v, t.e, "none", 1.5));
    t.pts
      .filter((_, i) => i % 3 === 0)
      .forEach((p, i) => {
        const [x, y] = v.ll(p[0], p[1]);
        els.push(
          <circle
            key={`${t.id}${i}`}
            cx={x}
            cy={y}
            r={2.6}
            fill="#d8ea3c"
            fillOpacity={0.55}
          />,
        );
      });
    if (v.inside(a, b))
      hits.push(
        <Hit
          key={`h${t.id}`}
          x={a}
          y={b}
          r={12}
          label={`Select track ${t.id.slice(-4)}`}
          onClick={() => onEntity(t)}
        />,
      );
  }
  return (
    <>
      <svg
        className="mp-svg"
        width={w}
        height={h}
        aria-label="Map plate"
        role="img"
      >
        <rect width={w} height={h} fill="#0c1a26" />
        {v.image()}
        {els}
      </svg>
      {hits}
    </>
  );
}
function EntityPlate({
  t,
  w,
  h,
}: {
  t: Track;
  w: number;
  h: number;
}): JSX.Element {
  const last = t.pts[t.pts.length - 1]!;
  const [px, py] = scenePx(t.e[0], t.e[1]);
  const v = new MapView(w, h, px, py, coverK(w, h, ...ENTITY_REGION));
  const [la, lb] = v.ll(last[0], last[1]);
  const tid = t.id.replace("vessel:", "").slice(-4);
  return (
    <svg
      className="mp-svg"
      width={w}
      height={h}
      aria-label="Map plate"
      role="img"
    >
      <rect width={w} height={h} fill="#0c1a26" />
      {v.image()}
      {ellipse("el", v, t.e, "rgba(216,234,60,.10)", 1.6)}
      {t.pts.map((p, i) => {
        const [x, y] = v.ll(p[0], p[1]);
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={3.4}
            fill="#e8f45a"
            fillOpacity={0.8}
          />
        );
      })}
      <rect
        x={la - 11}
        y={lb - 11}
        width={22}
        height={22}
        rx={3}
        fill="#3f73d6"
        stroke="#fff"
        strokeWidth={2}
      />
      <text
        x={la}
        y={lb + 28}
        fontSize={12}
        fill="#fff"
        textAnchor="middle"
        style={halo}
      >{`Track ${tid}`}</text>
    </svg>
  );
}

function Side({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <aside className="mp-side" aria-label="Selection">
      <div className="mp-shead">
        <div className="pg-fill">
          <b>{title}</b>
          <div className="pg-sm pg-mut">{sub}</div>
        </div>
        <button
          type="button"
          className="pg-btn sq"
          aria-label="Close the selection"
          onClick={onClose}
        >
          <Ico n="cross" />
        </button>
      </div>
      <div className="pg-pad pg-col" style={{ gap: 16 }}>
        {children}
      </div>
    </aside>
  );
}
function LayerPanel({
  d,
  onClose,
}: {
  d: Live;
  onClose: () => void;
}): JSX.Element {
  const t0 = d.tracks.length
    ? Math.min(...d.tracks.map((t) => t.pts[0]![2]))
    : null;
  const t1 = d.tracks.length
    ? Math.max(...d.tracks.map((t) => t.pts[t.pts.length - 1]![2]))
    : null;
  const clauses: [string, string][] = [
    ["Observation Type", "is AIS position"],
    ["Entity Location", "intersects a polygon with 4 vertices"],
    [
      "Observation Currency",
      t0 !== null && t1 !== null
        ? `is within ${((t1 - t0) / 3600).toFixed(1)} hours`
        : "is within the archive window",
    ],
    ["Track fixes", `is at least ${MIN_FIXES}`],
  ];
  return (
    <Side
      title="Live feed: AIS recorder tracks"
      sub={`Flattened live layer · ${d.tracks.length} objects`}
      onClose={onClose}
    >
      <dl className="pg-kv">
        <dt>Recorded</dt>
        <dd>{t0 === null ? "—" : fmtShort(t0)}</dd>
        <dt>Source</dt>
        <dd>/api/history/tracks</dd>
        <dt>Last poll</dt>
        <dd>{t1 === null ? "—" : `${age(Date.now() / 1000 - t1)} ago`}</dd>
        <dt>Backing dataset</dt>
        <dd>History archive</dd>
      </dl>
      <div>
        <b className="pg-sm pg-mut">Search query</b>
        <ul className="mp-q">
          {clauses.map(([a, b]) => (
            <li key={a}>
              <b>{a}</b> <span className="pg-mut">{b}</span>
            </li>
          ))}
        </ul>
      </div>
    </Side>
  );
}
function EntityPanel({
  t,
  onClose,
}: {
  t: Track;
  onClose: () => void;
}): JSX.Element {
  const last = t.pts[t.pts.length - 1]!;
  const now = Date.now() / 1000;
  const tid = t.id.replace("vessel:", "").slice(-4);
  const [px, py] = scenePx(t.e[0], t.e[1]);
  const [lx, ly] = scenePx(last[0], last[1]);
  const ts = new Date(last[2] * 1000);
  return (
    <Side
      title={`Track ${tid}`}
      sub={`Live entity · latest location in ${age(now - last[2])}`}
      onClose={onClose}
    >
      <dl className="pg-kv">
        <dt>Last updated</dt>
        <dd>{age(now - last[2])} ago</dd>
        <dt>Data source</dt>
        <dd>AIS history archive</dd>
        <dt>Layer</dt>
        <dd>AIS recorder tracks</dd>
        <dt>Timestamp</dt>
        <dd>
          {ts
            .toLocaleString("en-US", {
              timeZone: "UTC",
              month: "long",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            })
            .replace(" at ", " ")}{" "}
          UTC
        </dd>
      </dl>
      <div>
        <b className="pg-sm pg-mut">Imagery preview</b>
        <svg
          className="mp-thumb"
          viewBox={`${px - 16.5} ${py - 9.5} 33 19`}
          preserveAspectRatio="xMidYMid slice"
          role="img"
          aria-label="Imagery preview"
        >
          <rect x={px - 40} y={py - 40} width={80} height={80} fill="#0c1a26" />
          <image
            href={sceneHormuz}
            x={0}
            y={0}
            width={SCENE_W}
            height={SCENE_H}
            preserveAspectRatio="none"
          />
          <circle
            cx={lx}
            cy={ly}
            r={0.9}
            fill="rgba(63,115,214,.5)"
            stroke="#fff"
            strokeWidth={0.25}
          />
        </svg>
      </div>
      <p className="pg-mut pg-sm" style={{ margin: 0 }}>
        Maritime movement projection: no sog or course in the archive.
      </p>
    </Side>
  );
}

// ── A58 image viewer ─────────────────────────────────────────────────────────
/** chip_view(): crop the centre 600 m of the 1.6 km chip to 1266x647 and stretch (99.5th percentile, gamma .6) */
function useChip(sar: Sar | null): { url: string | null; err: string | null } {
  const [st, setSt] = useState<{ url: string | null; err: string | null }>({
    url: null,
    err: null,
  });
  useEffect(() => {
    if (!sar) return;
    let live = true;
    let made: string | null = null;
    setSt({ url: null, err: null });
    void (async () => {
      try {
        const r = await apiFetch(
          `/api/imagery/chip?lat=${sar.xy[1]}&lon=${sar.xy[0]}&radius_km=0.8`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bmp = await createImageBitmap(await r.blob());
        const cw = Math.trunc((bmp.width * 0.6) / 1.6);
        const ch = Math.trunc((cw * 647) / 1266);
        const cv = document.createElement("canvas");
        cv.width = 1266;
        cv.height = 647;
        const g = cv.getContext("2d")!;
        g.drawImage(
          bmp,
          Math.trunc(bmp.width / 2 - cw / 2),
          Math.trunc(bmp.height / 2 - ch / 2),
          cw,
          ch,
          0,
          0,
          1266,
          647,
        );
        const im = g.getImageData(0, 0, 1266, 647);
        const vals: number[] = [];
        for (let i = 0; i < im.data.length; i += 4)
          vals.push(im.data[i]!, im.data[i + 1]!, im.data[i + 2]!);
        vals.sort((a, b) => a - b);
        const p = Math.max(
          vals[Math.floor(0.995 * (vals.length - 1))] ?? 255,
          1,
        );
        for (let i = 0; i < im.data.length; i++)
          if (i % 4 !== 3)
            im.data[i] = Math.min(1, im.data[i]! / p) ** 0.6 * 255;
        g.putImageData(im, 0, 0);
        const blob = await new Promise<Blob | null>((res) =>
          cv.toBlob(res, "image/jpeg", 0.88),
        );
        if (!blob) throw new Error("encode");
        made = URL.createObjectURL(blob);
        if (live) setSt({ url: made, err: null });
      } catch (e) {
        if (live)
          setSt({
            url: null,
            err: `Sentinel-2 chip unavailable (${e instanceof Error && e.message.startsWith("HTTP") ? e.message : "decode failed"})`,
          });
      }
    })();
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [sar]);
  return st;
}
function Viewer({
  sar,
  date,
  chip,
  onClose,
  onNominate,
}: {
  sar: Sar;
  date: string | null;
  chip: { url: string | null; err: string | null };
  onClose: () => void;
  onNominate: () => void;
}): JSX.Element {
  const dd = date ? new Date(date + "T00:00:00Z") : null;
  const dlab = dd
    ? dd
        .toUTCString()
        .slice(5, 16)
        .replace(/^(\d+) (\w+) (\d+)$/, "$2 $1 $3")
        .toUpperCase()
    : "—";
  const lw = (sar.lengthM / 600) * 1266;
  const wd = (sar.widthM / 600) * 1266;
  return (
    <div className="mp-viewer">
      <div className="mp-vbar">
        <b>{dlab} Sentinel-2</b>
        <span className="pg-fill" />
        <button
          type="button"
          className="pg-btn"
          aria-label="Close the image viewer"
          onClick={onClose}
        >
          <Ico n="cross" /> Close
        </button>
      </div>
      <div className="mp-vimg">
        <svg
          viewBox="0 0 1266 647"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Sentinel-2 chip"
        >
          <rect width={1266} height={647} fill="#0c1a26" />
          {chip.url && (
            <image
              href={chip.url}
              width={1266}
              height={647}
              preserveAspectRatio="none"
            />
          )}
          <rect
            x={633 - lw / 2}
            y={323.5 - wd / 2}
            width={lw}
            height={wd}
            fill="none"
            stroke="#f0a040"
            strokeWidth={3}
            transform={`rotate(${sar.headingDeg - 90} 633 323.5)`}
          />
          <text
            x={633}
            y={323.5 + 56}
            fontSize={18}
            fill="#e8d0a0"
            textAnchor="middle"
            style={halo}
          >
            Vessel candidate
          </text>
          <rect
            x={1266 - 40 - 211}
            y={647 - 30}
            width={211}
            height={6}
            fill="#e6ecf4"
          />
          <text
            x={1266 - 40 - 211}
            y={647 - 38}
            fontSize={16}
            fill="#fff"
            style={halo}
          >
            100 m
          </text>
          {!chip.url && (
            <text
              x={633}
              y={330}
              fontSize={22}
              fill="#c6ccd2"
              textAnchor="middle"
            >
              {chip.err ?? "loading Sentinel-2 chip…"}
            </text>
          )}
        </svg>
      </div>
      <div className="mp-vinfo">
        <div className="pg-card pg-pad pg-col" style={{ gap: 8 }}>
          <b>Vessel candidate · Detection</b>
          <span className="pg-sm pg-mut">Source Sentinel-1 SAR</span>
          <span className="pg-sm">
            Candidate, {sar.classification.confidence} confidence
          </span>
          <button
            type="button"
            className="pg-btn pri"
            aria-label="Actions: nominate this detection"
            onClick={onNominate}
          >
            Nominate this detection
          </button>
          <button
            type="button"
            className="pg-btn"
            aria-label="Close the detection"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <dl className="pg-kv pg-card pg-pad">
          <dt>Position</dt>
          <dd>
            {sar.xy[1].toFixed(6)}°, {sar.xy[0].toFixed(6)}°
          </dd>
          <dt>MGRS</dt>
          <dd>{mgrs(sar.xy[1], sar.xy[0])}</dd>
          <dt>Size</dt>
          <dd>
            {(sar.lengthM / 1000).toFixed(2)} km x{" "}
            {(sar.widthM / 1000).toFixed(2)} km
          </dd>
        </dl>
      </div>
    </div>
  );
}

// ── A59 nominate ─────────────────────────────────────────────────────────────
type Phase = { state: "busy" | "ok" | "error"; msg: string } | null;
function Nominate({
  it,
  tid,
  ll,
  phase,
  onCancel,
  onGo,
}: {
  it: WItem;
  tid: string;
  ll: [number, number];
  phase: Phase;
  onCancel: () => void;
  onGo: (() => void) | undefined;
}): JSX.Element {
  const rows: [string, string][] = [
    ["Board", "Target board"],
    ["Column", "Confirm"],
    ["Target", tid],
    ["Name", it.title],
    ["Priority", "3"],
    ["Kind", "vessel"],
    ["Location", `${ll[1].toFixed(5)}, ${ll[0].toFixed(5)}`],
  ];
  return (
    <div
      className="dk-over"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        className="dk-dlg"
        role="dialog"
        aria-modal="true"
        aria-label="Nominate"
      >
        <h3>
          Nominate
          <span className="pg-fill" />
          <button
            type="button"
            className="pg-btn sq flat"
            aria-label="Close"
            onClick={onCancel}
          >
            <Ico n="cross" />
          </button>
        </h3>
        <dl className="pg-kv dk-pad">
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="pg-row dk-pad">
          {phase && (
            <span
              role="status"
              className={phase.state === "error" ? "tt-bad" : "pg-mut"}
            >
              {phase.state === "busy"
                ? "nominate_target: running"
                : phase.state === "ok"
                  ? "Nominated"
                  : `nominate_target failed (${phase.msg})`}
            </span>
          )}
          <span className="pg-fill" />
          <button
            type="button"
            className="pg-btn"
            aria-label="Cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pg-btn pri"
            aria-label="Nominate: run nominate_target"
            disabled={!onGo}
            title={onGo ? undefined : "nominate_target is not available"}
            onClick={onGo}
          >
            Nominate
          </button>
        </div>
      </div>
    </div>
  );
}

function useLive(): Live {
  const sanc = useJson<FC<SancP>>("/api/sanctions/vessels");
  const sar = useJson<SarFC>("/api/intel/dark-vessels/sar?aoi=hormuz");
  const ves = useJson<{ vessels: { lon: number; lat: number }[] }>(
    "/api/maritime/vessels?bbox=52,22.5,60.5,29.5",
  );
  const jam = useJson<{
    features: {
      geometry: { type: string; coordinates: number[][][] | number[][][][] };
      properties: { percent_bad?: number };
    }[];
  }>("/api/jamming/nacp");
  const choke = useJson<{
    features: {
      geometry: { coordinates: number[] };
      properties: { name: string };
    }[];
  }>("/api/maritime/chokepoints");
  const [from] = useState(() => Math.floor(Date.now() / 1000) - 7 * 86400);
  const hist = useJson<{ tracks: { id: string; points: number[][] }[] }>(
    `/api/history/tracks?kind=vessel&min_lon=52&min_lat=22.5&max_lon=60.5&max_lat=29.5&from_ts=${from}&limit_ids=2000`,
  );
  const sRows = sancRows(sanc?.data ?? null);
  const tracks: Track[] = (hist?.data?.tracks ?? [])
    .map((t) => ({
      id: t.id,
      pts: t.points
        .map((p) => [p[1]!, p[0]!, p[2]!] as [number, number, number])
        .sort((a, b) => a[2] - b[2]),
    }))
    .filter((t) => t.pts.length >= MIN_FIXES)
    .map((t) => ({ ...t, e: ell(t.pts.map((p) => [p[0], p[1]])) }));
  return {
    sanc: sRows,
    hz: sRows.filter((s) => inHormuz(s.xy)),
    sar: sarRows(sar?.data ?? null),
    sarDate: sar?.data?.summary.date ?? null,
    vessels: (ves?.data?.vessels ?? []).map((v) => [v.lon, v.lat]),
    jam: (jam?.data?.features ?? [])
      .filter((f) => (f.properties.percent_bad ?? 0) >= 10)
      .map((f) => ({
        ring:
          f.geometry.type === "Polygon"
            ? (f.geometry.coordinates as number[][][])[0]!
            : (f.geometry.coordinates as number[][][][])[0]![0]!,
        pct: f.properties.percent_bad ?? 0,
      })),
    choke:
      choke?.data?.features.find(
        (f) => f.properties.name === "Strait of Hormuz",
      )?.geometry.coordinates ?? null,
    tracks,
    tracksErr: !hist
      ? "loading recorded tracks…"
      : !hist.ok
        ? unavailable("Recorded tracks", hist)
        : tracks.length
          ? null
          : `No vessel track with ${MIN_FIXES}+ fixes in the archive for this box (GET /api/history/tracks)`,
    ready: {
      box: true,
      jam: jam !== null,
      ais: ves !== null,
      sar: sar !== null,
      reg: sanc !== null,
      line: sar !== null && choke !== null,
      trk: hist !== null,
    },
  };
}

type MapState =
  | { v: "canvas" }
  | { v: "layer" }
  | { v: "entity"; t: Track }
  | { v: "image"; sar: Sar }
  | { v: "nominate"; sar: Sar };
export function MapApp({
  nav,
  focus,
}: {
  nav: (v: FoundryNav) => void;
  focus?: WItem | null;
}): JSX.Element {
  const d = useLive();
  const [st, setSt] = useState<MapState>({ v: "canvas" });
  const [phase, setPhase] = useState<Phase>(null);
  const [hidden, setHidden] = useState<Set<LayerKey>>(new Set());
  const [nOver, setNOver] = useState(0);
  const guard = useJson<{ action_tools?: string[] }>("/api/ai/guardrails");
  const [ref, { w, h }] = useSize();
  const chipSar = st.v === "image" || st.v === "nominate" ? st.sar : null;
  const chip = useChip(chipSar);
  const show = new Set(LAYERS.map(([k]) => k).filter((k) => !hidden.has(k)));
  const counts: Record<LayerKey, number | null> = {
    box: 1,
    jam: d.ready.jam ? d.jam.length : null,
    ais: d.ready.ais ? d.vessels.length : null,
    sar: d.ready.sar ? d.sar.length : null,
    reg: d.ready.reg ? d.hz.length : null,
    line: d.ready.line ? (d.sar.length && d.choke ? 1 : 0) : null,
  };
  const close = (): void => setSt({ v: "canvas" });
  const viewer = st.v === "image" || st.v === "nominate";
  const tracksOn = st.v === "layer" || st.v === "entity";

  const nominate = (sar: Sar): JSX.Element => {
    const tools = guard?.data?.action_tools ?? [];
    const tid = sar.id;
    const it: WItem =
      focus && focus.ref === tid
        ? focus
        : {
            kind: "sar",
            id: "SR" + tid.split(":").pop()!.slice(-4).padStart(4, "0"),
            title: `SAR hull ${Math.round(sar.lengthM)} m, no AIS`,
            link: "",
            icon: "ship",
            shape: "c",
            color: "#14b8a6",
            t: 0,
            ll: sar.xy,
            ref: tid,
          };
    const go = async (): Promise<void> => {
      setPhase({ state: "busy", msg: "" });
      try {
        const r = await apiFetch("/api/actions/nominate_target", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_id: tid, priority: 3, note: it.title }),
        });
        setPhase(
          r.ok
            ? { state: "ok", msg: "" }
            : { state: "error", msg: `HTTP ${r.status}` },
        );
      } catch {
        setPhase({ state: "error", msg: "network error" });
      }
    };
    return (
      <Nominate
        it={it}
        tid={tid}
        ll={sar.xy}
        phase={phase}
        onCancel={() => setSt({ v: "image", sar })}
        onGo={
          tools.includes("nominate_target") && phase?.state !== "busy"
            ? () => void go()
            : undefined
        }
      />
    );
  };

  return (
    <DkPage here="map" nav={nav} cls="mp">
      <div className="mp-body">
        <aside className="mp-left" aria-label="Map layers">
          <h3>Map layers</h3>
          <ul>
            {LAYERS.map(([k, lab]) => (
              <li key={k}>
                <label>
                  <input
                    type="checkbox"
                    checked={!hidden.has(k)}
                    onChange={() =>
                      setHidden((s) => {
                        const n = new Set(s);
                        if (n.has(k)) n.delete(k);
                        else n.add(k);
                        return n;
                      })
                    }
                  />
                  <span className="pg-fill">{lab}</span>
                  <span className="pg-mut">{cnt(counts[k])}</span>
                </label>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="mp-lay"
                aria-pressed={tracksOn}
                aria-label="Select layer: Live feed - AIS recorder tracks"
                onClick={() =>
                  setSt(tracksOn ? { v: "canvas" } : { v: "layer" })
                }
              >
                <span className="pg-fill">AIS recorder tracks</span>
                <span className="pg-mut">
                  {d.ready.trk ? d.tracks.length : "—"}
                </span>
              </button>
            </li>
          </ul>
          <div className="mp-foot pg-sm pg-mut">
            Satellite basemap ·{" "}
            {tracksOn || viewer ? "1 view" : `${nOver} overlays`}
          </div>
        </aside>
        <div className="mp-stage" ref={ref}>
          {viewer ? (
            <Viewer
              sar={st.sar}
              date={d.sarDate}
              chip={chip}
              onClose={close}
              onNominate={() => {
                setPhase(null);
                setSt({ v: "nominate", sar: st.sar });
              }}
            />
          ) : (
            w > 0 &&
            h > 0 &&
            (st.v === "canvas" ? (
              <Canvas
                d={d}
                v={
                  new MapView(
                    w,
                    h,
                    OVERVIEW.cx,
                    OVERVIEW.cy,
                    coverK(w, h, OVERVIEW.rw, OVERVIEW.rh),
                  )
                }
                show={show}
                onSar={(sar) => setSt({ v: "image", sar })}
                onCount={setNOver}
              />
            ) : st.v === "layer" ? (
              <LayerPlate
                d={d}
                w={w}
                h={h}
                onEntity={(t) => setSt({ v: "entity", t })}
              />
            ) : (
              <EntityPlate t={st.t} w={w} h={h} />
            ))
          )}
          {tracksOn && d.tracksErr && (
            <div className="mp-msg" role="status">
              {d.tracksErr}
            </div>
          )}
        </div>
        {st.v === "layer" && <LayerPanel d={d} onClose={close} />}
        {st.v === "entity" && (
          <EntityPanel t={st.t} onClose={() => setSt({ v: "layer" })} />
        )}
      </div>
      {st.v === "nominate" && nominate(st.sar)}
    </DkPage>
  );
}
