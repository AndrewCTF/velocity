// Chat (gotham-008-036, D2 D18 D19 D20): sec_chat() of _build_gotham_a.py in
// the 1094 x 667 figure's pixels. No chat store exists: channels are the alert
// feeds, the thread is the standing detection, embeds and Shared Files are the
// evidence locker, watch rules stand in for direct messages. Nothing sends.
import { useState } from "react";
import { A, Hit, I, IS, T, Tc, frag, sceneBg, toPx, type N } from "./kit.js";
import { hhmm, regionAlerts } from "./data.js";
import type { Ctx, Page } from "./model.js";

const BLUE_T = "#6aa6e8";

export function Chat({ c }: { c: Ctx }): JSX.Element {
  const [draft, setDraft] = useState("");
  const W = 1094, H = 667;
  const REG_AL = regionAlerts(c.alerts);
  const N_STAND = Object.values(c.standing?.counts ?? {}).reduce((a, b) => a + b, 0);
  const CHANNELS: [string, string, number][] = [
    ["Gulf incident alerts", "globe", REG_AL.length], ["Standing detections", "lock", N_STAND], ["NGA warnings, Gulf", "lock", 0],
    // the builder badges only the two feeds with hits for this workspace
    ["Chokepoint congestion", "globe", 0], ["Watch officer briefs", "globe", 0],
  ];
  const o: N[] = [A(0, 0, W, H, "background:#101216")];
  // strip
  o.push(A(0, 0, W, 31, "background:#1a1e22"), A(276, 0, W - 276, 31, "background:#2c323a"));
  o.push(IS("globe", 11, 15, 13, "#e5e8eb"), Hit(2, 6, 18, 18, "Home: the exploration", () => c.go("explorer")));
  const tiles: [string, string, Page | null, string][] = [
    ["#2d72d2", "globe", "explorer", "Object Explorer"], ["#d64545", "play", null, "Replay: the console's time dock"], ["#3fb27f", "th", "browser", "Browser"],
    ["#4c8bd6", "flow-branch", "menubar", "Graph document"], ["#a064c8", "style", "slides", "Slides"], ["#e0a64a", "chat", "chat", "Chat"],
    ["#3fb27f", "gantt-chart", "dossier", "Dossier"], ["#aab4bc", "code", null, "Code: the Workflows app"], ["#aab4bc", "code", null, "Code: the Workflows app"],
    ["#e08a2e", "search-text", "browser", "Search"],
  ];
  tiles.forEach(([col, ic, pg, lab], k) => {
    const xc = 33 + 25.1 * k;
    o.push(A(xc - 10, 5, 20, 20, `background:#23282e;border:1px solid ${col}66;border-radius:3px`), I(ic, xc, 15, 11, col));
    o.push(Hit(xc - 10, 5, 20, 20, lab, pg ? () => c.go(pg) : undefined, `${lab}, outside this workspace`));
  });
  const s = c.sel;
  const [sx, sy] = s ? toPx(s.v.lon, s.v.lat) : [1000, 540];
  o.push(A(290, 3, 55, 25, "background:#24292f"), A(299, 4, 46, 24, sceneBg(1000, 540, 46, 24, 0.25, "brightness(.5)")), I("home", 300, 15, 12, "#e5e8eb"));
  o.push(Hit(290, 3, 55, 25, "Home tab: the exploration", () => c.go("explorer")));
  o.push(A(352, 1, 60, 29, `${sceneBg(sx, sy, 60, 29, 0.6, "brightness(.35)")};border:2px solid #4c90f0`), I("chat", 363, 15, 11, "#e0a64a"));
  o.push(I("properties", 891, 15, 12, "#c3ccd2"), I("inbox", 916, 15, 12, "#c3ccd2"));
  o.push(Hit(883, 7, 16, 16, "Properties: the custom object view", () => c.go("cov")), Hit(908, 7, 16, 16, "Inbox", () => c.go("inbox")));
  o.push(A(932, 4, 153, 23, "border:1px solid #3d444c;border-radius:3px"), I("search", 944, 15, 11, "#dfe5e7"), T(957, 15, "Search", "#dfe5e7", 9.5), A(1015, 7, 66, 17, "border:1px solid #4a525a;border-radius:2px"), Tc(1048, 15, "Ctrl + Space", "#c3ccd2", 8, 70));
  o.push(Hit(932, 4, 153, 23, "Search: the Browser", () => c.go("browser")));
  o.push(A(0, 31, W, 19, "background:#2c323a"), T(7, 41, "Edit", "#f1f4f5", 9.5), T(38, 41, "View", "#f1f4f5", 9.5), T(73, 41, "Window", "#f1f4f5", 9.5));
  o.push(Hit(4, 33, 28, 16, "Edit", undefined, "The console's own Edit menu serves this workspace"), Hit(35, 33, 30, 16, "View", undefined, "The console's own View menu serves this workspace"), Hit(70, 33, 40, 16, "Window", undefined, "One window"));
  o.push(I("chat", 459, 41, 11, "#e0a64a"), T(469, 41, "Velocity [2] | Standing detections", "#f1f4f5", 9.5), I("refresh", 1082, 41, 10, "#c3ccd2"));
  // sidebar
  o.push(A(0, 50, 270, 617, "background:#2a343e"), T(8, 75, "Chat", "#f1f4f5", 13, 400, "font-weight:600"), A(0, 98, 270, 1, "background:#212a32"));
  o.push(A(8, 113, 251, 23, "background:#1c242b;border:1px solid #2e3944;border-radius:3px"), I("search", 20, 125, 11, "#aab4bc"), T(30, 125, "Search...", "#6b7680", 9.5));
  o.push(Hit(8, 113, 251, 23, "Search: the Browser", () => c.go("browser")));
  o.push(I("chevron-down", 11, 156, 10, "#aab4bc"), T(23, 156, "Channels", "#aab4bc", 9.5), I("add", 259, 156, 11, "#4c90f0"));
  o.push(Hit(251, 148, 16, 16, "Add channel", undefined, "Channels are the alert feeds; there is no channel store"));
  const ys = [190, 222, 256, 291, 326];
  const dest: (Page | null)[] = ["inbox", null, "inbox", "dossier", null];
  CHANNELS.forEach(([nm, ic, cnt], k) => {
    const yc = ys[k]!;
    const on = nm === "Standing detections";
    if (on) o.push(A(0, 206, 270, 32, "background:#4c525e"));
    o.push(ic === "globe" ? IS("globe", 39, yc, 13, "#c3ccd2") : I("lock", 39, yc, 12, "#e5e8eb"), T(53, yc, nm, on ? "#f1f4f5" : "#d5dbe0", 9.5, 400, `font-weight:${on ? 500 : 400}`));
    if (cnt) o.push(A(241, yc - 8, 17, 17, "background:#4a7eb4;border-radius:9px"), Tc(249.5, yc, String(cnt), "#fff", 8, 20));
    const d = dest[k];
    o.push(Hit(0, yc - 15, 270, 30, nm, !on && d ? () => c.go(d) : undefined, on ? "This is the open channel" : "Read in the AI app"));
  });
  o.push(I("chevron-down", 11, 358, 9, "#aab4bc"), T(33, 358, "Show 2 more", "#aab4bc", 9));
  o.push(Hit(8, 350, 80, 16, "Show 2 more", undefined, "Every alert feed is listed"));
  o.push(I("chevron-down", 11, 388, 10, "#aab4bc"), T(23, 388, "Watch rules", "#aab4bc", 9.5), I("add", 259, 388, 11, "#4c90f0"));
  o.push(Hit(251, 380, 16, 16, "Add watch rule", undefined, "Watch rules are added from the alert rules list"));
  c.rules.slice(0, 4).forEach((rl, k) => {
    const yc = 421 + k * 31.7;
    o.push(A(40, yc - 2, 4, 4, "background:#aab4bc;border-radius:2px"), T(53, yc, rl.label, "#d5dbe0", 9.5));
  });
  // thread header
  o.push(A(271, 50, 559, 47, "background:#101216;border-bottom:1px solid #20262c"));
  o.push(I("lock", 289, 67, 11, "#f1f4f5"), T(299, 67, "Standing detections", "#f1f4f5", 11, 400, "font-weight:600"), T(286, 81, `${N_STAND} detection${N_STAND === 1 ? "" : "s"} • Alert rules`, "#aab4bc", 8.3));
  for (const [xc, ic] of [[737, "search"], [761, "user"], [785, "folder-open"], [809, "cog"]] as const) o.push(I(ic, xc, 74, 12, "#c3ccd2"));
  o.push(Hit(729, 66, 16, 16, "Search: the Browser", () => c.go("browser")), Hit(753, 66, 16, 16, "Members", undefined, "No member list exists"),
    Hit(777, 66, 16, 16, "Files", undefined, "The evidence locker is open on the right"), Hit(801, 66, 16, 16, "Settings", undefined, "Rules are edited from the alert rules list"));
  o.push(T(333, 121, "Standing detections", "#f1f4f5", 16, 400, "font-weight:600"));
  o.push(T(333, 153, <>These are the alert-rule hits for this workspace. This is the start of <b>Standing detections</b>.</>, "#d5dbe0", 9.5));
  o.push(T(333, 169, <>Topic: Rules evaluated on every snapshot <span style={{ color: "#3fb27f" }}>(edit)</span></>, "#d5dbe0", 9.5));
  o.push(I("people", 347, 210, 12, "#4c90f0"), T(359, 210, "Edit rules", "#4c90f0", 9.5));
  o.push(Hit(340, 202, 70, 16, "Edit rules", undefined, "Rules are edited from the alert rules list"));
  // first message: the real standing detection
  const sd = c.standing?.detections[0] ?? null;
  const ts = c.standing?.as_of ?? 0;
  o.push(A(291, 261, 537, 22, "background:#181c20"));
  o.push(A(284, 246, 16, 16, "background:#e0a64a;border-radius:8px"), Tc(292, 254, "SD", "#101216", 7, 20, "font-weight:700"));
  o.push(T(308, 254, "standing-detection engine", "#c3ccd2", 8.8), T(437, 254, ts ? hhmm(ts) : "", "#8f99a8", 8.5));
  o.push(T(309, 272, sd ? sd.summary : c.standing ? "No standing detections" : "Standing detections loading", "#f1f4f5", 9.5));
  if (sd) {
    o.push(I("download", 314, 295, 10, "#3fb27f"), T(323, 295, `Open ${sd.entity_id} at ${sd.lat.toFixed(3)} N, ${sd.lon.toFixed(3)} E`, "#3fb27f", 9.5));
    o.push(T(309, 319, `Rule: ${sd.rule_label}, kind ${sd.kind}, severity ${sd.severity_word}`, "#f1f4f5", 9.5));
  }
  const ev = c.evidence.map((e) => e.props);
  const e1 = ev[0];
  const e2 = ev.length > 3 ? ev[3] : ev[ev.length - 1];
  if (e1) {
    o.push(A(309, 336, 396, 143, "background:#323e4a;border-radius:3px"));
    o.push(I("document", 326, 353, 14, "#5a74d8"), T(344, 352, e1.filename || "evidence", BLUE_T, 10.5), T(344, 370, `By ${e1.captured_by}`, "#8f99a8", 9), T(344, 387, "OSINT", "#f1f4f5", 9.5));
    o.push(A(603, 344, 94, 127, "background:#fff"), T(610, 358, "Evidence", "#222", 8, 400, "font-weight:700"), T(610, 372, (e1.title ?? "").slice(0, 34), "#555", 5.5), A(608, 405, 84, 36, "background:#cfd3d8"));
  }
  if (e2) {
    o.push(A(309, 497, 396, 108, "background:#323e4a;border-radius:3px"));
    o.push(I("send-to-graph", 326, 517, 14, "#e0a64a"), T(348, 517, e2.filename || "capture", BLUE_T, 10.5), T(348, 539, `By ${e2.captured_by}`, "#8f99a8", 9), T(348, 562, "OSINT", "#f1f4f5", 9.5));
    o.push(A(596, 507, 105, 89, "background:#fff"), T(604, 520, e2.capture_method, "#222", 7, 400, "font-weight:700"));
  }
  o.push(A(829, 335, 3, 45, "background:#e5e8eb"));
  o.push(A(287, 621, 533, 36, "background:#0c1014;border:1px solid #3d444c;border-radius:3px"), I("paperclip", 740, 640, 12, "#aab4bc"), I("emoji", 766, 640, 14, "#aab4bc"), I("send-message", 793, 640, 12, "#4c90f0"));
  o.push(
    <input
      className="sl-field"
      aria-label="Message"
      placeholder="Send a message..."
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      style={{ left: 298, top: 633, width: 420, height: 14, fontSize: 10, color: "#f1f4f5" }}
    />,
  );
  o.push(Hit(732, 632, 16, 16, "Attach", undefined, "Attachments go to the evidence locker from Investigate"), Hit(758, 632, 16, 16, "Emoji", undefined, "No chat store exists, so nothing is sent"),
    Hit(785, 632, 16, 16, "Send", undefined, "No chat store exists, so nothing is sent"));
  // shared files
  o.push(A(833, 50, 261, 617, "background:#101216;border-left:1px solid #20262c"));
  o.push(T(845, 68, "Evidence locker", "#f1f4f5", 10.5, 400, "font-weight:600"), T(845, 82, "Standing detections", "#aab4bc", 8.3), I("cross", 1085, 74, 10, "#f1f4f5"));
  o.push(Hit(1077, 66, 16, 16, "Close: the exploration", () => c.go("explorer")));
  o.push(A(834, 97, 260, 1, "background:#20262c"));
  const ys2: [number, number][] = [[128, 168], [177, 268], [281, 320], [329, 368]];
  ev.slice(0, 4).forEach((e, k) => {
    const [y0_, y1_] = ys2[k]!;
    o.push(A(843, y0_, 236, y1_ - y0_, "background:#101216;border:1px solid #3a424a;border-radius:3px"));
    const nm = e.filename || e.source_url || "capture";
    o.push(I("paperclip", 855, y0_ + 18, 12, "#c3ccd2"), T(865, y0_ + 14, nm, BLUE_T, 9, 140, "max-width:150px;overflow:hidden"), T(865, y0_ + 27, `Captured by ${e.captured_by}`, "#aab4bc", 8));
    if (k === 1) o.push(A(1020, y0_ + 4, 54, 85, "background:#fff"));
  });
  if (!ev.length) o.push(T(845, 128, "The evidence locker is empty", "#aab4bc", 9));
  return frag(o);
}
