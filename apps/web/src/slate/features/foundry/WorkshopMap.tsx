// Workshop map widget pages D192-D196, native: the plate fills its pane and
// zooms with it. Live OpenFlights airports and routes, CelesTrak elements and
// USGS quakes; panels are floating cards anchored to the pane corners.
import { useEffect, useMemo, useState } from "react";
import { Glyph, Ii } from "./kit.js";
import {
  Bar,
  Btn,
  Float,
  MapNote,
  MapStage,
  Page,
  Timeline,
  useMap,
  useScale,
} from "./native.js";
import {
  airportsOf,
  countryOrder,
  d192,
  d196,
  dedupeTracks,
  depsOf,
  fmt_d,
  fmt_dt,
  fmt_slash,
  fmt_t,
  lengthRamp,
  magRamp,
  mmmdd,
  ofvOf,
  proj,
  quakeCell,
  quakesOf,
  satTracks,
  splitWrap,
  useJson,
  why,
  type Gp,
  type Route,
  type Track,
} from "./data.js";
import { frac, ticks } from "./view.js";
import type { Nav } from "./nav.js";

type AFC = Parameters<typeof airportsOf>[0];
const BLU = "#2d72d2";
const PBLUE = "#3d6fd1";
const PLBLUE = "#7fc1ed";
const PLAV = "#b9a9ee";
const PRED = "#c14a4a";

/** OpenFlights airports with departures, and the per-airport departure counts. */
function useAirports() {
  const rr = useJson<{ routes: Route[] }>("/api/aviation/routes");
  const ar = useJson<AFC>("/api/aviation/airports/openflights");
  const v = useMemo(() => {
    if (!rr?.data || !ar?.data) return null;
    const deps = depsOf(rr.data.routes);
    return {
      routes: rr.data.routes,
      deps,
      ofv: ofvOf(airportsOf(ar.data), deps),
    };
  }, [rr, ar]);
  return {
    v,
    err: why("OpenFlights routes", rr) ?? why("OpenFlights airports", ar),
  };
}

/** The live CelesTrak elements of D194/D196, SGP4-propagated for one orbit from `t0`. */
function useTracks(t0: number): { tracks: Track[] | null; err: string | null } {
  const st = useJson<{ items: Gp[] }>("/api/space/gp?group=stations");
  const we = useJson<{ items: Gp[] }>("/api/space/gp?group=weather&limit=40");
  const tracks = useMemo(() => {
    if (!st) return null;
    if (!st.data) return [];
    if (!we) return null;
    return satTracks(
      [...st.data.items, ...(we.data?.items.slice(0, 6) ?? [])],
      t0,
    );
  }, [st, we, t0]);
  return { tracks, err: why("CelesTrak elements", st) };
}

const Tile = ({ bg, icon }: { bg: string; icon: string }): JSX.Element => (
  <span className="fxn-sw-tile" style={{ background: bg }}>
    {Ii(icon, 12, "#fff")}
  </span>
);

export function D192({ nav }: { nav: Nav }): JSX.Element {
  const m = useMap(5.4, 1131);
  const lon0 = 8.6;
  const lat0 = 50.2;
  const fn = useMemo(() => proj(lon0, lat0, m.zf, m.w, m.h), [m.zf, m.w, m.h]);
  const kmpx = useScale(lat0, m.zf);
  const { v, err } = useAirports();
  const r = useMemo(
    () => (v && m.w > 0 ? d192(v.ofv, v.deps, fn, m.w, m.h) : null),
    [v, fn, m.w, m.h],
  );
  const BC = [PBLUE, PLBLUE, PLAV, PRED];
  const selected = r?.selected ?? [];
  const sel = new Set(selected.map((a) => a.iata));
  const svg = r ? (
    <>
      {r.ctr
        ? (() => {
            const [cx, cy] = fn(r.ctr.lon, r.ctr.lat);
            return (
              <circle
                cx={cx}
                cy={cy}
                r={r.rkm / kmpx}
                fill="#4a73c9"
                fillOpacity=".18"
                stroke={BLU}
                strokeWidth="1.6"
                strokeDasharray="2.2 3.2"
              />
            );
          })()
        : null}
      <g className="fxn-halo">
        {[...r.inview]
          .sort((p, q) => fn(p.lon, p.lat)[1] - fn(q.lon, q.lat)[1])
          .map((a) => {
            const [x, y] = fn(a.lon, a.lat);
            return (
              <Glyph
                key={a.iata}
                name="airplane"
                x={x}
                y={y}
                s={sel.has(a.iata) ? 22 : 20}
                col={BC[r.bin(v!.deps.get(a.iata)!)]!}
              />
            );
          })}
      </g>
    </>
  ) : null;
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Workshop map · <b>Legend and radius selection</b>
          </>
        }
      />
      <div className="fxn-body">
        <MapStage m={m} lon={lon0} lat={lat0} svg={svg} kmPx={kmpx}>
          <Float pos="tl" title="Legend">
            <div className="fxn-leg">
              <Tile bg="#8e3f9e" icon="map-marker" />
              <span>Airports (OpenFlights)</span>
            </div>
            <div className="fxn-by">
              Icon colored by <b>Departing routes</b>
            </div>
            {r ? (
              <div className="fxn-sw-row">
                {r.edges.map(([a, b], i) => (
                  <div key={i}>
                    <i style={{ background: BC[i] }} />
                    {a} to {b}
                  </div>
                ))}
              </div>
            ) : null}
          </Float>
          <Float pos="tr" title="Selection" count={r ? selected.length : "—"}>
            <div className="fxn-by">Airports (OpenFlights)</div>
            <ul className="fxn-list">
              {selected.map((a) => (
                <li key={a.iata} className="fxn-leg">
                  <span
                    className="fxn-pin"
                    style={{ background: BC[r!.bin(v!.deps.get(a.iata)!)] }}
                  >
                    {Ii("map-marker", 14, "#fff")}
                  </span>
                  <span>
                    [{a.iata}] {a.name} + {a.city}, {a.country}
                  </span>
                </li>
              ))}
            </ul>
          </Float>
          <MapNote text={err} />
        </MapStage>
      </div>
    </Page>
  );
}

interface Country {
  n: string[];
  r: [number, number][][];
}
const CAT = [
  "#7d5a6e",
  "#d8ae6b",
  "#a85a4e",
  "#6f6f3b",
  "#4a5f77",
  "#5b4570",
  "#6b8e5a",
  "#b0a860",
  "#a04e6e",
  "#8b7a4a",
]; // swatch colours sampled from the reference legend
const SATP = "#6b5bd8";

export function D194({ nav }: { nav: Nav }): JSX.Element {
  const m = useMap(2.1, 1135, true);
  const fn = useMemo(() => proj(0, 14, m.zf, m.w, m.h), [m.zf, m.w, m.h]);
  const [t0] = useState(() => Date.now() / 1000);
  const { v, err } = useAirports();
  const { tracks, err: terr } = useTracks(t0);
  const [geo, setGeo] = useState<Country[] | null>(null);
  useEffect(() => {
    // countries.json: Natural Earth admin-0, simplified by countries.gen.py
    void import("./countries.json").then((j) =>
      setGeo(j.default as unknown as Country[]),
    );
  }, []);
  const order = useMemo(() => (v ? countryOrder(v.ofv, v.deps) : []), [v]);
  const shapes = useMemo(() => {
    if (!geo || !order.length) return [];
    const f2 = (lo: number, la: number): [number, number] =>
      fn(lo, Math.max(-85, Math.min(85, la)));
    const out: Array<[string, string]> = [];
    for (const c of geo) {
      const hit = order.find((o) => c.n.includes(o));
      if (hit === undefined) continue;
      const d = c.r
        .map(
          (ring) =>
            "M" +
            ring
              .map(([a, b]) =>
                f2(a, b)
                  .map((q) => q.toFixed(1))
                  .join(" "),
              )
              .join(" L") +
            "Z",
        )
        .join(" ");
      out.push([d, CAT[order.indexOf(hit) % CAT.length]!]);
    }
    return out;
  }, [geo, order, fn]);
  const sats = useMemo(() => (tracks ? dedupeTracks(tracks) : []), [tracks]);
  const drawn = shapes.length;
  const lines: JSX.Element[] = [];
  const icons: Array<[number, number]> = [];
  for (const s of sats) {
    for (const sg of splitWrap(s.pts)) {
      if (sg.length < 2) continue;
      const pp = sg.map(([lo, la]) => fn(lo, la));
      const n = pp.length;
      for (let i = 0; i < n - 1; i++)
        lines.push(
          <path
            key={`${s.norad}-${lines.length}`}
            d={`M${pp[i]![0].toFixed(1)} ${pp[i]![1].toFixed(1)}L${pp[i + 1]![0].toFixed(1)} ${pp[i + 1]![1].toFixed(1)}`}
            stroke="#7165e8"
            strokeWidth="2.4"
            strokeOpacity={(0.9 * (1 - i / n) ** 1.2).toFixed(2)}
            fill="none"
            strokeLinecap="round"
          />,
        );
    }
    icons.push(fn(...s.pts[0]!));
  }
  const svg = (
    <>
      {shapes.map(([d, c], i) => (
        <path
          key={i}
          d={d}
          fill={c}
          fillOpacity=".55"
          fillRule="evenodd"
          stroke="#fff"
          strokeWidth=".7"
        />
      ))}
      {lines}
      <g
        style={{
          filter: "drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 3px #7165e8)",
        }}
      >
        {icons
          .filter(([x, y]) => x > 0 && x < m.w && y > 0 && y < m.h)
          .map(([x, y], i) => (
            <Glyph
              key={i}
              name="satellite"
              x={x}
              y={y}
              s={21}
              col={SATP}
              rot={45}
            />
          ))}
      </g>
    </>
  );
  const rest = Math.max(drawn - CAT.length, 0);
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Workshop map · <b>Satellites and countries</b>
          </>
        }
      />
      <div className="fxn-body">
        <MapStage m={m} lon={0} lat={14} svg={svg}>
          <Float pos="br" title="Legend" className="fxn-lift">
            <div className="fxn-leg">
              <Tile bg={SATP} icon="satellite" />
              <span>Satellites</span>
              <span className="fxn-count">{sats.length}</span>
            </div>
            <div className="fxn-leg">
              <Tile bg="#2d72d2" icon="globe" />
              <span>Countries</span>
              <span className="fxn-count">{drawn}</span>
            </div>
            <div className="fxn-by">
              Shape colored by <b>Country Name</b>
            </div>
            <div className="fxn-leg">
              <div className="fxn-sw-row" style={{ flex: 1 }}>
                {CAT.map((c) => (
                  <div key={c}>
                    <i style={{ background: c, margin: 0 }} />
                  </div>
                ))}
              </div>
              <span className="fxn-count">+{rest}</span>
            </div>
          </Float>
          <MapNote text={err ?? terr} />
        </MapStage>
      </div>
    </Page>
  );
}

export function D195({ nav }: { nav: Nav }): JSX.Element {
  const m = useMap(4.5, 1131);
  const qr = useJson<Parameters<typeof quakesOf>[0]>("/api/eq?range=week");
  const qk = useMemo(() => (qr?.data ? quakesOf(qr.data) : []), [qr]);
  const spanLon = m.w > 0 ? (m.w / (256 * 2 ** m.zf)) * 360 : 0;
  const [lon0, lat0] = useMemo(
    () => (qk.length && spanLon ? quakeCell(qk, spanLon) : [0, 0]),
    [qk, spanLon],
  );
  const fn = useMemo(
    () => proj(lon0, lat0, m.zf, m.w, m.h),
    [lon0, lat0, m.zf, m.w, m.h],
  );
  const vis = useMemo(
    () =>
      qk.filter((e) => {
        const [x, y] = fn(e.lon, e.lat);
        return x > 0 && x < m.w && y > 0 && y < m.h;
      }),
    [qk, fn, m.w, m.h],
  );
  const big = vis.length ? vis.reduce((a, b) => (b.mag > a.mag ? b : a)) : null;
  let svg: JSX.Element | null = null;
  let tip: JSX.Element | null = null;
  if (vis.length && big) {
    const mags = vis.map((e) => e.mag);
    const mlo = Math.min(...mags);
    const mhi = Math.max(...mags);
    svg = (
      <>
        {[...vis]
          .sort((a, b) => a.mag - b.mag)
          .map((e, i) => {
            const [x, y] = fn(e.lon, e.lat);
            const c = magRamp(e.mag, mlo, mhi);
            return (
              <circle
                key={i}
                cx={x.toFixed(1)}
                cy={y.toFixed(1)}
                r={(1.5 + Math.max(e.mag, 0.1) ** 2.1 * 0.62).toFixed(1)}
                fill={c}
                fillOpacity=".62"
                stroke={c}
                strokeOpacity=".9"
                strokeWidth="1"
              />
            );
          })}
      </>
    );
    const [bx, by] = fn(big.lon, big.lat);
    const place =
      big.place.length < 28 ? big.place : big.place.slice(0, 26) + "...";
    tip = (
      <div
        className="fxn-tip"
        style={{
          left: Math.max(8, Math.min(bx + 8, m.w - 248)),
          top: Math.max(8, Math.min(by + 3, m.h - 90)),
        }}
      >
        <div className="fxn-tip-h">
          <span
            className="fxn-pin"
            style={{ background: "#c23030", width: 20, height: 20 }}
          >
            {Ii("pulse", 12, "#fff")}
          </span>
          <span>
            M{big.mag} {place}
          </span>
        </div>
        <div className="fxn-tip-r">
          <span>Magnitude</span>
          <span>{big.mag}</span>
        </div>
      </div>
    );
  }
  // timeline: histogram of the real event times, cursor at the largest event
  let tl: JSX.Element | null = null;
  if (qk.length && big) {
    const ts = qk.map((e) => e.time / 1000);
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    const nbin = 360;
    const hist = new Array<number>(nbin).fill(0);
    for (const t of ts)
      hist[Math.min(nbin - 1, Math.floor(frac(t, t0, t1) * nbin))]!++;
    const mx = Math.max(...hist);
    const bars = hist.map((c) =>
      c
        ? c < mx * 0.35
          ? "#f6d77a"
          : c < mx * 0.7
            ? "#f0bb4a"
            : "#e8923a"
        : null,
    );
    const bt = big.time / 1000;
    tl = (
      <Timeline
        from={`${fmt_d(t0)} UTC`}
        to={`${fmt_d(t1)} UTC`}
        cursor={frac(bt, t0, t1)}
        chip={`${fmt_slash(bt)} UTC`}
        ticks={ticks(t0, t1, 86400)
          .filter((d) => Math.floor(d / 86400) % 2 === 0)
          .map((d) => [frac(d, t0, t1), mmmdd(d)] as [number, string])}
        bars={bars}
        note="Cursor at the largest event in view"
      />
    );
  }
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Workshop map · <b>Quake tooltip</b>
          </>
        }
      >
        <Btn icon="timeline-events" onClick={() => nav.go("d196")}>
          Timeline
        </Btn>
      </Bar>
      <div className="fxn-body fxn-col-body">
        <MapStage
          m={m}
          lon={qk.length ? lon0 : null}
          lat={qk.length ? lat0 : null}
          svg={svg}
        >
          {tip}
          <MapNote text={why("USGS quakes", qr)} />
        </MapStage>
        {tl}
      </div>
    </Page>
  );
}

export function D196({ nav }: { nav: Nav }): JSX.Element {
  const m = useMap(3.7, 1135);
  const fn = useMemo(() => proj(12, 47, m.zf, m.w, m.h), [m.zf, m.w, m.h]);
  const [now] = useState(() => Date.now() / 1000);
  const { v, err } = useAirports();
  const { tracks } = useTracks(now);
  const r = useMemo(
    () => (v && m.w > 0 ? d196(v.routes, v.ofv, fn, m.w, m.h) : null),
    [v, fn, m.w, m.h],
  );
  const svg = r ? (
    <>
      {[...r.rts]
        .sort((a, b) => a[0] - b[0])
        .map(([d, a, b], i) => {
          const [x1, y1] = fn(a.lon, a.lat);
          const [x2, y2] = fn(b.lon, b.lat);
          return (
            <line
              key={i}
              x1={x1.toFixed(1)}
              y1={y1.toFixed(1)}
              x2={x2.toFixed(1)}
              y2={y2.toFixed(1)}
              stroke={lengthRamp(d, r.dmin, r.dmax)}
              strokeWidth="1.6"
              strokeOpacity=".85"
            />
          );
        })}
      {[
        ...new Map(
          r.rts.flatMap(([, a, b]) => [
            [a.iata, fn(a.lon, a.lat)] as const,
            [b.iata, fn(b.lon, b.lat)] as const,
          ]),
        ).values(),
      ].map(([x, y], i) => (
        <circle
          key={i}
          cx={x.toFixed(1)}
          cy={y.toFixed(1)}
          r="4.2"
          fill="#8fb88f"
          fillOpacity=".9"
          stroke="#4d5a52"
          strokeWidth="1"
        />
      ))}
    </>
  ) : null;
  // the SGP4 sample times of the live tracks: 45 s apart from now
  const t0 = now - 30 * 60;
  const t1 = now + 100 * 60;
  const nSamples =
    tracks && tracks.length ? Math.max(...tracks.map((t) => t.pts.length)) : 0;
  const marks = Array.from({ length: Math.min(129, nSamples) }, (_, k) =>
    frac(now + k * 45, t0, t1),
  );
  const nf0 = (n: number): string =>
    n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Workshop map · <b>Routes and timeline</b>
          </>
        }
      />
      <div className="fxn-body fxn-col-body">
        <Timeline
          className="fxn-tl-top"
          from={`${fmt_dt(t0)} UTC`}
          to={`${fmt_dt(t1)} UTC`}
          cursor={frac(now, t0, t1)}
          chip={`${fmt_slash(now)} UTC`}
          ticks={ticks(t0, t1, 1200).map(
            (tt) =>
              [frac(tt, t0, t1), fmt_t(tt).replace(":00 ", " ")] as [
                number,
                string,
              ],
          )}
          marks={marks}
          note={nSamples ? "Dots: satellite position samples" : undefined}
        />
        <MapStage m={m} lon={12} lat={47} svg={svg}>
          <Float pos="br" title="Legend" className="fxn-lift">
            <div className="fxn-leg">
              <Tile bg="#2d5fc0" icon="route" />
              <span>Routes (OpenFlights)</span>
            </div>
            <div className="fxn-by">
              Line segment colored by <b>Great-circle length (km)</b>
            </div>
            <div className="fxn-ramp" />
            <div className="fxn-ramp-l">
              <span>{r ? nf0(r.dmin) : "—"}</span>
              <span>{r ? nf0(r.dmax) : "—"}</span>
            </div>
          </Float>
          <MapNote text={err} />
        </MapStage>
      </div>
    </Page>
  );
}
