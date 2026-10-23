// Legacy map frames D200 (selection card, radius circle, route-count bins) and
// D201+D202 (icon legend card, page tabs) (sec_d200 / sec_d201,
// _build_foundry_apps.py:1265-1342), on live OpenFlights and AIS data.
import { useMemo } from "react";
import { APP_GROUPS, useAppView } from "../../../state/appView.js";
import {
  BLU,
  DARK,
  E,
  Fr,
  Hit,
  I,
  frag,
  hairline,
  kit,
  type N,
} from "./kit.js";
import { attribution, mini_bar, plane } from "./mapkit.js";
import { ATTR } from "./mapkit.js";
import { Plate } from "./Plate.js";
import {
  aisType,
  airportsOf,
  d200,
  densCenter,
  depsOf,
  ofvOf,
  proj,
  scaleBar,
  useJson,
  vesselsOf,
  why,
  type Route,
} from "./data.js";
import type { Nav } from "./nav.js";

const { txt, bx } = kit(1);
const errBox = (e: string | null, x: number, y: number): N =>
  e
    ? frag([
        mini_bar(x, y, e.length * 6.2 + 20, 26),
        txt(x + 10, y + 13, e, 11, "#ac2f33"),
      ])
    : null;

export function D200({ nav }: { nav: Nav }): JSX.Element {
  const W = 897;
  const H = 375;
  const zf = 5.7;
  const lon0 = 10;
  const lat0 = 49;
  const fn = useMemo(() => proj(10, 49, zf, W, H), []);
  const kmpx = scaleBar(lat0, zf);
  const rr = useJson<{ routes: Route[] }>("/api/aviation/routes");
  const ar = useJson<Parameters<typeof airportsOf>[0]>(
    "/api/aviation/airports/openflights",
  );
  const r = useMemo(() => {
    if (!rr?.data || !ar?.data) return null;
    const deps = depsOf(rr.data.routes);
    const x = d200(ofvOf(airportsOf(ar.data), deps), deps, fn, W, H);
    return x ? { ...x, deps } : null;
  }, [rr, ar, fn]);
  const o: N[] = [<Plate key="p" lon={lon0} lat={lat0} zf={zf} W={W} H={H} />];
  if (r) {
    const [sx, sy] = fn(r.sel.lon, r.sel.lat);
    const [nx, ny] = fn(r.nb.lon, r.nb.lat);
    o.push(
      <svg
        key="c"
        style={{ left: 0, top: 0, width: W, height: H }}
        width={W}
        height={H}
      >
        <circle
          cx={sx}
          cy={sy}
          r={r.rkm / kmpx}
          fill="#f5a460"
          fillOpacity=".45"
          stroke="#f0a060"
          strokeWidth="1.4"
        />
        <line
          x1={sx}
          y1={sy}
          x2={nx}
          y2={ny}
          stroke="#e8923a"
          strokeWidth="1.4"
          strokeDasharray="4 3"
        />
        <circle
          cx={sx}
          cy={sy}
          r="14"
          fill="none"
          stroke="#e8923a"
          strokeWidth="1.6"
        />
      </svg>,
    );
    for (const a of [...r.inview].sort(
      (p, q) => fn(p.lon, p.lat)[1] - fn(q.lon, q.lat)[1],
    )) {
      const [x, y] = fn(a.lon, a.lat);
      o.push(plane(x, y, r.col(r.deps.get(a.iata)!), 20));
    }
    o.push(
      txt(
        (sx + nx) / 2 + 4,
        (sy + ny) / 2 - 8,
        `${Math.round(r.rkm)} km`,
        10.5,
        "#8a5a2a",
        600,
      ),
    );
  }
  o.push(
    bx(
      5,
      5,
      28,
      85,
      "#fff",
      "#d3d8de",
      3,
      "box-shadow:0 1px 3px rgba(17,20,24,.2)",
    ),
    E(11, 11, 15, 15, "background:#394048;border-radius:50%"),
    I("polygon-filter", 19, 46, 16, "#394048"),
    I("cross", 19, 76, 14, "#394048"),
    I("cog", 546, 19, 16, "#5f6b7c"),
    mini_bar(567, 5, 324, 72, "#fff", "#e1e5ea", 3),
    E(582, 22, 30, 30, "background:#12a89d;border-radius:4px"),
    I("map-marker", 597, 37, 18, "#fff"),
    txt(
      622,
      28,
      r ? `[${r.sel.iata}] ${r.sel.name.slice(0, 20)} + ...` : "",
      12,
      "#215db0",
      700,
      160,
    ),
    txt(622, 45, "Airport (OpenFlights)", 10.5, "#5f6b7c"),
    bx(786, 21, 29, 31, "#fff", "#c5cbd3", 3),
    I("zoom-to-fit", 800, 36, 16, "#394048"),
    E(822, 21, 50, 31, "background:#2d72d2;border-radius:3px"),
    txt(847, 37, "Open", 12, "#fff", 400, 50, "c"),
    bx(
      5,
      285,
      28,
      80,
      "#fff",
      "#d3d8de",
      3,
      "box-shadow:0 1px 3px rgba(17,20,24,.2)",
    ),
    I("zoom-in", 19, 297, 16, "#394048"),
    I("zoom-out", 19, 325, 16, "#394048"),
    bx(5, 345, 28, 22, "#fff", "#d3d8de", 3),
    I("zoom-to-fit", 19, 356, 14, "#394048"),
    attribution(40, 364, ATTR),
    errBox(
      why("OpenFlights routes", rr) ?? why("OpenFlights airports", ar),
      300,
      330,
    ),
    Hit(
      822,
      21,
      50,
      31,
      "Open",
      r ? () => nav.go("d192") : undefined,
      "Airports not loaded",
    ),
    Hit(536, 9, 22, 22, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}

// the app's AIS palette (apps/web/src/globe/adapters/styles.ts:47-56, not exported)
const PALV: Record<string, string> = {
  Cargo: "#14b8a6",
  Tanker: "#d97706",
  Fishing: "#5eead4",
  Passenger: "#38bdf8",
  Tug: "#c084fc",
  "Pleasure craft": "#4ade80",
  Sailing: "#a5f3fc",
  SAR: "#ef4444",
  Military: "#f59e0b",
};

export function D201({ nav }: { nav: Nav }): JSX.Element {
  const W = 1661;
  const H = 866;
  const TOPH = 53;
  const MH = H - TOPH;
  const zf = 10;
  const setApp = useAppView((s) => s.setApp);
  const vr = useJson<Parameters<typeof vesselsOf>[0]>("/api/maritime/snapshot");
  const ves = useMemo(() => (vr?.data ? vesselsOf(vr.data) : null), [vr]);
  const [lo, la] = useMemo(
    () => (ves ? densCenter(zf, W, MH, ves) : [0, 0, 0]),
    [ves, MH],
  );
  const fn = useMemo(() => proj(lo, la, zf, W, MH), [lo, la, MH]);
  const vin = useMemo(
    () =>
      (ves ?? []).filter((v) => {
        const [x, y] = fn(v.lon, v.lat);
        return x > 0 && x < W && y > 0 && y < MH;
      }),
    [ves, fn, MH],
  );
  const tc = new Map<string, number>();
  for (const v of vin)
    tc.set(aisType(v.shipType), (tc.get(aisType(v.shipType)) ?? 0) + 1);
  const top3 = [...tc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .filter((t) => t !== "No value")
    .slice(0, 3);
  const cmap = new Map(top3.map((t) => [t, PALV[t] ?? "#8f99a8"]));
  const rows: Array<[string, string]> = [
    ...top3.map((t) => [t, cmap.get(t)!] as [string, string]),
    ...(
      [
        ["Other", "#2d72d2"],
        ["No value", "#8f99a8"],
      ] as Array<[string, string]>
    ).slice(0, 4 - top3.length),
  ];
  const o: N[] = [
    E(0, 0, W, H, "background:#fff"),
    E(0, TOPH, W, MH, "background:#e6e8ea"),
  ];
  if (ves)
    o.push(
      <Plate
        key={`p${lo},${la}`}
        lon={lo}
        lat={la}
        zf={zf}
        W={W}
        H={MH}
        top={TOPH}
      />,
    );
  for (const v of [...vin].sort(
    (a, b) => fn(a.lon, a.lat)[1] - fn(b.lon, b.lat)[1],
  )) {
    const [x, y] = fn(v.lon, v.lat);
    const t = aisType(v.shipType);
    o.push(
      I(
        "ship",
        x,
        y + TOPH,
        18,
        cmap.get(t) ?? (t !== "No value" ? "#2d72d2" : "#8f99a8"),
        "filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1.5px #fff);",
      ),
    );
  }
  // page tabs = the app's real top-level tab groups (apps/web/src/state/appView.ts APP_GROUPS)
  o.push(
    E(0, 0, W, TOPH, "background:#fff"),
    hairline(0, TOPH - 1, W, "#d3d8de"),
    E(0, 0, 53, TOPH - 1, "background:#f0f2f5"),
    I("application", 27, 28, 18, "#5f6b7c"),
  );
  let xx = 70;
  const hits: N[] = [];
  APP_GROUPS.forEach((gr, i) => {
    const w = gr.label.length * 6.9;
    o.push(
      txt(
        xx,
        28,
        gr.label,
        12.8,
        i === 0 ? "#215db0" : DARK,
        i === 0 ? 600 : 400,
      ),
    );
    if (i === 0) o.push(E(xx, 50, w + 2, 2, `background:${BLU}`));
    const first = gr.apps[0];
    hits.push(
      Hit(
        xx - 6,
        8,
        w + 14,
        40,
        `Open ${gr.label}`,
        first ? () => setApp(first) : undefined,
        "No app in this group",
      ),
    );
    xx += w + 22;
  });
  o.push(
    bx(
      5,
      60,
      28,
      85,
      "#fff",
      "#d3d8de",
      3,
      "box-shadow:0 1px 3px rgba(17,20,24,.2)",
    ),
    E(11, 66, 15, 15, "background:#394048;border-radius:50%"),
    I("polygon-filter", 19, 102, 16, "#394048"),
    I("cross", 19, 132, 14, "#394048"),
    bx(5, 777, 28, 56, "#fff", "#d3d8de", 3),
    I("zoom-in", 19, 791, 16, "#394048"),
    I("zoom-out", 19, 819, 16, "#394048"),
    bx(5, 842, 28, 22, "#fff", "#d3d8de", 3),
    I("zoom-to-fit", 19, 853, 14, "#394048"),
    I("cog", 1643, 73, 18, "#5f6b7c"),
    attribution(36, 857, ATTR),
    mini_bar(1433, 724, 214, 142, "#fbfbfc", "#e1e5ea", 3),
    txt(1449, 748, "VESSELS BY SHIP TYPE", 13, "#1c2127", 700),
  );
  rows.forEach(([lab, c], i) => {
    const yy = 775 + 18 * i;
    o.push(I("ship", 1457, yy, 16, c), txt(1470, yy + 0.5, lab, 12.5, DARK));
  });
  o.push(
    I("eye-open", 1621, 789, 16, "#394048"),
    I("minimize", 1640, 847, 15, "#394048"),
    errBox(why("AIS snapshot", vr), 300, 800),
    frag(hits),
    Hit(0, 0, 53, TOPH - 1, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}
