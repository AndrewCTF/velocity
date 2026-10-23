// E4 / E5 / E6: the Gaia map frame (gaia_map() in _build_features.py), crop
// 730,273 1140x641, and the shared pieces E7 and E9 reuse: the satellite
// layer (Esri World Imagery z17 mosaic of Port Rashid / Dubai Creek with the
// live AIS tracks of its bbox), the rail and the window chrome.
import type { CSSProperties } from "react";
import {
  A,
  I,
  T,
  Hit,
  circ,
  frag,
  hexlogo,
  insetFrame,
  css,
  type N,
} from "./ui.js";
import {
  NX,
  NY,
  SATW,
  SATH,
  UTC,
  grow,
  hull,
  pickMarkers,
  tileUrl,
  unavailable,
  watchBoxes,
  type Evid,
  type Res,
  type SatV,
} from "./data.js";
// shortcut: reference-derived image kept out of the repo; the page draws without it. Ship a licensed asset to restore it.
const world: string = "";

export const MX = 800;
export const MY = 45; // mosaic px shown at the map's top-left corner
export type Go = (page: Page) => void;
export type Page =
  | "chat"
  | "gaia"
  | "map"
  | "slides"
  | "present1"
  | "present2"
  | "graph"
  | "lineage"
  | "globe"
  | "ring";

/** The mosaic as one image of SATW x SATH px scaled by k, top-left at (left, top). */
export function Mosaic({
  left,
  top,
  k,
  style,
}: {
  left: number;
  top: number;
  k: number;
  style?: CSSProperties;
}): JSX.Element {
  const tiles: N[] = [];
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NY; j++)
      tiles.push(
        <img
          key={`${i}.${j}`}
          alt=""
          src={tileUrl(i, j)}
          style={{
            position: "absolute",
            left: 256 * i * k,
            top: 256 * j * k,
            width: 256 * k + 0.5,
            height: 256 * k + 0.5,
            maxWidth: "none",
          }}
        />,
      );
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: SATW * k,
        height: SATH * k,
        ...style,
      }}
    >
      {tiles}
    </div>
  );
}
/** The builder's `background:url(overlay/eu-sat.jpg) px py/bw auto` boxes. */
export function satBg(
  x: number,
  y: number,
  w: number,
  h: number,
  px: number,
  py: number,
  bw: number,
  style = "",
): N {
  return (
    <div
      key={`bg${x}.${y}`}
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        overflow: "hidden",
        ...css(style),
      }}
    >
      <Mosaic left={px} top={py} k={bw / SATW} />
    </div>
  );
}

const tag = (x: number, y: number, style: string, text: string): N => (
  <div
    key={text}
    style={{ left: +x.toFixed(1), top: +y.toFixed(1), ...css(style) }}
  >
    {text}
  </div>
);

const DUBAI_CREEK: [number, number][] = [
  [1522, 300],
  [1668, 300],
  [1690, 420],
  [1678, 500],
  [1562, 500],
  [1546, 420],
]; // hand-traced along the dark-water edge of the imagery (authored, as in the copy)

export function satLayer(
  vs: SatV[],
  x: number,
  y: number,
  w: number,
  h: number,
  mx: number,
  my: number,
  k = 1.0,
  markers = true,
  labels = true,
  boxes = true,
  fs = 1.0,
  blur = 0.4,
): N {
  const P = (px: number, py: number): [number, number] => [
    (px - mx) * k,
    (py - my) * k,
  ];
  const pts = (ps: [number, number][]): string =>
    ps
      .map((p) =>
        P(...p)
          .map((n) => n.toFixed(1))
          .join(","),
      )
      .join(" ");
  const cl = watchBoxes(vs);
  const lab = `font-size:${(6.6 * k * fs).toFixed(1)}px;font-weight:600;padding:1px ${(3 * k).toFixed(1)}px;white-space:nowrap;color:#fff`;
  return (
    <div
      key={`sat${x}.${y}`}
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        overflow: "hidden",
        background: "#05070a",
      }}
    >
      <Mosaic
        left={-mx * k}
        top={-my * k}
        k={k}
        style={{ filter: `blur(${blur}px) contrast(.92)` }}
      />
      <svg
        aria-hidden
        style={{ left: 0, top: 0, width: w, height: h, overflow: "visible" }}
      >
        {boxes
          ? cl.map((g, gi) => (
              <polygon
                key={gi}
                points={pts(grow(hull(g.map((v) => v.px)), 14))}
                fill="rgba(200,30,48,.13)"
                stroke="#d11e32"
                strokeWidth={(2 * k).toFixed(1)}
                strokeLinejoin="round"
              />
            ))
          : null}
        <polygon
          points={pts(DUBAI_CREEK)}
          fill="rgba(48,110,214,.28)"
          stroke="#3a7ad8"
          strokeWidth={(1.6 * k).toFixed(1)}
        />
      </svg>
      {labels
        ? frag([
            ...cl.map((g, gi) => {
              const cxp = g.reduce((s, v) => s + v.px[0], 0) / g.length;
              const cyp = g.reduce((s, v) => s + v.px[1], 0) / g.length;
              const [lx, ly] = P(cxp + 22, cyp - 36);
              return tag(
                lx,
                ly,
                `background:#c4182c;border:1px solid #e25a68;${lab}`,
                gi === 0 ? "Watch box A" : "Watch box B",
              );
            }),
            tag(...P(1530, 308), `background:#2a62c4;${lab}`, "Dubai Creek"),
          ])
        : null}
      {markers
        ? frag(
            pickMarkers(vs, 6, [mx, my, w / k, h / k]).flatMap((v) => {
              const [px, py] = P(...v.px);
              return [
                A(
                  px - 8 * k,
                  py - 8 * k,
                  16 * k,
                  16 * k,
                  `background:#f4f8fc;border-radius:${3 * k}px;border:1px solid #9ab8d8;box-shadow:0 1px 3px rgba(0,0,0,.5)`,
                ),
                <svg
                  key={`m${v.id}`}
                  className="i"
                  aria-label={v.name ?? String(v.mmsi)}
                  style={{
                    left: px - 6 * k,
                    top: py - 6 * k,
                    width: 12 * k,
                    height: 12 * k,
                    color: "#1f6fb0",
                  }}
                >
                  <title>{`${v.name ?? ""} · MMSI ${v.mmsi}`}</title>
                  <use
                    href={`${import.meta.env.BASE_URL}bp-sprite.svg#bp-cargo-ship`}
                  />
                </svg>,
              ];
            }),
          )
        : null}
    </div>
  );
}

const RAIL: [string, string, Page | null][] = [
  ["globe-network", "#4a78d8", "map"],
  ["play", "#d94848", null],
  ["th", "#3fa35a", "gaia"],
  ["diagram-tree", "#e0b82c", "lineage"],
  ["graph", "#7a5cc8", "graph"],
  ["gantt-chart", "#2fb3a2", "globe"],
  ["presentation", "#a64fc9", "slides"],
  ["th-list", "#3fa35a", null],
  ["vertical-bar-chart-asc", "#e0b82c", null],
  ["high-priority", "#e8923a", null],
  ["edit", "#4a78d8", null],
  ["high-priority", "#e8923a", null],
  ["send-to-graph", "#e8923a", null],
  ["target", "#7a5cc8", null],
  ["search-template", "#e8923a", null],
  ["flow-linear", "#3fa35a", null],
  ["presentation", "#7a5cc8", null],
  ["presentation", "#7a5cc8", null],
];
const RAIL_Y = [
  361, 376, 391, 406, 421, 437, 452, 467, 482, 497, 512, 527, 542, 558, 573,
  588, 603, 619,
];
const PAGE_NAME: Record<Page, string> = {
  chat: "Chat",
  gaia: "Gaia home",
  map: "Map",
  slides: "Slides",
  present1: "Presentation",
  present2: "Presentation",
  graph: "Graph",
  lineage: "Data lineage",
  globe: "Simulation",
  ring: "Simulation",
};

export function rail(briefsN: number | null, evidN: number, go: Go): N {
  const s: N[] = [
    A(731, 305, 16, 609, "background:#101418"),
    A(
      735,
      309,
      8,
      7,
      `background:${briefsN ? "#c8283a" : "#3a4046"};border-radius:1px;font-size:5px;color:#fff;display:grid;place-items:center`,
      briefsN === null ? "?" : String(briefsN),
    ),
    I("inbox", 739, 311, 7, "#c4ccd2"),
    A(
      735,
      333,
      8,
      7,
      "background:#3a4046;border-radius:1px;font-size:5px;color:#fff;display:grid;place-items:center",
      String(evidN),
    ),
    I("duplicate", 739, 328, 7, "#c4ccd2"),
    Hit(733, 324, 12, 12, "Evidence", () => go("gaia")),
  ];
  RAIL.forEach(([ic, col, to], i) => {
    const y = RAIL_Y[i]!;
    s.push(
      A(
        734,
        y - 6,
        11,
        11,
        "background:rgba(255,255,255,.04);border-radius:2px",
      ),
      I(ic, 739.5, y, 8, col),
      Hit(
        734,
        y - 6,
        11,
        11,
        to ? PAGE_NAME[to] : ic,
        to ? () => go(to) : undefined,
        "No Velocity app behind this icon",
      ),
    );
  });
  s.push(
    I("double-chevron-right", 739.5, 633, 7, "#c4ccd2"),
    I("add", 739.5, 660, 8, "#c4ccd2"),
    I("folder-close", 739.5, 675, 8, "#c4ccd2"),
    I("help", 739.5, 889, 8, "#c4ccd2"),
    T(739.5, 905, "AW", 5.4, "#c4ccd2", 600, "c"),
  );
  return frag(s);
}

export function topChrome(
  search: string,
  thumbs: N,
  menu: [number, string, number][],
  title: N,
  right: N,
  banner = true,
  fs = 5.7,
): N {
  const s: N[] = [
    A(731, 274, 1138, 27, "background:#161a1e"),
    A(731, 273, 1138, 3, "background:#0a0c0e"),
    hexlogo(740, 291, 5, "#e4e8ec"),
    A(
      748,
      285,
      76,
      13,
      "background:#12161a;border:1px solid #2c343a;border-radius:2px;box-sizing:border-box",
    ),
    I("search", 755, 291.5, 7, "#c4ccd2"),
    T(761, 292, search, 6.2, "#e4e8ec"),
    thumbs,
  ];
  for (const [x, ic] of [
    [1833, "minus"],
    [1847, "square"],
    [1862, "cross"],
  ] as const)
    s.push(I(ic, x, 277, 6, "#c4ccd2"));
  s.push(
    I("panel", 1843, 291, 8, "#aab2b8"),
    I("menu", 1863, 291, 8, "#aab2b8"),
    A(731, 301, 1139, 14, "background:#0e1416"),
  );
  for (const [x, t, dim] of menu)
    s.push(T(x, 308, t, fs, dim ? "#5a6268" : "#f0f3f5", 600));
  s.push(title, right);
  if (banner)
    s.push(
      A(748, 315, 1122, 10, "background:#007a33"),
      T(1315, 320, "UNCLASSIFIED // OPEN SOURCE", 6, "#eef5ee", 700, "c", 0.05),
    );
  return frag(s);
}

export function thumbsRow(active: number, go: Go): N {
  return frag([
    A(833, 284, 35, 13, "background:#1a2024;border-radius:2px;overflow:hidden"),
    A(
      833,
      284,
      35,
      13,
      `background:${world ? `url(${world})` : "none"} -772px -327px/1100px 360px;opacity:.9;border-radius:2px`,
    ),
    I("home", 839, 290.5, 6, "#e4e8ec"),
    Hit(833, 284, 35, 13, "Gaia home", () => go("gaia")),
    satBg(
      872,
      283,
      34,
      15,
      -(450 * 0.075),
      -(520 * 0.075),
      SATW * 0.075,
      `border-radius:2px`,
    ),
    A(
      872,
      283,
      34,
      15,
      `border:1.5px solid ${active === 1 ? "#4b78c8" : "#2c343a"};border-radius:2px;box-sizing:border-box`,
    ),
    circ(878, 290.5, 3, "#2a50a8"),
    Hit(872, 283, 34, 15, "Map", () => go("map")),
    A(
      909,
      283,
      33,
      15,
      `border:1.5px solid ${active === 2 ? "#4b78c8" : "#2c343a"};border-radius:2px;box-sizing:border-box;background:#f4f6f8`,
    ),
    A(911, 288, 5, 5, "background:#7a3d9c;border-radius:1px"),
    Hit(909, 283, 33, 15, "Slides", () => go("slides")),
  ]);
}

function mapTools(): N {
  const s: N[] = [];
  for (const y of [330, 345])
    s.push(
      A(
        906,
        y,
        22,
        11,
        "background:#f4f6f8;border-radius:3px;box-shadow:0 1px 2px rgba(0,0,0,.5)",
      ),
      I(y === 330 ? "symbol-diamond" : "layers", 913, y + 5.5, 7, "#434b52"),
      I("chevron-right", 923, y + 5.5, 6, "#434b52"),
    );
  s.push(
    A(906, 389, 7, 17, "background:#f4f6f8;border-radius:0 3px 3px 0"),
    I("chevron-left", 909.5, 397.5, 6, "#434b52"),
  );
  return frag(s);
}

function e5Map(vs: SatV[], go: Go): N {
  const s: N[] = [
    satLayer(vs, 905, 325, 965, 589, MX, MY),
    mapTools(),
    A(1114, 353, 551, 19, "background:rgba(34,38,42,.94)"),
    T(1122, 362.5, "Dubai Creek Watch", 6.6, "#f0f3f5", 600),
    I("info-sign", 1623, 362, 7, "#c4ccd2"),
    I("more", 1637, 362, 7, "#c4ccd2"),
    I("cross", 1650, 362, 6, "#c4ccd2"),
    A(913, 500, 66, 13, "background:rgba(34,38,42,.94)"),
    A(916, 503, 7, 7, "background:#3a6fb4;border-radius:1px"),
    T(927, 506.5, "Dubai Creek Watch", 5.8, "#f0f3f5", 600),
    A(906, 747, 16, 60, "background:#f4f6f8;border-radius:2px"),
    T(914, 754, "3D", 5.8, "#2c343a", 700, "c"),
    Hit(906, 747, 16, 14, "3D globe", () => go("globe")),
    I("grid-view", 914, 769, 7, "#434b52"),
    I("draw", 914, 785, 7, "#434b52"),
    I("export", 914, 799, 7, "#434b52"),
    circ(936, 794, 10, "#f4f6f8", "box-shadow:0 1px 3px rgba(0,0,0,.5)"),
    I("compass", 936, 794, 11, "#c8283a"),
    A(920, 811, 85, 1, "background:#f4f6f8"),
    A(920, 808, 1, 5, "background:#f4f6f8"),
    A(1856, 330, 11, 62, "background:#f4f6f8;border-radius:2px"),
    I("notifications", 1861, 336, 7, "#434b52"),
    I("pulse", 1861, 364, 7, "#434b52"),
    I("chat", 1861, 379, 7, "#434b52"),
    Hit(1856, 373, 11, 12, "Chat", () => go("chat")),
    A(1856, 728, 11, 70, "background:#f4f6f8;border-radius:2px"),
    I("zoom-in", 1861, 771, 7, "#434b52"),
    I("zoom-out", 1861, 785, 7, "#434b52"),
    I("locate", 1861, 735, 7, "#434b52"),
    I("layers", 1861, 749, 7, "#434b52"),
    A(1795, 802, 72, 13, "background:#f4f6f8;border-radius:2px"),
  ];
  ["cut", "th", "list", "time", "fullscreen"].forEach((ic, i) =>
    s.push(I(ic, 1802 + i * 14, 808.5, 7, "#434b52")),
  );
  return frag(s);
}

function leftPanel(
  vs: SatV[],
  vRes: Res<unknown> | null,
  reload: () => void,
): N {
  return frag([
    A(748, 325, 157, 589, "background:#fefefe"),
    A(748, 330, 157, 14, "background:#30363c"),
    I("layers", 757, 337, 7, "#5a9be8"),
    T(765, 337.5, "Map layers", 5.8, "#f2f4f6", 600),
    A(749, 343, 52, 1.5, "background:#3a6fb4"),
    I("database", 817, 337, 7, "#9aa4ab"),
    T(823, 337.5, "Data sources", 5.8, "#9aa4ab", 600),
    I("wrench", 872, 337, 7, "#aab2b8"),
    T(878, 337.5, "Tools", 5.8, "#aab2b8", 600),
    I("filter", 756, 357, 7, "#434b52"),
    T(768, 357.5, "Find...", 6.4, "#6a747b"),
    I("caret-right", 755, 373, 5, "#434b52"),
    I("polygon-filter", 765, 373, 7, "#7a5cc8"),
    T(773, 373.5, "WATCH_DubaiCreek", 6.2, "#2c343a"),
    A(748, 862, 157, 20, "background:#e8ecf0"),
    satBg(752, 866, 15, 10, -120, -60, 130, "border-radius:1px"),
    T(771, 872, "Esri World Imagery", 6.1, "#2c343a", 600),
    T(840, 872, "2 overlays", 5.6, "#7a838a"),
    A(748, 882, 157, 16, "background:#e8ecf0"),
    T(751, 890, "Weather", 4.6, "#7a838a"),
    A(773, 884, 14, 11, "background:#cbd2d8;border-radius:2px"),
    T(780, 890, "None", 5.4, "#2c343a", 600, "c"),
    I("temperature", 797, 890, 7, "#4a535a"),
    I("wind", 812, 890, 7, "#4a535a"),
    I("cloud", 828, 890, 7, "#4a535a"),
    I("cog", 895, 890, 7, "#4a535a"),
    A(748, 900, 157, 14, "background:#32363c"),
    T(755, 907, vRes?.ok ? "Online" : "Offline", 5.6, "#e8923a", 600),
    T(779, 907, "View", 5.6, "#5a9be8", 600),
    T(
      818,
      907,
      vRes?.ok ? `${vs.length} live AIS tracks` : unavailable("AIS", vRes),
      5,
      "#7a838a",
    ),
    I("refresh", 883, 907, 7, "#3fa35a"),
    Hit(877, 901, 12, 12, "Refresh AIS tracks", reload),
    circ(897, 907, 3.2, "#e8923a"),
  ]);
}

function clipsDrawer(ev: Evid[], close: () => void): N {
  const s: N[] = [
    A(905, 819, 965, 75, "background:#202428;border-top:1px solid #2c3236"),
    T(910, 828, "Related clips", 5.8, "#e8ecef", 600),
    A(1801, 823, 29, 11, "background:#2e62b8;border-radius:2px"),
    I("plus", 1808, 828.5, 6, "#fff"),
    T(1814, 829, "New", 5.8, "#fff", 600),
    Hit(
      1801,
      823,
      29,
      11,
      "New clip",
      undefined,
      "Clips are captured into the evidence locker from the console",
    ),
    I("export", 1838, 829, 7, "#c4ccd2"),
    I("cross", 1857, 829, 6, "#c4ccd2"),
    Hit(1851, 823, 12, 12, "Close related clips", close),
  ];
  if (!ev.length)
    s.push(T(913, 860, "No clips in the evidence locker", 5.4, "#aab2b8"));
  // one clip per evidence item, at the copy's 55 px tile with a 6 px gap
  ev.slice(0, 14).forEach((e, i) => {
    const x = 909 + i * 61;
    s.push(
      A(
        x,
        842,
        55,
        40,
        "border:1px solid #4b78c8;box-sizing:border-box;background:#343a3a",
      ),
      I("document", x + 27, 858, 12, "#9aa4ab"),
      A(x + 1, 843, 53, 38, "background:rgba(10,14,18,.45)"),
      I("clipboard", x + 10, 849, 6, "#f4f6f8"),
      Hit(
        x + 6,
        845,
        9,
        9,
        "Copy SHA-256",
        () => void navigator.clipboard?.writeText(e.sha256),
      ),
      T(x + 4, 872, `By ${e.captured_by || "local"}`, 4.6, "#f0f3f5"),
      T(
        x + 4,
        878,
        UTC(Date.parse(e.captured_at) / 1000, "%m/%d/%Y"),
        4.6,
        "#f0f3f5",
      ),
      T(
        x + 2,
        887,
        e.title.length < 22 ? e.title : `${e.title.slice(0, 20)}…`,
        4.8,
        "#f0f3f5",
      ),
    );
  });
  return frag(s);
}

export function GaiaMapFrame({
  vs,
  vRes,
  ev,
  briefsN,
  drawer,
  setDrawer,
  reload,
  go,
}: {
  vs: SatV[];
  vRes: Res<unknown> | null;
  ev: Evid[];
  briefsN: number | null;
  drawer: boolean;
  setDrawer: (b: boolean) => void;
  reload: () => void;
  go: Go;
}): N {
  const title = frag([
    A(1243, 303, 8, 8, "background:#2a50a8;border-radius:1px"),
    T(1257, 308, "DubaiCreek_Watch_Plan", 6, "#f0f3f5", 600),
    I("star-empty", 1370, 308, 6, "#c4ccd2"),
    I("chevron-down", 1380, 308, 5, "#c4ccd2"),
  ]);
  const right = frag([
    T(1771, 308, "Share", 5.8, "#f0f3f5", 600),
    T(1789, 308, "1", 5, "#aab2b8"),
    I("shield", 1804, 308, 6.5, "#c4ccd2"),
    T(1812, 308, "UNCLAS", 5.8, "#f0f3f5", 600),
    I("camera", 1850, 308, 6.5, "#c4ccd2"),
    I("refresh", 1863, 308, 6, "#c4ccd2"),
    Hit(1857, 302, 12, 12, "Refresh AIS tracks", reload),
  ]);
  const menu: [number, string, number][] = [
    [752, "File", 0],
    [771, "Edit", 0],
    [790, "View", 0],
    [813, "Related", 1],
    [840, "Window", 0],
    [870, "Support", 0],
    [903, "✓ Saved", 1],
  ];
  return frag([
    insetFrame(730, 273, 1870, 914),
    e5Map(vs, go),
    leftPanel(vs, vRes, reload),
    rail(briefsN, ev.length, go),
    topChrome("Search: creek", thumbsRow(1, go), menu, title, right),
    Hit(813, 302, 24, 12, "Related clips", () => setDrawer(!drawer)),
    drawer ? clipsDrawer(ev, () => setDrawer(false)) : null,
  ]);
}
