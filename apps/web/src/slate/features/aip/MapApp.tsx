// Map app: features A54-A59, ported from gotham/aip/_build_features_b.py
// (map_menubar .. a58, a59) over the scene-hormuz plate (the same scene fit as
// the light map in data.ts). Live layers: the Hormuz box, GPS-jamming cells
// (/api/jamming/nacp), AIS positions (/api/maritime/vessels), SAR candidates
// (/api/intel/dark-vessels/sar), registry matches (/api/sanctions/vessels),
// recorded vessel tracks (/api/history/tracks) for the 2-sigma ellipses, a
// Sentinel-2 chip (/api/imagery/chip) and the nominate_target action.
import { useEffect, useState } from "react";
import { apiFetch } from "../../../transport/http.js";
import { Hit, I, L, R, SVG, T, frag, type N } from "./ui.js";
import { inHormuz, sancRows, sarRows, sarTitle, scenePx, unavailable, useJson, type FC, type Sanc, type SancP, type Sar, type SarFC } from "./data.js";
import { age, ell, km, mgrs, type WItem } from "./dataB.js";
import { banner } from "./Titan.js";
import sceneHormuz from "./sceneHormuz.jpg";

const SCENE_W = 1882;
const SCENE_H = 1242;
const KM_PX = (111.32 * Math.cos((25.8 * Math.PI) / 180)) / 579.0603917238906;
const HZ_BOX: [number, number][] = [[53.5, 24.2], [58.8, 24.2], [58.8, 27.8], [53.5, 27.8]];
const MIN_FIXES = 20;

/** scene px (cx, cy) shown at pane centre at k screen px per scene px (the builder's MapView) */
class MapView {
  constructor(public x: number, public y: number, public w: number, public h: number, public cx: number, public cy: number, public k: number) {}
  px(px: number, py: number): [number, number] {
    return [this.x + this.w / 2 + (px - this.cx) * this.k, this.y + this.h / 2 + (py - this.cy) * this.k];
  }
  ll(lon: number, lat: number): [number, number] {
    const [a, b] = scenePx(lon, lat);
    return this.px(a, b);
  }
  inside(a: number, b: number, m = 0): boolean {
    return this.x + m < a && a < this.x + this.w - m && this.y + m < b && b < this.y + this.h - m;
  }
  bg(): N {
    const ox = this.x + this.w / 2 - this.cx * this.k;
    const oy = this.y + this.h / 2 - this.cy * this.k;
    return R(this.x, this.y, this.w, this.h, "#0c1a26", "", "overflow:hidden", R(ox - this.x, oy - this.y, SCENE_W * this.k, SCENE_H * this.k, `url(${sceneHormuz}) 0 0/100% 100%`));
  }
  kmPx(d: number): number {
    return (d / KM_PX) * this.k;
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
}

function menubar(onHome: () => void, y = 229, title = "GULF AND RED SEA WATCH"): N[] {
  const s: N[] = [R(406, 214, 1461, 30, "#0a0d11"), R(414, 221, 14, 14, "transparent", "#e8ecf0", "border-radius:50%;border-width:2px"), I("caret-down", 444, y, 11, "#e8ecf0"), R(466, 219, 31, 20, "#a8aeb6", "", "border-radius:10px"), I("chat", 481, y, 13, "#2a2f33"), Hit(408, 216, 48, 26, "AIP terminal", onHome)];
  for (const [it, x] of [["File", 521], ["Edit", 562], ["View", 606], ["Insert", 655], ["Selection", 717], ["Map", 775], ["Tools", 822], ["Help", 870], ["Develop", 925]] as const) s.push(T(x, y, it, 12.5, "#f2f4f6", 400, "", "", "c"));
  s.push(L(960, 218, 960, 240, "#2a2f35"), I("tick", 977, y, 13, "#3aa655"), T(1006, y, "Saved", 11, "#9aa2aa", 400, "", "", "c"));
  s.push(I("diagram-tree", 1052, y, 14, "#4c7fd4"), T(1066, y, title, 12.5, "#f2f4f6"), I("star-empty", 1199, y, 13, "#c6ccd2"), I("chevron-down", 1220, y, 12, "#c6ccd2"));
  s.push(I("locate", 1456, y, 15, "#c6ccd2"), I("flash", 1485, y, 15, "#c6ccd2"), I("pulse", 1516, y, 15, "#c6ccd2"), R(1522, 220, 5, 5, "#4c90f0", "", "border-radius:50%"), T(1557, y, "Share", 12.5, "#4c7fd4", 400, "", "", "c"), T(1619, y, "U", 12.5, "#e8ecf0", 400, "", "", "c"));
  s.push(R(1657, 218, 205, 22, "#0e1318", "#3a4048", "border-radius:2px"), I("search", 1669, y, 13, "#c6ccd2"), T(1683, y, "Search", 11.5, "#c6ccd2"));
  return s;
}

const PITCH = 17.6;
function layerTree(d: Live, sel: number | null, onRow: (i: number) => void): N[] {
  const tr = (i: number): string => `Registry match, track ${d.hz[i] ? String(d.hz[i]!.mmsi).slice(-4) : "n/a"}`;
  const rows: [string, string, number, string][] = [
    ["F", "Gulf and Red Sea watch map [VEL]", 0, "dot"], ["F", "1. Maritime", 0, "dot"],
    ["L", "Historic search - AIS recorder tracks", 1, "caret"], ["L", "Live feed - AIS vessels", 1, "eyeoff"],
    ["F", "2. SAR", 0, "dot"], ["L", "Dark-vessel SAR", 1, "grey"], ["L", "Live feed - SAR dark candidates", 1, "hover"],
    ["F", "3. Registry", 0, "dot"], ["L", "Sanctioned vessels", 1, "green"], ["S", tr(0), 2, ""], ["S", tr(1), 2, ""], ["S", tr(2), 2, ""], ["S", tr(3), 2, ""],
    ["L", "Live feed - Sentinel-2 chips", 1, "green"], ["L", "Imagery", 1, "rss"], ["S", `${d.sarDate ?? "n/a"} Sentinel-1`, 2, ""], ["S", "Chokepoint congestion", 1, "eyeoff"], ["W", "Watch items", 0, ""],
  ];
  const s: N[] = [];
  rows.forEach(([kind, lab, ind, tail], i) => {
    const y = 309 + i * PITCH;
    const x = 413 + ind * 9;
    if (sel === i) s.push(R(406, y - 8, 190, 17, "#fbe8d4"));
    let ic: [string, string] = { F: ["folder-close", "#9aa2aa"], L: ["satellite", "#4c7fd4"], S: ["dot", "#4c7fd4"], W: ["list", "#9aa2aa"] }[kind] as [string, string];
    if (kind === "S" && ind === 2 && lab.includes("Registry")) ic = ["shield", "#4c7fd4"];
    if (kind === "S" && lab.includes("Sentinel")) ic = ["media", "#4c7fd4"];
    s.push(I(ic[0], x + 5, y, 9, ic[1]), T(x + 16, y, lab.slice(0, 40), 7.6, "#3a3e44"));
    if (tail === "dot") s.push(R(584, y - 1.5, 3, 3, "#3a3e44", "", "border-radius:50%"));
    else if (tail === "green") s.push(R(580, y - 5, 10, 10, "#3aa655", "", "border-radius:50%"), I("arrow-up", 585, y, 6, "#fff"));
    else if (tail === "grey") s.push(R(580, y - 5, 10, 10, "#a8aeb6", "", "border-radius:50%"));
    else if (tail === "eyeoff") s.push(I("eye-off", 572, y, 9, "#6a7378"), R(580, y - 5, 10, 10, "#a8aeb6", "", "border-radius:50%"));
    else if (tail === "hover") s.push(I("edit", 538, y, 7, "#6a7378"), I("locate", 554, y, 7, "#6a7378"), I("eye-open", 570, y, 8, "#6a7378"), R(580, y - 5, 10, 10, "#3aa655", "", "border-radius:50%"));
    else if (tail === "rss") s.push(I("feed", 586, y, 8, "#a8aeb6"));
    if (i === 2 || i === 3) s.push(Hit(406, y - 8, 190, 17, `Select layer: ${lab}`, () => onRow(i)));
  });
  return s;
}
function mapLeft(d: Live, nOverlays: number, sel: number | null, onRow: (i: number) => void): N[] {
  const s: N[] = [R(405, 244, 192, 694, "#fff"), R(405, 244, 192, 26, "#343c46"), R(405, 268, 66, 2, "#4c90f0")];
  s.push(T(433, 257, "Map layers", 7.8, "#f2f4f6", 600, "", "", "c"), I("database", 480, 257, 8, "#aab2ba"), T(509, 257, "Data sources", 7.8, "#aab2ba", 400, "", "", "c"), I("wrench", 558, 257, 8, "#aab2ba"), T(576, 257, "Tools", 7.8, "#aab2ba", 400, "", "", "c"));
  s.push(R(406, 277, 184, 17, "#eaeef2"), I("search", 410, 285, 8, "#6a7378"), T(414, 285, "Search this map...", 7.6, "#8a9298"));
  s.push(...layerTree(d, sel, onRow));
  s.push(R(405, 920, 192, 18, "#d9dde1"), T(420, 930, "Satellite basemap", 7, "#4a5358"), T(580, 930, `${nOverlays} overlays`, 7, "#4a5358", 400, "", "", "r"), I("camera", 605, 931, 9, "#4a5358"));
  s.push(R(598, 806, 17, 114, "#fff", "#d9dfe2"), ...["map-marker", "layers", "th", "edit", "send-to", "export"].map((ic, i) => I(ic, 606, 814 + i * 20, 9, "#4a5358")));
  return s;
}
function toolbars(): N[] {
  const s: N[] = [R(596, 246, 199, 38, "#fff"), R(596, 286, 199, 36, "#fff"), R(787, 246, 8, 76, "#fff")];
  s.push(T(602, 254, "Track symbols", 6.5, "#8a9298"), I("caret-down", 653, 254, 7, "#4a5358"), T(602, 271, "Vessels", 8, "#4a5358"), I("caret-down", 657, 271, 7, "#4a5358"), R(670, 266, 12, 9, "#9fd6ee", "#6aa6c4"), I("caret-down", 691, 271, 7, "#4a5358"), T(713, 271, "Symbol", 7.5, "#4a5358"), I("caret-down", 769, 271, 7, "#4a5358"));
  s.push(T(602, 294, "Annotations", 6.5, "#8a9298"), I("caret-down", 646, 294, 7, "#4a5358"), T(602, 312, "Symbol", 7.5, "#4a5358"), I("caret-down", 641, 312, 7, "#4a5358"));
  for (const [x, ic] of [[664, "record"], [684, "more"], [705, "polygon-filter"], [726, "widget"], [747, "add-to-artifact"], [768, "square"]] as const) s.push(I(ic, x, 312, 9, "#4a5358"));
  s.push(I("chevron-left", 788, 264, 8, "#4a5358"), I("chevron-left", 788, 303, 8, "#4a5358"));
  return s;
}
function diamond(x: number, y: number, col: string, sz: number, label: string): N[] {
  return [
    <svg className="a" aria-hidden style={{ left: x - sz - 1, top: y - sz - 1, width: 2 * sz + 2, height: 2 * sz + 2 }}>
      <polygon points={`${sz + 1},1 ${2 * sz + 1},${sz + 1} ${sz + 1},${2 * sz + 1} 1,${sz + 1}`} fill={col} stroke="#3a1a1e" strokeWidth={1.3} fillOpacity={0.92} />
    </svg>,
    T(x, y + sz + 7, label, 6.5, "#fff", 400, "text-shadow:0 0 2px #000,0 0 2px #000", "", "c"),
  ];
}
const mapBg = (ban: string): N[] => [R(405, 184, 1463, 754, "#0c1a26"), ...banner(ban)];
const poly = (pts: [number, number][]): string => pts.map(([a, b]) => `${a.toFixed(0)},${b.toFixed(0)}`).join(" ");

// ── A55 canvas ───────────────────────────────────────────────────────────────
function canvas(d: Live, onSar: (s: Sar) => void): { s: N[]; n: number; dkm: number | null } {
  const v = new MapView(597, 244, 1270, 694, 700, 760, 0.85);
  const s: N[] = [v.bg()];
  const hits: N[] = []; // drawn last: the overlays above a marker must not swallow its click
  let n = 0;
  s.push(SVG([<polygon points={poly(HZ_BOX.map(([a, b]) => v.ll(a, b)))} fill="rgba(70,120,210,.22)" stroke="#5b8ae0" strokeWidth={1.5} />], 597, 244, 1270, 694, "overflow:hidden"));
  n++;
  const js: N[] = [];
  for (const j of d.jam) {
    const q = j.ring.map((c) => v.ll(c[0]!, c[1]!));
    if (!q.some(([a, b]) => v.inside(a, b))) continue;
    js.push(<polygon points={poly(q)} fill="rgba(220,70,80,.30)" stroke="#d63c4a" strokeWidth={1.6} />);
    const cx = q.reduce((a, p) => a + p[0], 0) / q.length;
    const cy = q.reduce((a, p) => a + p[1], 0) / q.length;
    if (v.inside(cx, cy, 30)) js.push(<text x={cx.toFixed(0)} y={cy.toFixed(0)} fontSize={9} fill="#fff" textAnchor="middle" stroke="#000" strokeWidth={0.3}>GPS jamming {Math.round(j.pct)}% bad</text>);
  }
  if (js.length) n++;
  s.push(SVG(js, 597, 244, 1270, 694, "overflow:hidden"));
  const dots = d.vessels.map(([lon, lat]) => v.ll(lon, lat)).filter(([a, b]) => v.inside(a, b, 4)).map(([a, b]) => <circle cx={a.toFixed(1)} cy={b.toFixed(1)} r={2.2} fill="#e8f040" fillOpacity={0.85} />);
  if (dots.length) n++;
  s.push(SVG(dots, 597, 244, 1270, 694, "overflow:hidden"));
  let nSar = 0;
  for (const sr of d.sar) {
    const [a, b] = v.ll(...sr.xy);
    if (!v.inside(a, b, 10)) continue;
    nSar++;
    s.push(R(a - 7, b - 7, 14, 14, "rgba(255,170,60,.15)", "#ffb347", "border-width:2px"), T(a, b + 17, sarTitle(sr), 6.5, "#fff", 400, "text-shadow:0 0 2px #000", "", "c"));
    hits.push(Hit(a - 9, b - 9, 18, 18, `Open the Sentinel-2 chip at ${sarTitle(sr)}`, () => onSar(sr)));
  }
  if (nSar) n++;
  let nReg = 0;
  for (const sc of d.hz) {
    const [a, b] = v.ll(...sc.xy);
    if (v.inside(a, b, 10)) {
      nReg++;
      s.push(...diamond(a, b, "#f0707a", 8, `Track ${String(sc.mmsi).slice(-4)} ${sc.cls}`));
    }
  }
  if (nReg) n++;
  const longest = [...d.sar].sort((p, q) => q.lengthM - p.lengthM)[0];
  let dkm: number | null = null;
  if (longest && d.choke) {
    const a = longest.xy;
    const b = d.choke.slice(0, 2);
    const [xa, ya] = v.ll(a[0], a[1]);
    const [xb, yb] = v.ll(b[0]!, b[1]!);
    dkm = km(a, b);
    const ln: N[] = [<line x1={xa.toFixed(0)} y1={ya.toFixed(0)} x2={xb.toFixed(0)} y2={yb.toFixed(0)} stroke="#000" strokeWidth={2} />];
    for (let i = 1; i <= Math.floor(dkm / 5); i++) {
      const f = (i * 5) / dkm;
      const tx = xa + (xb - xa) * f;
      const ty = ya + (yb - ya) * f;
      ln.push(<circle cx={tx.toFixed(0)} cy={ty.toFixed(0)} r={2.4} fill="#f0e020" />, <text x={(tx + 4).toFixed(0)} y={(ty - 4).toFixed(0)} fontSize={8} fill="#f0e020" stroke="#000" strokeWidth={0.3}>{i * 5}</text>);
    }
    ln.push(<circle cx={xa.toFixed(0)} cy={ya.toFixed(0)} r={3} fill="#000" />, <circle cx={xb.toFixed(0)} cy={yb.toFixed(0)} r={3} fill="#000" />, <text x={((xa + xb) / 2 + 6).toFixed(0)} y={((ya + yb) / 2 + 12).toFixed(0)} fontSize={9} fill="#f0e020" stroke="#000" strokeWidth={0.3}>{dkm.toFixed(2)} km</text>);
    s.push(SVG(ln, 597, 244, 1270, 694, "overflow:hidden"), R(xb - 15, yb - 15, 30, 30, "rgba(76,127,212,.10)", "#4c7fd4", "border-radius:50%;border-width:2px"));
    n++;
  }
  s.push(...hits);
  return { s, n, dkm };
}

// ── A56 layer selection ──────────────────────────────────────────────────────
function pickView(tracks: Track[], w = 1092, h = 694, k = 3.0): [number, number] {
  let best: [number, number, number] | null = null;
  for (let gx = 200; gx < 1500; gx += 25)
    for (let gy = 350; gy < 1150; gy += 25) {
      const v = new MapView(597, 244, w, h, gx, gy, k);
      let c = 0;
      for (const t of tracks) {
        const [a, b] = v.ll(t.e[0], t.e[1]);
        if (v.inside(a, b, 60)) c++;
      }
      if (!best || c > best[0]) best = [c, gx, gy];
    }
  return [best![1], best![2]];
}
const ellipse = (v: MapView, e: Track["e"], fill: string, sw: number): N => {
  const [a, b] = v.ll(e[0], e[1]);
  return <ellipse cx={a.toFixed(1)} cy={b.toFixed(1)} rx={v.kmPx(e[2]).toFixed(1)} ry={v.kmPx(e[3]).toFixed(1)} transform={`rotate(${(-e[4]).toFixed(1)} ${a.toFixed(1)} ${b.toFixed(1)})`} fill={fill} stroke="#d8ea3c" strokeWidth={sw} strokeOpacity={0.9} />;
};
function selFrame(onClose: () => void): N[] {
  return [R(1689, 246, 179, 692, "#fafbfc", "#d9dfe2"), T(1695, 255, "Selection", 7.5, "#3a3e44", 600), I("locate", 1821, 255, 8, "#4a5358"), I("eye-open", 1837, 255, 8, "#4a5358"), I("cross", 1859, 255, 8, "#4a5358"), Hit(1852, 248, 14, 14, "Close the selection", onClose)];
}
const kvs = (y: number, k: string, v: string, x = 1760): N[] => [T(1701, y, k, 6.8, "#8a9298"), T(x, y, v, 6.8, "#3a3e44")];
const fmtShort = (t: number): string => {
  const d = new Date(t * 1000);
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${m} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
};
function layerSel(d: Live, onEntity: (t: Track) => void, onClose: () => void): N[] {
  const [gx, gy] = d.tracks.length ? pickView(d.tracks) : [700, 760];
  const v = new MapView(597, 244, 1092, 694, gx, gy, 3.0);
  const s: N[] = [v.bg()];
  const sv: N[] = [];
  for (const t of d.tracks) {
    const [a, b] = v.ll(t.e[0], t.e[1]);
    if (!v.inside(a, b, -150)) continue;
    sv.push(ellipse(v, t.e, "none", 1.5));
    t.pts.filter((_, i) => i % 3 === 0).forEach((p) => {
      const [x, y] = v.ll(p[0], p[1]);
      sv.push(<circle cx={x.toFixed(1)} cy={y.toFixed(1)} r={2.6} fill="#d8ea3c" fillOpacity={0.55} />);
    });
    if (v.inside(a, b)) s.push(Hit(a - 10, b - 10, 20, 20, `Select track ${t.id.slice(-4)}`, () => onEntity(t)));
  }
  s.splice(1, 0, SVG(sv, 597, 244, 1092, 694, "overflow:hidden"));
  const t0 = d.tracks.length ? Math.min(...d.tracks.map((t) => t.pts[0]![2])) : null;
  const t1 = d.tracks.length ? Math.max(...d.tracks.map((t) => t.pts[t.pts.length - 1]![2])) : null;
  s.push(...selFrame(onClose), R(1696, 270, 24, 24, "#dde6f4", "", "border-radius:50%"), I("satellite", 1708, 282, 12, "#4c7fd4"), T(1729, 281, "Live feed - AIS recorder tracks", 7.6, "#2a2f33", 600), T(1729, 291, `Flattened live layer • ${d.tracks.length} Objects`, 6.8, "#8a9298"));
  if (d.tracksErr) s.push(T(1143, 591, d.tracksErr, 13, "#e8ecf0", 400, "text-shadow:0 0 3px #000", "", "c"));
  s.push(...kvs(313, "Recorded", t0 === null ? "n/a" : fmtShort(t0), 1741), ...kvs(326, "Source", "/api/history/tracks", 1741));
  s.push(...kvs(339, "Last poll", t1 === null ? "n/a" : `${age(Date.now() / 1000 - t1)} ago`, 1741), ...kvs(352, "Backing Dataset", "History archive", 1759), ...kvs(365, "Backing Query", "Live feed - AIS recor...", 1759), R(1842, 361, 9, 9, "#3aa655", "", "border-radius:50%"));
  s.push(R(1695, 389, 156, 16, "#fff", "#d9dfe2"), I("th-list", 1740, 397, 8, "#4a5358"), T(1782, 397, "Open in table", 7, "#3a3e44", 400, "", "", "c"));
  s.push(R(1690, 417, 177, 18, "#f1f3f5"), I("info-sign", 1700, 426, 8, "#4a5358"), T(1722, 426, "Details", 7, "#3a3e44"), I("chevron-down", 1846, 426, 7, "#4a5358"), T(1695, 447, "Search query", 6.5, "#8a9298"));
  const clauses: [number, number, string, string][] = [
    [459, 15, "Observation Type", "is AIS position"],
    [489, 22, "Entity Location", "intersects a polygon with 4 vertices"],
    [528, 22, "Observation Currency", t0 !== null && t1 !== null ? `is within ${((t1 - t0) / 3600).toFixed(1)} hours` : "is within the archive window"],
    [570, 15, "Track fixes", `is at least ${MIN_FIXES}`],
  ];
  for (const [y0, h, a, b] of clauses) {
    s.push(R(1695, y0, 156, h, "#fff", "#e6eaec"), T(1700, y0 + 8, <><b>{a}</b> <span style={{ color: "#8a9298" }}>{b}</span></>, 6.8, "#3a3e44"));
    if (y0 < 570) s.push(T(1773, y0 + h + 7, "AND", 5.8, "#9aa2aa", 400, "", "", "c"));
  }
  s.push(I("filter", 1700, 647, 8, "#4a5358"), T(1722, 647, "Filters", 7, "#3a3e44"), T(1836, 647, "1", 6.5, "#3a3e44", 400, "", "", "r"), I("chevron-right", 1845, 647, 7, "#4a5358"));
  s.push(I("th-list", 1700, 668, 8, "#4a5358"), T(1722, 668, "Histogram", 7, "#3a3e44"), I("chevron-down", 1846, 668, 7, "#4a5358"));
  s.push(T(1708, 691, "List", 6.8, "#3a3e44"), T(1743, 691, <b>Histogram</b>, 6.8, "#3a3e44"), I("search", 1845, 691, 8, "#4a5358"), L(1695, 700, 1855, 700, "#d9dfe2"));
  s.push(R(1695, 705, 160, 13, "#fbe8d4"), T(1706, 711, "Live feed - AIS recorder tracks", 6.3, "#a8641a"));
  s.push(T(1700, 731, <><i>fx</i> {" "} Style rules</>, 7, "#3a3e44"), I("chevron-right", 1845, 731, 7, "#4a5358"), I("edit", 1700, 752, 8, "#4a5358"), T(1722, 752, "Appearance", 7, "#3a3e44"), I("chevron-down", 1846, 752, 7, "#4a5358"));
  s.push(T(1697, 773, <b>Object</b>, 6.8, "#3a3e44"), T(1697, 784, "Icon", 6, "#8a9298"), R(1697, 791, 154, 14, "#fff", "#d9dfe2"), T(1717, 798, "Select an icon", 6.5, "#4a5358"), T(1697, 818, "Stroke", 6, "#8a9298"), T(1776, 818, "Fill", 6, "#8a9298"));
  s.push(R(1697, 823, 70, 11, "#fff", "#d9dfe2"), R(1702, 828, 60, 2, "#d8ea3c"), R(1776, 823, 75, 11, "#fff", "#d9dfe2"), T(1697, 845, "Icon scale", 6, "#8a9298"), T(1787, 845, "Icon size", 6, "#8a9298"), R(1697, 851, 80, 11, "#fff", "#d9dfe2"), T(1703, 857, "Region", 6, "#4a5358"), R(1787, 851, 64, 11, "#fff", "#d9dfe2"), T(1793, 857, "0.35x", 6, "#4a5358"));
  s.push(T(1697, 876, "Text label", 6.5, "#3a3e44"), R(1832, 872, 18, 8, "#d9dfe2", "", "border-radius:4px"));
  return s;
}

/** the builder's pick_entity: the longest 8-80 km track of >= 30 fixes that is not a registry match */
export function pickEntity(tracks: Track[], sancMmsi: Set<string>): { t: Track; path: number } | null {
  let best: { t: Track; path: number } | null = null;
  for (const t of tracks) {
    if (sancMmsi.has(t.id.replace("vessel:", "")) || t.pts.length < 30) continue;
    let path = 0;
    for (let i = 0; i + 1 < t.pts.length; i++) path += km(t.pts[i]!, t.pts[i + 1]!);
    if (path > 8 && path < 80 && (!best || path > best.path)) best = { t, path };
  }
  return best;
}

// ── A57 live entity ──────────────────────────────────────────────────────────
function entity(d: Live, t: Track, onClose: () => void): N[] {
  const last = t.pts[t.pts.length - 1]!;
  const [px, py] = scenePx(t.e[0], t.e[1]);
  const v = new MapView(597, 244, 1092, 694, px, py, 2.6);
  const sv: N[] = [];
  for (const o of d.tracks) {
    const [a, b] = v.ll(o.e[0], o.e[1]);
    if (o.id !== t.id && v.inside(a, b, -40))
      o.pts.filter((_, i) => i % 6 === 0).forEach((p) => {
        const [x, y] = v.ll(p[0], p[1]);
        sv.push(<circle cx={x.toFixed(1)} cy={y.toFixed(1)} r={2.4} fill="#d8ea3c" fillOpacity={0.7} />);
      });
  }
  sv.push(ellipse(v, t.e, "rgba(216,234,60,.10)", 1.6));
  for (const p of t.pts) {
    const [x, y] = v.ll(p[0], p[1]);
    sv.push(<circle cx={x.toFixed(1)} cy={y.toFixed(1)} r={3.4} fill="#e8f45a" fillOpacity={0.8} />);
  }
  const tid = t.id.replace("vessel:", "").slice(-4);
  const [la, lb] = v.ll(last[0], last[1]);
  const now = Date.now() / 1000;
  const s: N[] = [v.bg(), SVG(sv, 597, 244, 1092, 694, "overflow:hidden"), R(la - 11, lb - 11, 22, 22, "#3f73d6", "#fff", "border-radius:3px;border-width:2px"), I("ship", la, lb, 14, "#fff"), T(la, lb + 21, `Track ${tid}`, 7.5, "#fff", 400, "text-shadow:0 0 2px #000", "", "c")];
  s.push(...selFrame(onClose));
  s.push(I("ship", 1711, 285, 14, "#2a2f33"), T(1729, 277, `Track ${tid}`, 7.6, "#4c6aa8", 600), T(1729, 287, "Live entity", 6.8, "#8a9298"), T(1729, 297, `Latest location in ${age(now - last[2])}`, 6.5, "#8a9298"));
  s.push(...kvs(315, "Last updated", `${age(now - last[2])} ago`, 1750), ...kvs(328, "Data source", "AIS history archive", 1750), ...kvs(341, "Layer", "AIS recorder tracks", 1750), ...kvs(354, "Classification", "U", 1750));
  s.push(R(1695, 376, 155, 15, "#fff", "#d9dfe2"), T(1770, 384, "Actions \u00a0▾", 7, "#3a3e44", 400, "", "", "c"));
  s.push(I("media", 1700, 409, 8, "#4a5358"), T(1711, 409, "Imagery preview", 7, "#3a3e44"), I("chevron-down", 1846, 409, 7, "#4a5358"));
  const tv = new MapView(1690, 423, 165, 95, px, py, 5.0);
  const [tx, ty] = tv.ll(last[0], last[1]);
  s.push(tv.bg(), R(tx - 4, ty - 4, 8, 8, "rgba(63,115,214,.35)", "#fff", "border-radius:50%"));
  s.push(T(1700, 531, "Correlation", 7, "#3a3e44"), I("chevron-right", 1845, 531, 7, "#4a5358"), I("info-sign", 1700, 552, 8, "#4a5358"), T(1722, 552, "Details", 7, "#3a3e44"), I("chevron-down", 1846, 552, 7, "#4a5358"));
  s.push(R(1695, 570, 160, 18, "#fff", "#e6eaec"), T(1717, 579, "Properties", 7, "#3a3e44"), R(1697, 592, 156, 11, "#f1f3f5"), T(1701, 597, "FEATURED PROPERTIES", 5.6, "#8a9298"));
  const ts = new Date(last[2] * 1000);
  s.push(T(1702, 614, "Timestamp", 6, "#8a9298"), T(1702, 628, ts.toLocaleString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).replace(" at ", " ") + " UTC", 6.3, "#3a3e44"), T(1700, 645, "ADDITIONAL PROPERTIES", 5.6, "#8a9298"), I("chevron-right", 1845, 645, 7, "#4a5358"));
  s.push(I("add-to-artifact", 1700, 669, 8, "#4a5358"), T(1722, 669, "Enhancements", 7, "#3a3e44"), I("chevron-down", 1846, 669, 7, "#4a5358"));
  s.push(T(1708, 695, "Range rings", 6.3, "#3a3e44"), R(1695, 710, 155, 16, "#fff", "#d9dfe2"), I("add", 1745, 718, 7, "#4a5358"), T(1782, 718, "Add range ring", 6.3, "#4a5358", 400, "", "", "c"));
  s.push(T(1708, 748, "Range fans", 6.3, "#3a3e44"), R(1695, 763, 155, 16, "#fff", "#d9dfe2"), I("add", 1745, 771, 7, "#4a5358"), T(1782, 771, "Add range fan", 6.3, "#4a5358", 400, "", "", "c"));
  s.push(T(1708, 801, "Maritime movement projection", 6.3, "#3a3e44"), R(1695, 816, 155, 20, "#fff", "#d9dfe2"), T(1700, 826, "30 min projection: no sog or course in the archive", 5.8, "#4a5358"));
  s.push(I("edit", 1700, 857, 8, "#4a5358"), T(1722, 857, "Appearance", 7, "#3a3e44"), I("chevron-down", 1846, 857, 7, "#4a5358"), T(1697, 877, <b>Object</b>, 6.8, "#3a3e44"), T(1697, 889, "Icon", 6, "#8a9298"), R(1697, 896, 70, 13, "#fff", "#d9dfe2"), T(1712, 903, "Ship ▾", 6.3, "#4a5358"), T(1697, 920, "Icon size", 6, "#8a9298"), R(1697, 925, 70, 11, "#fff", "#d9dfe2"), T(1703, 931, "1.00x", 6, "#4a5358"));
  return s;
}

// ── A58 image viewer ─────────────────────────────────────────────────────────
/** chip_view(): crop the centre 600 m of the 1.6 km chip to 1266x647 and stretch (99.5th percentile, gamma .6) */
function useChip(sar: Sar | null): { url: string | null; err: string | null } {
  const [st, setSt] = useState<{ url: string | null; err: string | null }>({ url: null, err: null });
  useEffect(() => {
    if (!sar) return;
    let live = true;
    let made: string | null = null;
    setSt({ url: null, err: null });
    void (async () => {
      try {
        const r = await apiFetch(`/api/imagery/chip?lat=${sar.xy[1]}&lon=${sar.xy[0]}&radius_km=0.8`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bmp = await createImageBitmap(await r.blob());
        const cw = Math.trunc((bmp.width * 0.6) / 1.6);
        const ch = Math.trunc((cw * 647) / 1266);
        const cv = document.createElement("canvas");
        cv.width = 1266;
        cv.height = 647;
        const g = cv.getContext("2d")!;
        g.drawImage(bmp, Math.trunc(bmp.width / 2 - cw / 2), Math.trunc(bmp.height / 2 - ch / 2), cw, ch, 0, 0, 1266, 647);
        const im = g.getImageData(0, 0, 1266, 647);
        const vals: number[] = [];
        for (let i = 0; i < im.data.length; i += 4) vals.push(im.data[i]!, im.data[i + 1]!, im.data[i + 2]!);
        vals.sort((a, b) => a - b);
        const p = Math.max(vals[Math.floor(0.995 * (vals.length - 1))] ?? 255, 1);
        for (let i = 0; i < im.data.length; i++) if (i % 4 !== 3) im.data[i] = Math.min(1, im.data[i]! / p) ** 0.6 * 255;
        g.putImageData(im, 0, 0);
        const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/jpeg", 0.88));
        if (!blob) throw new Error("encode");
        made = URL.createObjectURL(blob);
        if (live) setSt({ url: made, err: null });
      } catch (e) {
        if (live) setSt({ url: null, err: `Sentinel-2 chip unavailable (${e instanceof Error && e.message.startsWith("HTTP") ? e.message : "decode failed"})` });
      }
    })();
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [sar]);
  return st;
}
function viewer(sar: Sar, date: string | null, chip: { url: string | null; err: string | null }, h: { onClose: () => void; onNominate: () => void }): N[] {
  const s: N[] = [R(406, 245, 1461, 19, "#10161e"), R(872, 245, 93, 19, "#2c4a80", "#4c7fd4"), T(918, 254, "View images", 8, "#cfe0ff", 400, "", "", "c"), T(1016, 254, "Compare images", 8, "#7a828a", 400, "", "", "c"), T(1111, 254, "View in 3D", 8, "#9aa2aa", 400, "", "", "c")];
  for (let x = 1683; x < 1832; x += 20) s.push(R(x, 250, 9, 9, "#9aa2aa"));
  const dd = date ? new Date(date + "T00:00:00Z") : null;
  const dlab = dd ? dd.toUTCString().slice(5, 16).replace(/^(\d+) (\w+) (\d+)$/, "$2 $1 $3").toUpperCase() : "n/a";
  s.push(R(406, 268, 1266, 19, "#2c4a80"), T(430, 277, `1 ${"\u00a0"}${dlab} Sentinel-2`, 7, "#e8ecf0", 600), T(1519, 277, "U", 7, "#e8ecf0"), T(1600, 277, "Selected ×", 7, "#cfe0ff"), Hit(1590, 270, 50, 15, "Close the image viewer", h.onClose));
  s.push(R(406, 288, 1266, 647, chip.url ? `url(${chip.url}) 0 0/100% 100%` : "#0c1a26", "", "border:2px solid #4c7fd4"));
  if (!chip.url) s.push(T(1039, 611, chip.err ?? "loading Sentinel-2 chip…", 14, "#c6ccd2", 400, "", "", "c"));
  const cx = 1039;
  const cy = 611;
  const lw = (sar.lengthM / 600) * 1266;
  const wd = (sar.widthM / 600) * 1266;
  s.push(R(cx - lw / 2, cy - wd / 2, lw, wd, "transparent", "", `border:2.5px solid #f0a040;transform:rotate(${sar.headingDeg - 90}deg)`), T(cx, cy + 40, "Vessel candidate", 7, "#e8d0a0", 400, "", "", "c"));
  s.push(R(920, 847, 189, 82, "#1c2024", "#3a3f45"), I("zoom-in", 935, 861, 11, "#c6ccd2"), T(951, 856, "Vessel candidate", 7, "#e8ebee", 600), T(951, 867, "Detection", 7, "#e8ebee", 600), I("cross", 1097, 861, 8, "#c6ccd2"), Hit(1090, 854, 14, 14, "Close the detection", h.onClose));
  s.push(L(921, 877, 1108, 877, "#2c3034"), T(926, 890, <>Source <span style={{ color: "#e8ebee" }}>Sentinel-1 SAR</span></>, 6.3, "#8a9298"), T(1072, 890, "Actions ▾", 6.3, "#c6ccd2", 400, "", "", "c"), Hit(1050, 884, 44, 13, "Actions: nominate this detection", h.onNominate));
  s.push(R(926, 908, 177, 14, "#2c3034", "#3a3f45"), T(931, 915, "Verify detection", 6.3, "#e8ebee"), T(1050, 915, `Candidate, ${sar.classification.confidence} ▾`, 6.3, "#e8ebee", 400, "", "", "c"));
  s.push(R(1578, 870, 88, 36, "rgba(16,22,30,.85)", "#8aa83a"), T(1583, 878, `${sar.xy[1].toFixed(6)}°, ${sar.xy[0].toFixed(6)}°`, 5.8, "#e8ecf0"), T(1583, 888, mgrs(sar.xy[1], sar.xy[0]), 5.8, "#e8ecf0"), T(1583, 898, "0.60km x 0.31km", 5.8, "#e8ecf0"));
  s.push(R(1610, 916, 55, 9, "#2c4a80", "#4c7fd4"), T(1637, 921, "100m", 5.8, "#e8ecf0", 400, "", "", "c"));
  s.push(R(1673, 287, 195, 651, "#16191d"), L(1673, 287, 1673, 938, "#2c3034"), T(1690, 279, "Adjust Image", 6.8, "#c6ccd2"), I("tick", 1830, 279, 8, "#7a9cf0"), T(1853, 279, "Enabled", 6.3, "#c6ccd2", 400, "", "", "r"), T(1679, 295, "Adjust color, brightness, and sharpness for image 1 in the layout.", 5.5, "#8a9298"));
  const sl: [string, number][] = [["Temperature", 0], ["Tint", 0], ["Brightness", 0.5], ["Contrast", 0.2], ["Saturation", 0], ["Sharpness", 0], ["Alpha Threshold", 0]];
  sl.forEach(([lab, val], i) => {
    const y = 333 + i * 28.7;
    s.push(T(1679, y, lab, 5.8, "#e8ebee", 600));
    const ticks = lab === "Sharpness" ? ["0%", "100%", "200%", "300%", "400%"] : lab === "Alpha Threshold" ? ["0%", "", "", "", "100%"] : ["-100%", "-50%", "0%", "50%", "100%"];
    ticks.forEach((t, j) => s.push(T(1745 + j * 24.5, y + 4, t, 4.8, "#9aa2aa", 400, "", "", "c")));
    const pos = lab === "Sharpness" || lab === "Alpha Threshold" ? val : (val + 1) / 2;
    s.push(L(1745, y - 3, 1845, y - 3, "#3a3f45"), R(1745 + 100 * pos - 4, y - 8, 8, 10, "#c6ccd2", "", "border-radius:2px"));
  });
  return s;
}

// ── A59 nominate ─────────────────────────────────────────────────────────────
type Phase = { state: "busy" | "ok" | "error"; msg: string } | null;
function nominate(it: WItem | null, tid: string, ll: [number, number] | null, phase: Phase, h: { onCancel: () => void; onGo?: (() => void) | undefined }): N[] {
  const s: N[] = [R(406, 214, 1461, 724, "rgba(40,44,48,.62)"), R(660, 274, 948, 664, "#282c30", "#3a3f45"), T(674, 293, "Nominate", 13, "#f2f4f6", 600), I("cross", 1592, 293, 12, "#c6ccd2"), Hit(1584, 285, 16, 16, "Close", h.onCancel), L(661, 312, 1607, 312, "#3a3f45")];
  s.push(T(674, 337, "Board", 14.5, "#f2f4f6", 600), T(674, 366, "Options for target type and subtype are derived from the target board stages", 12.5, "#c6ccd2"));
  s.push(R(675, 385, 906, 28, "#32363c", "#3a3f45", "border-radius:2px"), I("record", 691, 399, 13, "#e0605a"), T(706, 399, "Target board", 12.5, "#e8ebee"), I("caret-down", 1563, 399, 11, "#c6ccd2"));
  s.push(T(674, 437, "Select a column to add this target to", 14, "#f2f4f6", 600), R(675, 458, 906, 28, "#32363c", "#3a3f45", "border-radius:2px"));
  s.push(<svg className="a" aria-hidden style={{ left: 688, top: 465, width: 10, height: 14 }}><polygon points="5,0 10,7 5,14 0,7" fill="#c8a46a" /></svg>, T(706, 472, "Confirm", 12.5, "#e8ebee"), I("caret-down", 1563, 472, 11, "#c6ccd2"));
  s.push(L(661, 508, 1607, 508, "#3a3f45"), T(674, 535, "Target", 12.5, "#c6ccd2"), R(675, 549, 906, 49, "#2c3236"), I("record", 697, 573, 14, "#c6ccd2"), T(712, 573, tid, 12.5, "#e8ebee"));
  s.push(L(661, 618, 1607, 618, "#3a3f45"), T(674, 646, "Name", 12.5, "#c6ccd2"), R(675, 660, 906, 29, "#161a1e", "#4c7fd4", "border-width:2px"), T(685, 674, it?.title ?? "n/a", 12.5, "#e8ebee"));
  s.push(T(674, 712, "Priority", 12.5, "#c6ccd2"), T(1138, 712, "Kind", 12.5, "#c6ccd2"), R(675, 726, 443, 29, "#161a1e", "#3a3f45"), T(685, 740, "3", 12.5, "#e8ebee"), R(1138, 726, 443, 29, "#161a1e", "#3a3f45"), T(1148, 740, "vessel", 12.5, "#e8ebee"));
  s.push(T(674, 778, "Location", 12.5, "#c6ccd2"), R(675, 793, 102, 29, "#32363c", "#3a3f45", "border-radius:2px"), I("link", 691, 807, 13, "#c6ccd2"), T(710, 807, "Linked", 12.5, "#e8ebee"), I("caret-down", 758, 807, 10, "#c6ccd2"), R(777, 793, 804, 29, "#161a1e", "#3a3f45"), T(787, 807, ll ? `${ll[1].toFixed(5)}, ${ll[0].toFixed(5)}` : "n/a", 12.5, "#e8ebee"));
  s.push(T(674, 844, "Show additional", 12.5, "#7a9cf0"), L(661, 880, 1607, 880, "#3a3f45"), R(660, 881, 948, 57, "#22242a"));
  if (phase) s.push(T(680, 909, phase.state === "busy" ? "nominate_target: running" : phase.state === "ok" ? "Nominated" : `nominate_target failed (${phase.msg})`, 12, phase.state === "error" ? "#f0707a" : "#c6ccd2"));
  s.push(R(1455, 895, 56, 28, "#32363c", "#3a3f45", "border-radius:2px"), T(1483, 909, "Cancel", 12, "#e8ebee", 400, "", "", "c"), R(1522, 895, 75, 28, "#3c64bc", "", "border-radius:2px"), T(1559, 909, "Nominate", 12, "#fff", 400, "", "", "c"));
  s.push(Hit(1455, 895, 56, 28, "Cancel", h.onCancel), Hit(1522, 895, 75, 28, "Nominate: run nominate_target", h.onGo, "nominate_target is not available"));
  return s;
}

function useLive(): Live {
  const sanc = useJson<FC<SancP>>("/api/sanctions/vessels");
  const sar = useJson<SarFC>("/api/intel/dark-vessels/sar?aoi=hormuz");
  const ves = useJson<{ vessels: { lon: number; lat: number }[] }>("/api/maritime/vessels?bbox=52,22.5,60.5,29.5");
  const jam = useJson<{ features: { geometry: { type: string; coordinates: number[][][] | number[][][][] }; properties: { percent_bad?: number } }[] }>("/api/jamming/nacp");
  const choke = useJson<{ features: { geometry: { coordinates: number[] }; properties: { name: string } }[] }>("/api/maritime/chokepoints");
  const [from] = useState(() => Math.floor(Date.now() / 1000) - 7 * 86400);
  const hist = useJson<{ tracks: { id: string; points: number[][] }[] }>(`/api/history/tracks?kind=vessel&min_lon=52&min_lat=22.5&max_lon=60.5&max_lat=29.5&from_ts=${from}&limit_ids=2000`);
  const sRows = sancRows(sanc?.data ?? null);
  const tracks: Track[] = (hist?.data?.tracks ?? [])
    .map((t) => ({ id: t.id, pts: t.points.map((p) => [p[1]!, p[0]!, p[2]!] as [number, number, number]).sort((a, b) => a[2] - b[2]) }))
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
      .map((f) => ({ ring: (f.geometry.type === "Polygon" ? (f.geometry.coordinates as number[][][])[0]! : (f.geometry.coordinates as number[][][][])[0]![0]!), pct: f.properties.percent_bad ?? 0 })),
    choke: choke?.data?.features.find((f) => f.properties.name === "Strait of Hormuz")?.geometry.coordinates ?? null,
    tracks,
    tracksErr: !hist ? "loading recorded tracks…" : !hist.ok ? unavailable("Recorded tracks", hist) : tracks.length ? null : `No vessel track with ${MIN_FIXES}+ fixes in the archive for this box (GET /api/history/tracks)`,
  };
}

type MapState = { v: "canvas" } | { v: "layer" } | { v: "entity"; t: Track } | { v: "image"; sar: Sar } | { v: "nominate"; sar: Sar };
export function MapApp({ onHome, ban, focus }: { onHome: () => void; ban: string; focus?: WItem | null }): JSX.Element {
  const d = useLive();
  const [st, setSt] = useState<MapState>({ v: "canvas" });
  const [phase, setPhase] = useState<Phase>(null);
  const guard = useJson<{ action_tools?: string[] }>("/api/ai/guardrails");
  const chipSar = st.v === "image" || st.v === "nominate" ? st.sar : null;
  const chip = useChip(chipSar);
  const sel = st.v === "layer" || st.v === "entity" ? 3 : null;
  const close = (): void => setSt({ v: "canvas" });
  const onRow = (i: number): void => setSt(i === 3 || i === 2 ? { v: "layer" } : { v: "canvas" });
  const s: N[] = [R(282, 98, 1590, 916, "#0c1a26"), ...mapBg(ban)];
  let n = 0;
  if (st.v === "canvas") {
    const c = canvas(d, (sar) => setSt({ v: "image", sar }));
    n = c.n;
    s.push(...c.s);
  } else if (st.v === "layer") s.push(...layerSel(d, (t) => setSt({ v: "entity", t }), close));
  else if (st.v === "entity") s.push(...entity(d, st.t, () => setSt({ v: "layer" })));
  if (st.v === "image") s.push(...menubar(onHome), ...viewer(st.sar, d.sarDate, chip, { onClose: close, onNominate: () => { setPhase(null); setSt({ v: "nominate", sar: st.sar }); } }));
  else {
    if (st.v === "nominate") s.push(new MapView(597, 244, 1270, 694, 700, 760, 0.85).bg());
    s.push(...menubar(onHome), ...mapLeft(d, n, sel, onRow), ...toolbars(), R(618, 913, 33, 26, "#fff", "", "border-radius:50%"), I("compass", 634, 926, 14, "#c0392b"));
    if (st.v === "nominate") {
      const tools = guard?.data?.action_tools ?? [];
      const tid = st.sar.id;
      const it: WItem | null = focus && focus.ref === tid ? focus : { kind: "sar", id: "SR" + tid.split(":").pop()!.slice(-4).padStart(4, "0"), title: `SAR hull ${Math.round(st.sar.lengthM)} m, no AIS`, link: "", icon: "ship", shape: "c", color: "#14b8a6", t: 0, ll: st.sar.xy, ref: tid };
      const go = async (): Promise<void> => {
        setPhase({ state: "busy", msg: "" });
        try {
          const r = await apiFetch("/api/actions/nominate_target", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target_id: tid, priority: 3, note: it.title }) });
          setPhase(r.ok ? { state: "ok", msg: "" } : { state: "error", msg: `HTTP ${r.status}` });
        } catch {
          setPhase({ state: "error", msg: "network error" });
        }
      };
      s.push(...nominate(it, tid, st.sar.xy, phase, { onCancel: () => setSt({ v: "image", sar: st.sar }), onGo: tools.includes("nominate_target") && phase?.state !== "busy" ? () => void go() : undefined }));
    }
  }
  return frag(s);
}
