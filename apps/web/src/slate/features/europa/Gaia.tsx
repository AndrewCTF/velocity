// E3: the Gaia home frame of the copy (gaia() in _build_features.py), crop
// 766,279 1100x631. World map = the copy's Natural Earth land plate; rings,
// dots and chokepoints are the live routes; the table is the live evidence
// store filtered by the search box.
import { useState } from "react";
import { A, I, T as T0, Hit, circ, frag, insetFrame, titlebar, type N } from "./ui.js";
import {
  UTC,
  chipsOf,
  gx,
  gy,
  unavailable,
  warnRings,
  type Choke,
  type Evid,
  type Res,
} from "./data.js";
import { apiFetch } from "../../../transport/http.js";
import { setDragTitle } from "./drag.js";
import world from "./eu-world.png";

// the Gaia pane text is set larger than the chat pane's
const T = (
  x: number,
  yc: number,
  txt: N,
  fs = 9,
  col?: string,
  w?: number,
  al?: "l" | "c" | "r",
  ls?: number,
): N => T0(x, yc, txt, fs * 1.14, col, w, al, ls);

const GROUPS: [string, [number, number], number, number][] = [
  ["AMERICAS", [-168, -30], 350.0, 498.0],
  ["ATLANTIC AND EUROPE", [-27, 46], 350.0, 498.0],
  ["MIDDLE EAST", [28, 68], 392.0, 538.0],
  ["INDO-PACIFIC", [72, 180], 350.0, 498.0],
];

const shortDate = (iso: string): string => {
  const t = Date.parse(iso) / 1000;
  return Number.isFinite(t) ? UTC(t, "%m/%d/%Y %I:%M %p") : "—";
};

async function download(e: Evid): Promise<void> {
  const r = await apiFetch(`/api/evidence/${e.sha256}/blob`);
  if (!r.ok) return;
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = e.filename || `${e.sha256.slice(0, 12)}.bin`;
  a.click();
  URL.revokeObjectURL(url);
}

export function GaiaFrame({
  ev,
  chokes,
  chokeRes,
  warns,
  aircraft,
  toMap,
  toChat,
  toReports,
}: {
  ev: Res<{ props: Evid }[]> | null;
  chokes: Choke[];
  chokeRes: Res<unknown> | null;
  warns: { y: number; lon: number; lat: number }[];
  aircraft: [number, number][];
  toMap: () => void;
  toChat: () => void;
  toReports: () => void;
}): N {
  const [q, setQ] = useState("replay");
  const [card, setCard] = useState(true);
  const EVID = (ev?.data ?? []).map((x) => x.props);
  const hormuz = chokes.find((c) => c.name === "Strait of Hormuz");
  const s: N[] = [
    insetFrame(766, 279, 1866, 910),
    titlebar("Gaia home", "home", 1316),
    Hit(770, 283, 18, 18, "Chat", toChat),
    A(767, 304, 1099, 354, "background:#14181c"),
    A(767, 304, 1099, 354, `background:url(${world}) 0 0/1100px 360px no-repeat`),
  ];
  // theatre outlines: longitude spans that hold the real chokepoints of each group
  const labs: [number, number, string][] = [];
  const paths = GROUPS.map(([lab, [lo0, lo1], y0, y1]) => {
    const x0 = gx(lo0);
    const x1 = gx(lo1);
    const ym = y0 + (y1 - y0) * 0.5;
    const j = 13;
    const f = (n: number): string => n.toFixed(1);
    const d =
      `M${f(x0 + 9)} ${f(y0)} H${f(x1 - 9)} Q${f(x1)} ${f(y0)} ${f(x1)} ${f(y0 + 9)} V${f(ym)} L${f(x1 - j)} ${f(ym + 6)} V${f(y1 - 9)} Q${f(x1 - j)} ${f(y1)} ${f(x1 - j - 9)} ${f(y1)} ` +
      `H${f(x0 + 9)} Q${f(x0)} ${f(y1)} ${f(x0)} ${f(y1 - 9)} V${f(ym + 6)} L${f(x0 + j)} ${f(ym)} V${f(y0 + 9)} Q${f(x0 + j)} ${f(y0)} ${f(x0 + j + 9)} ${f(y0)}Z`;
    labs.push([x0 + (x1 - x0) / 2, y0 + 16, lab]);
    return <path key={lab} d={d} fill="rgba(120,140,155,.06)" stroke="#8d969d" strokeWidth="1.4" strokeLinejoin="round" />;
  });
  s.push(
    <svg key="map" aria-hidden style={{ left: 0, top: 0, width: 1920, height: 1080, overflow: "visible" }}>
      {paths}
      {warnRings(warns).map(([x, y], i) => (
        <circle key={`w${i}`} cx={x.toFixed(1)} cy={y.toFixed(1)} r="3.1" fill="none" stroke="#e8923a" strokeWidth="1.15" opacity=".9" />
      ))}
      {aircraft
        .filter((_, i) => i % 3 === 0)
        .map(([lon, lat]) => [gx(lon), gy(lat)] as const)
        .filter(([x, y]) => x > 770 && x < 1600 && y > 306 && y < 656)
        .map(([x, y], i) => (
          <circle key={`a${i}`} cx={x.toFixed(1)} cy={y.toFixed(1)} r="2.9" fill="#7f8fd6" opacity=".78" />
        ))}
    </svg>,
  );
  for (const [x, y, lab] of labs) s.push(T(x, y, lab, 8.3, "#f2f4f6", 600, "c", 0.01));
  for (const c of chokes)
    s.push(A(gx(c.lon) - 3, gy(c.lat) - 3, 6, 6, "border:1.3px solid #f0f2f4;border-radius:50%;box-sizing:border-box;background:rgba(20,24,28,.6)"));
  // create bar
  s.push(A(771, 316, 277, 22, "background:rgba(20,24,28,.9);border-radius:2px"), T(786, 327, "Create", 8.2, "#d8dee3"));
  const create: [number, number, string, string, (() => void) | undefined][] = [
    [821, 882, "globe-network", "Map", toMap],
    [887, 948, "th", "Sheet", undefined],
    [974, 1046, "form", "Case export", toReports],
  ];
  for (const [x0, x1, ic, lab, go] of create)
    s.push(
      A(x0, 316, x1 - x0, 21, "background:#2f6f3d;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.35)"),
      I(ic, x0 + 19, 326.5, 9, "#eef5ee"),
      T(x0 + 30, 327, lab, 8, "#f2f6f2"),
      Hit(x0, 316, x1 - x0, 21, `Create ${lab}`, go, "Velocity has no sheet store"),
    );
  s.push(
    A(949, 316, 17, 21, "background:#2f6f3d;border-radius:2px"),
    I("caret-down", 957.5, 327, 8, "#eef5ee"),
    A(1695, 317, 107, 21, "background:#1a1e22;border-radius:2px"),
    I("database", 1705, 327, 9, "#7a838a"),
    T(1716, 327.5, "Latest", 8.2, "#7a838a"),
    T(1760, 327.5, ev ? `${Math.round(ev.ms)}ms` : "…", 6.6, "#555d64"),
    I("caret-down", 1793, 327, 7, "#7a838a"),
    I("help", 1819, 327, 10, "#f2f4f6"),
    I("user", 1843, 327, 10, "#f2f4f6"),
  );
  // legend
  s.push(A(775, 558, 82, 92, "background:rgba(20,24,28,.8);border-radius:2px"));
  const leg: [string, string, string][] = [
    ["dot", "#7f8fd6", "Aircraft"],
    ["dotg", "#3fa35a", "SAR sweep"],
    ["ring", "#e8e8e8", "Chokepoint"],
    ["ring", "#e8923a", "NGA warning"],
    ["ic", "#9aa4ab", "Quake (EMSC)"],
  ];
  leg.forEach(([k, col, lab], i) => {
    const yc = 570 + i * 17;
    if (k === "ic") s.push(I("pulse", 789, yc, 9, col));
    else if (k.startsWith("dot")) s.push(circ(789, yc, 3, col));
    else s.push(A(786, yc - 3.2, 6.4, 6.4, `border:1.3px solid ${col};border-radius:50%`));
    s.push(T(803, yc + 0.3, lab, 7.4, "#aab2b8"));
  });
  if (hormuz) {
    const hx = gx(hormuz.lon);
    const hy = gy(hormuz.lat);
    s.push(
      A(hx - 52, hy + 30, 112, 20, "background:#e6e9f2;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.5)"),
      I("map-marker", hx - 39, hy + 40, 9, "#2a50a8"),
      T(hx - 29, hy + 40.5, "Strait of Hormuz", 7.8, "#242a38", 600, "l", 0.01),
      Hit(hx - 52, hy + 30, 112, 20, "Preview Strait of Hormuz", () => setCard(true)),
    );
  }
  // preview card
  if (card)
    s.push(
      A(1604, 349, 253, 275, "background:#242a30;border:1px solid #2c343a"),
      A(1604, 349, 253, 19, "background:#1f252a"),
      I("cross", 1847, 359, 8, "#d6dce0"),
      Hit(1840, 352, 14, 14, "Close preview", () => setCard(false)),
      A(1608, 372, 245, 106, "background:#2a323a"),
      I("globe-network", 1731, 423, 44, "#8a949b"),
      T(1731, 452.5, "Map preview not available", 7.6, "#e4e8ec", 400, "c"),
      T(1611, 497, "Strait of Hormuz", 8.6, "#f2f4f6", 400),
      T(1611, 515, "UNCLASSIFIED", 7.6, "#e4e8ec", 600),
      T(1611, 531, "Vessels in box", 7.6, "#8a949b"),
      T(1687, 531, hormuz ? `${hormuz.vessels} items` : unavailable("Chokepoints", chokeRes), 7.6, "#e4e8ec"),
      T(1611, 547, "Stationary", 7.6, "#8a949b"),
      T(1687, 547, hormuz ? `${hormuz.stationary} items` : "—", 7.6, "#e4e8ec"),
      I("pulse", 1633, 570, 14, "#6a747b"),
      T(1647, 570.5, "Presence not available", 7.6, "#8a949b"),
      A(1608, 600, 245, 20, "background:#2c54b0"),
      I("share", 1706, 610, 9, "#f2f6ff"),
      T(1717, 610.5, "Open map", 8, "#f2f6ff"),
      Hit(1608, 600, 245, 20, "Open map", toMap),
    );
  // tab strip
  s.push(A(767, 658, 1099, 32, "background:#1c1e24"));
  const tabs: [string, string, number, number, number, (() => void) | undefined][] = [
    ["duplicate", "All artifacts", 789, 804, 0, undefined],
    ["globe-network", "Maps", 883, 898, 0, toMap],
    ["th", "Datasets", 953, 968, 0, undefined],
    ["document", "Evidence", 1028, 1043, 1, () => undefined],
    ["document-open", "Reports", 1124, 1138, 0, toReports],
    ["lightbulb", "AI briefs", 1198, 1214, 0, undefined],
  ];
  for (const [ic, lab, ix, tx, on, go] of tabs)
    s.push(
      A(ix - 10, 666, 20, 20, "background:#252a31;border-radius:3px"),
      I(ic, ix, 676, 10, on ? "#b44fd6" : "#9aa4ab"),
      T(tx, 674, lab, 7.4, "#e4e8ec", 600),
      Hit(ix - 10, 664, tx - ix + lab.length * 5 + 14, 24, lab, go, "Only the evidence store backs this browser"),
    );
  s.push(
    A(1015, 688, 80, 2, "background:#6a9ae0"),
    A(1600, 663, 230, 23, "background:#1a2234;border:1px solid #3a4a70;border-radius:2px;box-sizing:border-box"),
    I("search", 1611, 675, 10, "#d8dee3"),
    <input
      key="q"
      aria-label="Search evidence"
      value={q}
      onChange={(e) => setQ(e.target.value)}
      style={{ position: "absolute", left: 1622, top: 667, width: 186, height: 16, background: "transparent", border: 0, outline: 0, padding: 0, color: "#e4e8ec", fontSize: 7.8 * 1.14 * 1.12, letterSpacing: "0.046em", fontFamily: "inherit" }}
    />,
    I("cross", 1817, 675, 8, "#d8dee3"),
    Hit(1810, 668, 14, 14, "Clear search", () => setQ("")),
    A(1840, 664, 16, 22, "background:#2a323a;border-radius:2px"),
    I("double-chevron-down", 1848, 675, 9, "#b8c0c6"),
  );
  // left filter list
  s.push(
    A(767, 690, 181, 220, "background:#242a30"),
    A(947, 690, 1, 220, "background:#1b2024"),
    A(775, 698, 165, 22, "background:#2e56b6;border-radius:2px"),
    T(782, 709.5, "All evidence", 7.6, "#f2f6ff"),
  );
  for (const [yc, t] of [
    [735, "Captured by me"],
    [761, "Shared with me"],
    [786, "Shared with my teams"],
    [811, "Favorites"],
  ] as const)
    s.push(T(782, yc + 0.5, t, 7.6, "#cdd3d8", 600), Hit(775, yc - 10, 165, 20, t, undefined, "Open mode has no user identity to filter by"));
  s.push(
    A(775, 830, 165, 1, "background:#3c444b"),
    A(775, 843, 11, 11, "border:1px solid #6a747b;border-radius:2px;box-sizing:border-box"),
    T(794, 848.5, "Show untitled", 7.6, "#cdd3d8"),
    A(775, 864, 11, 11, "border:1px solid #6a747b;border-radius:2px;box-sizing:border-box"),
    I("pulse", 800, 869, 9, "#3fa35a"),
    T(811, 869.5, "Only show verified", 7.6, "#cdd3d8"),
  );
  // table
  s.push(A(949, 690, 917, 220, "background:#1c1e24"));
  for (const [x, h] of [
    [955, "NAME"],
    [1107, "TYPE"],
    [1145, "ACTIVE"],
    [1187, "CREATED BY"],
    [1319, "LAST UPDATED"],
    [1435, "CLASSIFICATION"],
    [1518, "LABELS"],
    [1782, "ACTIONS"],
  ] as const)
    s.push(T(x, 704.5, h, 7.2, "#c4cad0", 700, "l", 0.02));
  s.push(I("sort-desc", 1395, 704, 7, "#aeb4ba"));
  const rows = EVID.filter((e) => e.title.toLowerCase().includes(q.trim().toLowerCase()));
  if (!ev?.ok) s.push(T(955, 740, unavailable("Evidence", ev), 8, "#e8923a", 600));
  else if (!rows.length) s.push(T(955, 740, `No evidence matches "${q}"`, 8, "#aab2b8"));
  const ys = [722, 770, 818];
  rows.slice(0, 3).forEach((e, k) => {
    const y = ys[k]!;
    if (k === 0) s.push(A(949, y, 917, 48, "background:#202328"));
    const t = e.title;
    const [typ1, typ2] = e.capture_method.split("_");
    s.push(
      <div
        key={`drag${k}`}
        draggable
        title={t}
        onDragStart={(d) => {
          d.dataTransfer.setData("text/plain", t);
          setDragTitle(t);
        }}
        onDragEnd={() => setDragTitle(null)}
        style={{ left: 949, top: y, width: 560, height: 48, cursor: "grab" }}
      />,
      I("document", 966, y + 11, 9, "#b44fd6"),
      T(978, y + 11.5, t.length < 21 ? t : `${t.slice(0, 19)}…`, 8, "#f2f4f6", 600, "l", 0.02),
    );
    if (k === 0) s.push(I("star-empty", 1087, y + 11, 8, "#aeb4ba"));
    s.push(
      T(1109, y + 11.5, cap(typ1 ?? ""), 7.4, "#d8dee3", 600),
      typ2 ? T(1109, y + 28, typ2, 7.4, "#d8dee3", 600) : null,
      T(1187, y + 11.5, e.captured_by || "local", 7.4, "#d8dee3", 600),
      T(1321, y + 11.5, shortDate(e.captured_at), 7.4, "#d8dee3", 600),
      T(1437, y + 11.5, "UNCLAS", 7.4, "#d8dee3", 600),
    );
    let cx = 1522;
    let cy = y + 13;
    for (const [lab, val] of chipsOf(e)) {
      const w = (lab.length + val.length) * 4.55 + 16;
      if (cx + w > 1760) {
        cx = 1522;
        cy += 17.3;
      }
      s.push(
        A(cx, cy - 6, w, 12, "background:#d6dade;border-radius:6px"),
        T(cx + 6, cy + 0.3, <><b>{lab}:</b> {val}</>, 6.8, "#252a30", 400, "l", 0.0),
      );
      cx += w + 4;
    }
    s.push(
      I("duplicate", 1794, y + 12, 9, "#c4ccd2"),
      Hit(1787, y + 5, 14, 14, "Copy SHA-256", () => void navigator.clipboard?.writeText(e.sha256)),
      I("export", 1815, y + 12, 9, "#c4ccd2"),
      Hit(1808, y + 5, 14, 14, "Download artifact", () => void download(e)),
    );
  });
  return frag(s);
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
