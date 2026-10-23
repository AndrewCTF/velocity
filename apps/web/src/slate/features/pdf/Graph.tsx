// The graph document (gotham-012-056, D31 D32 D33 D35 D36 D58) and its
// Search around state (gotham-013-061, D34 D37 D38 D39): sec_graph() and
// sec_graph2() of _build_gotham_b.py in the figures' own pixels. Every node is
// a real object: the selected track, its nearest ports, nearby vessels of the
// result set, the AIS feeds in its sources list, its flag state and the
// sanctions lookup. Links are drawn only where a record relates them.
import {
  A,
  Hit,
  I,
  IS,
  T,
  Tc,
  Tr,
  frag,
  sceneBg,
  toPx,
  type N,
} from "./kit.js";
import {
  TRK,
  km,
  nearestPorts,
  title,
  unavailable,
  type Hit as Row,
  type Warning,
} from "./data.js";
import type { Ctx, Page } from "./model.js";

const TILE_BG = "#282e36",
  TILE_BD = "#3a424d";
type Kind = "place" | "vessel" | "feed" | "flag" | "lists" | "doc";

/** One node: a tile, its glyph or photo, its label; `open` makes it a control. */
function tile(
  xc: number,
  yc: number,
  kind: Kind,
  label: string,
  o: {
    sel?: boolean;
    size?: number;
    photo?: string;
    lab_w?: number;
    open?: (() => void) | undefined;
    why?: string | undefined;
  } = {},
): N[] {
  const { sel = false, size = 42, photo, lab_w = 96 } = o;
  const out: N[] = [
    A(
      xc - size / 2,
      yc - size / 2,
      size,
      size,
      `background:${TILE_BG};border:${sel ? "2px solid #c2ccd4" : `1px solid ${TILE_BD}`};border-radius:2px`,
    ),
  ];
  if (photo)
    out.push(
      A(xc - size / 2 + 2, yc - size / 2 + 2, size - 4, size - 4, photo),
    );
  else
    out.push(
      kind === "place"
        ? I("map-marker", xc, yc, 26, "#d9a63a")
        : kind === "vessel"
          ? IS("ship", xc, yc, 26, "#9aa5b1")
          : kind === "feed"
            ? I("feed", xc, yc, 24, "#4c9bf0")
            : kind === "flag"
              ? I("flag", xc, yc, 24, "#d65a5a")
              : kind === "lists"
                ? I("shield", xc, yc, 26, "#8fb8ee")
                : I("document", xc, yc, 24, "#c9cfd6"),
    );
  out.push(Tc(xc, yc + size / 2 + 9, label, "#e5e8eb", 8.3, lab_w));
  out.push(
    Hit(
      xc - size / 2,
      yc - size / 2,
      size,
      size,
      label,
      o.open,
      o.why ?? `${label}: no object view for this node`,
    ),
  );
  return out;
}

type Edge = [x0: number, y0: number, x1: number, y1: number, label: string];
/** edges drawn centre to centre under the tiles */
function edgeSvg(
  W: number,
  H: number,
  edges: Edge[],
  sel_idx: number | null = null,
  arrows = false,
  labels = false,
): N[] {
  const lines: JSX.Element[] = [];
  const lab: N[] = [];
  edges.forEach(([x0, y0, x1, y1, tx], k) => {
    const thick = k === sel_idx;
    lines.push(
      <line
        key={`l${k}`}
        x1={x0}
        y1={y0}
        x2={x1}
        y2={y1}
        stroke={thick ? "#d9dee3" : "#7d8791"}
        strokeWidth={thick ? 3 : 1}
      />,
    );
    if (arrows) {
      const dx = x1 - x0,
        dy = y1 - y0;
      const n = Math.hypot(dx, dy) || 1;
      const ux = dx / n,
        uy = dy / n;
      const bx = x1 - ux * 25,
        by = y1 - uy * 25;
      const pts = `${bx.toFixed(1)},${by.toFixed(1)} ${(bx - ux * 7 + uy * 3.2).toFixed(1)},${(by - uy * 7 - ux * 3.2).toFixed(1)} ${(bx - ux * 7 - uy * 3.2).toFixed(1)},${(by - uy * 7 + ux * 3.2).toFixed(1)}`;
      lines.push(<polygon key={`p${k}`} fill="#e5e8eb" points={pts} />);
    }
    if (labels && tx)
      lab.push(
        Tc(
          (x0 + x1) / 2 + (x1 - x0) * 0.08,
          (y0 + y1) / 2 + (y1 - y0) * 0.08,
          tx,
          "#e5e8eb",
          7.2,
          Math.max(40, 4.4 * tx.length),
          "background:#1c2028;height:10px;line-height:10px",
        ),
      );
  });
  return [
    <svg style={{ left: 0, top: 0, width: W, height: H, overflow: "visible" }}>
      {lines}
    </svg>,
    ...lab,
  ];
}

function hrow(
  x_name: number,
  x_cnt: number,
  x_bar: number,
  bw: number,
  yc: number,
  name: string,
  cnt: number,
  frac: number,
  o: {
    sel?: boolean;
    icon?: N;
    frac_txt?: string;
    rowx?: number;
    roww?: number;
  } = {},
): N[] {
  const out: N[] = [];
  if (o.sel)
    out.push(
      A(
        o.rowx ?? -6,
        yc - 9,
        o.roww ?? x_bar + bw + 8,
        18,
        "border:1px solid #2672da;border-radius:1px;background:#28384e",
      ),
    );
  if (o.icon) out.push(o.icon);
  out.push(
    T(x_name, yc, name, "#f1f4f5", 9.6),
    Tr(x_cnt, yc, o.frac_txt ?? String(cnt), "#aab4bc", 9.2, 40),
  );
  out.push(
    A(x_bar, yc - 5.5, bw, 11, "background:#182838"),
    A(
      x_bar,
      yc - 5.5,
      Math.max(3, bw * frac),
      11,
      `background:${o.sel ? "#2672da" : "#7fb0f6"}`,
    ),
  );
  return out;
}

const hsec = (
  x: number,
  yc: number,
  name: string,
  cnt: number,
  xr: number,
  pic: N = null,
): N[] => [
  I("caret-down", x + 4, yc, 9, "#c3ccd2"),
  pic,
  T(
    x + (pic ? 32 : 15),
    yc,
    name,
    "#aab4bc",
    9.2,
    400,
    "font-weight:600;letter-spacing:.02em",
  ),
  Tr(xr, yc, String(cnt), "#aab4bc", 9, 30),
];

const graphCanvas = (W: number, H: number, y0 = 40): N[] => [
  A(0, 0, W, H, "background:#1c2028"),
  A(
    0,
    y0,
    W,
    H - y0,
    "background:#1c2028;background-image:radial-gradient(circle,#3a424c 1px,transparent 1.4px);background-size:22.6px 22.6px;background-position:8px 6px",
  ),
];

const VIEW_ONLY =
  "Styling is fixed in this view; the graph is drawn from the live records";
function ribbon(go: (p: Page) => void, find = true): N[] {
  const box = "background:#242832;border:1px solid #1a1e24;border-radius:3px";
  const o: N[] = [
    A(9, 47, 85, 39, box),
    A(99, 47, 54, 39, box),
    A(157, 47, 468, 39, box),
  ];
  for (const [x, tx] of [
    [13, "Organize"],
    [104, "Annotations"],
    [161, "Node styling"],
    [246, "Link styling"],
    [386, "Annotation styling"],
  ] as const)
    o.push(T(x, 55, tx, "#d5dbe0", 8.8, 400, "font-weight:600"));
  const G = "#aab4bc";
  o.push(
    I("layout-auto", 22, 74, 12, G),
    I("caret-down", 36, 76, 8, G),
    I("layers", 64, 74, 13, G),
    I("caret-down", 78, 76, 8, G),
  );
  o.push(I("new-text-box", 110, 73, 12, G), I("new-link", 132, 74, 12, G));
  o.push(
    A(165, 70, 8, 8, "background:#5d646e"),
    I("caret-down", 184, 76, 8, "#5d646e"),
    T(209, 74, "4", "#5d646e", 9),
    I("caret-down", 222, 76, 8, "#5d646e"),
  );
  o.push(
    A(238, 50, 1, 34, "background:#363c46"),
    A(252, 70, 9, 9, "background:#5d646e"),
    I("caret-down", 270, 76, 8, "#5d646e"),
    A(291, 74, 9, 1.5, "background:#aab4bc"),
    I("caret-down", 312, 76, 8, G),
    T(335, 74, "1px", "#5d646e", 9),
    I("caret-down", 358, 76, 8, "#5d646e"),
  );
  o.push(
    A(378, 50, 1, 34, "background:#363c46"),
    A(391, 70, 9, 9, "background:#5d646e"),
    I("caret-down", 409, 76, 8, "#5d646e"),
    A(432, 69, 11, 11, "border:1.5px solid #aab4bc"),
    I("caret-down", 451, 76, 8, G),
    A(476, 74, 9, 1.5, "background:#aab4bc"),
    I("caret-down", 495, 76, 8, G),
    T(517, 74, "1px", "#5d646e", 9),
    I("caret-down", 539, 76, 8, "#5d646e"),
    I("align-left", 568, 74, 12, G),
    I("caret-down", 582, 76, 8, G),
  );
  o.push(
    A(602, 50, 1, 34, "background:#363c46"),
    I("chevron-left", 613, 66, 10, "#d5dbe0"),
  );
  o.push(
    Hit(9, 47, 85, 39, "Organize", undefined, VIEW_ONLY),
    Hit(
      99,
      47,
      54,
      39,
      "Annotations",
      undefined,
      "Annotations are not stored for this graph",
    ),
    Hit(
      157,
      47,
      445,
      39,
      "Node, link and annotation styling",
      undefined,
      VIEW_ONLY,
    ),
  );
  if (find) o.push(...findBox(9, 96, 220, go));
  return o;
}

function findBox(x: number, y: number, w: number, go: (p: Page) => void): N[] {
  return [
    A(
      x,
      y,
      w,
      28,
      "background:#242832;border:1px solid #1a1e24;border-radius:3px",
    ),
    I("zoom-in", x + 11, y + 14, 12, "#aab4bc"),
    T(x + 24, y + 14, "Find artifacts, objects and links...", "#cfd6dc", 10.3),
    A(x + w - 24, y + 4, 1, 20, "background:#363c46"),
    I("chevron-left", x + w - 12, y + 14, 10, "#d5dbe0"),
    Hit(x, y, w, 28, "Find artifacts, objects and links: the Browser", () =>
      go("browser"),
    ),
  ];
}

function vtabStrip(go: (p: Page) => void, yc0 = 59): N[] {
  const o: N[] = [
    A(856, 47, 20, 120, "background:#242832;border-radius:2px 0 0 2px"),
    A(856, 48, 20, 22, "background:#424650"),
  ];
  vtabs().forEach(([ic, label, to], k) =>
    o.push(
      I(ic, 866, yc0 + 22.5 * k, 12, "#e5e8eb"),
      Hit(
        856,
        yc0 + 22.5 * k - 11,
        20,
        22,
        label,
        to ? () => go(to) : undefined,
      ),
    ),
  );
  return o;
}
const vtabs = (): [string, string, Page | null][] => [
  ["properties", "Properties: the custom object view", "cov"],
  ["info-sign", "Info: the Browser", "browser"],
  ["history", "History: the object's inbox feed", "inbox"],
  ["layers", "Layers: the map", "gaia"],
  ["warning-sign", "Warnings: the inbox", "inbox"],
];

const zoomCluster = (xs: number, y0: number): N[] =>
  (["zoom-in", "zoom-to-fit", "zoom-out"] as const).flatMap((ic, k) => [
    A(xs - 11, y0 + k * 22.5 - 11, 22, 22, "background:#1c2028"),
    I(ic, xs, y0 + k * 22.5, 14, "#e5e8eb"),
    Hit(
      xs - 11,
      y0 + k * 22.5 - 11,
      22,
      22,
      ic === "zoom-in"
        ? "Zoom in"
        : ic === "zoom-out"
          ? "Zoom out"
          : "Zoom to fit",
      undefined,
      "The graph is laid out at the figure's scale",
    ),
  ]);

/** the view tabs (D58): list, map, timeline */
const bottomTabs = (go: (p: Page) => void, y = 632): N[] => [
  A(8, y, 72, 16, "background:#242832;border-radius:2px"),
  I("th-list", 19, y + 10, 12, "#e5e8eb"),
  I("zoom-to-fit", 40, y + 10, 12, "#e5e8eb"),
  I("time", 66, y + 10, 12, "#e5e8eb"),
  Hit(10, y, 20, 16, "List: the Object Explorer", () => go("explorer")),
  Hit(30, y, 20, 16, "Map: the map", () => go("gaia")),
  Hit(54, y, 24, 16, "Timeline: the AIS timeline", () => go("timeline")),
];

/** The graph's node set, from the live model (the builder's graph model). */
export function graphModel(c: Ctx) {
  const SELR = c.sel;
  if (!SELR) return null;
  const at = [SELR.v.lon, SELR.v.lat];
  const NEARV = c.res
    .filter((r) => r !== SELR)
    .map((r) => ({ r, dd: km(at, [r.v.lon, r.v.lat]) }))
    .sort((a, b) => a.dd - b.dd);
  const FEEDS = SELR.v.sources?.length
    ? SELR.v.sources
    : [SELR.v.source ?? "n/a"];
  const NEARP = nearestPorts(c.ports, SELR.v.lon, SELR.v.lat, 5).map((p) => ({
    t: title(p.name),
    d: km(at, [p.lon, p.lat]),
  }));
  const FLAG = c.entity?.flag_country ?? "n/a";
  const w0 =
    [...c.warnings]
      .filter((f) => f.geometry)
      .sort((a, b) => dist(a, at) - dist(b, at))[0] ?? null;
  const WARNKM = w0 ? km(at, w0.geometry!.coordinates) : null;
  const WARNT = w0
    ? `NAVAREA ${w0.properties.navArea} ${w0.properties.msgNumber}/${String(w0.properties.msgYear).slice(2)}`
    : "n/a";
  const [px, py] = toPx(SELR.v.lon, SELR.v.lat);
  const ph = (size: number): string => sceneBg(px, py, size - 4, size - 4, 2.2);
  return {
    SELR,
    SELT: TRK(SELR.mmsi),
    NEARV,
    FEEDS,
    NEARP,
    FLAG,
    WARNKM,
    WARNT,
    ph,
  };
}
const dist = (f: Warning, at: number[]): number =>
  Math.hypot(
    (f.geometry!.coordinates[0] ?? 0) - (at[0] ?? 0),
    (f.geometry!.coordinates[1] ?? 0) - (at[1] ?? 0),
  );

function empty(W: number, H: number, c: Ctx, y0: number): JSX.Element {
  return frag([
    ...graphCanvas(W, H, y0),
    T(
      40,
      y0 + 60,
      c.boxRes && !c.boxRes.ok
        ? unavailable("AIS box", c.boxRes)
        : "No vessel matches the search, so the graph has no subject.",
      "#aab4bc",
      11,
    ),
  ]);
}

/** gotham-012-056 below its menu bar (the menu bar is MenuBar in Dossier.tsx). */
export function Graph({ c }: { c: Ctx }): JSX.Element {
  const W = 1157,
    H = 648;
  const g = graphModel(c);
  if (!g) return empty(W, H, c, 40);
  const { SELR, SELT, NEARV, FEEDS, NEARP, FLAG } = g;
  const N56_VESS: { r: Row; dd: number }[] = [
    { r: SELR, dd: 0 },
    ...NEARV.slice(0, 9),
  ];
  const N56_TYPES: [string, number][] = [
    ["Vessel", N56_VESS.length],
    ["Place", NEARP.length],
    ["AIS feed", FEEDS.length],
    ["Flag state", 1],
    ["Sanctions lookup", 1],
  ];
  const vcount = (key: (r: Row) => string): [string, number][] => {
    const m = new Map<string, number>();
    for (const { r } of N56_VESS) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  };
  const o: N[] = [...graphCanvas(W, H)];
  o.push(A(0, 0, W, 40, "background:#1c2028"));
  const cx = 545,
    cy = 320;
  const top: [number, number][] = [
    [408, 162],
    [480, 162],
    [552, 162],
    [636, 162],
    [728, 162],
  ];
  const lef: [number, number][] = [
    [51, 427],
    [120, 427],
    [189, 427],
    [51, 496],
    [120, 496],
    [189, 496],
    [51, 565],
    [120, 565],
    [189, 565],
  ];
  const edges: Edge[] = [
    ...top.slice(0, NEARP.length).map(([x, y]): Edge => [cx, cy, x, y, ""]),
  ];
  if (N56_VESS.length > 1) edges.push([cx, cy, 189, 427, ""]);
  edges.push(
    [cx, cy, 718, 490, ""],
    [cx, cy, 822, 490, ""],
    ...FEEDS.slice(0, 3).map((_, k): Edge => [cx, cy, 650 + 69 * k, 560, ""]),
  );
  o.push(...edgeSvg(W, H, edges, N56_VESS.length > 1 ? NEARP.length : null));
  top.forEach(([x, y], i) => {
    const pl = NEARP[i];
    if (pl)
      o.push(
        ...tile(x, y, "place", pl.t, {
          lab_w: 110,
          open: () => {
            c.setKw(pl.t);
            c.go("browser");
          },
        }),
      );
  });
  o.push(
    ...tile(cx, cy, "vessel", SELT, {
      sel: true,
      photo: g.ph(42),
      open: () => c.go("graph2"),
    }),
  );
  const order = [2, 1, 0, 5, 4, 3, 8, 7, 6];
  N56_VESS.slice(1).forEach(({ r }, i) => {
    const [x, y] = lef[order[i]!]!;
    o.push(
      ...tile(x, y, "vessel", title(r.name), {
        lab_w: 90,
        open: () => c.pick(r.mmsi),
      }),
    );
  });
  o.push(
    ...tile(718, 490, "flag", `Flag state ${FLAG}`, {
      lab_w: 120,
      why: "Flag state comes from the entity lookup",
    }),
  );
  FEEDS.slice(0, 3).forEach((f, k) =>
    o.push(
      ...tile(650 + 69 * k, 560, "feed", f, {
        lab_w: 70,
        why: `${f} is an AIS feed in this vessel's sources list`,
      }),
    ),
  );
  o.push(
    ...tile(
      822,
      490,
      "lists",
      c.sanc ? c.sanc.lists.join(", ") : "Sanctions lookup",
      { lab_w: 130, open: () => c.go("cov") },
    ),
  );
  o.push(...ribbon(c.go), ...vtabStrip(c.go));
  // histogram panel (D36)
  o.push(A(877, 47, 268, 601, "background:#242832;border:1px solid #1a1e24"));
  o.push(
    T(886, 59, "Histogram", "#f1f4f5", 11.5, 400, "font-weight:600"),
    I("cross", 1135, 59, 10, "#e5e8eb"),
    A(878, 72, 266, 1, "background:#363c46"),
    I("double-caret-vertical", 1082, 86, 12, "#e5e8eb"),
    I("collapse-all", 1105, 86, 12, "#e5e8eb"),
    A(1121, 78, 1, 16, "background:#363c46"),
    I("search-template", 1135, 86, 13, "#e5e8eb"),
    A(878, 100, 266, 1, "background:#363c46"),
  );
  o.push(
    Hit(1128, 52, 14, 14, "Close the histogram: the Object Explorer", () =>
      c.go("explorer"),
    ),
  );
  o.push(T(886, 117, "OBJECT TYPES", "#aab4bc", 10.2, 400, "font-weight:600"));
  o.push(
    ...hsec(
      886,
      139,
      "OBJECTS",
      N56_VESS.length + NEARP.length + FEEDS.length + 2,
      1131,
    ),
  );
  const mx = Math.max(1, N56_TYPES[0]![1]);
  const ICO: Record<string, [string, string]> = {
    Place: ["geosearch", "#d9a63a"],
    "AIS feed": ["feed", "#4c9bf0"],
    "Flag state": ["flag", "#d65a5a"],
    "Sanctions lookup": ["shield", "#8fb8ee"],
  };
  N56_TYPES.forEach(([nm, cnt], k) => {
    const yc = 165 + 17 * k;
    const ic =
      nm === "Vessel"
        ? IS("ship", 909, yc, 12, "#9aa5b1")
        : I(ICO[nm]![0], 909, yc, 12, ICO[nm]![1]);
    o.push(...hrow(921, 1048, 1053, 78, yc, nm, cnt, cnt / mx, { icon: ic }));
  });
  o.push(
    A(1053, 160, 78, 11, "background:#2672da"),
    I("caret-right", 1124, 165, 7, "#0b2a55"),
  );
  o.push(T(903, 252, "Show more...", "#aab4bc", 9.2));
  o.push(
    T(886, 285, "PROPERTY VALUES", "#aab4bc", 10.2, 400, "font-weight:600"),
  );
  let y = 307;
  const pv: [string, [string, number][]][] = [
    ["FLAG STATE", [[FLAG, 1]]],
    ["NAME", N56_VESS.map(({ r }) => [title(r.name), 1])],
    ["SPEED OVER GROUND (KN)", vcount((r) => r.sog.toFixed(1))],
    ["SHIP TYPE", vcount((r) => r.type)],
  ];
  for (const [nm, vals] of pv) {
    o.push(
      ...hsec(886, y, nm, vals.length, 1131, I("tag", 909, y, 11, "#c3ccd2")),
    );
    y += 27;
    const vm = Math.max(1, ...vals.map((v) => v[1]));
    for (const [v, cnt] of vals.slice(0, 5)) {
      o.push(
        T(903, y, v, "#f1f4f5", 9.6),
        Tr(1048, y, String(cnt), "#aab4bc", 9, 40),
        A(1053, y - 5.5, 78, 11, "background:#182838"),
        A(1053, y - 5.5, (78 * cnt) / vm, 11, "background:#7fb0f6"),
      );
      y += 17;
    }
    const last = y - 17;
    if (vals.length > 5) {
      o.push(T(903, last + 19, "Show more...", "#aab4bc", 9.2));
      y = last + 29;
    } else y = last + 26;
  }
  o.push(A(1136, 100, 6, 130, "background:#c2ccd4;border-radius:3px"));
  o.push(...bottomTabs(c.go), ...zoomCluster(858, 588));
  return frag(o);
}

/** gotham-013-061: the Search around state of the same graph. */
export function Graph2({ c }: { c: Ctx }): JSX.Element {
  const W = 1143,
    H = 691;
  const g = graphModel(c);
  if (!g) return empty(W, H, c, 22);
  const { SELR, SELT, NEARV, FEEDS, NEARP, FLAG, WARNKM, WARNT } = g;
  const V5 = [SELR, ...NEARV.slice(0, 4).map((x) => x.r)];
  const _prop = (fn: (r: Row) => string): [string, number, number][] => {
    const m = new Map<string, number>();
    for (const r of V5) m.set(fn(r), (m.get(fn(r)) ?? 0) + 1);
    const sv = fn(SELR);
    return [...m.entries()]
      .map(([k, v]): [string, number, number] => [k, v, k === sv ? 1 : 0])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const o: N[] = [...graphCanvas(W, H, 22)];
  // menubar (context only)
  o.push(A(0, 0, W, 22, "background:#101418"));
  for (const [x, tx] of [
    [8, "File"],
    [36, "Edit"],
    [64, "View"],
    [97, "Develop"],
    [143, "Insert"],
    [180, "Selection"],
    [230, "Window"],
    [274, "Help"],
  ] as const)
    o.push(
      T(x, 10, tx, "#f1f4f5", 10, 400, "font-weight:500"),
      Hit(
        x - 3,
        2,
        tx.length * 6 + 6,
        17,
        tx,
        undefined,
        "The graph's menus are the graph document's (Escape returns to the Object Explorer)",
      ),
    );
  o.push(
    A(308, 4, 1, 14, "background:#2a3038"),
    I("tick", 316, 10, 10, "#3fb27f"),
    T(326, 10, "Saved", "#8f99a8", 9),
    I("send-to-graph", 520, 10, 11, "#e0a64a"),
    T(
      533,
      10,
      `Investigation into ${SELT}`,
      "#f1f4f5",
      10,
      400,
      "font-weight:500",
    ),
    I("star-empty", 690, 10, 10, "#c3ccd2"),
    I("caret-down", 704, 10, 8, "#8f99a8"),
    T(1054, 10, "Share", "#f1f4f5", 10),
    I("shield", 1092, 10, 10, "#f1f4f5"),
    T(1104, 10, "OSINT", "#f1f4f5", 8.5),
  );
  o.push(Hit(514, 2, 180, 17, "The graph document", () => c.go("menubar")));
  const cx = 499,
    cy = 356;
  const nv = (
    i: number,
  ): [Kind, number, number, string, string, (() => void) | undefined][] => {
    const v = NEARV[i];
    const pos: [number, number][] = [
      [381, 433],
      [312, 466],
      [371, 352],
      [230, 360],
    ];
    return v
      ? [
          [
            "vessel",
            pos[i]![0],
            pos[i]![1],
            title(v.r.name),
            `Nearby ${v.dd.toFixed(1)} km`,
            () => c.pick(v.r.mmsi),
          ],
        ]
      : [];
  };
  const np = (
    i: number,
    x: number,
    y: number,
  ): [Kind, number, number, string, string, (() => void) | undefined][] => {
    const p = NEARP[i];
    return p
      ? [
          [
            "place",
            x,
            y,
            p.t,
            `Nearby ${p.d.toFixed(0)} km`,
            () => {
              c.setKw(p.t);
              c.go("browser");
            },
          ],
        ]
      : [];
  };
  const feed = (i: number): string => FEEDS[i] ?? FEEDS[0] ?? "n/a";
  const sl: [Kind, number, number, string, string, (() => void) | undefined][] =
    [
      ...(WARNKM !== null
        ? [
            [
              "doc",
              495,
              185,
              WARNT,
              `Nearby ${WARNKM.toFixed(0)} km`,
              () => c.go("inbox"),
            ] as [Kind, number, number, string, string, () => void],
          ]
        : []),
      ...np(0, 568, 198),
      ...np(1, 601, 260),
      ...np(2, 665, 302),
      [
        "lists",
        640,
        372,
        c.sanc
          ? `${c.sanc.lists.join(", ")}: ${c.sanc.matched ? "match" : "no match"}`
          : unavailable("Sanctions lookup", c.sancRes),
        "Looked up in",
        () => c.go("cov"),
      ],
      ["flag", 648, 452, `Flag state ${FLAG}`, "Flag state", undefined],
      ["feed", 584, 475, feed(0), "Reported by", undefined],
      ["feed", 511, 525, feed(1), "Reported by", undefined],
      ["feed", 424, 466, feed(2), "Reported by", undefined],
      ...nv(0),
      ...nv(1),
      ...nv(2),
      ...nv(3),
    ];
  o.push(
    ...edgeSvg(
      W,
      H,
      sl.map(([, x, y, , lb]): Edge => [cx, cy, x, y, lb]),
      null,
      true,
      true,
    ),
  );
  for (const [kind, x, y, lab, , open] of sl)
    o.push(
      ...tile(x, y, kind, lab, {
        lab_w: 130,
        open,
        why:
          kind === "feed"
            ? `${lab} is an AIS feed in this vessel's sources list`
            : undefined,
      }),
    );
  o.push(
    ...tile(cx, cy, "vessel", SELT, {
      size: 40,
      photo: g.ph(40),
      lab_w: 100,
      open: () => c.go("cov"),
    }),
  );
  o.push(
    <div
      className="fr"
      style={{ left: 0, top: -18, width: 432, height: 90, overflow: "hidden" }}
    >
      {frag(ribbon(c.go, false))}
    </div>,
  );
  o.push(...findBox(9, 74, 194, c.go));
  o.push(
    A(406, 29, 25, 34, "background:#242832;border:1px solid #1a1e24"),
    I("chevron-left", 420, 46, 10, "#d5dbe0"),
  );
  o.push(
    A(880, 28, 20, 82, "background:#242832"),
    A(880, 29, 20, 20, "background:#424650"),
  );
  vtabs()
    .slice(0, 4)
    .forEach(([ic, label, to], k) =>
      o.push(
        I(ic, 890, 39 + 20.5 * k, 12, "#e5e8eb"),
        Hit(880, 29 + 20.5 * k, 20, 20, label, to ? () => c.go(to) : undefined),
      ),
    );
  // context menu (D38): Search around opens the object's own links
  const mn = "#2e323c";
  const sh =
    "border:1px solid #1a1e24;border-radius:3px;box-shadow:0 3px 10px rgba(0,0,0,.45)";
  o.push(
    A(241, 103, 123, 283, `background:${mn};${sh}`),
    A(364, 163, 121, 179, `background:${mn};${sh}`),
    A(242, 166, 122, 21, "background:#3e424c"),
  );
  o.push(
    T(250, 116, "1 selected item", "#f1f4f5", 9.4, 400, "font-weight:700"),
  );
  const item = (
    yc: number,
    ic: string,
    tx: string,
    ar: boolean,
    x = 254,
    fn?: () => void,
    why = "Not available for a live AIS object",
  ): N[] => [
    I(ic, x, yc, 11, "#c3ccd2"),
    T(x + 11, yc, tx, "#f1f4f5", 9.6),
    ar && x === 254 ? I("caret-right", 350, yc, 9, "#c3ccd2") : null,
    Hit(x - 10, yc - 10, x === 254 ? 120 : 118, 20, tx, fn, why),
  ];
  const M1: [number, string, string, boolean, (() => void) | undefined][] = [
    [
      135,
      "filter-keep",
      "Add selection as filter",
      false,
      () => c.go("explorer"),
    ],
    [155, "select", "Select on graph", true, undefined],
    [176, "search-around", "Search around", true, () => c.go("menubar")],
    [196, "layout-auto", "Layout", true, undefined],
    [217, "layers", "Layers", true, () => c.go("gaia")],
    [237, "take-action", "Actions", true, () => c.go("browser")],
  ];
  for (const [yc, ic, tx, ar, fn] of M1)
    o.push(...item(yc, ic, tx, ar, 254, fn));
  o.push(
    A(243, 250, 120, 1, "background:#424650"),
    T(250, 264, "1 selected node", "#f1f4f5", 9.4, 400, "font-weight:700"),
  );
  const M2: [number, string, string, boolean][] = [
    [284, "style", "Style", true],
    [304, "edit", "Edit label...", false],
    [324, "merge-links", "Merge", true],
    [344, "unlink", "Unresolve", false],
    [372, "remove", "Remove", true],
  ];
  for (const [yc, ic, tx, ar] of M2)
    o.push(
      ...item(
        yc,
        ic,
        tx,
        ar,
        254,
        undefined,
        "The graph is drawn from the live records; nodes are not edited here",
      ),
    );
  o.push(A(243, 357, 120, 1, "background:#424650"));
  const M3: [number, string, string, Page | null][] = [
    [176, "document", "Documents", "inbox"],
    [196, "people", "Entities", "browser"],
    [216, "timeline-events", "Events", "timeline"],
    [237, "properties", "Properties", "cov"],
    [257, "citation", "Record Sourcing", "cov"],
    [277, "search-around", "Related artifacts", "browser"],
  ];
  for (const [yc, ic, tx, to] of M3)
    o.push(...item(yc, ic, tx, false, 377, to ? () => c.go(to) : undefined));
  o.push(
    T(371, 298, "More...", "#f1f4f5", 9.6),
    A(366, 312, 117, 1, "background:#424650"),
    T(371, 326, "Create new search...", "#f1f4f5", 9.6),
  );
  o.push(
    Hit(366, 289, 118, 18, "More: the custom object view", () => c.go("cov")),
    Hit(366, 317, 118, 18, "Create new search: the Browser", () =>
      c.go("browser"),
    ),
  );
  // minimap + zoom (D39): the real node positions
  o.push(
    A(781, 621, 84, 55, "background:#1c2028;border:1px solid #363c46"),
    A(823, 637, 37, 23, "background:#44445c"),
  );
  for (const [, x, y] of sl.slice(0, 12))
    o.push(
      A(
        823 + ((x - 230) / 440) * 36,
        639 + ((y - 185) / 340) * 19,
        2,
        2,
        "background:#9aa5b1",
      ),
    );
  o.push(...zoomCluster(881, 632), ...bottomTabs(c.go, 672));
  // histogram (D37): selected / total over this graph's nodes
  o.push(A(902, 28, 233, 650, "background:#242832;border:1px solid #1a1e24"));
  o.push(
    T(907, 39, "Histogram", "#f1f4f5", 11.2, 400, "font-weight:600"),
    I("cross", 1126, 39, 10, "#e5e8eb"),
    A(903, 51, 231, 1, "background:#363c46"),
    I("double-caret-vertical", 1079, 62, 12, "#e5e8eb"),
    I("collapse-all", 1099, 62, 12, "#e5e8eb"),
    A(1112, 55, 1, 14, "background:#363c46"),
    I("search-template", 1126, 62, 13, "#e5e8eb"),
    A(903, 75, 231, 1, "background:#363c46"),
  );
  o.push(
    Hit(1119, 32, 14, 14, "Close the histogram: the graph document", () =>
      c.go("menubar"),
    ),
  );
  o.push(T(907, 90, "OBJECT TYPES", "#aab4bc", 10, 400, "font-weight:600"));
  const nPlace = Math.min(3, NEARP.length),
    nFeed = Math.min(3, FEEDS.length);
  const nent = V5.length + nPlace + nFeed + 2;
  const hr = (
    yc: number,
    nm: string,
    tot: number,
    sel: number,
    icon: N,
    frac: number,
  ): N[] =>
    hrow(937, 1050, 1054, 68, yc, nm, 0, tot / Math.max(frac, 1), {
      sel: !!sel,
      icon,
      frac_txt: `${sel}/${tot}`,
      rowx: 907,
      roww: 220,
    });
  o.push(...hsec(907, 110, "SUMMARY", 2, 1127));
  o.push(
    ...hr(133, "Entity", nent, 1, I("circle", 926, 133, 10, "#4c8bd6"), nent),
    ...hr(
      148,
      "Document",
      WARNKM !== null ? 1 : 0,
      0,
      I("document", 926, 148, 10, "#c9cfd6"),
      1,
    ),
  );
  o.push(...hsec(907, 171, "ENTITY", 5, 1127));
  const ents: [string, number, number, N][] = [
    ["Vessel", V5.length, 1, IS("ship", 926, 195, 11, "#9aa5b1")],
    ["Place", nPlace, 0, I("geosearch", 926, 210, 11, "#d9a63a")],
    ["AIS feed", nFeed, 0, I("feed", 926, 225, 11, "#4c9bf0")],
    ["Flag state", 1, 0, I("flag", 926, 240, 11, "#d65a5a")],
    ["Sanctions lookup", 1, 0, I("shield", 926, 255, 11, "#8fb8ee")],
  ];
  ents.forEach(([nm, tot, sel, ic], k) =>
    o.push(...hr(195 + 15 * k, nm, tot, sel, ic, V5.length)),
  );
  o.push(T(990, 272, "Show more...", "#aab4bc", 9.2));
  o.push(
    ...hsec(907, 298, "DOCUMENT", WARNKM !== null ? 1 : 0, 1127),
    ...hr(
      321,
      "NGA warning",
      WARNKM !== null ? 1 : 0,
      0,
      I("document", 926, 321, 11, "#c9cfd6"),
      V5.length,
    ),
  );
  o.push(T(907, 371, "PROPERTY VALUES", "#aab4bc", 10, 400, "font-weight:600"));
  let y = 391;
  const props: [string, (r: Row) => string][] = [
    ["SHIP TYPE", (r) => r.type],
    ["FLAG STATE", (r) => r.v.flag ?? "n/a"],
    ["SOURCE", (r) => r.v.source ?? "n/a"],
    ["SPEED OVER GROUND (KN)", (r) => r.sog.toFixed(1)],
  ];
  for (const [nm, fn] of props) {
    const vals = _prop(fn);
    o.push(
      ...hsec(907, y, nm, vals.length, 1127, I("tag", 926, y, 10, "#c3ccd2")),
    );
    y += 27;
    for (const [v, tot, sel] of vals.slice(0, 4)) {
      o.push(
        ...hrow(922, 1050, 1054, 68, y, v, 0, tot / V5.length, {
          sel: !!sel,
          frac_txt: `${sel}/${tot}`,
          rowx: 907,
          roww: 220,
        }),
      );
      y += 17;
    }
    y += 10;
  }
  return frag(o);
}
