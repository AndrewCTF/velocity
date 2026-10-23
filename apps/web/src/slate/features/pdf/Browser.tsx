// Browser (gotham-006-025, D5 D6 D7 D8 D9 D10 D11): sec_browser() of
// _build_gotham_a.py, line for line, in the 1171 x 615 figure's pixels.
import { useState } from "react";
import { A, HL, N_MEDIA, Hit, I, T, Tc, Tr, frag, hit, sceneBg, shipicon, toPx, type N } from "./kit.js";
import {
  TRK, chokesNear, dmy, hhmm, nProps, nearbyEvents, nearestPorts, nearestWarnings, title, unavailable,
} from "./data.js";
import type { Ctx } from "./model.js";

export const LNK = "#215db0";
const LBL = "#5f6b7c";
const MRK = "#8f99a8";

/** Link groups of the selected object, shared by the Browser and the custom
 *  object view (the builder's LK). */
export function linksOf(c: Ctx) {
  const s = c.sel;
  if (!s) return { wl: [], alt: [], ports5: [], near6: [], chokes: [], lists: [] as string[] };
  const wl = nearestWarnings(c.warnings, s.v.lon, s.v.lat);
  const alt = nearbyEvents(c.alerts, s.v.lon, s.v.lat);
  const ports5 = nearestPorts(c.ports, s.v.lon, s.v.lat).map((p) => title(p.name));
  const near6 = c.list.filter((r) => r !== s).slice(0, 6);
  const chokes = chokesNear(c.chokes, s.v.lon, s.v.lat);
  return { wl, alt, ports5, near6, chokes, lists: c.sanc?.lists ?? [] };
}
export function sancLine(c: Ctx): string {
  if (!c.sanc) return unavailable("Sanctions lookup", c.sancRes);
  return `${c.sanc.lists.map((l) => l.replace("UN Security Council", "UN SC")).join(", ")}: ${c.sanc.matched ? "match" : "no match"}`;
}

export function Browser({ c }: { c: Ctx }): JSX.Element {
  const [draft, setDraft] = useState(c.kw);
  const [menu, setMenu] = useState(true);
  const KW = c.kw;
  const SELR = c.sel;
  const HAM = c.place?.name ?? "";
  const HAMS = HAM.replace("Lpg", "LPG");
  const NRES = c.res.length;
  const SHOWN = c.list.slice(0, 10);
  const o: N[] = [];
  o.push(A(0, 0, 1171, 615, "background:#eeeef2"));
  o.push(A(0, 0, 1171, 2, "background:#565d68"));
  o.push(A(0, 2, 1171, 31, "background:#f0f0f4;border-bottom:1px solid #d6d9de"));
  o.push(I("arrow-left", 18, 17, 12, "#394450"), T(29, 17, "All results", "#232b35", 10.5),
    A(78, 8, 1, 19, "background:#d3d7dd"), T(88, 17, "Objects", "#111", 11, 400, "font-weight:700"),
    T(133, 17, `Showing ${SHOWN.length} of ${NRES} results`, "#8f99a8", 10.5));
  o.push(Hit(10, 8, 64, 19, "All results: the exploration", () => c.go("explorer")));
  o.push(I("share", 1155, 17, 12, "#394450"), Hit(1146, 8, 18, 18, "Share", undefined, "No share list exists for searches"));
  // filters rail
  o.push(A(0, 34, 142, 581, "background:#fff"));
  o.push(I("filter", 12, 47, 11, "#394450"), T(21, 47, "FILTERS", "#5c6672", 8.5, 400, "letter-spacing:.04em"), I("menu-closed", 134, 47, 12, "#5c6672"));
  o.push(A(0, 61, 142, 1, "background:#e4e7eb"));
  o.push(T(7, 78, "Keyword", "#111", 10.5, 400, "font-weight:700"),
    A(49, 68, 62, 19, "background:#eeeef2;border:1px solid #dadde2;border-radius:2px"),
    T(56, 78, "matches", "#394450", 10), I("caret-down", 101, 78, 9, "#5c6672"));
  o.push(A(7, 93, 134, 32, "background:#fff;border:1px solid #c9ced5;border-radius:2px"), I("search", 17, 103, 11, "#394450"));
  o.push(
    <input
      className="sl-field"
      aria-label="Keyword"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") c.setKw(draft);
      }}
      style={{ left: 27, top: 96, width: 110, height: 14, fontSize: 10.5, color: "#111", letterSpacing: ".02em" }}
    />,
  );
  o.push(T(7, 142, "Object Type", "#111", 10.5, 400, "font-weight:700"),
    A(62, 132, 60, 20, "background:#eeeef2;border:1px solid #dadde2;border-radius:2px"), T(68, 142, "is any of", "#394450", 10), I("caret-down", 110, 142, 9, "#5c6672"),
    I("small-cross", 135, 142, 11, "#8f99a8"));
  o.push(A(7, 157, 134, 36, "background:#fff;border:1px solid #c9ced5;border-radius:2px"),
    A(10, 161, 38, 12, "background:#eeeef2;border-radius:2px"), T(14, 167, "Vessel", "#394450", 9), I("small-cross", 42, 167, 8, "#394450"));
  o.push(T(9, 206, "+ Add date", LNK, 10), T(9, 222, "+ Add location", LNK, 10), T(9, 238, "+ Add property...", LNK, 10));
  o.push(Hit(7, 199, 70, 14, "Add date", undefined, "The box pull carries only each hull's latest fix, so there is no date to filter"),
    Hit(7, 215, 80, 14, "Add location", undefined, "The location is the keyword's place and the 10 km radius"),
    Hit(7, 231, 90, 14, "Add property", undefined, "Property filters live in the exploration's filter path"));
  o.push(A(7, 252, 134, 20, "background:#2a72d4;border-radius:2px"), Tc(74, 262, "Search", "#fff", 10.5, 100));
  o.push(Hit(7, 252, 134, 20, "Search", () => c.setKw(draft)));
  o.push(A(0, 586, 142, 1, "background:#e4e7eb"), I("notifications-add", 36, 601, 11, "#394450"), T(46, 601, "Create search alert", "#394450", 10));
  o.push(Hit(30, 592, 110, 18, "Create search alert", undefined, "Alert rules are areas, not keywords; add one from the alert rules list"));
  if (!c.place)
    o.push(T(155, 80, c.ports.length ? `No place in the recorder box matches "${KW}"` : unavailable("Ports", null), "#8f99a8", 10));
  // result list
  o.push(A(148, 34, 214, 581, "background:#fff;border-left:1px solid #e0e3e8;border-right:1px solid #e0e3e8"));
  o.push(T(155, 47, "Sorted by", "#5c6672", 10), T(198, 47, "relevance", "#111", 10, 400, "text-decoration:underline"), I("caret-down", 244, 47, 9, "#5c6672"));
  o.push(A(322, 40, 34, 15, "background:#dfe2e7;border-radius:2px"), Tc(339, 47, "Actions", "#394450", 10, 40, "text-decoration:underline"));
  o.push(Hit(322, 40, 34, 15, "Actions", () => setMenu((m) => !m)));
  o.push(A(148, 60, 214, 1, "background:#e4e7eb"));
  let y = 61;
  for (const r of SHOWN) {
    const h = 65;
    const on = r === SELR;
    if (on) o.push(A(149, y, 212, h, "background:#eef3fb"));
    o.push(A(149, y + h - 1, 212, 1, "background:#e4e7eb"));
    o.push(shipicon(162, y + 18, on ? "#215db0" : "#8f99a8", 17));
    o.push(T(178, y + 12, r.name, "#111", 10.5, 400, "font-weight:700"));
    o.push(T(178, y + 25, `Vessel • ${nProps(r.v)} properties`, "#8f99a8", 9.5));
    o.push(T(155, y + 38, "Nearest place", "#8f99a8", 9.5), T(228, y + 38, hit(HAM, KW), "#111", 9.5, 400, "width:130px;overflow:hidden"));
    o.push(T(155, y + 53, "Ship type", "#8f99a8", 9.5), T(228, y + 53, r.type, "#111", 9.5));
    o.push(Hit(149, y, 212, h, `Open ${r.name}`, () => c.pick(r.mmsi)));
    y += 65;
  }
  // bulk actions menu
  const n = SHOWN.length;
  if (menu) {
    const mx = 198, my = 66;
    o.push(A(mx, my, 160, 337, "background:#363e48;border-radius:3px;box-shadow:0 3px 10px rgba(0,0,0,.35)"));
    o.push(A(mx + 138, my - 5, 9, 9, "background:#363e48;transform:rotate(45deg)"));
    const items: [number, string, string, (() => void) | undefined, string][] = [
      [82, `For all results (up to 10,000)`, "h", undefined, ""],
      [103, "Open all objects in new tab", "arrow-top-right", undefined, "Objects open in this window"],
      [123, "Add all objects to map", "xdis", undefined, "The map already draws every hull in the box"],
      [143, "Add all objects to new list", "list", undefined, "No object list store exists"],
      [177, `For current results (${n})`, "h", undefined, ""],
      [197, `Add ${n} objects to list`, "list>", undefined, "No object list store exists"],
      [217, "Remove from list", "xlist", undefined, "The results are not a list"],
      [243, `Download ${n} objects as .docx`, "download", undefined, "No .docx exporter exists; export a report from Reports"],
      [270, `Delete ${n} objects`, "xdel", undefined, "Live AIS objects cannot be deleted"],
      [297, "Open in new tab", "", undefined, "Objects open in this window"],
      [317, "Open in new window", "", undefined, "Objects open in this window"],
      [337, "Search using title", "", SELR ? () => { setDraft(SELR.name); } : undefined, "No object selected"],
      [365, "Add to dossier", "doc>", () => c.go("dossier"), ""],
      [385, "Add to graph", "graph>", () => c.go("menubar"), ""],
    ];
    const ICN: Record<string, string> = {
      "arrow-top-right": "arrow-top-right", xdis: "send-to-map", list: "list", "list>": "list", xlist: "list",
      download: "download", xdel: "cross-circle", "doc>": "document", "graph>": "send-to-graph",
    };
    for (const [yy, txt, kind, fn, why] of items) {
      if (kind === "h") {
        o.push(T(209, yy, txt, "#c5ccd4", 8.5, 400, "font-weight:600"));
        continue;
      }
      const dis = kind.startsWith("x");
      const col = dis ? "#78828e" : "#fff";
      const ic = ICN[kind];
      const tx = ic ? 224 : 208;
      if (ic) o.push(I(ic, 214, yy, 12, kind === "xdis" || kind === "doc>" ? "#5da7ef" : !dis ? "#f1f4f6" : "#78828e"));
      o.push(T(tx, yy, txt, col, 10.5));
      if (kind.endsWith(">")) o.push(I("caret-right", 332, yy, 10, "#c5ccd4"));
      o.push(Hit(mx + 4, yy - 9, 140, 18, txt, fn, why));
    }
    o.push(I("edit", 326, 82, 12, "#f1f4f6"), A(318, 73, 18, 18, "border:1px solid #4a5460;border-radius:2px;background:transparent"));
    o.push(Hit(318, 73, 18, 18, "Close the actions menu", () => setMenu(false)));
    for (const yy of [162, 231, 257, 285, 351]) o.push(A(mx + 8, yy, 144, 1, "background:#4a5460"));
    o.push(A(349, 70, 7, 276, "background:#b8c0d0;border-radius:3px"));
  }
  // object view
  o.push(A(376, 38, 784, 62, "background:#fff;border:1px solid #dcdfe4"));
  if (!SELR) {
    o.push(T(384, 62, c.boxRes && !c.boxRes.ok ? unavailable("AIS box", c.boxRes) : c.boxRes ? "No vessel matches the search" : "loading…", "#5c6672", 10.5));
    return frag(o);
  }
  const [sx, sy] = toPx(SELR.v.lon, SELR.v.lat);
  const SELT = TRK(SELR.mmsi);
  o.push(A(384, 48, 26, 26, `${sceneBg(sx, sy, 26, 26, 3.0)};border:1px solid #cbd0d6`));
  o.push(T(416, 55, SELR.name, "#111", 11, 400, "font-weight:700"), T(416, 68, `Vessel • ${SELT}`, "#232b35", 9.5));
  const tabs: [string, number, string][] = [["Overview", 384, "#215db0"], ["Properties", 437, "#232b35"], ["Links", 494, "#232b35"], ["Map", 531, "#232b35"], ["Media", 566, "#232b35"], ["History", 623, "#232b35"]];
  for (const [t_, x, col] of tabs) o.push(T(x, 86, t_, col, 10));
  o.push(A(595, 80, 12, 12, "background:#eeeef2;border-radius:2px"), Tc(601, 86, String(N_MEDIA), "#5c6672", 8.5, 12));
  o.push(I("search-around", 673, 86, 12, "#16a4c4"), T(681, 86, "Ava", "#232b35", 10));
  o.push(A(383, 91, 49, 2, "background:#215db0"));
  o.push(Hit(380, 78, 52, 16, "Overview", undefined, "This is the open tab"),
    Hit(433, 78, 56, 16, "Properties: the custom object view", () => c.go("cov")),
    Hit(490, 78, 34, 16, "Links: the custom object view", () => c.go("cov")),
    Hit(527, 78, 30, 16, "Map: the custom object view", () => c.go("cov")),
    Hit(562, 78, 48, 16, "Media: the custom object view", () => c.go("cov")),
    Hit(619, 78, 42, 16, "History: the object's inbox feed", () => c.go("inbox")),
    Hit(665, 78, 40, 16, "Ava", undefined, "The assistant opens from the AI app"));
  o.push(T(1109, 62, "Actions", "#232b35", 10), I("caret-down", 1148, 62, 9, "#5c6672"));
  o.push(Hit(1104, 54, 52, 16, "Actions: open the custom object view", () => c.go("cov")));
  const card = (x: number, yy: number, w: number, h: number): N =>
    A(x, yy, w, h, "background:#fff;border:1px solid #dcdfe4;border-radius:2px");
  // properties card
  o.push(card(384, 104, 384, 242));
  o.push(I("properties", 395, 117, 13, "#215db0"), T(408, 117, "Properties", LNK, 10.5, 400, "font-weight:700"), A(385, 128, 382, 1, "background:#e4e7eb"));
  const fx = c.fixes;
  const t0 = fx[0]?.[0] ?? SELR.v.t;
  const t1 = fx[fx.length - 1]?.[0] ?? SELR.v.t;
  const flag = c.entity?.flag_country ?? (c.entity ? "n/a" : "loading…");
  const rows: [number, number, string, string[], string][] = [
    [128, 167, "Position", [`${SELR.v.lat.toFixed(5)} N, ${SELR.v.lon.toFixed(5)} E`, `${SELR.d.toFixed(1)} km from ${HAMS}`], "pin"],
    [167, 195, "Reported name", [SELR.name], ""], [195, 223, "Flag state", [flag], ""],
    [223, 265, "Fix times", [`${hhmm(t1, true)} ${dmy(t1)}`, `${hhmm(t0, true)} ${dmy(t0)}`], "clock"],
    [265, 293, "Ship type", [SELR.type], ""], [293, 321, "Speed over ground", [`${SELR.sog.toFixed(1)} kn`], ""],
  ];
  for (const [ya, yb, lab, vals, ic] of rows) {
    o.push(A(385, yb, 382, 1, "background:#e4e7eb"));
    const lines = vals.length;
    if (lines === 2 && ic === "clock") o.push(HL(519, ya + 19, 764, ya + 34, "#eeeef2"));
    vals.forEach((v, j) => {
      let yc = lines === 2 ? ya + (ic === "pin" ? 15 : 12) + j * 15 : ya + 14;
      if (ic === "pin") yc = ya + 12 + j * 12;
      if (ic === "clock") yc = ya + 18 + j * 15;
      o.push(T(519, yc, v, "#111", 10), T(674, yc, "AIS", MRK, 7.5));
      if (ic === "clock") o.push(I("time", 750, yc, 12, "#5c6672"));
    });
    if (ic === "pin") o.push(I("map-marker", 749, ya + 14, 12, "#8f99a8"));
    o.push(T(391, ya + 14, lab, LBL, 10, 400, "font-weight:600"));
  }
  o.push(T(706, 332, `View all ${nProps(SELR.v)}`, LNK, 10), I("arrow-right", 757, 332, 11, LNK));
  o.push(Hit(700, 324, 66, 16, "View all properties", () => c.go("cov")));
  // media card
  o.push(card(384, 353, 384, 161));
  o.push(I("camera", 394, 365, 12, "#215db0"), T(408, 365, "Media", LNK, 10.5, 400, "font-weight:700"));
  o.push(A(391, 383, 84, 13, "background:#fad260"), Tc(433, 389, "Thumbnail", "#111", 9, 84));
  const media: [number, number, number, number, number][] = [[398, 397, 69, 66, 2.4], [484, 405, 77, 52, 1.2], [591, 397, 45, 66, 0.6]];
  media.forEach(([x, yy, w, h, k], i) => {
    o.push(A(x, yy, w, h, sceneBg(sx, sy, w, h, k)));
    o.push(Tc(x + w / 2, 471, `${SELT} (${i + 1})`, "#111", 9.5, 120));
    o.push(Tc(x + w / 2, 482, "OSINT", MRK, 8, 60));
  });
  o.push(T(706, 503, `View all ${media.length}`, LNK, 10), I("arrow-right", 757, 503, 11, LNK));
  o.push(Hit(700, 495, 66, 16, "View all media", () => c.go("cov")));
  // map card
  o.push(card(384, 524, 384, 100));
  o.push(I("map", 394, 535, 12, "#215db0"), T(408, 535, "Map", LNK, 10.5, 400, "font-weight:700"));
  o.push(A(385, 546, 382, 70, `${sceneBg(sx, sy, 382, 70, 1.1, "saturate(.1) brightness(2.6)")};opacity:.9`));
  for (const [yy, ic] of [[563, "zoom-in"], [582, "zoom-out"], [601, "zoom-to-fit"]] as const)
    o.push(A(392, yy - 9, 18, 18, "background:#fff;border:1px solid #cdd2d8;border-radius:2px"), I(ic, 401, yy, 11, "#394450"));
  o.push(Hit(392, 554, 18, 56, "Map: the custom object view", () => c.go("cov")));
  // links card
  const L = linksOf(c);
  const nlinks = { ent: L.near6.length + L.ports5.length + L.chokes.length + L.lists.length, ev: L.alt.length, doc: L.wl.length };
  const nall = nlinks.ent + nlinks.ev + nlinks.doc;
  o.push(card(776, 104, 384, 461));
  o.push(I("link", 787, 118, 13, "#215db0"), T(800, 118, "Links", LNK, 10.5, 400, "font-weight:700"),
    T(830, 118, `${nlinks.ent} Entities, ${nlinks.ev} Events, ${nlinks.doc} Documents`, LNK, 10), I("sort", 1088, 118, 12, "#394450"), T(1103, 118, "Newest", "#232b35", 10), I("caret-down", 1148, 118, 9, "#5c6672"));
  o.push(A(777, 130, 382, 1, "background:#e4e7eb"));
  const grp = (yy: number, name: string, k: number): N[] => [
    I("chevron-down", 787, yy, 10, "#232b35"), T(797, yy, name, "#111", 10.5, 400, "font-weight:700"), T(797 + 6.2 * name.length + 8, yy, `(${k})`, "#5c6672", 10.5),
  ];
  o.push(...grp(145, "Document", L.wl.length));
  L.wl.forEach((w, k) => o.push(I("document", 790, 161 + 20 * k, 13, "#abb3bf"), T(799, 161 + 20 * k, w, LNK, 10)));
  o.push(...grp(207, "Nearby events", L.alt.length));
  L.alt.forEach((w, k) => o.push(I("high-priority", 790, 224 + 20 * k, 12, "#8f99a8"), T(799, 224 + 20 * k, w, LNK, 10)));
  o.push(...grp(311, "Place", L.ports5.length));
  L.ports5.forEach((w, k) => o.push(I("geosearch", 789 + (k % 3) * 131, 328 + 20 * Math.floor(k / 3), 12, "#d9a63a"), T(799 + (k % 3) * 131 - 6, 328 + 20 * Math.floor(k / 3), w, LNK, 10)));
  o.push(...grp(373, "Sanctions lists", L.lists.length));
  o.push(I("shield", 789, 391, 12, "#215db0"), T(799, 391, sancLine(c), LNK, 10));
  o.push(...grp(417, "Vessel", L.near6.length));
  L.near6.forEach((r, k) => {
    const x = 789 + (k % 3) * 131, yy = 434 + 20 * Math.floor(k / 3);
    o.push(shipicon(x, yy, "#8f99a8", 12), T(x + 4, yy, title(r.name), LNK, 10), Hit(x - 6, yy - 8, 124, 16, `Open ${r.name}`, () => c.pick(r.mmsi)));
  });
  o.push(T(789, 477, "More object types", "#5c6672", 10));
  o.push(I("waves", 800, 499, 12, "#215db0"), T(811, 499, "Chokepoint", LNK, 10, 400, "font-weight:700"), T(870, 499, `(${L.chokes.length})`, "#5c6672", 10));
  o.push(A(777, 540, 382, 1, "background:#e4e7eb"));
  o.push(Tr(1099, 550, `View all ${nall}`, LNK, 10, 60), I("arrow-right", 1149, 550, 11, LNK));
  o.push(Hit(1040, 542, 116, 16, "View all links", () => c.go("cov")));
  o.push(card(776, 573, 384, 60), I("document-share", 787, 582, 12, "#394450"), T(800, 582, "Related Artifacts", "#111", 10.5, 400, "font-weight:700"));
  c.evidence.slice(0, 4).forEach((_, k) => o.push(A(789 + k * 95, 603, 70, 12, "background:#e9ecf0")));
  return frag(o);
}
