// Workshop map widget frames D192-D196 (the four quadrants of the
// widgets-map-ex frame; sec_d192, sec_d194-d196, _build_foundry_apps.py:932-1148)
// on live OpenFlights airports and routes, CelesTrak elements and USGS quakes.
import { useEffect, useMemo, useState } from "react";
import {
  BLU,
  DARK,
  E,
  GREY,
  Fr,
  Hit,
  I,
  frag,
  hairline,
  kit,
  span,
  type N,
} from "./kit.js";
import {
  ATTR,
  PBLUE,
  PLAV,
  PLBLUE,
  PRED,
  WSEL,
  attribution,
  map_tools,
  mini_bar,
  pin_tile,
  plane,
  scale_nm,
  swatch_legend,
  timeline_strip,
} from "./mapkit.js";
import { Plate } from "./Plate.js";
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
  scaleBar,
  splitWrap,
  useJson,
  why,
  type Gp,
  type Route,
  type Track,
} from "./data.js";
import type { Nav } from "./nav.js";

const k = kit(1);
const { txt, bx } = k;

type AFC = Parameters<typeof airportsOf>[0];

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

const errBox = (e: string | null, x: number, y: number): N =>
  e
    ? frag([
        mini_bar(x, y, e.length * 6.2 + 20, 26),
        txt(x + 10, y + 13, e, 11, "#ac2f33"),
      ])
    : null;

export function D192({ nav }: { nav: Nav }): JSX.Element {
  const W = 1131;
  const H = 699;
  const zf = 5.4;
  const lon0 = 8.6;
  const lat0 = 50.2;
  const fn = useMemo(() => proj(8.6, 50.2, zf, W, H), []);
  const kmpx = scaleBar(lat0, zf);
  const { v, err } = useAirports();
  const r = useMemo(() => (v ? d192(v.ofv, v.deps, fn, W, H) : null), [v, fn]);
  const BC = [PBLUE, PLBLUE, PLAV, PRED];
  const o: N[] = [<Plate key="p" lon={lon0} lat={lat0} zf={zf} W={W} H={H} />];
  if (r) {
    const sel = new Set(r.selected.map((a) => a.iata));
    if (r.ctr) {
      const [cx, cy] = fn(r.ctr.lon, r.ctr.lat);
      o.push(
        <svg
          key="c"
          style={{ left: 0, top: 0, width: W, height: H }}
          width={W}
          height={H}
        >
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
        </svg>,
      );
    }
    for (const a of [...r.inview].sort(
      (p, q) => fn(p.lon, p.lat)[1] - fn(q.lon, q.lat)[1],
    )) {
      const [x, y] = fn(a.lon, a.lat);
      o.push(
        plane(
          x,
          y,
          BC[r.bin(v!.deps.get(a.iata)!)]!,
          sel.has(a.iata) ? 22 : 20,
          sel.has(a.iata),
        ),
      );
    }
  }
  o.push(
    mini_bar(10, 10, 375, 132),
    bx(10, 10, 143, 43, "#fff", "#fff", 3),
    I("search", 82, 32, 18, "#394048"),
    E(159, 14, 185, 36, `background:${WSEL};border-radius:2px`),
    I("map", 226, 32, 18, "#215db0"),
    txt(242, 32.5, "Legend", 13, "#215db0", 600),
    I("double-chevron-left", 363, 32, 16, "#394048"),
    hairline(11, 53, 373, "#e1e5ea"),
    E(26, 67, 20, 20, "background:#b05bbf;border-radius:3px"),
    I("map-marker", 36, 77, 13, "#fff"),
    txt(50, 77.5, "Airports (OpenFlights)", 14, DARK),
    txt(
      198,
      101,
      ["Icon ", span("colored by", "color:#8f99a8"), " Departing routes"],
      12.5,
      "#394048",
      400,
      360,
      "c",
    ),
  );
  if (r)
    o.push(
      swatch_legend(
        26,
        110,
        343,
        r.edges.map(([a, b]) => `${a} to ${b}`),
        BC,
      ),
    );
  const selected = r?.selected ?? [];
  const nsel = selected.length;
  o.push(
    mini_bar(739, 10, 385, 62 + 42 * nsel + 12 + 14),
    I("double-chevron-right", 754, 29, 16, "#394048"),
    E(895, 15, 72, 28, `background:${WSEL};border-radius:2px`),
    txt(931, 29.5, "Selection", 12, "#215db0", 600, 72, "c"),
    hairline(740, 48, 383, "#e1e5ea"),
    I("caret-down", 754, 62, 10, "#5f6b7c"),
    txt(
      763,
      62.5,
      [
        "Airports (OpenFlights)  ",
        span(String(nsel), "color:#8f99a8;font-size:10px"),
      ],
      11,
      "#5f6b7c",
    ),
  );
  selected.forEach((a, i) => {
    const yy = 79 + 42 * i;
    o.push(
      pin_tile(751, yy, BC[r!.bin(v!.deps.get(a.iata)!)]!),
      txt(
        791,
        yy + 17.5,
        `[${a.iata}] ${a.name} + ${a.city}, ${a.country}`,
        13.5,
        "#1c2127",
        400,
        325,
      ),
    );
  });
  o.push(
    map_tools(10, 515),
    scale_nm(51, 670, kmpx),
    attribution(200, 685, ATTR),
    errBox(err, 400, 640),
    Hit(350, 18, 28, 28, "Foundry apps", nav.menu),
    Hit(745, 18, 22, 22, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
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
]; // swatch colours sampled from the reference legend (builder line 981)
const SATP = "#8b6cf0";

export function D194({ nav }: { nav: Nav }): JSX.Element {
  const W = 1135;
  const H = 620;
  const zf = 2.1;
  const fn = useMemo(() => proj(0, 14, zf, W, H), []);
  const [t0] = useState(() => Date.now() / 1000);
  const { v, err } = useAirports();
  const { tracks, err: terr } = useTracks(t0);
  const [geo, setGeo] = useState<Country[] | null>(null);
  useEffect(() => {
    // countries.json: Natural Earth admin-0, simplified by countries.gen.py
    void import("./countries.json").then((m) =>
      setGeo(m.default as unknown as Country[]),
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
  const o: N[] = [<Plate key="p" lon={0} lat={14} zf={zf} W={W} H={H} />];
  o.push(
    <svg
      key="cty"
      style={{ left: 0, top: 0, width: W, height: H }}
      width={W}
      height={H}
    >
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
    </svg>,
  );
  const lines: JSX.Element[] = [];
  const icons: [number, number][] = [];
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
  o.push(
    <svg
      key="trk"
      style={{ left: 0, top: 0, width: W, height: H }}
      width={W}
      height={H}
    >
      {lines}
    </svg>,
  );
  for (const [x, y] of icons)
    if (x > 0 && x < W && y > 0 && y < H)
      o.push(
        I(
          "satellite",
          x,
          y,
          21,
          "#6b5bd8",
          "filter:drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 2px #fff) drop-shadow(0 0 3px #7165e8);transform:rotate(45deg);",
        ),
      );
  o.push(
    mini_bar(832, 450, 298, 161),
    bx(832, 450, 126, 37, "#fff", "#fff", 2),
    txt(895, 469, "Find", 12, DARK, 400, 100, "c"),
    E(964, 454, 128, 31, `background:${WSEL};border-radius:2px`),
    txt(1028, 469.5, "Legend", 12, "#215db0", 600, 100, "c"),
    I("double-chevron-down", 1113, 469, 15, "#394048"),
    hairline(833, 488, 296, "#e1e5ea"),
    E(844, 500, 18, 18, `background:${SATP};border-radius:3px`),
    I("satellite", 853, 509, 12, "#fff"),
    txt(
      867,
      509.5,
      [
        "Satellites  ",
        span(String(sats.length), "color:#8f99a8;font-size:10px"),
      ],
      13,
      DARK,
    ),
    I("eye-open", 1104, 509, 16, "#394048"),
    E(844, 525, 273, 13, `background:${SATP};border-radius:3px`),
    E(844, 553, 18, 18, "background:#3d8bf2;border-radius:3px"),
    I("globe", 853, 562, 12, "#fff"),
    txt(
      867,
      562.5,
      ["Countries  ", span(String(drawn), "color:#8f99a8;font-size:10px")],
      13,
      DARK,
    ),
    I("eye-open", 1104, 562, 16, "#394048"),
    txt(
      980,
      587,
      ["Shape ", span("colored by", "color:#8f99a8"), " Country Name"],
      10.5,
      "#394048",
      400,
      280,
      "c",
    ),
  );
  const rest = Math.max(drawn - CAT.length, 0);
  CAT.forEach((c, i) =>
    o.push(E(844 + i * 25.4, 596, 24, 11, `background:${c};border-radius:2px`)),
  );
  o.push(
    E(1095, 595, 21, 13, "background:#e5e8ec;border-radius:2px"),
    txt(1105.5, 601.5, `+${rest}`, 8, GREY, 400, 21, "c"),
    map_tools(5, 432),
    attribution(282, 600, ATTR),
    errBox(err ?? terr, 300, 560),
    Hit(1100, 457, 26, 26, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}

export function D195({ nav }: { nav: Nav }): JSX.Element {
  const W = 1131;
  const H = 703;
  const MH = 618;
  const zf = 4.5;
  const qr = useJson<Parameters<typeof quakesOf>[0]>("/api/eq?range=week");
  const qk = useMemo(() => (qr?.data ? quakesOf(qr.data) : []), [qr]);
  const spanLon = (W / (256 * 2 ** zf)) * 360;
  const [lon0, lat0] = useMemo(
    () => (qk.length ? quakeCell(qk, spanLon) : [0, 0]),
    [qk, spanLon],
  );
  const fn = useMemo(() => proj(lon0, lat0, zf, W, MH), [lon0, lat0]);
  const o: N[] = [];
  if (qk.length)
    o.push(
      <Plate
        key={`p${lon0},${lat0}`}
        lon={lon0}
        lat={lat0}
        zf={zf}
        W={W}
        H={MH}
      />,
    );
  else o.push(E(0, 0, W, MH, "background:rgb(200,205,207)"));
  const vis = qk.filter((e) => {
    const [x, y] = fn(e.lon, e.lat);
    return x > 0 && x < W && y > 0 && y < MH;
  });
  if (vis.length) {
    const mags = vis.map((e) => e.mag);
    const mlo = Math.min(...mags);
    const mhi = Math.max(...mags);
    o.push(
      <svg
        key="q"
        style={{ left: 0, top: 0, width: W, height: MH }}
        width={W}
        height={MH}
      >
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
      </svg>,
    );
    const big = vis.reduce((a, b) => (b.mag > a.mag ? b : a));
    const [bx_, by_] = fn(big.lon, big.lat);
    const tx = Math.min(bx_ + 8, W - 225);
    const ty = Math.min(by_ + 3, MH - 60);
    const place =
      big.place.length < 28 ? big.place : big.place.slice(0, 26) + "...";
    o.push(
      mini_bar(tx, ty, 222, 58, "#fff", "#d3d8de", 3),
      E(tx + 8, ty + 7, 18, 18, "background:#c23030;border-radius:2px"),
      I("pulse", tx + 17, ty + 16, 12, "#fff"),
      txt(tx + 31, ty + 16.5, `M${big.mag} ${place}`, 11, DARK, 700, 186),
      hairline(tx + 1, ty + 31, 220, "#e1e5ea"),
      txt(tx + 8, ty + 45, "Magnitude", 11, DARK),
      txt(tx + 214, ty + 45, String(big.mag), 11, DARK, 400, 60, "r"),
    );
    // timeline: histogram of the real event times, cursor at the largest event
    const ts = qk.map((e) => e.time / 1000);
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    const pps = W / (t1 - t0);
    const axis: Array<[number, string]> = [];
    for (let d = Math.floor(t0 / 86400 + 1) * 86400; d < t1; d += 86400)
      if (Math.floor(d / 86400) % 2 === 0)
        axis.push([(d - t0) * pps, mmmdd(d)]);
    const nbin = Math.floor(W / 3);
    const hist = new Array<number>(nbin).fill(0);
    for (const t of ts)
      hist[Math.min(nbin - 1, Math.floor(((t - t0) / (t1 - t0)) * nbin))]!++;
    const mx = Math.max(...hist);
    const tk = frag(
      hist.map((c, i) =>
        c
          ? E(
              i * 3,
              MH + 62,
              2,
              20,
              `background:${c < mx * 0.35 ? "#f6d77a" : c < mx * 0.7 ? "#f0bb4a" : "#e8923a"}`,
            )
          : null,
      ),
    );
    const bt = big.time / 1000;
    o.push(
      timeline_strip(
        0,
        MH,
        W,
        bt,
        [fmt_d(t0), fmt_d(t1)],
        axis,
        (bt - t0) * pps,
        tk,
        fmt_slash(bt),
        "#1c3f7a",
        null,
        "d",
        85,
      ),
    );
  } else o.push(E(0, MH, W, H - MH, "background:#fff"));
  o.push(
    mini_bar(1047, 6, 79, 38, "#fff", "#d3d8de", 3),
    txt(1086, 25.5, "Selection", 12, DARK, 400, 79, "c"),
    map_tools(5, 430),
    bx(47, 574, 62, 30, "#f6f7f9", "#c5cbd3", 2),
    txt(78, 589.5, "Timeline", 11, DARK, 400, 62, "c"),
    attribution(282, 598, ATTR),
    errBox(why("USGS quakes", qr), 400, 560),
    Hit(1047, 6, 79, 38, "Foundry apps", nav.menu),
    Hit(47, 574, 62, 30, "Timeline", () => nav.go("d196")),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}

export function D196({ nav }: { nav: Nav }): JSX.Element {
  const W = 1135;
  const H = 778;
  const MY = 75;
  const zf = 3.7;
  const fn = useMemo(() => proj(12, 47, zf, W, H - MY), []);
  const [now] = useState(() => Date.now() / 1000);
  const { v, err } = useAirports();
  const { tracks } = useTracks(now);
  const r = useMemo(
    () => (v ? d196(v.routes, v.ofv, fn, W, H - MY) : null),
    [v, fn],
  );
  const fnm = (lo: number, la: number): [number, number] => {
    const p = fn(lo, la);
    return [p[0], p[1] + MY];
  };
  const o: N[] = [
    E(0, MY, W, H - MY, "background:#e6e8ea"),
    <Plate key="p" lon={12} lat={47} zf={zf} W={W} H={H - MY} top={MY} />,
  ];
  if (r) {
    const ns = new Map<string, [number, number]>();
    const ls = [...r.rts]
      .sort((a, b) => a[0] - b[0])
      .map(([d, a, b], i) => {
        const [x1, y1] = fnm(a.lon, a.lat);
        const [x2, y2] = fnm(b.lon, b.lat);
        ns.set(a.iata, [x1, y1]);
        ns.set(b.iata, [x2, y2]);
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
      });
    o.push(
      <svg
        key="r"
        style={{ left: 0, top: 0, width: W, height: H }}
        width={W}
        height={H}
      >
        {ls}
        {[...ns.values()].map(([x, y], i) => (
          <circle
            key={`n${i}`}
            cx={x.toFixed(1)}
            cy={y.toFixed(1)}
            r="4.2"
            fill="#8fb88f"
            fillOpacity=".9"
            stroke="#4d5a52"
            strokeWidth="1"
          />
        ))}
      </svg>,
    );
  }
  const ly = 575 + MY;
  o.push(
    mini_bar(822, ly, 300, 121),
    bx(822, ly, 127, 36, "#fff", "#fff", 2),
    txt(885, ly + 18, "Find", 12, DARK, 400, 100, "c"),
    E(955, ly + 3, 128, 31, `background:${WSEL};border-radius:2px`),
    txt(1019, ly + 18.5, "Legend", 12, "#215db0", 600, 100, "c"),
    I("double-chevron-down", 1106, ly + 18, 15, "#394048"),
    hairline(823, ly + 37, 298, "#e1e5ea"),
    E(835, ly + 48, 16, 16, "background:#2d5fc0;border-radius:3px"),
    I("route", 843, ly + 56, 11, "#fff"),
    txt(858, ly + 57, "Routes (OpenFlights)", 13, DARK),
    I("eye-open", 1097, ly + 57, 16, "#394048"),
    txt(
      966,
      ly + 82,
      [
        "Line segment ",
        span("colored by", "color:#8f99a8"),
        " Great-circle length (km)",
      ],
      10.5,
      "#394048",
      400,
      290,
      "c",
    ),
    E(
      835,
      ly + 91,
      275,
      11,
      "background:linear-gradient(90deg,#2e8b57,#96c878 45%,#e8d25a 70%,#c8463c);border:1px solid #c5cbd3",
    ),
  );
  if (r)
    o.push(
      txt(
        835,
        ly + 110,
        r.dmin.toLocaleString("en-US", { maximumFractionDigits: 0 }),
        8.5,
        GREY,
      ),
      txt(
        1110,
        ly + 110,
        r.dmax.toLocaleString("en-US", { maximumFractionDigits: 0 }),
        8.5,
        GREY,
        400,
        60,
        "r",
      ),
    );
  o.push(map_tools(5, 514 + MY), attribution(190, 692 + MY - 75 + 5, ATTR));
  // timeline strip: the 45-second SGP4 sample times of the live tracks (none before now)
  const ppm = 14.7;
  const tStart = now - 46 * 60;
  const tw = (W / ppm) * 60;
  const axis: Array<[number, string]> = [];
  for (
    let tt = (Math.floor(tStart / 600) + 1) * 600;
    tt < tStart + tw;
    tt += 600
  )
    axis.push([((tt - tStart) / 60) * ppm, fmt_t(tt).replace(":00 ", " ")]);
  const nSamples =
    tracks && tracks.length ? Math.max(...tracks.map((t) => t.pts.length)) : 0;
  const dots: N[] = [];
  for (let kk = 0; kk < Math.min(129, nSamples); kk++) {
    const x = 46 * ppm + kk * 0.75 * ppm;
    if (x < W)
      dots.push(
        E(
          x - 2,
          69,
          5,
          5,
          `background:#7a69e6;border-radius:50%;opacity:${kk < 40 ? 1 : 0.45}`,
        ),
      );
  }
  const hoverT = tStart + (188 / ppm) * 60;
  o.push(
    timeline_strip(
      0,
      0,
      W,
      now,
      [fmt_dt(tStart), fmt_t(tStart + tw)],
      axis,
      46 * ppm,
      frag(dots),
      fmt_slash(hoverT),
      "#6b7480",
      120,
    ),
    errBox(err, 300, 700),
    Hit(1094, ly + 6, 26, 26, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}
