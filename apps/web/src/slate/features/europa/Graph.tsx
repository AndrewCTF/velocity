// E10: the link-analysis graph with its histogram panel (graph_inset() in
// _build_features.py), crop 720,255 690x535, drawn upright. Nodes are a sample
// of 46 live ontology incidents (/api/ontology/search) linked to their
// detector domains; every histogram counts their real props. The copy's
// photo-matching dim filter is left out: it matched a monitor photograph, it
// is not product chrome.
import { A, I, T, Hit, frag, hexlogo, type N } from "./ui.js";
import { countBy, graphData, type Incident } from "./data.js";

const HUB: Record<string, [number, number]> = {
  "dark-vessel": [992, 520],
  military: [1032, 506],
  "ais-gap": [978, 548],
  "gps-jamming": [1016, 552],
  "air-emergency": [1048, 532],
  event: [1000, 494],
};
const hubOf = (d: string): [number, number] => HUB[d] ?? [1010, 520];
const TH: Record<string, string> = { high: "#e86a4a", elevated: "#e0b04a" };

function histRows(
  x: number,
  y0: number,
  rows: [string, number][],
  maxv: number,
): N {
  return frag(
    rows.flatMap(([lab, v], k) => {
      const yc = y0 + k * 12.5;
      return [
        T(x, yc, lab, 4.8, "#d0d6da"),
        T(x + 99, yc, String(v), 4.6, "#8a949b", 400, "r"),
        A(
          x + 105,
          yc - 3.4,
          Math.max(2, (44 * v) / maxv),
          6.5,
          "background:#6a8fd8;opacity:.9",
        ),
      ];
    }),
  );
}
const sortCount = (m: Map<string, number>): [string, number][] =>
  [...m.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );

export function GraphFrame({
  all,
  done,
  total,
  status,
  go,
}: {
  all: Incident[];
  done: number;
  total: number;
  status: string | null;
  go: () => void;
}): N {
  const { inc, doms } = graphData(all);
  const x0 = 720;
  const y0 = 255;
  const x1 = 1410;
  const y1 = 790;
  const s: N[] = [
    A(
      x0,
      y0,
      x1 - x0,
      y1 - y0,
      "background:#161a1e;border:1px solid #2a3036;box-sizing:border-box",
    ),
    A(x0 + 12, y0 + 17, x1 - x0 - 24, 12, "background:#007a33"),
    T(
      1065,
      y0 + 23,
      "UNCLASSIFIED // OPEN SOURCE",
      5.6,
      "#e8f2e8",
      700,
      "c",
      0.05,
    ),
    hexlogo(x0 + 22, y0 + 40, 5, "#c4ccd2"),
    Hit(x0 + 16, y0 + 34, 12, 12, "Gaia home", go),
  ];
  for (const [x, t] of [
    [755, "File"],
    [782, "Edit"],
    [810, "View"],
    [840, "Insert"],
    [872, "Selection"],
  ] as const)
    s.push(T(x, y0 + 40, t, 6.4, "#c4ccd2", 600));
  s.push(
    T(910, y0 + 42, "Saved", 5.4, "#59636a"),
    T(1327, y0 + 56, "Share", 5.2, "#aab2b8"),
    I("shield", 1357, y0 + 56, 6, "#aab2b8"),
    T(1364, y0 + 56, "UNCLAS", 5, "#aab2b8", 600),
    T(740, y0 + 56, "Organize", 5.2, "#b8c0c6", 600),
    I("layout-auto", 750, y0 + 69, 8, "#59636a"),
    I("database", 782, y0 + 69, 8, "#59636a"),
    T(812, y0 + 56, "Annotations", 5.2, "#b8c0c6", 600),
    I("annotation", 817, y0 + 69, 8, "#59636a"),
    I("new-object", 832, y0 + 69, 8, "#59636a"),
    T(853, y0 + 56, "Node styling", 5.2, "#b8c0c6", 600),
    I("square", 862, y0 + 69, 7, "#59636a"),
    T(889, y0 + 69, "4", 6, "#8a949b"),
    I("caret-down", 897, y0 + 69, 5, "#59636a"),
    T(916, y0 + 58, "Link styling", 5.2, "#b8c0c6", 600),
    I("minus", 925, y0 + 71, 8, "#59636a"),
    T(946, y0 + 72, "1px", 5, "#59636a"),
    I("chevron-left", 1020, y0 + 70, 6, "#59636a"),
  );
  // toast: the real progress of the ontology queries that build the graph
  if (done < total || status)
    s.push(
      A(1006, y0 + 36, 153, 22, "background:#e8ecef;border-radius:1px"),
      T(
        1013,
        y0 + 44,
        status ?? "Applying layout...",
        5.2,
        status ? "#c8283a" : "#2c343a",
      ),
      A(1034, y0 + 49, 124, 4, "background:#d0d6da"),
      A(
        1034,
        y0 + 49,
        (124 * done) / Math.max(1, total),
        4,
        "background:#3a6fb4",
      ),
    );
  s.push(
    A(
      738,
      y0 + 93,
      168,
      17,
      "background:#1a1f24;border:1px solid #232a30;border-radius:2px;box-sizing:border-box",
    ),
    I("search", 748, y0 + 101.5, 7, "#59636a"),
    T(757, y0 + 102, "Find artifacts, objects and links...", 5.6, "#59636a"),
    I("chevron-left", 897, y0 + 102, 6, "#59636a"),
  );
  // graph
  const N_ = inc.length;
  const order = [...inc.keys()].sort((a, b) =>
    inc[a]!.domains[0]! < inc[b]!.domains[0]!
      ? -1
      : inc[a]!.domains[0]! > inc[b]!.domains[0]!
        ? 1
        : a - b,
  );
  const pos = new Map<number, [number, number]>();
  order.forEach((i, rank) => {
    const a = (rank / N_) * 2 * Math.PI + 0.4;
    const r = 38 + ((rank * 37) % 7) * 13;
    const ds = inc[i]!.domains;
    const cx = ds.reduce((t, d) => t + hubOf(d)[0], 0) / ds.length;
    const cy = ds.reduce((t, d) => t + hubOf(d)[1], 0) / ds.length;
    pos.set(i, [cx + Math.cos(a) * r * 1.5, cy + Math.sin(a) * r]);
  });
  s.push(
    <svg
      key="links"
      aria-hidden
      style={{
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
        overflow: "visible",
      }}
    >
      {inc.flatMap((it, i) =>
        it.domains.map((d) => {
          const [hx, hy] = hubOf(d);
          const [px, py] = pos.get(i)!;
          return (
            <line
              key={`${i}${d}`}
              x1={px.toFixed(1)}
              y1={py.toFixed(1)}
              x2={hx}
              y2={hy}
              stroke="#7a848b"
              strokeWidth=".7"
              opacity=".85"
            />
          );
        }),
      )}
    </svg>,
  );
  inc.forEach((it, i) => {
    const [x, y] = pos.get(i)!;
    s.push(
      A(
        x - 4,
        y - 5,
        8,
        10,
        `background:#c8d0d6;border-radius:1px;box-shadow:inset 0 -3px 0 ${TH[it.threat ?? ""] ?? "#9aa4ab"}`,
      ),
      T(
        x,
        y + 9,
        (it.id.split(":")[1] ?? it.id).slice(0, 7),
        2.8,
        "#8a949b",
        400,
        "c",
        0,
      ),
    );
  });
  for (const d of doms) {
    const [x, y] = hubOf(d);
    s.push(
      A(
        x - 5,
        y - 5,
        10,
        10,
        "background:#3a6fb4;border-radius:2px;border:1px solid #9ab8e0",
      ),
      T(x, y + 9, d, 3.6, "#b8c0c6", 400, "c", 0),
    );
  }
  // minimap + zoom
  s.push(A(1165, 692, 50, 46, "background:#12161a;border:1px solid #232a30"));
  for (let q = 0; q < 40; q++)
    s.push(
      A(
        1170 + ((q * 7) % 38),
        698 + ((q * 11) % 34),
        1.2,
        1.2,
        "background:#59636a",
      ),
    );
  for (const [yy, ic] of [
    [688, "zoom-in"],
    [707, "zoom-to-fit"],
    [725, "zoom-out"],
  ] as const)
    s.push(I(ic, 1232, yy, 8, "#8a949b"));
  s.push(
    I("th-list", 764, 760, 8, "#8a949b"),
    I("history", 781, 760, 8, "#8a949b"),
  );
  // right panel
  const px0 = 1210;
  s.push(
    A(px0, 330, 200, 432, "background:#181e22;border-left:1px solid #242b31"),
  );
  for (const [yy, ic] of [
    [339, "info-sign"],
    [354, "history"],
    [371, "edit"],
  ] as const)
    s.push(I(ic, px0 + 7, yy, 7, "#8a949b"));
  s.push(
    T(
      1229,
      338,
      `${inc.length + doms.length} nodes selected`,
      6.4,
      "#e4e8ec",
      600,
    ),
    T(1291, 340, "Clear", 4.6, "#5a8bd0"),
    I("cross", 1375, 343, 5.5, "#8a949b"),
    T(1231, 361, "Histogram", 5.6, "#5a8bd0", 600),
    A(1229, 366, 30, 1.2, "background:#5a8bd0"),
    T(1273, 361, "List", 5.6, "#8a949b"),
    T(1287, 361, "Details", 5.6, "#8a949b"),
    I("sort", 1362, 361, 5, "#8a949b"),
    I("cross", 1377, 361, 5, "#8a949b"),
    T(1231, 383, "OBJECT TYPES", 5.8, "#aab2b8", 600),
    I("caret-down", 1236, 398, 4, "#8a949b"),
    T(1242, 398, "Velocity Object Type", 4.8, "#8a949b"),
    T(1241, 412, "VALUE", 3.8, "#6a747b", 600),
    T(1306, 412, "COUNT ▾", 3.8, "#6a747b", 600),
    histRows(
      1241,
      423,
      [
        ["Incident", inc.length],
        ["Detector domain", doms.length],
      ],
      Math.max(1, inc.length),
    ),
    T(1231, 473, "PROPERTY VALUES", 5.8, "#aab2b8", 600),
  );
  const block = (y: number, lab: string, rows: [string, number][]): N[] => [
    I("caret-down", 1238, y, 4, "#8a949b"),
    T(1244, y, lab, 4.8, "#8a949b"),
    T(1245, y + 13, "VALUE", 3.8, "#6a747b", 600),
    T(1308, y + 13, "COUNT ▾", 3.8, "#6a747b", 600),
    histRows(1247, y + 24, rows, Math.max(1, ...rows.map((r) => r[1]))),
  ];
  const thr = sortCount(countBy(inc, (i) => [i.threat ?? "n/a"]));
  const dc = sortCount(countBy(inc, (i) => i.domains)).slice(0, 4);
  const sc = sortCount(countBy(inc, (i) => [String(i.score)]));
  s.push(
    ...block(488, "Threat level", thr),
    ...block(540, "Domains", dc),
    ...block(626, "Score", sc.slice(0, 5)),
  );
  s.push(
    T(
      1250,
      717,
      `Show more · ${Math.min(5, sc.length)} of ${sc.length}`,
      4.2,
      "#59636a",
    ),
  );
  return frag(s);
}
