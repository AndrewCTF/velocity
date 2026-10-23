// Video (gotham-015-073, D49-D55): sec_video() of _build_gotham_b.py. There
// is no full-motion video. The builder's still was a repo orthophoto with its
// detector's output; here the still is the app's own satellite plate around
// the selected track (/tiles/sat, the maven video's plate maths) and the
// detections are the imagery route's answer for the hatched detection box.
// Readings with no source read n/a; transport is inert. The strip under it is
// the AIS recorder window (fixes per 2 minutes of the result set).
import { useEffect, useMemo, useState } from "react";
import { A, Hit, I, T, Tc, frag, type N } from "./kit.js";
import { TRK, fixBins, hhmm, recFixes, recorder, fetchJson } from "./data.js";
import { SPAN, TILE, makePlate, tiles, toLL, toPx } from "../maven/fmvPlate.js";
import type { Ctx } from "./model.js";

const OR = "#e8872a";
const FX0 = 281, FY0 = 35, FW = 864, FH = 480;
// the detection box in frame px (the builder's lot ROI sat in the same place)
const ROI = { x: 520, y: 70, w: 400, h: 330 };
interface Det { lon: number; lat: number; cls: string; conf: number | null }

export function Video({ c }: { c: Ctx }): JSX.Element {
  const W = 1154, H = 644;
  const sel = c.sel;
  const plate = useMemo(() => (sel ? makePlate(sel.v.lat, sel.v.lon, 17) : null), [sel]);
  // plate px -> frame px: the fix sits at the frame centre, native tile scale
  const [ox, oy] = plate && sel ? toPx(plate, sel.v.lat, sel.v.lon) : [0, 0];
  const vpos = (px: number, py: number): [number, number] => [FX0 + FW / 2 + (px - ox), FY0 + FH / 2 + (py - oy)];
  const roiLL = plate ? [toLL(plate, ROI.x - FX0 - FW / 2 + ox, ROI.y - FY0 - FH / 2 + oy), toLL(plate, ROI.x + ROI.w - FX0 - FW / 2 + ox, ROI.y + ROI.h - FY0 - FH / 2 + oy)] : null;
  const [det, setDet] = useState<{ dets: Det[]; note: string | null } | null>(null);
  useEffect(() => {
    if (!roiLL) return;
    const [[n, w], [s, e]] = roiLL as [[number, number], [number, number]];
    let live = true;
    setDet(null);
    void fetchJson<{ features?: { geometry: { coordinates: [number, number] }; properties: { cls?: string; conf?: number } }[]; summary?: { note?: string } }>(
      `/api/imagery/detect?min_lon=${w.toFixed(5)}&min_lat=${s.toFixed(5)}&max_lon=${e.toFixed(5)}&max_lat=${n.toFixed(5)}&date=${new Date().toISOString().slice(0, 10)}`,
    ).then((r) => {
      if (!live) return;
      if (!r.ok) return setDet({ dets: [], note: `Detection unavailable (HTTP ${r.status})` });
      const dets = (r.data?.features ?? []).map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], cls: String(f.properties.cls ?? "object"), conf: f.properties.conf ?? null }));
      setDet({ dets: dets.sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0)), note: r.data?.summary?.note ?? null });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plate]);
  const DETS = det?.dets ?? [];
  const VIS = plate ? DETS.map((d) => ({ d, p: vpos(...toPx(plate, d.lat, d.lon)) })) : [];
  const vin = ([x, y]: [number, number], m = 6): boolean => FX0 + m <= x && x <= FX0 + FW - m && FY0 + m <= y && y <= FY0 + FH - m;
  const VIS_IN = VIS.filter((v) => vin(v.p));
  const OFF = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const { p: [x, y] } of VIS)
    if (!vin([x, y])) {
      if (y < FY0) OFF.top += 1;
      else if (y > FY0 + FH) OFF.bottom += 1;
      else if (x < FX0) OFF.left += 1;
      else OFF.right += 1;
    }
  const SELD = VIS_IN[0] ?? null;
  const SELT = sel ? TRK(sel.mmsi) : "No track";
  const rec = recorder();
  const o: N[] = [A(0, 0, W, H, "background:#181e26")];
  // frame (the plate), burned-in readings (n/a: a still plate has no sensor pose)
  const tl: N[] = plate ? tiles(plate).map((t) => <img key={t.key} src={t.url} alt="" draggable={false} style={{ position: "absolute", left: t.x - ox + FW / 2, top: t.y - oy + FH / 2, width: TILE, height: TILE }} />) : [];
  o.push(A(FX0, FY0, FW, FH, "background-color:#222;overflow:hidden", tl));
  if (!sel) o.push(Tc(FX0 + FW / 2, FY0 + FH / 2, "No vessel matches the search, so there is no plate.", "#f1f4f5", 11, 400));
  // the detection box, hatched
  const pts = [[ROI.x, ROI.y], [ROI.x + ROI.w, ROI.y], [ROI.x + ROI.w, ROI.y + ROI.h], [ROI.x, ROI.y + ROI.h]].map((p) => p.join(",")).join(" ");
  o.push(
    <svg style={{ left: 0, top: 0, width: W, height: H, overflow: "visible" }}>
      <defs>
        <pattern id="pdf-hz" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(214,196,60,.20)" /><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(214,196,60,.55)" strokeWidth="2" /></pattern>
        <clipPath id="pdf-fc"><rect x={FX0} y={FY0} width={FW} height={FH} /></clipPath>
      </defs>
      <g clipPath="url(#pdf-fc)"><polygon points={pts} fill="url(#pdf-hz)" stroke="#d6c43c" strokeWidth="1.2" /></g>
    </svg>,
  );
  o.push(T(Math.min(ROI.x + ROI.w, FX0 + FW - 150), Math.max(ROI.y - 30, FY0 + 8), "Detection box", "#f1f4f5", 10.5, 400, "font-weight:600;text-shadow:0 0 3px #000"));
  for (const { p: [x, y] } of VIS_IN)
    o.push(<svg style={{ left: x - 6, top: y - 12, width: 12, height: 11 }}><polygon points="0,0 12,0 6,11" fill={OR} stroke="#fff" strokeWidth="1" /></svg>);
  if (SELD) {
    const [sx, sy] = SELD.p;
    o.push(A(sx - 19, sy - 24, 38, 38, `background:rgba(232,135,42,.28);border:1.5px solid ${OR}`), A(sx - 28, sy - 31, 56, 56, "background:rgba(255,255,255,.22);border-radius:28px"));
  }
  const hud = "font-family:'DejaVu Sans Mono',monospace;color:#f4f4f4;font-size:10.5px;text-shadow:0 0 2px #000;line-height:12px;white-space:pre";
  const PX = SPAN * TILE;
  o.push(A(290, 86, 150, 60, hud, `SAT PLATE\nTILES Z${plate?.z ?? "n/a"}\nNO SENSOR POSE\n${PX} X ${PX} PX`));
  o.push(A(290, 462, 190, 40, hud, `NO LASER, NO FMV\nTILE DATE n/a`));
  o.push(A(940, 462, 200, 50, `${hud};text-align:right`, `BRG n/a  RNG n/a\nELV n/a  TWD n/a\nDET ${det ? DETS.length : "n/a"}  ROI 1`));
  // off-screen counters (D52): detections outside the view, per edge
  const cp = { top: [FX0 + FW / 2, FY0 + 14], bottom: [FX0 + FW / 2 + 60, FY0 + FH - 14], left: [FX0 + 14, FY0 + FH / 2], right: [FX0 + FW - 14, FY0 + FH / 2] } as const;
  for (const k of ["top", "bottom", "left", "right"] as const) {
    const n = OFF[k];
    if (!n) continue;
    const [x, y] = cp[k];
    o.push(A(x - 12, y - 12, 24, 24, "background:rgba(40,50,60,.85);border:1px solid #cfd6dc;border-radius:12px"), Tc(x, y, String(n), "#fff", 11, 24),
      I(`arrow-${k === "top" ? "up" : k === "bottom" ? "down" : k}`, x + (k === "left" ? -16 : k === "right" ? 16 : 0), y + (k === "top" ? -17 : k === "bottom" ? 17 : 0), 9, "#fff"));
  }
  // header (D49)
  o.push(A(0, 0, W, 34, "background:#181e26"), I("fullscreen", 290, 16, 13, "#e5e8eb"), I("locate", 314, 16, 13, "#e5e8eb"));
  o.push(Hit(281, 6, 18, 20, "Full screen: the map", () => c.go("gaia")), Hit(305, 6, 18, 20, "Locate: the custom object view", sel ? () => c.go("cov") : undefined, "No vessel selected"));
  o.push(Tc(713, 11, "Satellite plate", "#f1f4f5", 9.6, 200, "font-weight:600"), Tc(713, 24, `${SELT} (still image, no FMV)`, "#aab4bc", 8.6, 220));
  o.push(A(1034, 6, 22, 20, "background:#0a9860;border-radius:2px;opacity:.45"), I("feed", 1045, 16, 12, "#fff"), A(1062, 8, 16, 16, "background:#323a44;border-radius:8px"), I("lightning", 1070, 16, 10, "#c3ccd2"),
    A(1086, 6, 56, 20, "border:1px solid #6b7680;border-radius:2px"), Tc(1114, 16, "AI feedback", "#e5e8eb", 8.8, 70));
  o.push(Hit(1034, 6, 22, 20, "Feed", undefined, "No video feed exists"), Hit(1062, 8, 16, 16, "Lightning", undefined, "No quick actions on a still"), Hit(1086, 6, 56, 20, "AI feedback", undefined, "No detector feedback store exists"));
  // left Tagging panel (D53)
  o.push(A(0, 0, 281, H, "background:#223038"));
  o.push(I("tag", 13, 15, 12, "#f1f4f5"), T(25, 15, "Tagging", "#f1f4f5", 10.5, 400, "font-weight:600"), A(201, 7, 67, 16, "background:#1a7abe;border-radius:2px"), Tc(234, 15, "Done tagging", "#fff", 8.8, 70, "font-weight:600"));
  o.push(Hit(201, 7, 67, 16, "Done tagging: the map", () => c.go("gaia")));
  o.push(A(0, 32, 281, 1, "background:#2c3a44"));
  o.push(A(8, 36, 68, 18, "background:#2e3c48;border:1px solid #3d4c58;border-radius:2px"), I("tick-circle", 17, 45, 10, "#e5e8eb"), T(30, 45, "Actions", "#f1f4f5", 8.8), I("caret-down", 67, 46, 7, "#e5e8eb"),
    A(90, 36, 122, 18, "background:#2e3c48;border:1px solid #3d4c58;border-radius:2px"), T(95, 45, "Group by:", "#aab4bc", 8.6), T(135, 45, "None", "#f1f4f5", 8.8), I("caret-down", 203, 46, 7, "#e5e8eb"),
    I("media", 240, 45, 11, "#e5e8eb"), I("th-list", 260, 45, 11, "#e5e8eb"));
  o.push(Hit(8, 36, 68, 18, "Actions: the Browser", () => c.go("browser")), Hit(90, 36, 122, 18, "Group by", undefined, "One group: the detection box"),
    Hit(232, 37, 16, 16, "Media: the custom object view", () => c.go("cov")), Hit(252, 37, 16, 16, "List: the Object Explorer", () => c.go("explorer")));
  o.push(A(0, 62, 281, 24, "background:#127cbc"), T(8, 73, "Tagging to", "#fff", 9), A(60, 66, 66, 16, "background:#2e8fcd;border-radius:2px"), I("map-marker", 70, 74, 9, "#fff"), T(80, 74, "Det. box", "#fff", 8.8, 36), I("cross", 120, 74, 7, "#fff"));
  o.push(A(10, 91, 258, 43, "background:#30404c;border:1.5px solid #2d8fe0;border-radius:3px"));
  const th = sel && plate ? (() => {
    const [px, py] = toPx(plate, sel.v.lat, sel.v.lon);
    const tx = plate.tx0 + Math.floor(px / TILE), ty = plate.ty0 + Math.floor(py / TILE);
    return `background:url(/tiles/sat/${plate.z}/${tx}/${ty}.jpg) ${(-((px % TILE) - 11)).toFixed(1)}px ${(-((py % TILE) - 9)).toFixed(1)}px/256px 256px;border:1px solid #6b7680`;
  })() : "background:#16203a;border:1px solid #6b7680";
  o.push(A(18, 102, 22, 18, th), T(50, 105, "Detection box", "#f1f4f5", 9.6, 400, "font-weight:700"), T(50, 117, "Location", "#aab4bc", 8), I("chevron-right", 250, 112, 10, "#e5e8eb"));
  o.push(Hit(10, 91, 258, 43, "Detection box: the map", () => c.go("gaia")));
  o.push(I("caret-down", 14, 141, 7, "#aab4bc"), T(22, 141, det ? `${DETS.length} linked observations` : "detecting…", "#aab4bc", 7.6));
  o.push(A(24, 152, 244, 294, "background:#384a58;border:1px solid #c08a3a;border-radius:3px"));
  const d0 = SELD?.d ?? null;
  const kv = (y: number, k: string, v: string): N[] => [T(35, y, k, "#c3ccd2", 7.6, 400, "font-weight:600"), T(103, y, v, "#f1f4f5", 7.8, 400, "max-width:160px;overflow:hidden;text-overflow:ellipsis")];
  if (d0) {
    o.push(A(34, 163, 22, 18, th), T(61, 167, "Detection 1", "#f1f4f5", 9.6, 400, "font-weight:700"), T(61, 179, `${d0.cls} in the box`, "#f1f4f5", 9.6, 400, "font-weight:700"), T(61, 192, "Observation", "#aab4bc", 7.8), I("more", 234, 168, 11, "#e5e8eb"), I("chevron-down", 252, 168, 9, "#e5e8eb"));
  } else
    o.push(T(36, 167, "No detection", "#f1f4f5", 9.6, 400, "font-weight:700"), T(36, 182, det ? (det.note ?? "No detections in the box") : "detecting…", "#f1f4f5", 7.8, 400, "white-space:normal;width:224px;height:auto;line-height:11px"));
  o.push(...kv(222, "Classification", ""), A(103, 217, 2, 10, "background:#e8872a"), T(110, 222, "OSINT", "#f1f4f5", 7.8), I("caret-down", 134, 222, 7, "#e5e8eb"));
  o.push(...kv(242, "Time interval", "n/a (still plate)"), ...kv(261, "Location", d0 ? `${d0.lat.toFixed(5)}, ${d0.lon.toFixed(5)}` : "n/a"), T(112, 281, "n/a (tile date)", "#f1f4f5", 7.8), I("calendar", 103, 281, 9, "#c3ccd2"), T(35, 281, "Date", "#c3ccd2", 7.6, 400, "font-weight:600"));
  o.push(...kv(303, "Detector", "YOLO, imagery route"), ...kv(325, "Confidence", d0?.conf != null ? d0.conf.toFixed(2) : "n/a"));
  o.push(T(35, 346, "Analyst Assess-", "#c3ccd2", 7.6, 400, "font-weight:600"), T(35, 358, "ment Summary", "#c3ccd2", 7.6, 400, "font-weight:600"), T(103, 346, "None recorded.", "#f1f4f5", 7.8));
  o.push(A(25, 372, 242, 22, "background:#766452"), T(35, 383, "QC Status", "#e5e8eb", 7.8, 400, "font-weight:600"), T(103, 383, "Unvalidated", "#fff", 7.8), I("double-caret-vertical", 162, 383, 8, "#fff"));
  o.push(Hit(100, 374, 72, 18, "QC status", undefined, "No analyst review store exists"));
  o.push(A(32, 400, 231, 21, "background:#365a70;border-radius:2px"), I("link", 98, 411, 10, "#e5e8eb"), T(112, 411, "Linked to Detection box", "#f1f4f5", 8.4));
  o.push(I("user", 38, 434, 9, "#aab4bc"), T(48, 434, "Detector run, no analyst assigned", "#aab4bc", 7.6, 400, "font-style:italic"));
  [462, 510, 556].forEach((y, k) => {
    if (!VIS_IN[k + 1]) return;
    o.push(A(10, y, 258, 38, "background:#2a3844;border:1px solid #324452;border-radius:3px"), A(18, y + 9, 22, 18, th), T(50, y + 12, `Detection ${k + 2}`, "#aab4bc", 9.4, 400, "font-weight:700"), T(50, y + 24, "Observation  Detection box", "#8f99a8", 7.8), I("chevron-right", 250, y + 19, 10, "#8f99a8"));
  });
  // transport (D54): inert, a still has no playback
  o.push(A(281, 520, 864, 33, "background:#1c2630"), T(293, 536, rec.last ? hhmm(rec.last, true) : "n/a", "#6aa6e8", 9.6, 400, "font-weight:600"));
  const G = "#e5e8eb";
  o.push(I("step-backward", 556, 536, 11, G), I("fast-backward", 577, 536, 11, G), T(588, 536, "2x", G, 8.8), I("history", 622, 536, 11, G), T(632, 536, "15s", G, 8.8), I("chevron-left", 669, 536, 11, G));
  o.push(A(686, 527, 56, 18, "background:#1a7abe;border-radius:2px"), I("pause", 698, 536, 10, "#fff"), T(710, 536, "Pause", "#fff", 8.8, 400, "font-weight:600"));
  o.push(I("chevron-right", 758, 536, 11, G), T(784, 536, "15s", G, 8.8), I("repeat", 806, 536, 11, G), T(830, 536, "2x", G, 8.8), I("fast-forward", 849, 536, 11, G), A(862, 527, 30, 17, "border:1px solid #6b3a3a;background:#3c2a2e;border-radius:2px"), Tc(877, 535, "Live", "#d25a5a", 8.4, 30), I("settings", 1108, 536, 11, G), I("style", 1131, 536, 11, G));
  o.push(Hit(546, 524, 350, 24, "Transport", undefined, "A still plate has no playback"), Hit(1098, 526, 44, 20, "Settings", undefined, "A still plate has no playback"));
  // timeline (D55): AIS recorder window, fixes per 2 minutes, the track's fixes as markers
  const TL0 = 283, TL1 = 1140;
  const B = fixBins(recFixes(new Set(c.res.map((r) => r.mmsi))), 120);
  o.push(A(281, 553, 864, 91, "background:#1c2630"), T(286, 558, "ZULU", "#aab4bc", 7.6));
  o.push(A(281, 568, 864, 1, "background:#4a5a68"));
  o.push(Hit(281, 570, 864, 60, "Timeline: the AIS timeline", () => c.go("timeline")));
  if (B) {
    const span = Math.max(1, B.t1 - B.t0);
    for (let k = 0; k <= 6; k++) {
      const x = TL0 + ((TL1 - TL0) * k) / 6;
      o.push(A(x, 561, 1, 8, "background:#aab4bc"), T(x + 3 + (k === 0 ? 26 : 0), 557, hhmm(B.t0 + (span * k) / 6), "#aab4bc", 7.6));
    }
    // the builder bins from the first fix ((t - FT0) // 120), not the clock grid
    const bins2 = new Map<number, number>();
    for (const f of recFixes(new Set(c.res.map((r) => r.mmsi)))) bins2.set(Math.floor((f.t - B.t0) / 120), (bins2.get(Math.floor((f.t - B.t0) / 120)) ?? 0) + 1);
    const nb2 = Math.floor(span / 120) + 1;
    const bmax2 = Math.max(1, ...bins2.values());
    for (const [k, n] of bins2) {
      const h = (44 * n) / bmax2;
      o.push(A(TL0 + ((TL1 - TL0) * k) / nb2 + 1, 624 - h, (TL1 - TL0) / nb2 - 1.5, h, "background:#e8b23a"));
    }
    for (const f of c.fixes)
      if (f[0] >= B.t0 && f[0] <= B.t1) o.push(<svg style={{ left: TL0 + ((TL1 - TL0) * (f[0] - B.t0)) / span - 5, top: 560, width: 10, height: 9 }}><polygon points="0,0 10,0 5,9" fill={OR} /></svg>);
    const wx = TL0 + (TL1 - TL0) * Math.max(0, 1 - 3600 / span);
    o.push(A(wx, 575, TL1 - wx, 50, "background:rgba(130,150,170,.35);border-top:2px solid #e8872a"), A(wx - 2, 590, 4, 20, "background:#8f9aa6"), A(TL1 - 4, 590, 4, 20, "background:#8f9aa6"));
    o.push(A(TL1 - 9, 563, 2, 62, "background:#1a7abe"), A(TL1 - 32, 618, 50, 12, "background:#1a7abe;border-radius:2px"), Tc(TL1 - 7, 624, hhmm(B.t1, true), "#fff", 7.6, 60));
    o.push(T(285, 636, hhmm(B.t0), "#aab4bc", 7.8), A(645, 630, 280, 12, "background:#2c3a46;border-radius:2px"), A(641, 629, 4, 14, "background:#8f9aa6"), A(921, 629, 4, 14, "background:#8f9aa6"),
      T(652, 636, hhmm(B.t1 - 3600), "#e5e8eb", 7.8), T(895, 636, hhmm(B.t1), "#e5e8eb", 7.8));
  } else o.push(T(300, 600, "No fixes recorded yet", "#aab4bc", 9));
  return frag(o);
}
