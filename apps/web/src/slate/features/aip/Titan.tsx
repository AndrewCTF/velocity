// TITAN ground-station console: features A44-A53 and A65, ported from
// gotham/aip/_build_features_b.py (tt_shell .. a53, a65) over this box: feeds
// (/api/status), upstream hosts (/api/status/sources), the AIS pipeline store,
// and the host's own devices and listening processes (/api/status/host; the
// Rx rate is two of its pulls one second apart, as the builder read
// /proc/net/dev twice).
import { useEffect, useState } from "react";
import { Hit, I, L, R, T, frag, type N } from "./ui.js";
import { dmy, fetchJson, unavailable, useJson, type Res } from "./data.js";
import {
  AIS_KEYS,
  FAMS,
  age,
  clock,
  cpuName,
  devices,
  groups,
  gstate,
  hostRec,
  lastOk,
  nicNames,
  nodash,
  tC,
  type Dev,
  type Engines,
  type Feed,
  type Group,
  type Host,
  type Src,
  type Status,
} from "./dataB.js";
import plateGlobe from "./plateGlobe.jpg";

export const TC = {
  page: "#1e2224", app: "#101418", bar: "#282c30", act: "#3c64be", ban: "#42985c", card: "#101418", cbd: "#2a2e32", tile: "#22242a",
  g: "#1a281e", r: "#2e1a1c", gr: "#242a2e", btn: "#32363c", lnk: "#7a9cf0", ink: "#e6e9ec", mut: "#9aa2aa",
};
export type TitanTab = "Overview" | "Data connections" | "Power management" | "Hardware management" | "Software management";
const comma = (n: number): string => n.toLocaleString("en-US");
const dash = (t: N): N => <span style={{ borderBottom: "1px dashed #5c646c" }}>{t}</span>;

/** "UNCLASSIFIED" for the /api/config classification UNCLAS. */
export const bannerOf = (c: string | undefined): string => (!c ? "UNCLASSIFIED" : c === "UNCLAS" ? "UNCLASSIFIED" : c);

export function banner(text: string): N[] {
  return [R(406, 185, 1461, 28, TC.ban), T(1141, 202, text, 14, "#fff", 400, "", "", "c")];
}

function ttShell(active: TitanTab, sh: number, ban: string, onTab: (t: TitanTab) => void, onHome: () => void, body = true): N[] {
  const s: N[] = body ? [R(405, 184, 1463, 754, TC.app)] : [];
  s.push(...banner(ban), R(406, 214, 1461, 42 + sh, TC.bar));
  s.push(R(409, 217 + Math.floor(sh / 2), 37, 37, "#2a3a5a", "#7a98c8", "border-radius:50%;border-width:2px"), T(427, 235 + sh, "V", 17, "#cfe0ff", 700, "", "", "c"), Hit(409, 217, 37, 37, "AIP terminal", onHome));
  const tabs: [TitanTab, string, number, number][] = [
    ["Overview", "timeline-bar-chart", 451, 588], ["Data connections", "data-connection", 589, 778], ["Power management", "power", 779, 986],
    ["Hardware management", "wrench", 987, 1219], ["Software management", "floppy-disk", 1220, 1444],
  ];
  for (const [lab, ic, x0, x1] of tabs) {
    const a = lab === active;
    if (a) s.push(R(x0, 214, x1 - x0, 42 + sh, TC.act));
    s.push(I(ic, x0 + 34, 231 + sh, 19, a ? "#fff" : "#aab2ba"), T(x0 + 51, 231 + sh, lab, 15, a ? "#fff" : "#aab2ba"), L(x1, 214, x1, 256 + sh, "#1c2024"));
    s.push(Hit(x0, 214, x1 - x0, 42, lab, lab === "Power management" ? undefined : a ? undefined : () => onTab(lab), lab === "Power management" ? "No power-management readings on this box beyond GPU draw" : undefined));
  }
  return s;
}
function ttCard(x: number, y: number, w: number, h: number, title: string, right?: string, onRight?: () => void): N[] {
  const s: N[] = [R(x, y, w, h, TC.card, TC.cbd), T(x + 15, y + 19, title, 13, "#dfe3e7", 600), L(x, y + 37, x + w, y + 37, TC.cbd)];
  if (right) s.push(T(x + w - 14, y + 19, right, 13, TC.lnk, 600, "", "", "r"), Hit(x + w - 100, y + 6, 92, 26, right, onRight));
  return s;
}
function ttTile(x: number, y: number, w: number, h: number, kind: "g" | "r" | "n", ic: string, text: string): N[] {
  const [bg, bd, col] = { g: [TC.g, "#1f3a28", "#6bd186"], r: [TC.r, "#44222a", "#f0707a"], n: [TC.gr, "#2e343a", "#b4bcc4"] }[kind];
  return [R(x, y, w, h, bg, bd), I(ic, x + w / 2 - 6 - text.length * 3.9, y + h / 2, 20, col), T(x + w / 2 + 8 - text.length * 3.9 + 8, y + h / 2 + 1, text, 17, "#e6e9ec", 400, "border-bottom:1px dashed #5c646c")];
}

interface Ctx {
  st: Res<Status> | null;
  feeds: Feed[];
  src: Src[];
  host: Host | null;
  hostRes: Res<Host> | null;
  rx: number | null;
  nic: string | null;
  devs: Dev[];
  grps: Group[];
  pipe: { store: { vessels: number; ageMedianS: number; lastMergeAgeS?: number } } | null;
}

// ── A44, A45 ─────────────────────────────────────────────────────────────────
function overview(c: Ctx, go: (t: TitanTab) => void, refresh: () => void): N[] {
  const nconn = c.feeds.length;
  const gOk = c.feeds.filter((f) => f.status === "green").length;
  const gBad = nconn - gOk;
  const ni = c.src.length;
  const niOk = c.src.filter((x) => x.state === "ok").length;
  const s: N[] = [T(452, 296, "Overview", 28, "#f4f6f8", 600)];
  s.push(...ttCard(452, 335, 440, 285, "Data connections summary", "View more", () => go("Data connections")));
  s.push(T(467, 397, dash(`${nconn} total connections`), 15, TC.ink));
  s.push(...(gBad ? [...ttTile(467, 424, 195, 56, "g", "tick-circle", `${gOk} healthy`), ...ttTile(682, 424, 195, 56, "n", "warning-sign", `${gBad} degraded or idle`)] : ttTile(467, 424, 410, 56, "g", "tick-circle", `${gOk} connections healthy`)));
  s.push(L(453, 495, 891, 495, TC.cbd), T(467, 520, dash(`${ni} total integrations`), 15, TC.ink));
  s.push(...ttTile(467, 547, 214, 56, "g", "tick-circle", `${niOk} healthy`), ...ttTile(697, 547, 185, 56, "r", "error", `${ni - niOk} failing`));
  s.push(...ttCard(452, 640, 440, 230, "Common maintainer tasks"));
  const tasks: [number, string, string, (() => void) | undefined, string][] = [
    [692, "refresh", "Refresh the feed snapshot", refresh, ""],
    [736, "database", "Back up the Foundry stores", undefined, "No backup route on this box"],
    [780, "globe", "Configure upstream connections", () => go("Data connections"), ""],
    [825, "map", "Configure map layers", undefined, "Map layers are configured in the map app"],
  ];
  for (const [y, ic, lab, fn, why] of tasks)
    s.push(R(467, y, 410, 30, TC.btn, "#3a3f45", "border-radius:2px"), I(ic, 590 - lab.length * 2.3, y + 15, 18, "#c6ccd2"), T(606 - lab.length * 2.3 + 4, y + 15, lab, 14.5, "#dde1e5"), Hit(467, y, 410, 30, lab, fn, why));
  const gen = c.st?.data ? new Date(c.st.data.generated_at * 1000) : null;
  const hhmm = gen ? `${String(gen.getUTCHours()).padStart(2, "0")}:${String(gen.getUTCMinutes()).padStart(2, "0")}` : "--:--";
  s.push(R(913, 335, 445, 82, TC.card, TC.cbd), T(945, 378, <><span style={{ fontSize: 46, fontWeight: 400 }}>{hhmm}</span> <span style={{ fontSize: 16, color: "#c6ccd2" }}>UTC</span></>, 16, "#f0f2f4"), L(1131, 350, 1131, 402, "#3a4046"));
  s.push(T(1147, 364, "Coordinates", 13, TC.mut), T(1147, 386, "Not available", 20, "#c6ccd2"));
  s.push(R(913, 437, 446, 304, "#000", TC.cbd), R(914, 438, 444, 302, `url(${plateGlobe}) center/cover`, "", "opacity:.9"));
  s.push(T(930, 725, c.st?.data ? `Live: ${comma(c.st.data.aircraft_count)} aircraft, ${comma(c.st.data.vessel_count)} vessels` : unavailable("Status", c.st), 13, "#dfe3e7", 600));
  const nOff = c.devs.filter((d) => d.st !== "Healthy").length;
  s.push(...ttCard(1378, 335, 441, 161, "Hardware summary", "View more", () => go("Hardware management")), T(1393, 397, dash(c.host ? `${c.devs.length} total devices` : unavailable("Host readings", c.hostRes)), 15, TC.ink));
  s.push(...ttTile(1393, 424, 214, 57, "g", "tick-circle", `${c.devs.length - nOff} healthy`), ...ttTile(1622, 424, 186, 57, "n", "offline", `${nOff} offline`));
  const swBad = c.grps.filter((g) => g.bad).length;
  const swUnk = c.grps.filter((g) => g.unknown).length;
  s.push(...ttCard(1378, 517, 441, 161, "Software summary", "Troubleshoot", () => go("Software management")), T(1393, 580, dash(`${c.grps.length} total software groups`), 15, TC.ink));
  s.push(...ttTile(1393, 606, 214, 57, "g", "tick-circle", `${c.grps.length - swBad - swUnk} healthy`), ...ttTile(1622, 606, 186, 57, "r", "error", `${swBad} failing`));
  return s;
}

// ── A46, A47, A65 ────────────────────────────────────────────────────────────
function devTile(x: number, y: number, d: Dev, sel: boolean): N[] {
  const off = d.st === "Offline";
  const bg = sel ? "#22407c" : off ? "#1a1c20" : TC.tile;
  const fg = off ? "#4c545c" : "#e8ebee";
  const nm = d.name.replace("NVIDIA ", "");
  const s: N[] = [R(x, y, 218, 83, bg), T(x + 10, y + 16, nm.slice(0, 24), nm.length < 17 ? 14.5 : 13, fg)];
  s.push(R(x + 218 - 10 - d.grp.length * 6.4 - 12, y + 7, d.grp.length * 6.4 + 12, 18, sel ? "#344a84" : "#2c3238", "", "border-radius:2px"), T(x + 218 - 10 - d.grp.length * 3.2 - 6, y + 17, d.grp, 11, off ? "#4c545c" : "#cfd6de", 400, "", "", "c"));
  if (off) {
    s.push(I("power", x + 22, y + 59, 17, "#4c545c"), T(x + 36, y + 59, "Offline", 18.5, "#4c545c"));
    if (d.extra) s.push(T(x + 208, y + 59, d.extra, 12, "#4c545c", 400, "", "", "r"));
  } else {
    s.push(I("tick-circle", x + 22, y + 59, 17, "#6bd186"), T(x + 36, y + 59, "Healthy", 18.5, "#f2f4f6"));
    if (d.extra) s.push(T(x + 208, y + 59, d.extra, 12, "#c6ccd2", 400, "", "", "r"));
  }
  return s;
}
const devOrder = (devs: Dev[]): Dev[] => [...devs.filter((d) => d.st === "Healthy"), ...devs.filter((d) => d.st !== "Healthy")];
function hwFilters(devs: Dev[], y0: number): N[] {
  const nOff = devs.filter((d) => d.st !== "Healthy").length;
  const s: N[] = [T(521, y0 - 9, "Status filters", 13, TC.mut), T(834, y0 - 9, "Device filters", 13, TC.mut)];
  s.push(R(451, y0, 60, 38, "#3c64be"), T(481, y0 + 19, `All (${devs.length})`, 13, "#fff", 400, "", "", "c"), R(521, y0, 304, 38, TC.tile, "#2a2f34"));
  for (const [x, ic, col, lab] of [[539, "tick-circle", "#6bd186", `Healthy (${devs.length - nOff})`], [649, "error", "#7a5a5e", "Failed (0)"], [742, "offline", "#c6ccd2", `Offline (${nOff})`]] as const)
    s.push(I(ic, x, y0 + 19, 17, col), T(x + 15, y0 + 19, lab, 13, lab.startsWith("Failed") ? "#5c646c" : "#c6ccd2"));
  s.push(R(834, y0, 421, 38, TC.tile, "#2a2f34"));
  let xs = 844;
  for (const lab of ["Compute", "Graphics", "Storage", "Network", "GPS"]) {
    const n = devs.filter((d) => d.grp === lab).length;
    const t = `${lab} (${n})`;
    s.push(T(xs, y0 + 19, t, 13, n ? "#c6ccd2" : "#5c646c"));
    xs += t.length * 6.6 + 14;
  }
  s.push(T(1274, y0 + 18, "*Click a device tile to view its details", 10.5, TC.mut));
  return s;
}
function hwGrid(devs: Dev[], y0: number, sel: number | null, onSel: (i: number) => void): N[] {
  const s: N[] = [];
  devOrder(devs).forEach((d, i) => {
    const x = 451 + (i % 3) * 228;
    const y = y0 + Math.floor(i / 3) * 94;
    s.push(...devTile(x, y, d, i === sel));
    // the detail page draws the CPU (the builder's detail_panel); other tiles have none
    s.push(Hit(x, y, 218, 83, `${d.name} details`, i === 0 && sel !== 0 ? () => onSel(0) : undefined, i === 0 ? undefined : "Detail page exists for the CPU only"));
  });
  return s;
}
function bar(x: number, y: number, f: number, col: string, w = 95, h = 11): N[] {
  return [R(x, y - Math.floor(h / 2), w, h, "#1a1e20", "", "border-radius:6px"), R(x, y - Math.floor(h / 2), Math.max(4, w * f), h, col, "", "border-radius:6px")];
}
function detailPanel(c: Ctx, onBack: () => void, y0 = 417): N[] {
  const h = c.host!;
  const nic = c.devs.filter((d) => d.grp === "Network");
  const name = cpuName(h);
  const threads = h.cpu.threads ?? 0;
  const s: N[] = [R(1142, y0, 678, 521, TC.tile), I("chevron-left", 1168, y0 + 24, 14, "#c6ccd2"), T(1183, y0 + 24, "Back", 13, "#e6e9ec"), L(1233, y0 + 8, 1233, y0 + 40, "#3a4046"), Hit(1155, y0 + 8, 72, 32, "Back to device locations", onBack)];
  s.push(T(1250, y0 + 24, name, 14, "#f2f4f6", 600), R(1395, y0 + 14, 92, 20, "#32363c", "", "border-radius:2px"), T(1441, y0 + 24, `Threads: ${threads}`, 11, "#c6ccd2", 400, "", "", "c"));
  s.push(R(1493, y0 + 14, 62, 20, "#32363c", "", "border-radius:2px"), T(1524, y0 + 24, "Compute", 11, "#c6ccd2", 400, "", "", "c"));
  s.push(R(1670, y0 + 7, 140, 34, "#32363c", "#3a4046", "border-radius:2px"), I("arrow-top-right", 1688, y0 + 24, 15, "#c6ccd2"), T(1706, y0 + 24, "External links", 13, "#e6e9ec"), I("caret-down", 1793, y0 + 24, 12, "#c6ccd2"));
  const k10 = h.hwmon.find((x) => x.chip === "k10temp");
  const t = k10?.temps.Tctl;
  const rows: [number, string, string | null][] = [[78, "General health", null], [111, "Internal temperature", t === undefined ? "n/a" : tC(t)], [143, "CPU", null], [175, "RAM", null], [207, "Storage", null], [239, "Network", c.rx === null ? "n/a" : `${c.rx.toFixed(3)} Mbps`]];
  for (const [dy, lab, val] of rows) {
    s.push(T(1161, y0 + dy, lab, 13, "#f0f2f4", 600));
    if (val) s.push(T(1398, y0 + dy, val, 13, "#e6e9ec"));
  }
  s.push(I("tick-circle", 1407, y0 + 78, 19, "#6bd186"), T(1425, y0 + 78, "Healthy", 14.5, "#f2f4f6", 600));
  const fr: [number, number | null][] = [
    [143, h.loadavg && threads ? h.loadavg[0]! / threads : null],
    [175, h.mem_mb.total ? h.mem_mb.used / h.mem_mb.total : null],
    [207, h.root ? h.root.used / h.root.size : null],
  ];
  for (const [dy, f] of fr) {
    if (f === null) continue;
    const col = f < 0.6 ? "#6bd186" : "#e4a864";
    s.push(T(1398, y0 + dy, `${Math.round(f * 100)}%`, 12.5, col), ...bar(1442, y0 + dy, f, col, 95));
  }
  s.push(R(1558, y0 + 77, 242, 120, "#1a1e20"), R(1568, y0 + 77, 222, 18, "#363a3e", "", "border:1px solid #4a4e52"), T(1679, y0 + 86, "Host: this workstation", 10.5, "#e6e9ec", 400, "", "", "c"));
  c.devs.slice(0, 4).forEach((d, i) => s.push(R(1568, y0 + 99 + i * 26, 222, 18, i === 0 ? "#22407c" : "#1a1e20", "#4a4e52"), T(1679, y0 + 108 + i * 26, d.name, 10.5, "#e6e9ec", 400, "", "", "c")));
  const nSto = c.devs.filter((d) => d.grp === "Storage").length;
  const nPass = threads + 2 + nSto + nic.filter((d) => d.st === "Healthy").length;
  s.push(R(1161, y0 + 296, 639, 22, "#32363c"), T(1171, y0 + 307, `${name} subcomponents`, 12.5, "#f0f2f4", 600));
  for (const [x, v, col] of [[1736, nPass, "#2c4a34"], [1763, 0, "#4a3c22"], [1785, 0, "#4a2428"]] as const)
    s.push(R(x - 11, y0 + 298, 22, 18, col, "", "border-radius:2px"), T(x, y0 + 307, String(v), 10.5, v ? "#bfe3c8" : "#c0a070", 400, "", "", "c"));
  const ccds = Object.keys(k10?.temps ?? {}).filter((k) => k.startsWith("Tccd")).length;
  const comp: [string, string][] = [[`Core complexes (${ccds})`, "chevron-down"], [`Physical disks (${nSto})`, "chevron-down"], [`Network cards (${nic.length})`, "chevron-up"]];
  let yy = y0 + 335;
  for (const [lab, chev] of comp) {
    s.push(L(1161, yy + 13, 1799, yy + 13, "#2c3034"), T(1171, yy, lab, 12.5, "#f0f2f4"), I("tick-circle", 1596, yy, 14, "#6bd186"), T(1616, yy, "Healthy", 12.5, "#e6e9ec"), I(chev, 1781, yy, 14, "#c6ccd2"));
    yy += 29;
  }
  for (const d of nic.slice(0, 5)) {
    const ok = d.st === "Healthy";
    s.push(T(1181, yy, d.name, 12, "#e6e9ec"), I(ok ? "tick" : "power", 1596, yy, 12, ok ? "#6bd186" : "#7a8288"), T(1612, yy, ok ? "Pass" : "Link down", 12, "#e6e9ec"));
    yy += 23.5;
  }
  return s;
}
function locations(c: Ctx): N[] {
  const h = c.host!;
  const s: N[] = [R(1142, 426, 678, 512, TC.tile), R(1142, 426, 678, 47, "#2a2e32"), T(1156, 450, "Device locations", 14.5, "#f0f2f4", 600)];
  ["Compute", "Storage", "Network", "Power"].forEach((nm, i) => {
    const x = [1156, 1319, 1481, 1645][i]!;
    s.push(R(x, 488, 158, 17, "#363a3e", "#4a4e52"), T(x + 79, 497, nm, 10.5, "#e6e9ec", 400, "", "", "c"));
  });
  s.push(R(1156, 511, 158, 40, "#16191c"), T(1235, 531, "Memory", 10.5, "#4c545c", 400, "", "", "c"), R(1156, 553, 158, 30, "#13161a"));
  s.push(R(1156, 584, 158, 118, "#16191c"), T(1235, 643, "GPU", 10.5, "#4c545c", 400, "", "", "c"), R(1156, 704, 158, 30, "#13161a"));
  s.push(R(1156, 735, 158, 138, "#162a4a", "#3a5aa0", "border-width:2px"), T(1235, 804, "CPU", 11, "#f0f2f4", 600, "", "", "c"));
  const disks = [...h.disks].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  if (disks[0]) s.push(R(1319, 511, 158, 198, "#1a1e22", "#4a4e52"), T(1398, 610, disks[0].name, 10.5, "#e6e9ec", 400, "", "", "c"));
  s.push(R(1319, 712, 158, 40, "#13161a"));
  if (disks[1]) s.push(R(1319, 763, 158, 80, "#1a1e22", "#4a4e52"), T(1398, 802, disks[1].name, 10.5, "#e6e9ec", 400, "", "", "c"));
  if (disks[2]) s.push(R(1319, 855, 158, 83, "#16191c"), T(1398, 896, disks[2].name, 10.5, "#4c545c", 400, "", "", "c"));
  c.devs.filter((d) => d.grp === "Network").slice(0, 7).forEach((d, i) => {
    const y = 511 + i * 60;
    const off = d.st === "Offline";
    s.push(R(1481, y, 158, 52, off ? "#16191c" : "#1a1e22", off ? "#2a2e32" : "#4a4e52"), T(1560, y + 26, d.name, 10.5, off ? "#4c545c" : "#e6e9ec", 400, "", "", "c"));
  });
  const gw = h.gpu?.power_w;
  const gl = h.gpu?.power_limit_w;
  s.push(R(1645, 511, 158, 427, "#16191c"), T(1724, 724, gw != null && gl != null ? `GPU ${Math.round(gw)} W of ${Math.round(gl)} W` : "GPU power n/a", 10.5, "#4c545c", 400, "", "", "c"));
  return s;
}

// ── A48, A49 ─────────────────────────────────────────────────────────────────
const SVC_ICON = { healthy: ["tick-circle", "#6bd186"], warning: ["warning-sign", "#e4a864"], failed: ["error", "#f0707a"], offline: ["power", "#c6ccd2"] } as const;
type SK = keyof typeof SVC_ICON;
function swFilters(gs: Group[], y0: number): N[] {
  const items: Record<SK, number> = { healthy: 0, warning: 0, failed: 0, offline: 0 };
  for (const g of gs) {
    if (g.unknown) continue;
    items.healthy += g.tot - g.bad;
    if (g.bad && g.badkind) items[g.badkind] += g.bad;
  }
  // process groups = the first five (the ones with a listening process)
  const procs = gs.slice(0, 5);
  const pc: Record<SK, number> = { healthy: procs.filter((g) => !g.bad && !g.unknown).length, warning: 0, failed: 0, offline: procs.filter((g) => g.bad).length };
  const s: N[] = [T(514, y0 - 34, "Process filters", 13, TC.mut), T(933, y0 - 34, "Service filters", 13, TC.mut), T(1495, y0 - 34, "External links", 13, TC.mut)];
  s.push(R(451, y0 - 19, 53, 38, "#3c64be"), T(477, y0 + 3, `All (${gs.length})`, 13, "#fff", 400, "", "", "c"), R(514, y0 - 19, 411, 38, TC.tile, "#2a2f34"));
  for (const [x0, cnt] of [[524, pc], [943, items]] as const) {
    if (x0 === 943) s.push(R(933, y0 - 19, 409, 38, TC.tile, "#2a2f34"));
    let xs = x0;
    for (const k of ["healthy", "warning", "failed", "offline"] as const) {
      const [ic, col] = SVC_ICON[k];
      const t = `${k[0]!.toUpperCase()}${k.slice(1)} (${cnt[k]})`;
      s.push(I(ic, xs + 8, y0 + 3, 17, cnt[k] ? col : "#4c545c"), T(xs + 24, y0 + 3, t, 13, cnt[k] ? "#c6ccd2" : "#5c646c"));
      xs += 104;
    }
  }
  const ext = (path: string) => () => void window.open(path, "_blank", "noopener");
  s.push(R(1495, y0 - 19, 171, 38, TC.btn, "#3a4046"), T(1510, y0 + 3, "API status page", 13.5, "#e6e9ec"), I("arrow-top-right", 1647, y0 + 3, 15, "#c6ccd2"), Hit(1495, y0 - 19, 171, 38, "Open /api/status", ext("/api/status")));
  s.push(R(1671, y0 - 19, 149, 38, TC.btn, "#3a4046"), T(1685, y0 + 3, "Doctor report", 13.5, "#e6e9ec"), I("arrow-top-right", 1801, y0 + 3, 15, "#c6ccd2"));
  return s;
}
function swRows(gs: Group[], sel: string): N[] {
  const s: N[] = [];
  const ys = [422, 504, 585, 666, 735, 801, 868, 935];
  const hs = [54, 54, 54, 44, 44, 57, 57, 57];
  gs.forEach((g, i) => {
    const y = ys[i]!;
    const h = hs[i]!;
    const on = g.name === sel;
    s.push(R(452, y, 936, h + 1, on ? "#1a2432" : TC.tile, on ? "#2c5cc0" : ""), I(g.icon, 479, y + h / 2, 19, "#c6ccd2"));
    s.push(T(507, y + 21, g.name, 14.5, "#f2f4f6", 600), T(507, y + 38, g.desc.slice(0, 92), 10.5, TC.mut));
    const st = gstate(g);
    const [ic, col] = g.unknown ? (["warning-sign", "#7a8288"] as const) : SVC_ICON[st];
    const txt = g.unknown ? "State unknown" : st === "healthy" ? "All services healthy" : `${g.bad} of ${g.tot} services ${st === "offline" ? "offline" : st === "failed" ? "failed" : "warning"}`;
    s.push(I(ic, 950, y + 21, 15, col), T(963, y + 21, txt, 12.5, "#e6e9ec"), T(943, y + 40, g.sub.slice(0, 48), 10.5, TC.mut));
    s.push(I(g.unknown ? "warning-sign" : "tick-circle", 1173, y + 21, 15, g.unknown ? "#7a8288" : "#6bd186"), T(1186, y + 21, g.ps, 12.5, "#e6e9ec"), T(1165, y + 40, g.pss.slice(0, 46), 10.5, TC.mut));
  });
  return s;
}
function swPanel(c: Ctx, g: Group): N[] {
  const s: N[] = [R(1403, 422, 417, 516, TC.tile), T(1417, 445, g.name, 14.5, "#f2f4f6", 600), L(1404, 470, 1819, 470, "#2c3034"), T(1417, 489, g.desc.slice(0, 60), 11.5, "#c6ccd2"), T(1417, 506, g.desc.slice(60), 11.5, "#c6ccd2"), T(1796, 539, "Show less", 10.5, TC.lnk, 400, "", "", "r")];
  s.push(T(1417, 573, "Processes and hosted services", 13.5, "#f2f4f6", 600), I("info-sign", 1633, 573, 14, "#c6ccd2"));
  const api = c.host?.listening["8000"];
  s.push(R(1426, 598, 366, 35, "#282c30"), R(1431, 608, 30, 16, "#3a4046", "", "border-radius:2px"), T(1446, 616, "PID", 9.5, "#c6ccd2", 400, "", "", "c"));
  s.push(T(1472, 616, api ? `uvicorn ${api.pid}` : unavailable("Host readings", c.hostRes), 13.5, "#f2f4f6"));
  if (api) s.push(I("tick-circle", 1630, 617, 15, "#6bd186"), T(1646, 617, "Healthy", 12.5, "#e6e9ec"), T(1780, 617, "•••", 11, "#c6ccd2", 700, "", "", "c"));
  const ais = hostRec(c.src, AIS_KEYS);
  const nOk = ais.filter((x) => x.state === "ok").length;
  s.push(I("caret-down", 1435, 661, 11, "#c6ccd2"), T(1452, 661, `${ais.length} Hosted Services`, 12, "#e6e9ec", 600), I("tick-circle", 1630, 661, 15, nOk === ais.length ? "#6bd186" : "#e4a864"), T(1646, 661, `${nOk} of ${ais.length} healthy`, 12, "#e6e9ec", 600));
  ais.slice(0, 6).forEach((x, i) => {
    const y = 688 + i * 17.5;
    const ok = x.state === "ok";
    s.push(T(1452, y, nodash(x.host.replace("www.", "")), 11.5, "#e6e9ec"), I(ok ? "tick-circle" : "error", 1630, y, 14, ok ? "#6bd186" : "#f0707a"), T(1646, y, ok ? "Healthy" : "Failing", 11.5, "#e6e9ec"));
  });
  return s;
}

// ── A50 to A53 ───────────────────────────────────────────────────────────────
function pill(x: number, y: number, hs: Src[]): N[] {
  const n = hs.length;
  const bad = hs.filter((h) => h.state === "failing").length;
  if (!n) return [R(x, y, 140, 41, "#2c3034", "", "border-radius:20px"), I("database", x + 27, y + 21, 17, "#6c747c"), T(x + 44, y + 13, "0 integrations", 12, "#9aa2aa"), T(x + 44, y + 29, <span style={{ color: "#7a9cf0" }}>Configure</span>, 11, "#9aa2aa")];
  if (bad) return [R(x, y, 148, 41, "#382a2e", "", "border-radius:20px"), I("database", x + 27, y + 21, 17, "#f0707a"), T(x + 44, y + 13, `${n} integrations`, 12, "#f0a0a6"), T(x + 44, y + 29, `${bad} failing`, 11, "#f0707a")];
  return [R(x, y, 148, 41, "#263630", "", "border-radius:20px"), I("database", x + 27, y + 21, 17, "#6bd186"), T(x + 44, y + 13, `${n} integrations`, 12, "#9ae0ac"), T(x + 44, y + 29, "All healthy", 11, "#6bd186")];
}
function connList(c: Ctx, onOpen: () => void): N[] {
  const n = FAMS.reduce((a, [, it]) => a + it.length, 0);
  const gen = c.st?.data?.generated_at ?? Date.now() / 1000;
  const s: N[] = [T(452, 296, "Data connections", 28, "#f4f6f8", 600)];
  s.push(R(1529, 281, 291, 29, "#101418", "#3a4046", "border-radius:15px"), I("search", 1543, 295, 15, "#c6ccd2"), T(1558, 295, "Search connections & integrations", 12, "#9aa2aa"));
  s.push(R(455, 335, 78, 28, "#1a2234", "", "border-radius:14px"), T(494, 349, `Active (${n})`, 14, TC.lnk, 600, "", "", "c"), T(591, 349, "Archived (0)", 14, "#dfe3e7", 400, "", "", "c"));
  s.push(R(1546, 335, 138, 30, TC.btn, "#3a4046", "border-radius:2px"), T(1615, 350, "Show all integrations", 12.5, "#e6e9ec", 400, "", "", "c"), R(1690, 335, 129, 30, "#3e824c", "", "border-radius:2px"), I("add", 1706, 350, 15, "#fff"), T(1721, 350, "Add connection", 12.5, "#fff"));
  s.push(R(452, 384, 1368, 48, "#282c30"), T(471, 407, "FILTERS", 10.5, "#9aa2aa", 600), R(533, 392, 138, 31, TC.btn, "", "border-radius:15px"), T(543, 407, "Connection type", 12.5, "#e6e9ec"), I("caret-down", 651, 407, 11, "#c6ccd2"), R(685, 392, 147, 31, TC.btn, "", "border-radius:15px"), T(696, 407, "Connection status", 12.5, "#e6e9ec"), I("caret-down", 813, 407, 11, "#c6ccd2"));
  let y = 432;
  for (const [fam, items] of FAMS) {
    s.push(R(452, y, 1368, 28, "#282c30"), T(471, y + 14, `${fam} (${items.length})`, 12.5, "#e6e9ec"));
    y += 28;
    for (const [nm, sub, keys, ic] of items) {
      const hs = hostRec(c.src, keys);
      s.push(R(452, y, 1368, 66, TC.tile), L(452, y + 66, 1819, y + 66, "#2a2e32"), I("chevron-right", 485, y + 33, 16, "#c6ccd2"), R(512, y + 17, 32, 32, "#2c3238", "", "border-radius:50%"), I(ic, 528, y + 33, 17, "#e6e9ec"));
      s.push(T(556, y + 24, nm, 15.5, TC.lnk, 600), T(556, y + 40, sub, 10.5, "#c6ccd2"));
      const la = lastOk(hs);
      const ok = hs.some((h) => h.state === "ok");
      s.push(T(837, y + 24, "Last success", 11.5, "#c6ccd2"), T(837, y + 40, dash(la === null ? "n/a" : dmy(new Date((gen - la) * 1000))), 11.5, "#f0f2f4"));
      if (hs.length)
        s.push(I(ok ? "tick-circle" : "error", 1071, y + 24, 15, ok ? "#6bd186" : "#f0707a"), T(1083, y + 24, ok ? "Connection currently active" : "Connection failing", 11.5, "#f0f2f4"), T(1063, y + 40, la === null ? "No success recorded" : <>Last success {dash(age(la))} ago</>, 10.5, "#c6ccd2"));
      else s.push(I("power", 1071, y + 24, 15, "#9aa2aa"), T(1083, y + 24, "No upstream host recorded", 11.5, "#c6ccd2"), T(1063, y + 40, "Configured as a feed, not an HTTP poll", 10.5, "#9aa2aa"));
      s.push(...pill(1331, y + 13, hs), R(1655, y + 14, 145, 29, TC.btn, "#3a4046", "border-radius:2px"), T(1727, y + 29, "Configuration", 12.5, "#e6e9ec", 400, "", "", "c"));
      const ais = nm === "AIS keyless";
      s.push(Hit(452, y, 1190, 66, `Open ${nm}`, ais ? onOpen : undefined, "Detail page exists for AIS keyless only"), Hit(1655, y + 14, 145, 29, `${nm} configuration`, ais ? onOpen : undefined, "Detail page exists for AIS keyless only"));
      y += 66;
    }
  }
  return s;
}
const crumb = (y: number, onList: () => void): N[] => [
  T(452, y, <><span style={{ color: "#8c949c" }}>Data connections</span> {" "}<span style={{ fontSize: 20 }}>›</span>{" "} AIS keyless</>, 28, "#f4f6f8", 600),
  Hit(452, y - 18, 230, 36, "Back to data connections", onList),
];
const manage = (): N[] => [R(1645, 294, 175, 31, TC.btn, "#3a4046", "border-radius:2px"), I("cog", 1662, 309, 15, "#c6ccd2"), T(1680, 309, "Manage connection", 12, "#e6e9ec"), I("caret-down", 1803, 309, 11, "#c6ccd2")];
const kv = (x: number, y: number, k: string, v: string, vx: number): N[] => [T(x, y, k, 12.5, "#e6e9ec", 600), T(vx, y, v, 12.5, "#c6ccd2")];
function connCards(c: Ctx, onList: () => void): N[] {
  const hs = hostRec(c.src, AIS_KEYS);
  const gen = c.st?.data?.generated_at ?? Date.now() / 1000;
  const st = c.pipe?.store;
  const s: N[] = [];
  const all: (Src | null)[] = [null, ...hs.slice(0, 5)];
  all.forEach((h, i) => {
    const x = [500, 825, 1150][i % 3]!;
    const y = i < 3 ? 300 : 603;
    const hh = i < 3 ? 287 : 303;
    const yo = i < 3 ? 45 : 59;
    s.push(R(x, y, 310, hh, TC.tile, "#2a2e32"), R(x, y, 310, 37, "#1c2024"), L(x, y + 37, x + 310, y + 37, "#2a2e32"));
    if (!h) {
      s.push(T(x + 12, y + 19, "Connection", 12, "#f2f4f6", 600));
      const rows: [string, string][] = [["Sources", String(hs.length)], ["Vessels in store", st ? comma(st.vessels) : "n/a"], ["Median fix age", st ? `${Math.round(st.ageMedianS)} s` : "n/a"], ["Last merge", st?.lastMergeAgeS != null ? `${Math.round(st.lastMergeAgeS)} s ago` : "n/a"]];
      rows.forEach(([k, v], j) => s.push(...kv(x + 10, y + yo + j * 32, k, v, x + 170)));
    } else {
      s.push(T(x + 12, y + 19, nodash(h.host), 12, "#f2f4f6", 600));
      const lst = h.success_age_s !== null ? new Date((gen - h.success_age_s) * 1000).toISOString().slice(0, 10) : "n/a";
      const rows: [string, string][] = [["State", h.state.toUpperCase()], ["Last status", String(h.last_status ?? "n/a")], ["Latency", h.latency_ms ? `${Math.round(h.latency_ms)} ms` : "n/a"], ["Requests ok", comma(h.ok)], ["Requests failed", comma(h.fail)], ["Last success", lst], ["Last error", nodash(h.last_error || "none").slice(0, 22)], ["Protocol", "HTTPS"]];
      rows.forEach(([k, v], j) => s.push(...kv(x + 10, y + yo + j * 32, k, v, x + 170)));
    }
  });
  s.push(R(406, 257, 1461, 80, TC.app), ...crumb(300, onList));
  s.push(R(1495, 294, 130, 31, TC.btn, "#3a4046", "border-radius:2px"), T(1510, 309, "Open /api/status", 12, "#e6e9ec"), I("arrow-top-right", 1608, 309, 14, "#c6ccd2"), Hit(1495, 294, 130, 31, "Open /api/status", () => void window.open("/api/status", "_blank", "noopener")), ...manage());
  return s;
}
const INT_HEAD: [number, string[]][] = [[519, ["Integration", "name"]], [637, ["Data", "type"]], [726, ["Source name"]], [848, ["Source", "status"]], [953, ["Integration", "status"]], [1072, ["Requests", "ok"]], [1168, ["Latency"]], [1284, ["Success", "rate"]], [1398, ["Failed", "requests"]]];
const NAMES: [string, string][] = [["shipxplorer", "ShipXplorer"], ["vesselfinder", "VesselFinder"], ["openwaters", "OpenWaters"], ["meri.digitraffic", "Digitraffic"], ["kystdatahuset", "Kystdatahuset"]];
function connDetail(c: Ctx, show: boolean, h: { onList: () => void; onToggle: () => void; onChecks: () => void }): N[] {
  const hs = hostRec(c.src, AIS_KEYS);
  const dy = show ? 42 : 0; // the summary sits 42 px lower with the details collapsed
  const up = c.host?.listening["8000"]?.etimes;
  const s: N[] = [...crumb(300, h.onList), ...manage(), R(452, 339, 1368, 599, "#14181c")];
  for (const [x, k, v] of [[500, "CONNECTION NAME", "AIS keyless"], [761, "CONNECTION TYPE", "Vessels"], [1023, "CONNECTION STATUS", null], [1285, "LINK TYPE", "HTTPS poll"], [1547, "VESSELS IN STORE", c.pipe ? comma(c.pipe.store.vessels) : "n/a"]] as const) {
    s.push(T(x, 342 + dy, k, 10.5, "#b4bcc4", 600));
    const ok = hs.some((x2) => x2.state === "ok");
    if (v) s.push(T(x, 374 + dy, v, 15, "#f2f4f6"));
    else s.push(I(ok ? "tick-circle" : "error", x + 7, 374 + dy, 16, ok ? "#6bd186" : "#f0707a"), T(x + 21, 374 + dy, ok ? "Healthy" : "Failing", 15, "#f2f4f6"));
  }
  s.push(T(500, 411 + dy, "API UPTIME", 9.5, "#b4bcc4", 600), T(500, 443 + dy, up === undefined ? "n/a" : clock(up), 13.5, "#f2f4f6"));
  s.push(T(500, 526 + dy, <>Connection details <span style={{ color: "#7a9cf0" }}>({show ? "show" : "hide"})</span></>, 12.5, "#f2f4f6", 600), Hit(490, 512 + dy, 210, 28, show ? "Show connection details" : "Hide connection details", h.onToggle));
  s.push(R(1648, 511 + dy, 123, 29, TC.btn, "#3a4046", "border-radius:2px"), I("pulse", 1666, 526 + dy, 15, "#c6ccd2"), T(1682, 526 + dy, "Health checks", 12, "#e6e9ec"), Hit(1648, 511 + dy, 123, 29, "Health checks: one card per upstream host", h.onChecks), L(500, 550 + dy, 1770, 550 + dy, "#2c3034"));
  let ty = 651;
  if (!show) {
    const h0 = hs[0];
    const nicSp = c.nic ? c.host?.net[c.nic]?.speed_mbps : null;
    const cards: [number, string, boolean, [string, string][]][] = [
      [500, "Transport", true, [["Protocol", "HTTPS"], ["Encryption", "TLS"], ["Last status", String(h0?.last_status ?? "n/a")], ["Latency", h0?.latency_ms ? `${Math.round(h0.latency_ms)} ms` : "n/a"]]],
      [825, "Link details", false, hs.slice(0, 4).map((x) => [nodash(x.host).replace("www.", "").slice(0, 16), x.state === "ok" ? "Healthy" : "Failing"])],
      [1150, "Network details", false, [["Rx bit rate", c.rx === null ? unavailable("Host readings", c.hostRes).slice(0, 22) : `${c.rx.toFixed(2)} Mbps`], ["Rx utilization", c.rx !== null && nicSp ? `${((100 * c.rx) / nicSp).toFixed(1)}%` : "n/a"]]],
    ];
    for (const [x, t, chk, rows] of cards) {
      s.push(R(x, 575, 310, 192, "#14181c", "#2a2e32"), R(x, 575, 310, 40, "#181c20"), L(x, 615, x + 310, 615, "#2a2e32"), T(x + 10, 595, t, 12.5, "#f2f4f6", 600));
      if (chk) s.push(I("tick-circle", x + 291, 595, 16, "#6bd186"));
      rows.forEach(([k, v], j) => {
        const y = 635 + j * 32;
        s.push(T(x + 10, y, k, 11.5, "#e6e9ec", 600), ...(k === "Encryption" ? [I("lock", x + 177, y, 13, "#c6ccd2"), T(x + 190, y, v, 12.5, "#c6ccd2")] : [T(x + 170, y, v, 12.5, "#c6ccd2")]));
      });
    }
    ty = 829;
  }
  s.push(T(500, ty, "Active & available data integrations", 12.5, "#f2f4f6", 600), L(500, ty + (show ? 17 : 19), 1770, ty + (show ? 17 : 19), "#2c3034"));
  const hy = show ? 710 : 889;
  for (const [x, hd] of INT_HEAD) hd.forEach((t, i) => s.push(T(x, hy + (i - (hd.length - 1) / 2) * 16, dash(t), 11, "#c6ccd2", 600)));
  if (show) {
    hs.slice(0, 3).forEach((x, i) => {
      const y = 741 + i * 61;
      const ok = x.state === "ok";
      const nm = NAMES.find(([k]) => x.host.includes(k))?.[1] ?? x.host;
      const tot = x.ok + x.fail;
      s.push(R(500, y, 1270, 56, "#22262a", "#2a2e32"), T(519, y + 28, nm, 13, "#f2f4f6", 600), T(637, y + 28, "AIS", 12.5, "#c6ccd2"), T(726, y + 28, nodash(x.host), 12.5, "#c6ccd2"));
      s.push(I("feed", 856, y + 28, 15, ok ? "#6bd186" : "#f0707a"), T(870, y + 28, ok ? "Online" : "Failing", 12.5, "#c6ccd2"), I(ok ? "tick-circle" : "error", 961, y + 28, 15, ok ? "#6bd186" : "#f0707a"), T(974, y + 28, ok ? "Healthy" : "Failing", 12.5, "#c6ccd2"));
      s.push(T(1072, y + 28, comma(x.ok), 12.5, "#c6ccd2"), T(1168, y + 28, x.latency_ms ? `${Math.round(x.latency_ms)} ms` : "n/a", 12.5, "#c6ccd2"), T(1284, y + 28, tot ? `${((100 * x.ok) / tot).toFixed(1)}%` : "n/a", 12.5, "#c6ccd2"), T(1398, y + 28, comma(x.fail), 12.5, "#c6ccd2"));
      s.push(R(1528, y + 11, 184, 31, "#14181c", "#3a5aa0", "border-radius:2px"), I("globe", 1565, y + 27, 15, "#7a9cf0"), T(1584, y + 27, "View in workspace", 11.5, "#7a9cf0"), T(1736, y + 28, "•••", 11, "#c6ccd2", 700, "", "", "c"));
    });
    const y = 741 + 3 * 61 - 5;
    s.push(R(500, y, 1270, 40, "#1a1e22"), T(521, y + 20, "-", 11.5, "#6c747c"), T(637, y + 20, "AIS", 11.5, "#6c747c"), T(726, y + 20, "AISStream", 11.5, "#6c747c"), T(856, y + 20, "n/a", 11.5, "#6c747c"), T(953, y + 20, "N/A", 11.5, "#6c747c"), R(1528, y + 5, 184, 30, "#1a1e22", "#3a6a48", "border-radius:2px"), T(1620, y + 20, "Add configuration", 11.5, "#6bd186", 400, "", "", "c"));
  }
  return s;
}

function useHost(nonce: number): { res: Res<Host> | null; rx: number | null; nic: string | null } {
  const [out, setOut] = useState<{ res: Res<Host> | null; rx: number | null; nic: string | null }>({ res: null, rx: null, nic: null });
  useEffect(() => {
    let live = true;
    void (async () => {
      const a = await fetchJson<Host>("/api/status/host", nonce > 0);
      if (!live) return;
      setOut({ res: a, rx: null, nic: null });
      if (!a.data) return;
      await new Promise((r) => setTimeout(r, 1000));
      const b = await fetchJson<Host>("/api/status/host", true);
      if (!live || !b.data) return;
      // the first link that is up with a reported speed (the builder's enp8s0)
      const nic = nicNames(b.data).find((n) => b.data!.net[n]!.oper === "up" && b.data!.net[n]!.speed_mbps) ?? null;
      const ra = nic ? a.data.net[nic]?.rx_bytes : null;
      const rb = nic ? b.data.net[nic]?.rx_bytes : null;
      const dt = b.data.taken - a.data.taken;
      setOut({ res: b, rx: ra != null && rb != null && dt > 0 ? ((rb - ra) * 8) / 1e6 / dt : null, nic });
    })();
    return () => {
      live = false;
    };
  }, [nonce]);
  return out;
}

type ConnView = "list" | "show" | "hide" | "cards";
export function TitanView({ onHome }: { onHome: () => void }): JSX.Element {
  const [nonce, setNonce] = useState(0);
  const [tab, setTab] = useState<TitanTab>("Overview");
  const [conn, setConn] = useState<ConnView>("list");
  const [dev, setDev] = useState<number | null>(null);
  const st = useJson<Status>("/api/status", nonce);
  const src = useJson<{ sources: Src[] }>("/api/status/sources", nonce);
  const cfg = useJson<{ classification?: string }>("/api/config");
  const models = useJson<{ engines: Engines }>("/api/ai/models", nonce);
  const local = useJson<{ ollama_up: boolean }>("/api/ai/local", nonce);
  const ver = useJson<{ git_sha: string; stores: Record<string, number> }>("/api/status/version", nonce);
  const pipe = useJson<Ctx["pipe"] & object>("/api/maritime/pipeline/stats", nonce);
  const hostR = useHost(nonce);
  const host = hostR.res?.data && !("error" in hostR.res.data) ? hostR.res.data : null;
  const feeds = (st?.data?.feeds ?? []).map((f) => ({ ...f, name: nodash(f.name) }));
  const sources = src?.data?.sources ?? [];
  const c: Ctx = {
    st, feeds, src: sources, host, hostRes: hostR.res, rx: hostR.rx, nic: hostR.nic,
    devs: host ? devices(host) : [],
    grps: groups(host, feeds, sources, models?.data?.engines ?? null, local?.data?.ollama_up ?? null, ver?.data ?? null),
    pipe: pipe?.data ?? null,
  };
  const ban = bannerOf(cfg?.data?.classification);
  const go = (t: TitanTab): void => {
    setTab(t);
    setConn("list");
    setDev(null);
  };
  const s: N[] = [R(282, 98, 1590, 916, TC.page)];
  const hostMsg = (): N => T(1136, 600, unavailable("Host readings", hostR.res), 16, "#c6ccd2", 400, "", "", "c");
  if (tab === "Overview") s.push(...ttShell(tab, 0, ban, go, onHome), ...overview(c, go, () => setNonce((n) => n + 1)));
  else if (tab === "Hardware management") {
    if (dev === null) {
      s.push(...ttShell(tab, 0, ban, go, onHome), T(452, 296, "Hardware management", 28, "#f4f6f8", 600), ...hwFilters(c.devs, 357), ...hwGrid(c.devs, 426, null, setDev));
      s.push(...(host ? locations(c) : [R(1142, 426, 678, 512, TC.tile), hostMsg()]));
    } else {
      s.push(...ttShell(tab, -9, ban, go, onHome), T(452, 288, "Hardware management", 28, "#f4f6f8", 600), ...hwFilters(c.devs, 348), ...hwGrid(c.devs, 417, dev, setDev), R(1858, 214, 4, 590, "#3a3e42"));
      if (host) s.push(...detailPanel(c, () => setDev(null)));
    }
    if (!host) s.push(T(780, 520, unavailable("Host readings", hostR.res), 15, "#c6ccd2", 400, "", "", "c"));
  } else if (tab === "Software management") {
    const g = c.grps[0]!;
    s.push(...ttShell(tab, 6, ban, go, onHome), T(452, 302, "Software management", 28, "#f4f6f8", 600), ...swFilters(c.grps, 383), ...swRows(c.grps, g.name), R(1858, 214, 4, 724, "#3a3e42"), ...swPanel(c, g));
  } else {
    s.push(...ttShell("Data connections", 0, ban, go, onHome));
    if (!src?.ok) s.push(T(1136, 296, unavailable("Upstream sources", src), 14, "#f0707a", 400, "", "", "c"));
    if (conn === "list") s.push(...connList(c, () => setConn("show")));
    else if (conn === "cards") s.push(...connCards(c, () => setConn("list")));
    else s.push(...connDetail(c, conn === "show", { onList: () => setConn("list"), onToggle: () => setConn(conn === "show" ? "hide" : "show"), onChecks: () => setConn("cards") }));
  }
  return frag(s);
}
