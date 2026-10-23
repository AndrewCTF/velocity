// Lineage workspace: features A7-A12, ported from gotham/aip/_build_features_a.py
// (rail_dark .. a12) over the real Foundry stores (/api/foundry/lineage,
// datasets, bindings, connections, monitors, kinds, builds) and the AI
// guardrails' clearance.
import { useState } from "react";
import { CLIP, Hit, I, L, R, SVG, T, frag, type N } from "./ui.js";
import {
  comma,
  mon,
  unavailable,
  useJson,
  type Binding,
  type Build,
  type Dataset,
  type Guardrails,
  type Lineage as Lin,
  type Rows,
} from "./data.js";

export type FoundryNav = "terminal" | "lineage" | "transforms" | "registry" | "control" | "titan" | "map" | "board";

const COL = {
  raw: "#886a4e",
  ref: "#8eb8f4",
  der: "#ec5c9a",
  tf: "#ead074",
  obj: "#2c58b6",
  nodata: "#666c78",
  view: "#4c72c2",
};

/** The rail every Foundry page carries; its icons are this app's navigation. */
export function railDark(nav: (v: FoundryNav) => void, here: FoundryNav): N[] {
  const s: N[] = [R(282, 98, 51, 916, "#1e2224")];
  const items: [number, string][] = [
    [125, "menu-open"], [190, "home"], [228, "search"], [266, "notifications"], [334, "history"], [373, "folder-open"],
    [449, "search-template"], [497, "build"], [545, "applications"], [593, "data-lineage"], [636, "folder-shared"],
    [817, "globe-network"], [855, "random"], [910, "help"],
  ];
  for (const [y, ic] of items) s.push(I(ic, 306, y, 17, y === 449 || y === 497 ? "#b9a8ff" : "#cfd5d8"));
  s.push(
    R(300, 261, 7, 7, "#e98a2c", "", "border-radius:50%"),
    T(306, 950, "AM", 12, "#cfd5d8", 400, "", "", "c"),
    I("share", 306, 989, 15, "#cfd5d8"),
  );
  s.push(...railHits(nav, here, { home: 190, build: 497, apps: 545, lineage: 593, board: 266, map: 636, titan: 817, control: 855 }, 282, 51));
  return s;
}

export function railHits(
  nav: (v: FoundryNav) => void,
  here: FoundryNav,
  y: { home: number; build: number; apps: number; lineage: number; board?: number; map?: number; titan?: number; control?: number },
  x0: number,
  w: number,
): N[] {
  const go = (v: FoundryNav) => (here === v ? undefined : () => nav(v));
  const s: N[] = [
    Hit(x0, y.home - 17, w, 34, "AIP terminal", go("terminal")),
    Hit(x0, y.build - 17, w, 34, "Manage transforms", go("transforms")),
    Hit(x0, y.apps - 17, w, 34, "Registry Watch Manager", go("registry")),
    Hit(x0, y.lineage - 17, w, 34, "Master lineage", go("lineage")),
  ];
  // the rail's notifications, map, network and settings icons open the part-B apps
  const extra: [number | undefined, string, FoundryNav][] = [
    [y.board, "Target board (watch items)", "board"],
    [y.map, "Map: Gulf and Red Sea watch", "map"],
    [y.titan, "Ground station: devices, software, data connections", "titan"],
    [y.control, "Control panel: language models and AI settings", "control"],
  ];
  for (const [yy, lab, v] of extra) if (yy !== undefined) s.push(Hit(x0, yy - 17, w, 34, lab, go(v)));
  return s;
}

function linHeader(build: [number, number, number]): N[] {
  const s: N[] = [R(333, 98, 1539, 54, "#fff"), L(333, 151, 1872, 151, "#e1e6e8")];
  s.push(R(345, 108, 34, 34, "#f4f6f7"), I("data-lineage", 361, 125, 22, "#e98a2c"));
  s.push(
    I("th-list", 410, 113, 14, "#4a5358"),
    T(427, 113, "Velocity Foundry", 14.5, "#4a5358"),
    T(527, 113, "›", 15, "#4a5358"),
    T(554, 113, "Master Lineage - Velocity", 17, "#2a2f33", 700),
    I("star-empty", 736, 113, 15, "#6a7378"),
  );
  s.push(
    T(401, 137, "File ▾", 12.5, "#4a5358"),
    T(440, 137, "Help ▾", 12.5, "#4a5358"),
    L(493, 129, 493, 145, "#ccd"),
    I("office", 506, 137, 14, "#4a5358"),
    T(518, 137, "1", 12.5, "#4a5358"),
  );
  s.push(
    R(1102, 107, 216, 34, "#fff", "#c2c9ce", "border-radius:2px"),
    I("git-branch", 1119, 124, 16, "#4a5358"),
    T(1136, 124, "master", 15, "#2a2f33"),
    I("caret-down", 1303, 124, 14, "#4a5358"),
  );
  s.push(I("git-branch", 1342, 124, 19, "#4a5358"), I("key-command", 1383, 124, 19, "#4a5358"), I("cog", 1423, 124, 19, "#4a5358"));
  s.push(
    R(1453, 108, 141, 32, "#eef1f3", "#dde2e5", "border-radius:3px"),
    I("refresh", 1472, 124, 15, "#8a9397"),
    T(1485, 125, String(build[0]), 11.5, "#6a7378"),
  );
  s.push(
    L(1502, 112, 1502, 136, "#d3d9dc"),
    I("tick", 1514, 124, 14, "#2e8a4a"),
    T(1527, 125, String(build[1]), 11.5, "#2e8a4a"),
    L(1550, 112, 1550, 136, "#d3d9dc"),
  );
  s.push(I("cross", 1565, 124, 13, "#c62828"), T(1577, 125, String(build[2]), 11.5, "#c62828"));
  s.push(T(1618, 124, "Actions", 15, "#2a2f33"), I("caret-down", 1682, 124, 13, "#4a5358"), L(1712, 112, 1712, 138, "#e1e6e8"));
  s.push(I("people", 1738, 124, 17, "#4a5358"), T(1762, 124, "Share", 15, "#2a2f33"), I("panel-stats", 1835, 124, 19, "#4a5358"));
  return s;
}

const TOOLS: [number, string, string][] = [
  [361, "move", "Tools"], [443, "graph", "Layout"], [509, "undo", "Undo/redo"], [575, "filter-remove", "Clean"], [626, "target", "Select"],
  [676, "diagram-tree", "Expand"], [726, "tint", "Color"], [776, "zoom-to-fit", "Find"], [826, "remove", "Remove"], [876, "grid-view", "Align"], [927, "flows", "Flow"],
];

function linToolbar(colorMode: string, colorIcon: string): N[] {
  const s: N[] = [R(333, 152, 1497, 83, "transparent")];
  for (const [x, ic, lab] of TOOLS)
    s.push(
      R(x - 17, 165, 34, 34, "#fff", "#cdd3d6", "border-radius:2px"),
      I(ic, x, 182, 19, "#4a5358"),
      T(x, 213, lab, 12.5, "#6a7378", 400, "", "", "c"),
    );
  s.push(I("redo", 526, 182, 19, "#4a5358", "opacity:.6"));
  for (const [x, ic, lab] of [[1491, "layout-grid", ["Layout", "by color"]], [1547, "group-objects", ["Group", "by color"]], [1603, "eye-open", ["Legend"]]] as const) {
    s.push(R(x - 17, 165, 34, 34, "#fff", "#cdd3d6", "border-radius:2px"), I(ic, x, 182, 19, "#4a5358"));
    lab.forEach((t, i) => s.push(T(x, 213 + i * 18, t, 12.5, "#6a7378", 400, "", "", "c")));
  }
  s.push(
    R(1642, 165, 176, 34, "#fff", "#c2c9ce", "border-radius:2px"),
    I(colorIcon, 1659, 182, 16, "#2a2f33"),
    T(1676, 182, colorMode, 15.5, "#2a2f33"),
    I("caret-down", 1802, 182, 13, "#4a5358"),
  );
  s.push(T(1730, 213, "Node color options", 12.5, "#6a7378", 400, "", "", "c"));
  return s;
}

function rightRail(): N[] {
  const s: N[] = [R(1830, 152, 42, 862, "#fff", "", "border-left:1px solid #e1e6e8")];
  for (const [y, ic] of [[176, "search"], [219, "properties"], [262, "build"], [305, "calendar"], [348, "shield"], [391, "exchange"]] as const)
    s.push(I(ic, 1850, y, 17, "#2a2f33"));
  s.push(L(1832, 413, 1870, 413, "#e1e6e8"), I("double-chevron-left", 1851, 434, 17, "#2a2f33"));
  return s;
}

function zoomStack(y0 = 851): N[] {
  const s: N[] = [R(345, y0 - 18, 33, 136, "#fff", "#cdd3d6", "border-radius:3px")];
  ["locate", "zoom-in", "zoom-out", "zoom-to-fit"].forEach((ic, i) => {
    s.push(I(ic, 361, y0 + i * 33, 17, "#2a2f33"));
    if (i) s.push(L(346, y0 + i * 33 - 16, 377, y0 + i * 33 - 16, "#e1e6e8"));
  });
  return s;
}

const TABS: [number, string, string, number][] = [
  [343, "Preview", "th", 430], [432, "History", "history", 526], [528, "Code", "code", 608],
  [610, "Build timeline", "timeline-bar-chart", 748], [750, "Data health", "pulse", 868],
];

function bottomTabs(active: string[] | null, y = 978): N[] {
  const s: N[] = [R(333, y, 540, 36, "#fff", "", "border-top:1px solid #e1e6e8")];
  for (const [x, lab, ic, xe] of TABS) {
    const on = active === null ? lab === "Build timeline" || lab === "Data health" : active.includes(lab);
    const col = on ? "#2a2f33" : "#b9c1c6";
    s.push(I(ic, x + 17, y + 21, 16, col), T(x + 34, y + 21, lab, 15, col), L(xe, y, xe, y + 36, "#e1e6e8"));
  }
  s.push(I("double-chevron-up", 889, y + 20, 17, "#2a2f33"));
  return s;
}

function wNode(cx: number, cy: number, label: string, bg: string, sel: boolean, chev: boolean, fg: string, sz: number, sc: number): [N[], [number, number, number, number]] {
  const h = 26 * sc;
  const w = Math.trunc((label.length * 6.7 + 34) * sc);
  const x = cx - Math.floor(w / 2);
  const y = cy - h / 2;
  const s: N[] = [
    R(x, y, w, h, bg, sel ? "#e8266f" : "", "border-radius:2px;" + (sel ? "border-width:2px;box-shadow:0 0 0 2px rgba(232,38,111,.25);" : "")),
    T(x + w / 2, cy, label, sz, fg, 400, "", "", "c"),
  ];
  if (chev) s.push(I("chevron-right", x + w - 11 * sc, cy, 12 * sc, fg));
  return [s, [x, y, w, h]];
}

function wObj(cx: number, cy: number, label: string, icon: string, bg: string, sc: number): N[] {
  const w = Math.trunc(Math.max(150, label.length * 7 + 44) * sc);
  const x = cx - Math.floor(w / 2);
  const y = cy - 22 * sc;
  return [
    R(x, y, w, 20 * sc, "#101616", "", "border-radius:2px 2px 0 0"),
    I(icon, cx, y + 10 * sc, 13 * sc, "#fff"),
    I("link", x + w - 12 * sc, y + 10 * sc, 11 * sc, "#fff"),
    R(x, y + 20 * sc, w, 26 * sc, bg, "", "border-radius:0 0 2px 2px"),
    I("chevron-left", x + 11 * sc, y + 33 * sc, 11 * sc, "#fff"),
    T(cx, y + 33 * sc, label, 12.5 * sc, "#fff", 400, "", "", "c"),
    I("chevron-right", x + w - 11 * sc, y + 33 * sc, 11 * sc, "#fff"),
  ];
}

function arrowSvg(x1: number, y1: number, x2: number, y2: number, col: string, wd: number, dash = ""): N[] {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const ah = 7;
  const p = [
    [x2, y2],
    [x2 - ah * Math.cos(ang - 0.4), y2 - ah * Math.sin(ang - 0.4)],
    [x2 - ah * Math.cos(ang + 0.4), y2 - ah * Math.sin(ang + 0.4)],
  ];
  return [
    <line x1={x1.toFixed(0)} y1={y1.toFixed(0)} x2={x2.toFixed(0)} y2={y2.toFixed(0)} stroke={col} strokeWidth={wd} strokeDasharray={dash || undefined} />,
    <polygon points={p.map(([a, b]) => `${a!.toFixed(0)},${b!.toFixed(0)}`).join(" ")} fill={col} />,
  ];
}

const pill = (cx: number, cy: number): N[] => [
  R(cx - 11, cy - 7, 22, 14, "#fff", "#c5ccd0", "border-radius:7px"),
  T(cx, cy, "↔1", 9, "#4a5358", 400, "", "", "c"),
];

/** lineage_layout(): isolated raw datasets top-left in two columns, each raw
 *  dataset that feeds a transform on its own row (input, transform, output),
 *  reference datasets along the bottom. */
export function lineageLayout(lin: Lin): Map<string, [number, number]> {
  const pos = new Map<string, [number, number]>();
  const touches = (id: string): boolean => lin.edges.some((e) => e.src === id || e.dst === id);
  const iso = lin.nodes.filter((n) => n.type === "dataset" && n.kind === "raw" && !touches(n.id));
  iso.forEach((n, i) => pos.set(n.id, [460 + (i % 2) * 190, 300 + Math.floor(i / 2) * 60]));
  const roots = lin.nodes.filter((n) => n.type === "dataset" && n.kind === "raw" && lin.edges.some((e) => e.src === n.id));
  const slots = [330, 450, 590, 760];
  roots.forEach((n, i) => {
    const y = slots[i] ?? 760 + (i - 3) * 150;
    pos.set(n.id, [820, y]);
    const outs = lin.edges.filter((e) => e.src === n.id).map((e) => e.dst);
    outs.forEach((t, j) => {
      const ty = y + (j - (outs.length - 1) / 2) * 56;
      pos.set(t, [1090, ty]);
      for (const e of lin.edges) if (e.src === t) pos.set(e.dst, [1370, ty]);
    });
  });
  lin.nodes.filter((n) => n.kind === "reference").forEach((n, i) => pos.set(n.id, [450 + i * 175, 905]));
  return pos;
}

const KIND_ICON: Record<string, string> = {
  vessel: "ship",
  aircraft: "airplane",
  incident: "warning-sign",
  situation: "eye-open",
  evidence: "document",
};
const kindLabel = (k: string): string => `[Velocity] ${k.charAt(0).toUpperCase()}${k.slice(1)}`;

interface Store {
  lin: Lin;
  ds: Map<string, Dataset>;
  bound: Map<string, Binding>;
  kinds: string[];
}

interface CanvasOpts {
  sel?: string | null;
  mode?: "color" | "perm";
  k?: number;
  dx?: number;
  dy?: number;
  labelFs?: number;
  onNode?: (id: string) => void;
  onHover?: (id: string | null) => void;
}

function lineageCanvas(st: Store, o: CanvasOpts): N[] {
  const { sel = null, mode = "color", k = 1, dx = 0, dy = 0, labelFs = 12.5 } = o;
  const pos = lineageLayout(st.lin);
  const name = new Map(st.lin.nodes.map((n) => [n.id, n.name]));
  const ks = k > 1.2 || k < 1 ? k : 1;
  const P = (id: string): [number, number] => {
    const [x, y] = pos.get(id) ?? [0, 0];
    return [x * k + dx, y * k + dy];
  };
  const half = (id: string): number => (((name.get(id) ?? "").length * 6.7 + 34) / 2) * ks;
  const svg: N[] = [];
  const pills: N[] = [];
  for (const e of st.lin.edges) {
    if (!pos.has(e.src) || !pos.has(e.dst)) continue;
    const [x1, y1] = P(e.src);
    const [x2, y2] = P(e.dst);
    const wa = half(e.src);
    const wb = half(e.dst);
    const hot = sel !== null && (e.dst === sel || e.src === sel);
    svg.push(...arrowSvg(x1 + wa, y1, x2 - wb, y2, hot ? "#e8803c" : "#7d868c", hot ? 1.6 : 1.2));
    pills.push(...pill((x1 + wa + x2 - wb) / 2, (y1 + y2) / 2));
  }
  // bound kinds sit level with their dataset (the copy's [Velocity] Vessel at 1570, 760)
  const boundKinds: [number, number, string][] = [];
  for (const b of st.bound.values()) {
    if (!pos.has(b.dataset_id)) continue;
    const [, by] = pos.get(b.dataset_id)!;
    const ox = 1570 * k + dx;
    const oy = by * k + dy;
    const [sx, sy] = P(b.dataset_id);
    const wa = half(b.dataset_id);
    svg.push(...arrowSvg(sx + wa, sy, ox - 75 * k, oy + 10 * k, "#7d868c", 1.2, "5 4"));
    pills.push(...pill((sx + wa + ox - 75 * k) / 2, (sy + oy + 10 * k) / 2));
    boundKinds.push([1570, by, b.object_kind]);
  }
  const nodes: N[] = [];
  const hits: N[] = [];
  for (const [nid] of pos) {
    const n = st.lin.nodes.find((x) => x.id === nid);
    if (!n) continue;
    const [x, y] = P(nid);
    let bg: string;
    let fg: string;
    if (n.type === "transform") [bg, fg] = [COL.tf, "#2a2f33"];
    else if (n.kind === "raw") [bg, fg] = [COL.raw, "#fff"];
    else if (n.kind === "reference") [bg, fg] = [COL.ref, "#1d2a3a"];
    else [bg, fg] = [COL.der, "#fff"];
    if (st.bound.has(nid)) [bg, fg] = [COL.der, "#fff"];
    if (mode === "perm") [bg, fg] = [(st.ds.get(nid)?.row_count ?? 1) === 0 ? COL.nodata : COL.view, "#fff"];
    const sz = k < 1 ? labelFs * Math.min(k, 1) : labelFs * (k > 1.2 ? k : 1);
    const [s, [bx, by, bw, bh]] = wNode(x, y, n.name, bg, nid === sel, n.type === "transform" || n.kind === "derived", fg, sz, ks);
    nodes.push(...s);
    if (o.onNode)
      hits.push(
        <button
          type="button"
          className="a sl-hit"
          aria-label={`Select ${n.name}`}
          title={n.name}
          style={{ left: bx, top: by, width: bw, height: bh }}
          onClick={() => o.onNode!(nid)}
          onMouseEnter={() => o.onHover?.(nid)}
          onMouseLeave={() => o.onHover?.(null)}
        />,
      );
  }
  const sc = k < 1 ? k : 1;
  const objBg = mode === "perm" ? COL.view : COL.obj;
  for (const [kx, ky, kind] of boundKinds) nodes.push(...wObj(kx * k + dx, ky * k + dy, kindLabel(kind), KIND_ICON[kind] ?? "cube", objBg, sc));
  // ontology kinds with no upstream dataset (the copy's four), when this box has them
  const boundSet = new Set([...st.bound.values()].map((b) => b.object_kind));
  ["aircraft", "incident", "situation", "evidence"]
    .filter((kd) => st.kinds.includes(kd) && !boundSet.has(kd))
    .forEach((kd, i) => nodes.push(...wObj((1480 + (i % 2) * 190) * k + dx, (360 + Math.floor(i / 2) * 120) * k + dy, kindLabel(kd), KIND_ICON[kd]!, objBg, sc)));
  return [SVG(svg, 0, 0, 1920, 1080, "pointer-events:none"), ...pills, ...nodes, ...hits];
}

function legendPanel(leg: [string, string][]): N[] {
  const s: N[] = [R(1400, 244, 418, 275, "#f8fcfc", "#e1e6e8", "box-shadow:0 2px 10px rgba(0,0,0,.18)")];
  leg.forEach(([c, lab], i) => {
    const x = 1414 + (i % 2) * 198;
    const y = 270 + Math.floor(i / 2) * 38.8;
    s.push(R(x, y - 11, 22, 22, c, "", "border-radius:2px"), T(x + 30, y, lab.length < 24 ? lab : lab.slice(0, 22) + "...", 15.2, "#2a2f33"));
  });
  s.push(T(1415, 499, "Show Color Group Editor ▾", 14.5, "#38507e"));
  return s;
}

function permPanel(nOk: number, nNoData: number, nNoAccess: number, nUnknown: number, clearance: string): N[] {
  const s: N[] = [R(1431, 244, 388, 220, "#fff", "#e1e6e8", "box-shadow:0 2px 10px rgba(0,0,0,.18)")];
  for (const [x, y, c, lab] of [
    [1446, 270, "#4c72c2", `View data (${nOk})`],
    [1595, 270, "#e88c9e", `No access (${nNoAccess})`],
    [1446, 309, "#666c78", `No data (${nNoData})`],
    [1595, 309, "#ced4d4", `Permissions unknown (${nUnknown})`],
  ] as const)
    s.push(R(x, y - 11, 22, 22, c, "", "border-radius:2px"), T(x + 29, y, lab, 15.2, "#2a2f33"));
  s.push(
    T(1625, 343, "You are only able to view a user's access level if", 12.5, "#6a7378", 400, "", "", "c"),
    T(1625, 361, "you have that access level", 12.5, "#6a7378", 400, "", "", "c"),
  );
  s.push(
    T(1450, 393, "Permissions type:", 15, "#2a2f33"),
    R(1570, 377, 230, 33, "#fff", "#c2c9ce", "border-radius:2px"),
    T(1581, 393, "Data access in datasets", 15, "#2a2f33"),
    I("double-caret-vertical", 1782, 393, 14, "#4a5358"),
  );
  s.push(
    T(1450, 433, "View as:", 15, "#2a2f33"),
    R(1508, 417, 292, 33, "#fff", "#c2c9ce", "border-radius:2px"),
    T(1519, 433, `Local principal (clearance ${clearance})`, 15, "#2a2f33"),
    I("cross", 1757, 433, 12, "#2a2f33"),
    I("caret-down", 1780, 433, 12, "#2a2f33"),
  );
  return s;
}

function hoverCard(x: number, y: number, ds: Dataset): N[] {
  return [
    R(x, y, 389, 132, "#fff", "#e1e6e8", "box-shadow:0 2px 10px rgba(0,0,0,.22);border-radius:2px"),
    I("th", x + 20, y + 23, 17, "#4a7fc8"),
    T(x + 37, y + 23, ds.name, 15.5, "#2a2f33", 700),
    I("git-branch", x + 300, y + 23, 15, "#4a5358"),
    T(x + 318, y + 23, `v${ds.latest_version} (master)`, 13, "#2a2f33"),
    I("folder-close", x + 19, y + 50, 16, "#4a5358"),
    T(x + 35, y + 50, `foundry://${ds.id}`, 13.5, "#2a2f33"),
    T(x + 35, y + 67, `${ds.kind} dataset, ${ds.schema.length} columns`, 13.5, "#2a2f33"),
    I("time", x + 19, y + 88, 16, "#4a5358"),
    T(x + 37, y + 88, `Last new data ${mon(new Date(ds.updated_at.slice(0, 10) + "T00:00:00Z"))}`, 13.5, "#2a2f33"),
    I("database", x + 19, y + 110, 16, "#4a5358"),
    T(x + 37, y + 110, `${comma(ds.row_count)} rows`, 13.5, "#2a2f33"),
    T(x + 105, y + 110, "| Row count from the store, size n/a", 13.5, "#6a7378", 400, "font-style:italic"),
  ];
}

const TYPE: Record<string, string> = { str: "String", float: "Double", int: "Integer", bool: "Boolean" };

function drawer(ds: Dataset, rows: ReturnType<typeof useJson<Rows>>, onClose: () => void): N[] {
  const s: N[] = [R(333, 526, 1539, 488, "#fff", "", "border-top:1px solid #d3d9dc"), R(333, 526, 1539, 40, "#fff"), L(333, 565, 1872, 565, "#e1e6e8")];
  for (const [x, lab, ic, xe] of TABS) {
    const on = lab === "Preview";
    s.push(I(ic, x + 17, 546, 16, on ? "#2c64c2" : "#2a2f33"), T(x + 34, 546, lab, 15, on ? "#2c64c2" : "#2a2f33"));
    if (on) s.push(R(x, 563, xe - x, 2, "#2c64c2"));
  }
  s.push(I("double-chevron-down", 889, 546, 17, "#2a2f33"), I("maximize", 918, 546, 16, "#2a2f33"));
  s.push(I("th", 352, 583, 17, "#2c64c2"), T(370, 583, ds.name, 15.5, "#2a2f33"));
  const rs = rows?.data?.rows ?? [];
  s.push(R(1413, 568, 142, 30, "#f1f4f5"), T(1484, 583, rows?.ok ? `Showing first ${rs.length} of ${comma(ds.row_count)} rows` : unavailable("Rows", rows), 13.5, "#4a5358", 400, "", "", "c"));
  s.push(R(1558, 568, 92, 30, "#f1f4f5"), T(1604, 583, `${ds.schema.length} columns`, 14, "#4a5358", 400, "", "", "c"));
  s.push(I("search", 1672, 583, 17, "#2a2f33"), T(1690, 583, "Search columns...", 14.5, "#2a2f33"));
  s.push(R(333, 602, 1539, 44, "#f4f6f7"), L(333, 646, 1872, 646, "#d3d9dc"), R(333, 602, 44, 412, "#eef2f4"));
  const schema = rows?.data?.schema ?? ds.schema;
  const cols = schema.slice(0, 9);
  const xs = cols.map((_, i) => 383 + i * 167);
  cols.forEach((c, i) => {
    const x = xs[i]!;
    s.push(T(x, 613, c.name.length < 16 ? c.name : c.name.slice(0, 14) + "..", 15, "#2a2f33"), T(x, 634, TYPE[c.type] ?? c.type, 14, "#6a7378"));
    s.push(L(x - 8, 602, x - 8, 1014, "#e6eaec"));
  });
  const body: N[] = [];
  rs.forEach((row, r) => {
    const y = 660 + r * 22.8;
    body.push(T(355, y, String(r + 1), 13.5, "#4a5358", 400, "", "", "c"));
    cols.forEach((c, i) => {
      const v = row[c.name];
      const txt = v === null || v === undefined ? "" : typeof v === "number" && !Number.isInteger(v) ? v.toFixed(15) : String(v);
      body.push(T(xs[i]!, y, txt, 13.2, "#2a2f33", 400, "font-family:'DejaVu Sans Mono',monospace;font-size:13.8px;width:158px;overflow:hidden;text-overflow:ellipsis"));
    });
  });
  s.push(CLIP(333, 646, 1539, 368, body));
  s.push(
    R(1690, 960, 158, 32, "#fff", "#cdd3d6", "box-shadow:0 1px 5px rgba(0,0,0,.2);border-radius:2px"),
    T(1769, 976, "Calculate row count", 14.5, "#2c64c2", 400, "", "", "c"),
  );
  s.push(Hit(876, 532, 26, 28, "Close the preview", onClose));
  return s;
}

export function LineageView({ nav, focus }: { nav: (v: FoundryNav) => void; focus?: string | null }): JSX.Element {
  const lin = useJson<Lin>("/api/foundry/lineage");
  const dsR = useJson<Dataset[]>("/api/foundry/datasets");
  const bnd = useJson<Binding[]>("/api/foundry/bindings");
  const conns = useJson<{ connections: { kind?: string; type?: string }[] }>("/api/foundry/connections");
  const mons = useJson<unknown[]>("/api/foundry/monitors");
  const kinds = useJson<{ kinds: string[] }>("/api/foundry/kinds");
  const models = useJson<{ installed: unknown[] }>("/api/ai/models");
  const builds = useJson<Build[]>("/api/foundry/builds");
  const guard = useJson<Guardrails>("/api/ai/guardrails");

  const [sel, setSel] = useState<string | null>(focus ?? null);
  const [drawerOpen, setDrawer] = useState(Boolean(focus));
  const [mode, setMode] = useState<"color" | "perm">("color");
  const [legend, setLegend] = useState(true);
  const [close, setClose] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  const ds = new Map((dsR?.data ?? []).map((d) => [d.id, d]));
  const selDs = sel ? ds.get(sel) : undefined;
  const showDrawer = drawerOpen && Boolean(selDs);
  const rows = useJson<Rows>(showDrawer && sel ? `/api/foundry/datasets/${sel}/rows?limit=16` : null);

  const s: N[] = [];
  if (!lin?.ok || !lin.data) {
    s.push(R(282, 98, 1590, 916, "#e6eaee"), ...railDark(nav, "lineage"), ...linHeader([0, 0, 0]));
    s.push(T(1100, 560, unavailable("Lineage", lin), 17, "#59646a", 400, "", "", "c"));
    return frag(s);
  }
  const st: Store = {
    lin: lin.data,
    ds,
    bound: new Map((bnd?.data ?? []).map((b) => [b.dataset_id, b])),
    kinds: kinds?.data?.kinds ?? [],
  };
  const dsNodes = st.lin.nodes.filter((n) => n.type === "dataset");
  const nRaw = dsNodes.filter((n) => n.kind === "raw").length;
  const nRef = dsNodes.filter((n) => n.kind === "reference").length;
  const nTf = st.lin.nodes.filter((n) => n.type === "transform").length;
  const all = dsR?.data ?? [];
  const nNoData = all.filter((d) => d.row_count === 0).length;
  const bl = builds?.data ?? [];
  const bOk = bl.filter((b) => b.status === "succeeded").length;
  const bFail = bl.filter((b) => b.status === "failed").length;
  const cl = conns?.data?.connections ?? [];
  const ck = (re: RegExp): number => cl.filter((c) => re.test(String(c.kind ?? c.type ?? ""))).length;
  const n = (r: { ok: boolean } | null, v: number): string => (r?.ok ? String(v) : "n/a");
  const leg: [string, string][] = [
    ["#ae3462", `Data connections (${n(conns, cl.length)})`],
    ["#886a4e", `Raw datasets (${nRaw})`],
    ["#ead074", `Transforms (${nTf})`],
    ["#88e6ce", `Monitors (${n(mons, mons?.data?.length ?? 0)})`],
    ["#60c662", `Stream sources (${n(conns, ck(/mqtt|kafka|stream/i))})`],
    ["#60c662", `HTTP poll sources (${n(conns, ck(/http|poll/i))})`],
    ["#8eb8f4", `Reference datasets (${nRef})`],
    ["#ec5c9a", `Ontology-bound (${st.bound.size})`],
    ["#b84858", "Restricted (n/a)"],
    ["#4c72c2", `Ontology kinds (${n(kinds, st.kinds.length)})`],
    ["#c0c6ca", `Models (${n(models, models?.data?.installed.length ?? 0)})`],
    ["#427c42", `Builds (${n(builds, bl.length)})`],
  ];
  const clearance = guard?.ok ? String(guard.data?.clearance ?? 0) : "n/a";
  const perm = mode === "perm";
  const pick = (id: string): void => {
    setSel(id);
    // colour mode opens the preview (A9); permissions mode only selects (A11)
    setDrawer(!perm && ds.has(id));
  };
  // canvas transform per state: A12 close-up, A9 drawer, A10/A11 permissions, A7 base
  let cv: CanvasOpts;
  if (close) cv = { k: 2, dx: -700, dy: -1060, labelFs: 12.5 };
  else if (showDrawer) cv = { k: 0.42, dx: 600, dy: 128, labelFs: 16 };
  else if (perm) cv = { k: 0.42, dx: 560, dy: 110, labelFs: 17 };
  else cv = {};
  cv = { ...cv, sel, mode, onNode: pick, onHover: setHover };

  const page: N[] = [
    R(333, 152, 1497, 862, "#e6eaee"),
    Hit(333, 235, 1497, 743, "Clear the selection", sel ? () => { setSel(null); setDrawer(false); } : undefined, "Nothing selected"),
    ...lineageCanvas(st, cv), R(333, 152, 1497, 83, "rgba(230,234,238,.88)")];
  page.push(...railDark(nav, "lineage"), ...linHeader([bl.length - bOk - bFail, bOk, bFail]));
  page.push(...linToolbar(perm ? "Permissions" : "Custom color", perm ? "lock" : "tint"), ...rightRail(), ...zoomStack());
  page.push(...bottomTabs(sel && !showDrawer && perm ? TABS.map((t) => t[1]) : null));
  // No access: lineage datasets the datasets route did not list for this
  // principal; Permissions unknown: every lineage dataset when that route did
  // not answer 200 (nothing can be said about access then)
  const listed = new Set(all.map((d) => d.id));
  const nNoAccess = dsR?.ok ? dsNodes.filter((d) => !listed.has(d.id)).length : 0;
  const nUnknown = dsR?.ok ? 0 : dsNodes.length;
  if (perm) page.push(...permPanel(all.length - nNoData, nNoData, nNoAccess, nUnknown, clearance));
  else if (legend) page.push(...legendPanel(leg));
  if (sel && !close) page.push(T(1851, 991, "1 node selected", 14.5, "#4a5358", 400, "", "", "r"));
  if (showDrawer && selDs) page.push(...drawer(selDs, rows, () => setDrawer(false)));
  // toolbar + zoom controls
  page.push(
    Hit(1642, 165, 176, 34, perm ? "Node color: custom color" : "Node color: permissions", () => setMode(perm ? "color" : "perm")),
    Hit(1586, 165, 34, 34, legend ? "Hide the legend" : "Show the legend", perm ? undefined : () => setLegend(!legend)),
    Hit(345, 834, 33, 33, "Locate: fit the graph", () => setClose(false)),
    Hit(345, 867, 33, 33, "Zoom in", () => setClose(true)),
    Hit(345, 900, 33, 33, "Zoom out", () => setClose(false)),
    Hit(345, 933, 33, 33, "Zoom to fit", () => setClose(false)),
    Hit(343, 978, 87, 36, "Preview the selected dataset", selDs ? () => setDrawer(true) : undefined),
    Hit(870, 978, 36, 36, "Open the preview", selDs ? () => setDrawer(true) : undefined),
  );
  // hover card (A11): above-left of the hovered dataset, as the copy places it
  const hv = hover ? ds.get(hover) : undefined;
  if (hv && !close) {
    const p = lineageLayout(st.lin).get(hv.id);
    if (p) {
      const k = cv.k ?? 1;
      const x = p[0] * k + (cv.dx ?? 0);
      const y = p[1] * k + (cv.dy ?? 0);
      page.push(<div className="fr" style={{ pointerEvents: "none" }}>{frag(hoverCard(Math.max(340, x - 390), Math.max(160, y - 97), hv))}</div>);
    }
  }
  if (!close) {
    s.push(...page);
    return frag(s);
  }
  // A12: the close-up, the page shifted up 22 px, a white strip at the foot
  s.push(CLIP(282, 98, 1590, 916, [<div className="fr" style={{ top: -22 }}>{frag(page)}</div>]), R(282, 992, 1590, 22, "#fff"));
  const pos = lineageLayout(st.lin);
  for (const b of st.bound.values()) {
    const p = pos.get(b.dataset_id);
    if (!p) continue;
    const vx = p[0] * 2 - 700;
    const vy = p[1] * 2 - 1060 - 22;
    ["cube", "cloud-download"].forEach((ic, j) =>
      s.push(R(vx + 50 + j * 40, vy - 56, 36, 36, "#fff", "#2a2f33", "border-radius:50%;border-width:2px"), I(ic, vx + 68 + j * 40, vy - 38, 18, "#2a2f33")),
    );
  }
  s.push(T(1851, 975, "n/a: no restricted node on this box (0 No access)", 13, "#6a7378", 400, "", "", "r"));
  return frag(s);
}
