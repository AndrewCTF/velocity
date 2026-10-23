// Control Panel: features A36-A43, ported from gotham/aip/_build_features_b.py
// (cp_side .. a43) over the AI settings routes: /api/ai/models (engines and
// catalog), /api/ai/local (the Ollama models), /api/ai/hardware (the model the
// hardware probe recommends), /api/ai/guardrails (governance, tools, the one
// principal), /api/ai/calls (calls per model) and /api/status/sources (the
// usage chart: upstream requests per host, since no spend exists locally).
import { useState } from "react";
import { Hit, I, L, R, T, frag, type N } from "./ui.js";
import { useJson, unavailable, type Res } from "./data.js";
import { axis, busiest, catName, nodash, type Call, type CatEntry, type GuardB, type Hardware, type Models, type Src } from "./dataB.js";

export type CpTab = "Overview" | "Access permissions" | "Plugins and tools" | "Users" | "Usage and cost";
interface Row {
  name: string;
  by: string;
  tile: string;
  installed: boolean;
  embed: boolean;
  cat: CatEntry | null;
}
const TILE_ICON: Record<string, string> = { "#d4f0d2": "#38a24e", "#dcd8ee": "#7a5cc8", "#def0f8": "#58a8d4" };
const comma = (n: number): string => n.toLocaleString("en-US");

function cpSide(onConsole: () => void, sel = "Language Models"): N[] {
  const s: N[] = [R(281, 98, 287, 917, "#1a4080")];
  s.push(R(300, 111, 22, 22, "transparent", "#e8eef8", "border-radius:50%;border-width:2px"), T(333, 122, "Velocity Control Panel", 17.5, "#f4f7fc", 600));
  s.push(I("diagram-tree", 311, 176, 18, "#dbe6f6"), T(333, 177, "Local workspace", 15.5, "#e8eef8"), R(520, 163, 29, 27, "#4a6aa0", "", "border-radius:2px"), T(534, 175, "•••", 11, "#fff", 700, "", "", "c"));
  s.push(I("home", 311, 231, 19, "#e8eef8"), T(333, 231, "Home", 15.5, "#e8eef8"), I("search", 311, 268, 19, "#e8eef8"), T(333, 268, "Search...", 15.5, "#e8eef8"), T(549, 268, "⌘J", 13, "#9fb4d4", 400, "", "", "r"));
  s.push(L(282, 296, 567, 296, "#2c5494"));
  const groups: [number, string, string[]][] = [
    [325, "FOUNDATION SETTINGS", ["Authentication", "Ontology", "Action Graph", "Feed Settings", "Resource Manager"]],
    [563, "CONTROL FLOW SETTINGS", ["Model Library", "Hand-off Flows", "Scoped Sessions", "Language Models", "Third Party Applications"]],
  ];
  for (const [y0, title, items] of groups) {
    s.push(T(301, y0, title, 12.5, "#9fb4d4", 600, "letter-spacing:.04em"), I("caret-up", 539, y0, 14, "#9fb4d4"));
    items.forEach((it, i) => {
      const y = y0 + 39 + i * 37;
      if (it === sel) s.push(R(282, y - 19, 286, 37, "#16325e"), R(282, y - 19, 4, 37, "#4c90f0"));
      s.push(T(301, y, it, 15.5, "#e8eef8"));
    });
  }
  s.push(I("manual", 311, 915, 18, "#dbe6f6"), T(333, 915, "View documentation", 15.5, "#e8eef8"), I("arrow-top-right", 311, 952, 18, "#dbe6f6"), T(333, 952, "Open Velocity console", 15.5, "#e8eef8"), I("log-out", 311, 989, 18, "#dbe6f6"), T(333, 989, "Log out", 15.5, "#e8eef8"));
  s.push(Hit(282, 213, 286, 36, "Home: the AIP terminal", onConsole), Hit(282, 934, 286, 36, "Open the Velocity console", onConsole));
  return s;
}
const cpPage = (onConsole: () => void): N[] => [R(568, 98, 1304, 917, "#f2f6fa"), ...cpSide(onConsole)];

function lmRow(y: number, r: Row, onManage: () => void): N[] {
  const s: N[] = [R(786, y, 870, 80, "#fff"), R(804, y + 17, 50, 46, r.tile, "", "border-radius:2px"), I("citation", 829, y + 40, 24, TILE_ICON[r.tile]!)];
  s.push(T(872, y + 29, r.name, 16, "#2a2f33", 600), T(872, y + 52, r.by, 13.5, "#6a7378"));
  const chips: [string, string, string, number][] = [["Self-hosted", "#3a7a48", "#e6f0e6", 82], r.embed ? ["Embeddings only", "#3a5a96", "#e2eefc", 108] : r.installed ? ["Installed", "#3a5a96", "#e2eefc", 70] : ["Not installed", "#4a5358", "#ececec", 94]];
  let cx = 1530 - chips.reduce((a, c) => a + c[3] + 13, 0) + 13;
  for (const [lab, fg, bg, w] of chips) {
    s.push(R(cx, y + 31, w, 20, bg, "", "border-radius:2px"), T(cx + w / 2, y + 41, lab, 13.5, fg, 400, "", "", "c"));
    cx += w + 13;
  }
  s.push(L(1543, y + 24, 1543, y + 56, "#d9dfe2"), T(1596, y + 41, "Manage", 15.5, "#2a2f33", 400, "", "", "c"), Hit(1550, y + 24, 92, 32, `Manage ${r.name}`, onManage));
  return s;
}

function header(): N[] {
  return [R(568, 98, 1304, 92, "#fcfdfe"), L(568, 190, 1872, 190, "#e1e6ea"), T(593, 130, "Language models", 20, "#2a2f33", 700), T(593, 158, "Manage language models used in Velocity.", 15, "#6a7378")];
}

function listPage(rows: Row[], err: string | null, h: { onManage: (i: number) => void; onAdd: () => void }): N[] {
  const s: N[] = [...header(), R(568, 191, 1304, 74, "#fcfdfe"), L(568, 264, 1872, 264, "#e1e6ea")];
  s.push(R(587, 213, 372, 35, "#fff", "#c9d0d5"), I("search", 606, 231, 19, "#4a5358"), T(624, 231, "Filter models...", 15.5, "#7a8388"));
  s.push(T(978, 231, "Managed by", 15.5, "#2a2f33"), I("caret-down", 1087, 231, 14, "#4a5358"), T(1125, 231, "Status", 15.5, "#2a2f33"), I("caret-down", 1191, 231, 14, "#4a5358"));
  s.push(R(1692, 213, 162, 35, "#f4f6f7", "#c9d0d5", "border-radius:2px"), T(1704, 231, "Add new model", 15.5, "#2a2f33"), I("arrow-top-right", 1836, 231, 16, "#2a2f33"), Hit(1692, 213, 162, 35, "Add a model in the model manager (AI hub)", h.onAdd));
  s.push(R(785, 288, 872, Math.max(1, rows.length) * 81, "#fff", "#d9dfe2", "border-radius:2px"));
  if (err) s.push(T(1221, 328, err, 15.5, "#59646a", 400, "", "", "c"));
  rows.forEach((r, i) => {
    s.push(...lmRow(289 + i * 81, r, () => h.onManage(i)));
    if (i) s.push(L(786, 289 + i * 81, 1656, 289 + i * 81, "#e6eaec"));
  });
  return s;
}

function tabsCp(active: CpTab, onTab: (t: CpTab) => void, y = 192): N[] {
  const labs: [CpTab, number, number][] = [["Overview", 664, 70], ["Access permissions", 793, 140], ["Plugins and tools", 951, 126], ["Users", 1059, 42], ["Usage and cost", 1159, 110]];
  const s: N[] = [];
  for (const [lab, cx, w] of labs) {
    s.push(T(cx, y, lab, 15.5, lab === active ? "#3a5aa0" : "#2a2f33", 400, "", "", "c"));
    if (lab === active) s.push(R(cx - w / 2, 213, w, 3, "#3062a4"));
    s.push(Hit(cx - w / 2 - 6, y - 16, w + 12, 32, lab, lab === active ? undefined : () => onTab(lab)));
  }
  return s;
}
function detailHead(name: string, active: CpTab, h: { onBack: () => void; onTab: (t: CpTab) => void }): N[] {
  return [
    R(568, 98, 1304, 118, "#fcfdfe"),
    L(568, 216, 1872, 216, "#e1e6ea"),
    I("arrow-left", 599, 134, 20, "#2a2f33"),
    Hit(585, 120, 28, 28, "Back to language models", h.onBack),
    R(630, 112, 50, 46, "#d4f0d2", "", "border-radius:2px"),
    I("citation", 655, 135, 24, "#38a24e"),
    T(698, 123, <><span style={{ color: "#59646a" }}>Language models</span> {" "}<span style={{ fontSize: 14 }}>›</span>{" "} {name}</>, 18, "#2a2f33", 600),
    T(698, 147, "Manage language model access and usage", 14.5, "#59646a"),
    ...tabsCp(active, h.onTab),
  ];
}

function usageChart(src: Src[], x0: number, y0: number, x1: number, y1: number, big: boolean): N[] {
  const hs = busiest(src);
  if (!hs.length) return [T((x0 + x1) / 2, (y0 + y1) / 2, "No upstream request recorded since boot", 14, "#6a7378", 400, "", "", "c")];
  const { step, top } = axis(Math.max(...hs.map((h) => h.ok + h.fail)));
  const s: N[] = [];
  const bw = (x1 - x0) / hs.length;
  hs.forEach((h, i) => {
    const hok = ((y1 - y0) * h.ok) / top;
    const hf = ((y1 - y0) * h.fail) / top;
    const bx = x0 + i * bw;
    s.push(R(bx, y1 - hok, bw, hok, big ? "#1c78a4" : "#8cc0e8", "#fff"), R(bx, y1 - hok - hf, bw, hf, "#dc8c38", "#fff"));
  });
  s.push(L(x0 - 2, y0 - 8, x0 - 2, y1, "#8a9397"), L(x0 - 2, y1, x1, y1, "#8a9397"));
  for (let v = 0; v <= top; v += step) {
    const yy = y1 - ((y1 - y0) * v) / top;
    s.push(T(x0 - 14, yy, v >= 1000 ? `${+(v / 1000).toPrecision(6)}k` : String(v), 12.5, "#4a5358", 400, "", "", "r"), L(x0 - 6, yy, x0 - 2, yy, "#8a9397"));
  }
  s.push(T(x0 + 30, y1 + 15, nodash(hs[0]!.host), 11.5, "#4a5358", 400, "", "", "c"), T(x1 - 40, y1 + 15, nodash(hs[hs.length - 1]!.host), 11.5, "#4a5358", 400, "", "", "c"));
  return s;
}
const okFail = (src: Src[]): [number, number] => [src.reduce((a, x) => a + x.ok, 0), src.reduce((a, x) => a + x.fail, 0)];

function overview(r: Row, g: GuardB | null, src: Src[], calls: Res<Call[]> | null, hub: () => void): N[] {
  const s: N[] = [R(747, 239, 947, 258, "#fff", "#dfe4e8"), L(1319, 240, 1319, 452, "#dfe4e8"), R(748, 452, 946, 44, "#f4f4f6"), L(748, 452, 1693, 452, "#dfe4e8")];
  const creator = r.cat ? `${r.cat.repo_id.split("/")[0]} (GGUF)` : "Ollama";
  s.push(T(767, 268, "Name", 14.5, "#6a7378"), T(767, 293, r.name, 18, "#2a2f33", 700), T(1043, 268, "Created by", 14.5, "#6a7378"), T(1043, 293, creator, 15.5, "#2a2f33", 600));
  const comps = g?.compartments ?? [];
  s.push(T(767, 339, "Groups", 14.5, "#6a7378"), I("people", 777, 368, 18, "#59646a"), T(799, 368, "local", 15.5, "#2a2f33"), T(767, 425, comps.length ? comps.join(", ") : "n/a: no further groups", 14.5, "#6a7378"));
  s.push(T(1043, 339, "Markings", 14.5, "#6a7378"), R(1043, 357, 144, 23, "#3a3e42", "", "border-radius:12px"), I("shield", 1060, 369, 13, "#fff"), T(1075, 369, "Marking UNCLAS", 12.5, "#fff"));
  s.push(T(1339, 269, "View model", 15, "#6a7378"), R(1465, 252, 209, 35, "#fff", "#c9d0d5", "border-radius:2px"), T(1478, 270, "Open in Model manager", 15, "#2a2f33"), I("arrow-top-right", 1656, 269, 16, "#2a2f33"), Hit(1465, 252, 209, 35, "Open in the model manager (AI hub)", hub));
  s.push(L(1320, 298, 1693, 298, "#dfe4e8"));
  const now = Date.now();
  const mine = (calls?.data ?? []).filter((c) => c.model_id.toLowerCase().includes(r.name.toLowerCase().split(":")[0]!));
  const inDays = (d: number): string => (calls?.ok ? String(mine.filter((c) => now - Date.parse(c.ts) <= d * 86400e3).length) : "n/a");
  const rows: [number, string, string | null][] = [[328, "Status", null], [362, "Calls (7 day)", inDays(7)], [394, "Calls (30 day)", inDays(30)], [426, "Tools", g ? String(g.tools.length) : "n/a"]];
  for (const [y, lab, val] of rows) {
    s.push(T(1339, y, lab, 15.5, "#6a7378"));
    if (val === null) s.push(R(1595, y - 11, 78, 22, "#ececec", "", "border-radius:2px"), T(1634, y, r.installed ? "Installed" : "Not installed", 13, "#4a5358", 400, "", "", "c"));
    else s.push(T(1674, y, val, 15.5, "#2a2f33", 400, "", "", "r"));
  }
  const lab = (t: string): N => <span style={{ color: "#6a7378", fontSize: 12.5 }}>{t}</span>;
  s.push(
    T(767, 475, <>{lab("ID")} {" "}{(r.cat ? r.cat.repo_id.split("/")[1] ?? "" : r.name).slice(0, 22)}</>, 15, "#2a2f33"),
    T(1112, 475, <>{lab("API")} {" "}/api/ai/models</>, 15, "#2a2f33"),
    T(1460, 475, <>{lab("QUANT")} {" "}{r.cat?.recommended_quant ?? "n/a"}</>, 15, "#2a2f33"),
  );
  s.push(R(746, 518, 949, 278, "#fff", "#dfe4e8"), T(766, 543, "Upstream requests since boot, 16 busiest hosts", 15.5, "#2a2f33", 600), I("arrow-right", 1657, 543, 17, "#2a2f33"), T(1636, 543, "Details", 15, "#2a2f33", 400, "", "", "r"), L(747, 567, 1694, 567, "#dfe4e8"));
  s.push(...usageChart(src, 768, 606, 1512, 682, false));
  const [ok, fail] = okFail(src);
  s.push(T(772, 736, "Succeeded", 15, "#6a7378"), T(772, 764, <b style={{ fontSize: 23 }}>{comma(ok)}</b>, 15, "#2a2f33"), T(1233, 736, "Failed", 15, "#6a7378"), T(1233, 764, <b style={{ fontSize: 23 }}>{comma(fail)}</b>, 15, "#2a2f33"));
  for (const [y, c, l] of [[627, "#8cc0e8", "Succeeded"], [650, "#dc8c38", "Failed"]] as const) s.push(R(1561, y - 5, 24, 10, c, "", "border-radius:2px"), T(1594, y, l, 15, "#2a2f33"));
  s.push(R(746, 818, 949, 200, "#fff", "#dfe4e8"), T(766, 845, "Access summary", 15.5, "#2a2f33", 600));
  const acc: [number, string, string, string[], boolean][] = [
    [898, "folder-close", `Read tools (${g?.tools.length ?? 0})`, ["#3a8a56"], false],
    [951, "cube", `Action tools (${g?.action_tools.length ?? 0})`, ["#3a8a56", "#d9c9c9", "#c83a4a"], true],
    [1005, "cog", `Control tools (${g?.control_tools.length ?? 0})`, ["#3a8a56", "#c83a4a"], false],
  ];
  for (const [y, ic, l, dots, sel] of acc) {
    if (sel) s.push(R(748, y - 27, 352, 53, "#e4ecf6"));
    s.push(I(ic, 778, y, 22, sel ? "#2f6fd0" : "#59646a"), T(803, y, l, 15.5, "#2a2f33"), ...dots.map((c, i) => R(993 + 16 * i, y - 4, 7, 7, c, "", "border-radius:50%")), I("chevron-right", 1067, y, 16, "#2a2f33"));
  }
  s.push(L(1101, 872, 1101, 1015, "#dfe4e8"));
  for (const [x, h] of [[1120, "Name"], [1282, "Role"], [1385, "Data access"]] as const) s.push(T(x, 889, h, 12.5, "#4a5358", 600));
  s.push(L(1101, 906, 1693, 906, "#dfe4e8"));
  (g?.action_tools ?? []).slice(0, 3).forEach((nm, i) => {
    const y = 927 + i * 39;
    s.push(I("th", 1128, y, 16, "#3f73d6"), T(1146, y, nm, 15, "#2a2f33", 600), T(1282, y, g?.action_approval ? "Approval" : "Direct", 13, "#2a2f33", 600), I("tick", 1398, y, 16, "#3a8a56"), L(1101, y + 20, 1693, y + 20, "#e6eaec"));
  });
  return s;
}

function usage(src: Src[], g: GuardB | null): N[] {
  const s: N[] = [R(663, 250, 1120, 337, "#fff", "#dfe4e8"), T(683, 274, "Upstream requests since boot, 16 busiest hosts", 15.5, "#2a2f33", 600), L(664, 297, 1782, 297, "#dfe4e8")];
  s.push(...usageChart(src, 731, 340, 1524, 538, true));
  const [ok, fail] = okFail(src);
  s.push(T(1579, 339, "Succeeded", 15, "#6a7378"), T(1579, 366, <b style={{ fontSize: 23 }}>{comma(ok)}</b>, 15, "#2a2f33"), T(1579, 414, "Failed", 15, "#6a7378"), T(1579, 442, <b style={{ fontSize: 23 }}>{comma(fail)}</b>, 15, "#2a2f33"));
  for (const [y, c, l] of [[484, "#1c78a4", "Succeeded"], [507, "#dc8c38", "Failed"]] as const) s.push(R(1573, y - 5, 24, 10, c, "", "border-radius:2px"), T(1606, y, l, 15, "#2a2f33"));
  // A40: the two governance values that exist (no dollar limits do)
  s.push(R(661, 622, 1121, 317, "#fff", "#dfe4e8"), I("lock", 697, 656, 22, "#2a2f33"), T(722, 655, "Set action limits", 18, "#2a2f33", 600), T(722, 683, "Define when the assistant may act without an operator", 15, "#59646a"), L(662, 715, 1781, 715, "#e1e6ea"));
  const th = g?.action_auto_threshold;
  const rows: [number, string, string, string, string][] = [
    [748, "Auto-approval threshold for actions", "Proposed actions scoring at or above this run without an operator.", th === undefined ? "n/a" : th > 1 ? `${th} is above any possible score, so none run unattended.` : `Actions scoring ${th} or more run unattended.`, th === undefined ? "n/a" : String(th)],
    [860, "Operator approval for actions", "Whether a proposed action waits for an operator decision.", `${g?.action_tools.length ?? 0} action tools, ${g?.operator_only_actions.length ?? 0} operator-only.`, g ? (g.action_approval ? "Required" : "Off") : "n/a"],
  ];
  for (const [y, lab, h1, h2, val] of rows)
    s.push(T(685, y, lab, 15.5, "#2a2f33", 600), T(685, y + 26, h1, 15, "#59646a"), T(685, y + 47, h2, 15, "#59646a"), R(1234, y - 18, 523, 35, "#fff", "#c9d0d5"), T(1246, y, val, 15.5, "#2a2f33"));
  s.push(L(662, 827, 1781, 827, "#e1e6ea"));
  return s;
}

function access(g: GuardB | null): N[] {
  const s: N[] = [R(612, 217, 801, 70, "#fff", "#e3e8ea", "border-top:0"), R(656, 217, 18, 18, "#305894", "", "border-radius:2px"), I("tick", 665, 226, 13, "#fff"), I("person", 694, 226, 17, "#59646a"), T(714, 226, "local (operator)", 15.5, "#2a2f33")];
  s.push(R(612, 288, 801, 306, "#fff", "#e3e8ea", "border-top:0"), T(636, 321, "Markings", 17, "#2a2f33", 600), T(636, 346, "Manage which markings the language model will have access to", 15, "#59646a"));
  s.push(R(636, 369, 753, 203, "#fff", "#e3e8ea"), R(649, 380, 727, 34, "#fff", "#c9d0d5", "border-radius:17px"), I("search", 667, 397, 19, "#4a5358"), T(686, 397, "Filter and select marking...", 15.5, "#7a8388"), L(637, 427, 1388, 427, "#e3e8ea"));
  s.push(R(655, 442, 18, 18, "#305894", "", "border-radius:2px"), I("tick", 664, 451, 13, "#fff"), R(684, 439, 120, 24, "#3a3e42", "", "border-radius:12px"), I("shield", 701, 451, 13, "#fff"), T(716, 451, "UNCLAS", 12.5, "#fff"));
  s.push(R(612, 613, 801, 440, "#fff", "#e3e8ea"), T(636, 647, "Advanced settings", 17, "#2a2f33", 600), T(636, 675, "Further limit language model access", 15, "#59646a"), L(613, 706, 1412, 706, "#e3e8ea"));
  s.push(R(636, 731, 370, 55, "#fff", "#d9dfe2", "border-radius:2px"), R(652, 750, 18, 18, "#fff", "#8a9397", "border-radius:50%"), T(683, 759, "Default (group and marking access)", 15.5, "#2a2f33"));
  s.push(R(1019, 731, 370, 55, "#f0f6f8", "#4676da", "border-radius:2px;border-width:2px"), R(1035, 750, 18, 18, "#fff", "#305894", "border-radius:50%;border-width:2px"), R(1040, 755, 8, 8, "#305894", "", "border-radius:50%"), T(1066, 759, "Allowlist", 15.5, "#2a5aa8"));
  s.push(R(636, 797, 753, 200, "#fff", "#e3e8ea"), T(660, 827, "Allowlisted resources", 15.5, "#2a2f33", 600), R(1291, 809, 79, 35, "#fff", "#c9d0d5", "border-radius:2px"), I("add", 1310, 827, 17, "#2a2f33"), T(1342, 827, "Add", 15.5, "#2a2f33", 400, "", "", "c"), L(637, 856, 1388, 856, "#e3e8ea"));
  if (g?.action_tools[0]) s.push(I("th", 670, 892, 17, "#59646a"), T(689, 892, `${g.action_tools[0]} (action tool)`, 15.5, "#2a2f33"), I("edit", 1309, 891, 16, "#2a2f33"), T(1342, 892, "Edit", 15.5, "#2a2f33", 400, "", "", "c"), L(637, 927, 1388, 927, "#e3e8ea"));
  if (g?.operator_only_actions[0]) s.push(I("th", 670, 962, 17, "#d98a2c"), T(689, 962, `${g.operator_only_actions[0]} (operator only)`, 15.5, "#2a2f33"), I("edit", 1309, 962, 16, "#2a2f33"), T(1342, 962, "Edit", 15.5, "#2a2f33", 400, "", "", "c"));
  s.push(R(1469, 239, 392, 730, "#fff", "#dfe4e8"), T(1488, 267, "Access summary", 15.5, "#2a2f33", 600), L(1470, 293, 1860, 293, "#dfe4e8"));
  const rows: [number, string, string, [string, number][]][] = [
    [327, "folder-close", `Read tools (${g?.tools.length ?? 0})`, [["#3a8a56", 1780]]],
    [369, "cube", `Action tools (${g?.action_tools.length ?? 0})`, [["#3a8a56", 1753], ["#d0d0d0", 1770], ["#c83a4a", 1784]]],
    [410, "cog", `Control tools (${g?.control_tools.length ?? 0})`, [["#3a8a56", 1769], ["#c83a4a", 1784]]],
  ];
  if (g?.citations_required) rows.push([452, "document", "Citations required", [["#3a8a56", 1784]]]);
  for (const [y, ic, lab, dots] of rows)
    s.push(I(ic, 1500, y, 22, y === 369 || y === 410 ? "#2f6fd0" : "#59646a"), T(1525, y, lab, 15.5, "#2a2f33"), ...dots.map(([c, x]) => R(x - 3, y - 3, 7, 7, c, "", "border-radius:50%")), I("chevron-right", 1827, y, 16, "#2a2f33"));
  s.push(I("info-sign", 1497, 502, 17, "#59646a"), T(1516, 497, "Information displayed is dependent on your access", 13.5, "#2a2f33"), T(1516, 513, "level.", 13.5, "#2a2f33"));
  return s;
}

function plugins(m: Models | null, g: GuardB | null, ollamaUp: boolean | null, hub: () => void): N[] {
  const s: N[] = [R(786, 238, 870, 383, "#fff", "#dfe4e8"), T(811, 272, "Engines", 18, "#2a2f33", 600), T(811, 299, "Manage inference engines this language model can run on", 15, "#59646a"), R(1552, 261, 78, 35, "#fff", "#c9d0d5", "border-radius:2px"), I("add", 1570, 278, 17, "#2a2f33"), T(1602, 278, "Add", 15.5, "#2a2f33", 400, "", "", "c"), L(787, 331, 1655, 331, "#dfe4e8")];
  s.push(Hit(1552, 261, 78, 35, "Add an engine in the model manager (AI hub)", hub));
  const e = m?.engines;
  const chipOf = (inst: boolean, run: boolean): [string, string, string, number] =>
    run ? ["Running", "#3a5aa0", "#e6eef8", 78] : inst ? ["Installed, idle", "#8a5a1a", "#f4ece2", 112] : ["Not installed", "#9a2a30", "#f8e6e6", 98];
  const rows: [string, string, [string, string, string, number], boolean][] = e
    ? [
        ["llama.cpp", e.llamacpp.version ? e.llamacpp.version.split("(")[0]!.replace("version:", "Build").trim() : e.llamacpp.installed ? "Installed" : "Not installed", chipOf(e.llamacpp.installed, e.llamacpp.running), false],
        ["vLLM", e.vllm.version ?? (e.vllm.installed ? "Installed" : "Not installed"), chipOf(e.vllm.installed, e.vllm.running), false],
        ["Ollama", ollamaUp ? "Serving embeddings" : "Not answering", chipOf(e.ollama.installed, e.ollama.running), true],
      ]
    : [];
  if (!e) s.push(T(1221, 400, unavailable("Engines", null), 15, "#59646a", 400, "", "", "c"));
  rows.forEach(([nm, sub, [chp, fg, bg, w], db], i) => {
    const y = 355 + i * 81;
    s.push(R(810, y, 822, 81, "#fff", "#e3e8ea"), R(829, y + 18, 50, 45, "#f0ecfa", "", "border-radius:2px"), I(db ? "database" : "desktop", 854, y + 40, 24, "#7a5cc8"));
    s.push(T(897, y + 29, nm, 15.5, "#2a2f33", 600), T(897, y + 52, sub, 13.5, "#6a7378"), R(1312 - w + 6, y + 31, w, 22, bg, "", "border-radius:2px"), T(1312 - w / 2 + 6, y + 42, chp, 13, fg, 400, "", "", "c"));
    s.push(T(1401, y + 41, "View status", 15.5, "#2a2f33"), I("arrow-top-right", 1487, y + 41, 16, "#2a2f33"), L(1517, y + 24, 1517, y + 58, "#d9dfe2"), T(1571, y + 41, "Manage", 15.5, "#2a2f33", 400, "", "", "c"));
    s.push(Hit(1390, y + 24, 110, 34, `${nm} status in the AI hub`, hub), Hit(1524, y + 24, 94, 34, `Manage ${nm} in the AI hub`, hub));
  });
  s.push(R(786, 645, 870, 255, "#fff", "#dfe4e8"), T(811, 679, "Tools", 18, "#2a2f33", 600), T(811, 706, "Configure the tools that this model can interact with in Velocity.", 15, "#59646a"), L(787, 738, 1655, 738, "#dfe4e8"));
  const tools: [number, string, string, string, string, string, number][] = [
    [780, "build", "Actions", g?.action_approval ? "Approval required" : "No approval", "#f4ece2", "#8a5a1a", 124],
    [861, "function", `Read tools (${g?.tools.length ?? 0})`, g?.citations_required ? "Citations required" : "No citations", "#f8e6e6", "#9a2a30", 124],
  ];
  for (const [y, ic, lab, chp, bg, fg, w] of tools)
    s.push(R(810, y - 24, 50, 48, "#f4f4f6", "", "border-radius:2px"), I(ic, 835, y, 24, "#59646a"), T(872, y, lab, 15.5, "#2a2f33"), R(1524 - w, y - 11, w, 22, bg, "", "border-radius:2px"), T(1524 - w / 2, y, chp, 13, fg, 400, "", "", "c"), L(1536, y - 17, 1536, y + 17, "#d9dfe2"), T(1590, y, "Manage", 15.5, "#2a2f33", 400, "", "", "c"));
  s.push(L(787, 819, 1655, 819, "#e6eaec"));
  return s;
}

function users(g: GuardB | null): N[] {
  return [
    R(786, 238, 870, 470, "#fff", "#dfe4e8"),
    T(811, 272, "User access", 18, "#2a2f33", 600),
    T(811, 299, "Manage which principals will have access to this language model", 15, "#59646a"),
    L(787, 331, 1655, 331, "#dfe4e8"),
    R(811, 356, 820, 328, "#fff", "#e3e8ea"),
    R(823, 367, 795, 35, "#fff", "#c9d0d5", "border-radius:17px"),
    I("search", 841, 384, 19, "#4a5358"),
    T(860, 384, "Filter and select principal...", 15.5, "#7a8388"),
    L(812, 414, 1630, 414, "#e3e8ea"),
    R(829, 428, 19, 19, "#305894", "", "border-radius:2px"),
    I("tick", 838, 437, 13, "#fff"),
    I("person", 869, 438, 18, "#59646a"),
    T(889, 438, <>local <span style={{ color: "#6a7378", fontSize: 13.5 }}>(clearance {g?.clearance ?? "n/a"}, compartments: {g?.compartments.length ? g.compartments.join(", ") : "none"})</span></>, 15.5, "#2a2f33"),
  ];
}

export function ControlPanel({ onConsole, onHub }: { onConsole: () => void; onHub: () => void }): JSX.Element {
  const models = useJson<Models>("/api/ai/models");
  const local = useJson<{ models: string[]; ollama_up: boolean }>("/api/ai/local");
  const hw = useJson<Hardware>("/api/ai/hardware");
  const guard = useJson<GuardB>("/api/ai/guardrails");
  const src = useJson<{ sources: Src[] }>("/api/status/sources");
  const calls = useJson<Call[]>("/api/ai/calls?limit=500");
  const [open, setOpen] = useState<number | null>(null);
  const [tab, setTab] = useState<CpTab>("Overview");
  const cat = models?.data?.catalog ?? [];
  const rec = cat.find((c) => c.repo_id === hw?.data?.recommendation.repo_id) ?? null;
  const speed = cat.find((c) => c.tier === "30b") ?? null;
  const installed = new Set((models?.data?.installed ?? []).map((x) => JSON.stringify(x)));
  const rows: Row[] = [];
  const om = local?.data?.models[0];
  if (om) rows.push({ name: om, by: "Ollama, size not reported by /api/ai/local", tile: "#d4f0d2", installed: true, embed: om.includes("embed"), cat: null });
  for (const [c, tile] of [[rec, "#dcd8ee"], [speed, "#def0f8"]] as const)
    if (c && !rows.some((r) => r.cat === c))
      rows.push({ name: catName(c), by: `Catalog entry, ${c.license}, ${c.quants[0]?.size_gb ?? "n/a"} GB (${c.recommended_quant})`, tile, installed: [...installed].some((x) => x.includes(c.repo_id)), embed: false, cat: c });
  const err = !models?.ok || !local?.ok ? unavailable("Model list", !models?.ok ? models : local) : null;
  const g = guard?.data ?? null;
  const s: N[] = cpPage(onConsole);
  const row = open === null ? null : rows[open] ?? null;
  if (!row) s.push(...listPage(rows, rows.length ? null : err, { onManage: (i) => { setOpen(i); setTab("Overview"); }, onAdd: onHub }));
  else {
    s.push(...detailHead(row.name, tab, { onBack: () => setOpen(null), onTab: setTab }));
    const sources = src?.data?.sources ?? [];
    if (tab === "Overview") s.push(...overview(row, g, sources, calls, onHub));
    else if (tab === "Usage and cost") s.push(...usage(sources, g));
    else if (tab === "Access permissions") s.push(...access(g));
    else if (tab === "Plugins and tools") s.push(...plugins(models?.data ?? null, g, local?.data?.ollama_up ?? null, onHub));
    else s.push(...users(g));
    if (!src?.ok && (tab === "Overview" || tab === "Usage and cost")) s.push(T(1221, 230, unavailable("Upstream sources", src), 13, "#9a2a30", 400, "", "", "c"));
  }
  return frag(s);
}
