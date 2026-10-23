// Timeline (gotham-013-062, D40): sec_timeline() of _build_gotham_b.py. Bars
// are the AIS fixes of the Browser result set, one per (MMSI, fix time) across
// every box pull since the app opened, in 5 minute bins, stacked by the source
// each pull reported the fix under.
import { useState } from "react";
import { A, Hit, I, T, Tr, frag, type N } from "./kit.js";
import { dmy, fixBins, hhmm, recFixes, recorder } from "./data.js";
import type { Ctx } from "./model.js";

export const SRC_COL: Record<string, string> = { shipxplorer: "#da2c6e", openwaters: "#8eb024", vesselfinder: "#9c3e9c" };
const BIN = 300;

export function Timeline({ c }: { c: Ctx }): JSX.Element {
  const W = 1139, H = 358;
  const [off, setOff] = useState<string[]>([]);
  const fx = recFixes(new Set(c.res.map((r) => r.mmsi)));
  const B = fixBins(fx, BIN);
  const o: N[] = [A(0, 0, W, H, "background:#10141a")];
  o.push(A(0, 0, 100, 34, "background:#10141a"));
  const tabs: [number, string, number, string, (() => void) | undefined][] = [
    [20, "th-list", 0, "List: the Object Explorer", () => c.go("explorer")], [52, "zoom-to-fit", 0, "Map: the map", () => c.go("gaia")], [85, "time", 1, "Timeline", undefined],
  ];
  for (const [xc, ic, act, label, fn] of tabs)
    o.push(A(xc - 16, 2, 32, 30, `background:${act ? "#44485a" : "#262a30"};border-radius:3px 3px 0 0`), I(ic, xc, 18, 15, "#e5e8eb"), Hit(xc - 16, 2, 32, 30, label, fn, "This is the timeline"));
  o.push(A(1, 36, W - 2, 314, "background:#262a30;border:1px solid #3a3f48;border-radius:2px"));
  o.push(T(17, 53, "Timeline", "#f1f4f5", 13, 400, "font-weight:700"),
    T(97, 53, B ? `Showing ${hhmm(B.t0)} to ${hhmm(B.t1)} ${dmy(B.t1)}` : c.boxRes && !c.boxRes.ok ? "No fixes: the AIS box pull failed" : "No fixes recorded yet", "#aab4bc", 9.6, 400, "font-weight:600"),
    Tr(1083, 53, "Bin size: minutes", "#aab4bc", 9.6, 120, "font-weight:600"), I("cross", 1117, 53, 12, "#e5e8eb"), A(2, 69, W - 4, 1, "background:#3a3f48"));
  o.push(Hit(1109, 45, 16, 16, "Close the timeline: the graph document", () => c.go("menubar")));
  const PX0 = 35, PX1 = 868, BASE_Y = 307;
  o.push(A(PX0, 70, 1, 245, "background:#aab4bc"), A(PX0, BASE_Y, PX1 - PX0, 1, "background:#aab4bc"));
  if (B) {
    const shown = B.order.map(([s]) => s).filter((s) => !off.includes(s));
    const max = Math.max(1, ...B.bins.map((b) => shown.reduce((a, s) => a + (b.get(s) ?? 0), 0)));
    const STEP = 5 * Math.ceil(max / 3.3 / 5);
    const sc = 64.0 / STEP;
    for (let v = STEP; v <= 3 * STEP; v += STEP) {
      const y = BASE_Y - v * sc;
      o.push(A(PX0, y, PX1 - PX0, 1, "background:#7a828c"), Tr(28, y, String(v), "#aab4bc", 9.5, 24));
    }
    const bw = (PX1 - PX0 - 8) / B.bins.length;
    B.bins.forEach((b, k) => {
      const x = PX0 + 4 + k * bw;
      let y = BASE_Y;
      for (const s of shown) {
        const n = b.get(s) ?? 0;
        if (!n) continue;
        const h = n * sc;
        o.push(A(x, y - h, bw - 2.5, h, `background:${SRC_COL[s] ?? "#2e70d2"};background-image:repeating-linear-gradient(0deg,transparent 0,transparent ${(sc - 1).toFixed(2)}px,#262a30 ${(sc - 1).toFixed(2)}px,#262a30 ${sc.toFixed(2)}px)`));
        y -= h;
      }
    });
    // x axis: a label every full hour, minor ticks every 30 minutes
    for (let t = (Math.floor(B.t0 / 1800) + 1) * 1800; t < B.t1; t += 1800) {
      const x = PX0 + 4 + (t / BIN - B.b0) * bw;
      const major = t % 3600 === 0;
      o.push(A(x, BASE_Y, 1, major ? 8 : 5, "background:#aab4bc"));
      if (major) o.push(T(x + 3, 321, hhmm(t), "#aab4bc", 9.5));
    }
  }
  // legend
  o.push(A(870, 70, 1, 280, "background:#3a3f48"));
  const cb = (x: number, y: number, on: boolean): N[] => [A(x - 8, y - 8, 16, 16, on ? "background:#2e70d2;border-radius:2px" : "border:1px solid #6b7680;border-radius:2px"), on ? I("tick", x, y, 12, "#fff") : null];
  const all = B ? B.order.map(([s]) => s) : [];
  o.push(...cb(891, 85, off.length === 0), T(910, 85, "Source", "#f1f4f5", 11), Hit(881, 75, 70, 20, "Source: show every source", off.length ? () => setOff([]) : undefined, "Every source is shown"));
  (B?.order ?? []).forEach(([s, n], k) => {
    const y = 116 + 31.5 * k;
    const on = !off.includes(s);
    o.push(...cb(914, y, on), T(934, y, `${s} (${n})`, "#f1f4f5", 11), A(1090, y - 8, 16, 16, `background:${SRC_COL[s] ?? "#2e70d2"};border-radius:2px`));
    o.push(Hit(904, y - 10, 200, 20, `${on ? "Hide" : "Show"} ${s}`, () => setOff(on ? [...off, s] : off.filter((x) => x !== s))));
  });
  if (!all.length) o.push(T(904, 116, `${recorder().polls} box pull${recorder().polls === 1 ? "" : "s"}, no fixes in the result set`, "#aab4bc", 10));
  o.push(A(1120, 78, 7, 85, "background:#5d646e;border-radius:3px"));
  return frag(o);
}
