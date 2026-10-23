// Slides (gotham-010-046, D25 D26 D27): sec_slides() of _build_gotham_a.py in
// the 1157 x 636 figure's pixels. An incident brief for the searched place;
// red-hatched chips are fields with no source here, left unfilled.
import { useState } from "react";
import { A, Hit, I, T, Tc, frag, type N } from "./kit.js";
import { TRK, hhmm, recorder } from "./data.js";
import type { Ctx } from "./model.js";

// the brief / report-export section list (level, label)
const OUTLINE: [number, string][] = [
  [0, "0. Incident Preliminaries"], [1, "a. Incident Information an..."], [1, "b. Five W"], [0, "1. Situation"], [1, "a. Cluster"], [2, "i. Scene Overlay"], [1, "b. Nearby Traffic"],
  [0, "2. Assessment"], [1, "a. Selected Track"], [0, "3. Collection"], [1, "a. Concept of Collection"], [2, "i. SAR Passes"], [2, "ii. AIS Recorder"], [2, "iii. Replay Window"],
  [1, "b. Coordinating Instructions"], [2, "i. Evidence Capture"], [2, "ii. Alert Rules"], [1, "c. Timeline"], [2, "i. Recorder Timeline"], [2, "ii. Data Gaps"],
  [0, "4. Distribution"], [1, "a. Report Export"], [1, "b. Evidence Locker"], [1, "c. Alert Delivery"],
];
const OYS = [70, 91, 115, 141, 162, 186, 210, 235, 257, 282, 304, 328, 351, 375, 399, 422, 446, 470, 493, 517, 542, 564, 588, 611];
const HATCH = "background:repeating-linear-gradient(135deg,#e66a6e 0 3px,#f08a8e 3px 5px)";
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function chip(xc: number, yc: number, text: string, size: number, w: number, h?: number, color = "#fff"): N[] {
  const hh = h ?? size * 1.35;
  return [A(xc - w / 2, yc - hh / 2, w, hh, HATCH), Tc(xc, yc, text, color, size, w + 20, "font-weight:700")];
}

export function Slides({ c }: { c: Ctx }): JSX.Element {
  const [find, setFind] = useState("");
  const [cur, setCur] = useState(1);
  const W = 1157, H = 636;
  const o: N[] = [A(0, 0, W, H, "background:#f6f6f8"), A(0, 0, W, 2, "background:#5a6470")];
  o.push(T(8, 16, "Slides", "#394450", 10), T(51, 16, "Outline", "#215db0", 10), A(53, 26, 36, 1.5, "background:#215db0"));
  o.push(Hit(4, 8, 36, 16, "Slides", undefined, "The outline lists every slide of this brief"));
  o.push(A(5, 33, 167, 22, "background:#fff;border:1px solid #b8bec6;border-radius:2px"));
  o.push(
    <input
      className="sl-field"
      aria-label="Find form fields"
      placeholder="Find form fields..."
      value={find}
      onChange={(e) => setFind(e.target.value)}
      style={{ left: 12, top: 37, width: 150, height: 14, fontSize: 10, color: "#1c2127" }}
    />,
  );
  OUTLINE.forEach(([lv, t_], i) => {
    const yc = OYS[i]!;
    const dim = find && !t_.toLowerCase().includes(find.toLowerCase()) ? ";opacity:.35" : "";
    if (lv === 0) {
      o.push(T(12, yc, t_, "#5c6672", 8.6, 400, `font-weight:600${dim}`));
      return;
    }
    if (i === cur) o.push(A(5, yc - 11, 155, 23, "background:#e6e8ee"), A(12, yc - 3, 6, 6, "background:#2a72d4;border-radius:3px"));
    else o.push(A(11 + (lv - 1) * 9, yc - 2.5, 5, 5, "border:1px solid #b8bec6;border-radius:3px"));
    o.push(T(22 + (lv - 1) * 12, yc, t_, "#1c2127", 8.8, 400, `font-weight:600${dim}`));
    o.push(Hit(5, yc - 11, 155, 23, t_, () => setCur(i)));
  });
  o.push(A(162, 68, 10, 552, "background:#c0c0c0"));
  o.push(A(178, 0, 1, H, "background:#e3e5ea"));
  // form pane
  const head = OUTLINE[cur]![1];
  const two = cur === 1;
  o.push(T(186, 29, two ? "a. Incident Information and" : head, "#1c2127", 16, 400, "font-weight:600"), two ? T(186, 53, "Additional Products", "#1c2127", 16, 400, "font-weight:600") : null, A(186, 77, 304, 1, "background:#e3e5ea"));
  const fields: [number, string, string, string][] = [
    [100, "Brief Type", "Select a brief type for this deck", "sel"], [175, "Related Stencils", "Attach any additional relevant Stencils", "Add Related Stencil"],
    [295, "Related Maps", "Attach any additional relevant Maps", "Add Related Map"], [415, "Related Sheets", "Attach any additional relevant Sheets", "Add Related Sheet"],
    [536, "Additional Products", "Attach any additional relevant products (GeoJSON, PDFs, etc.)", "Add Product"],
  ];
  for (const [yc, t_, sub, kind] of fields) {
    o.push(T(186, yc, t_, "#1c2127", 11), T(186, yc + 17, sub, "#8f99a8", 8.5));
    if (kind === "sel") {
      o.push(A(186, 130, 304, 23, "background:#f2f3f5;border:1px solid #c9ced5;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,.12)"), T(194, 141, "Select...", "#8f99a8", 10), I("caret-down", 477, 141, 10, "#394450"));
      o.push(Hit(186, 130, 304, 23, "Brief type", undefined, "No brief type list exists"));
    } else {
      o.push(A(186, yc + 30, 304, 38, "background:#f4f5f7;border:1px solid #e3e5ea"), T(201, yc + 49, "None added.", "#aab4bc", 10));
      const bw = kind.includes("Stencil") ? 122 : kind.includes("Map") || kind.includes("Sheet") ? 117 : 91;
      o.push(A(186, yc + 75, bw, 22, "background:#f6f6f8;border:1px solid #b8bec6;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,.12)"), I("add", 199, yc + 86, 11, "#394450"), T(212, yc + 86, kind, "#1c2127", 10));
      o.push(Hit(186, yc + 75, bw, 22, kind, undefined, "No store feeds this slot"));
    }
  }
  o.push(A(502, 8, 9, 624, "background:#c0c0c0"));
  // preview
  o.push(A(520, 0, 637, 41, "background:#f6f6f8;border-bottom:1px solid #dfe2e7"), I("menu-open", 538, 21, 12, "#394450"), T(752, 21, "Visual:", "#5c6672", 10),
    A(790, 10, 140, 22, "background:#f6f6f8;border:1px solid #c9ced5;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,.1)"), I("layers", 806, 21, 11, "#394450"), T(816, 21, "Hormuz Gulf", "#1c2127", 10), I("caret-down", 913, 21, 9, "#394450"), I("print", 1140, 21, 12, "#394450"));
  o.push(Hit(530, 13, 16, 16, "Outline", undefined, "The outline is always shown"), Hit(790, 10, 140, 22, "Visual", undefined, "One scene plate: the Gulf"),
    Hit(1132, 13, 16, 16, "Print", () => window.print()));
  o.push(A(520, 42, 637, H - 42, "background:#eceef2"));
  const sx0 = 533, sx1 = 1155;
  const now = new Date(c.now * 1000);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const cao = `${p2(now.getUTCDate())}${MON[now.getUTCMonth()]}${String(now.getUTCFullYear()).slice(2)}`;
  const last = recorder().last || c.now;
  const slHeader = (y0_: number, mid: string): N[] => [
    A(sx0, y0_, sx1 - sx0, 24, "background:#000"),
    ...chip(637, y0_ + 7, "Incident Type", 6.4, 52),
    Tc(837, y0_ + 7, "OSINT", "#e8913a", 6.5, 60, "font-weight:700"),
    T(996, y0_ + 7, "SRC:", "#fff", 6.4, 400, "font-weight:700"), T(1010, y0_ + 7, "AIS recorder", "#fff", 6.4, 400, "font-weight:700"),
    T(540, y0_ + 19, `CAO: ${cao} ${hhmm(last).slice(0, -1)}`, "#fff", 6.4, 400, "font-weight:700"), T(603, y0_ + 19, "// Status: Draft", "#fff", 6.4, 400, "font-weight:700"),
    Tc(837, y0_ + 19, mid, "#fff", 6.4, 200, "font-weight:700"),
    T(966, y0_ + 19, "ORG:", "#fff", 6.4, 400, "font-weight:700"), ...chip(990, y0_ + 19, "Org", 6.2, 14), T(1000, y0_ + 19, "- ROLE:", "#fff", 6.4, 400, "font-weight:700"),
    ...chip(1046, y0_ + 19, "Position", 6.2, 28), T(1062, y0_ + 19, "- SVOIP:", "#fff", 6.4, 400, "font-weight:700"), ...chip(1111, y0_ + 19, "SVOIP", 6.2, 24),
  ];
  o.push(A(sx0, 55, sx1 - sx0, 351, "background:#fff"), ...slHeader(55, "Overview"));
  o.push(A(695, 87, 298, 38, "background:#dc8c3e"), Tc(844, 96, "The overall classification of this briefing is:", "#1c2127", 9.5, 290, "font-weight:700"), Tc(844, 115, "OSINT", "#1c2127", 12, 290, "font-weight:700"));
  const place = c.place;
  o.push(Tc(844, 173, place ? `${place.name.replace("Lpg", "LPG")} cluster` : "No place searched", "#fff", 14, 620, "font-weight:700;color:#1c2127"));
  o.push(...chip(844, 207, "Incident Type", 8.6, 66));
  o.push(Tc(844, 234, c.sel ? `${c.res.length} vessels within 10 km, ${TRK(c.sel.mmsi)} nearest track` : `${c.res.length} vessels within 10 km`, "#394450", 10, 400));
  if (place) o.push(Tc(844, 251, `${place.lat.toFixed(4)} N, ${place.lon.toFixed(4)} E`, "#1c2127", 10, 300, "font-weight:600"));
  o.push(T(535, 307, "Status: Draft", "#1c2127", 10, 400, "font-weight:700"));
  o.push(...chip(844, 279, "Start Time", 8.6, 66));
  o.push(...chip(844, 338, "Assessment", 8.6, 70));
  o.push(A(533, 361, 622, 1, "background:#222"));
  o.push(...chip(844, 371, "Expanded Purpose", 8.6, 90));
  o.push(A(sx0, 394, sx1 - sx0, 12, "background:#000"), Tc(844, 400, "OSINT", "#e8913a", 6.5, 60, "font-weight:700"));
  o.push(A(sx0, 421, sx1 - sx0, 215, "background:#e9e9e9"), ...slHeader(421, "Scene"));
  o.push(...chip(844, 538, "Scene Overlay", 17, 195, 25));
  return frag(o);
}
