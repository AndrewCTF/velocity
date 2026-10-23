// Foundry resource workspace: features A22-A28, ported from
// gotham/aip/_build_features_a.py (rail44 .. a28). A real transform stands in
// for the modeling objective (Velocity has none); the evaluation dashboard
// states that no labelled evaluation set exists and reads every metric n/a
// except Row Count, the build's real rows_out.
import { useState, type WheelEvent } from "react";
import { apiFetch } from "../../../transport/http.js";
import { useAppView } from "../../../state/appView.js";
import { CLIP, Hit, I, L, R, T, frag, type N } from "./ui.js";
import { railHits, type FoundryNav } from "./Lineage.js";
import {
  tsFmt,
  unavailable,
  useJson,
  type Binding,
  type Build,
  type Check,
  type Dataset,
  type Transform,
} from "./data.js";

function rail44(nav: (v: FoundryNav) => void): N[] {
  const s: N[] = [R(282, 98, 44, 916, "#1e2224")];
  const items: [number, string][] = [
    [121, "menu-open"], [179, "home"], [212, "search"], [245, "notifications"], [306, "history"], [340, "folder-open"],
    [406, "search-template"], [448, "build"], [491, "th"], [531, "folder-shared"], [842, "globe-network"], [875, "random"], [923, "help"],
  ];
  for (const [y, ic] of items) s.push(I(ic, 301, y, 17, y === 406 || y === 448 ? "#b9a8ff" : "#cfd5d8"));
  s.push(
    R(297, 240, 7, 7, "#e98a2c", "", "border-radius:50%"),
    T(301, 958, "AM", 12, "#cfd5d8", 400, "", "", "c"),
    I("share", 301, 993, 15, "#cfd5d8"),
  );
  // th (491) is this rail's applications slot; folder-shared (531) opens lineage
  s.push(...railHits(nav, "transforms", { home: 179, build: 448, apps: 491, lineage: 531 }, 282, 44));
  return s;
}

function resHeader(name: string): N[] {
  return [
    R(326, 98, 1546, 48, "#fff"),
    L(326, 146, 1872, 146, "#e1e6e8"),
    R(326, 98, 49, 48, "#efe8fa"),
    I("data-lineage", 351, 122, 22, "#7a4fd0"),
    I("th-list", 395, 110, 14, "#4a5358"),
    T(409, 111, "Velocity Fou...", 14.5, "#4a5358"),
    T(504, 111, "›", 14, "#4a5358"),
    T(521, 111, "•••", 14, "#4a5358"),
    T(548, 111, "›", 14, "#4a5358"),
    T(562, 111, name, 16, "#2a2f33", 700),
    I("star-empty", 768, 111, 15, "#6a7378"),
    T(386, 132, "File ▾", 12, "#4a5358"),
    T(420, 132, "Help ▾", 12, "#4a5358"),
    L(467, 125, 467, 139, "#ccd"),
    I("office", 481, 132, 13, "#4a5358"),
    T(491, 132, "1", 12, "#4a5358"),
    R(1448, 105, 220, 32, "#f0f6f8", "#d5dce0", "border-radius:2px"),
    I("help", 1466, 121, 17, "#2a2f33"),
    T(1481, 121, "Get started with transforms", 14.5, "#2a2f33"),
    T(1656, 121, "Actions", 14.5, "#2a2f33"),
    I("caret-down", 1713, 121, 12, "#4a5358"),
    I("people", 1769, 121, 16, "#4a5358"),
    T(1782, 121, "Share", 14.5, "#2a2f33"),
    I("panel-stats", 1848, 121, 18, "#4a5358"),
  ];
}

interface Ctx {
  tf: Transform;
  tin: Dataset | undefined;
  tout: Dataset | undefined;
  tfBuilds: Build[];
  builds: Build[];
  checks: Check[] | null;
  ds: Map<string, Dataset>;
  boundKinds: string[];
}

const nm = (d: Dataset | undefined, id: string): string => d?.name ?? id;

function objRightPanel(c: Ctx, onLineage: (id?: string) => void): N[] {
  const s: N[] = [R(1588, 146, 284, 868, "#fff", "", "border-left:1px solid #e1e6e8")];
  s.push(I("menu-open", 1617, 166, 16, "#2a2f33"), T(1633, 166, "Transform details", 14, "#2a2f33", 700), L(1589, 187, 1871, 187, "#e1e6e8"));
  s.push(R(1603, 207, 265, 30, "#fff", "#d5dce0", "border-radius:2px"), I("cog", 1654, 222, 16, "#2a2f33"), T(1668, 222, "Transform settings", 13.5, "#2a2f33"));
  s.push(L(1589, 258, 1871, 258, "#e1e6e8"), I("chevron-down", 1613, 288, 16, "#2a2f33"), T(1628, 288, "Transform API", 16, "#2a2f33"));
  const inId = c.tf.inputs[0] ?? "";
  s.push(T(1603, 322, `Inputs (Showing 1 of ${c.tf.inputs.length})`, 12.5, "#4a5358"));
  s.push(
    R(1603, 341, 265, 54, "#fff", "#d5dce0"),
    T(1617, 359, `${nm(c.tin, inId)} · dataset`, 12.5, "#4a5358"),
    I("arrow-right", 1634, 377, 14, "#2a2f33"),
    R(1652, 369, 15, 15, "#e8b930", "", "border-radius:2px"),
    T(1675, 378, `${c.tin?.row_count ?? "n/a"} rows`, 12.5, "#2a2f33"),
  );
  s.push(T(1603, 423, "Outputs (Showing 1 of 1)", 12.5, "#4a5358"));
  s.push(
    R(1603, 442, 265, 54, "#fff", "#d5dce0"),
    T(1617, 461, `${nm(c.tout, c.tf.output_dataset_id)} · dataset`, 12.5, "#4a5358"),
    I("arrow-right", 1634, 479, 14, "#2a2f33"),
    R(1652, 471, 15, 15, "#e8b930", "", "border-radius:2px"),
    T(1675, 480, `${c.tout?.row_count ?? "n/a"} rows`, 12.5, "#2a2f33"),
  );
  s.push(L(1589, 622, 1871, 622, "#e1e6e8"), I("chevron-down", 1613, 653, 16, "#2a2f33"), T(1628, 654, "Input datasets", 16, "#2a2f33"));
  const dsl: [string, Dataset | undefined][] = [[inId, c.tin], [c.tf.output_dataset_id, c.tout]];
  dsl.forEach(([id, d], i) => {
    const y = [689, 724][i]!;
    s.push(I("th", 1611, y, 14, "#4a7fc8"), T(1625, y, nm(d, id), 13.5, "#2f6fd0"), T(1625, y + 17, `foundry://${id}`, 10.5, "#6a7378"));
    s.push(Hit(1603, y - 10, 250, 32, `Preview ${nm(d, id)} in the lineage`, () => onLineage(id)));
  });
  s.push(L(1589, 833, 1871, 833, "#e1e6e8"), I("chevron-down", 1613, 865, 16, "#2a2f33"), T(1628, 865, "Lineage", 16, "#2a2f33"));
  s.push(I("data-lineage", 1611, 900, 14, "#4a5358"), T(1625, 900, "Master Lineage + builds", 13.5, "#2f6fd0"), T(1625, 917, "/Velocity Foundry/lineage", 10.5, "#6a7378"));
  s.push(Hit(1603, 890, 250, 34, "Open the master lineage", () => onLineage()));
  s.push(L(1589, 940, 1871, 940, "#e1e6e8"), I("chevron-down", 1613, 971, 16, "#2a2f33"), T(1628, 971, "Linked ontology kinds", 16, "#2a2f33"));
  if (c.boundKinds.length)
    c.boundKinds.slice(0, 1).forEach((k) => s.push(I("cube", 1611, 1005, 14, "#4a7fc8"), T(1625, 1005, k, 13.5, "#2f6fd0")));
  else s.push(T(1611, 1005, "none bound", 13.5, "#6a7378"));
  return s;
}

function objPage(c: Ctx, dy: number, h: { onRun?: (() => void) | undefined; runMsg: string; onAll: () => void }): N[] {
  const Y = (y: number): number => y + dy;
  const s: N[] = [R(326, 146, 1262, 868, "#f2f6f6")];
  s.push(R(426, Y(207), 30, 26, "#efe8fa"), I("data-lineage", 441, Y(220), 19, "#7a4fd0"), T(471, Y(219), c.tf.name, 28, "#2a2f33", 700));
  s.push(T(425, Y(261), "Summary", 16, "#2a2f33", 700), I("edit", 1474, Y(265), 17, "#2a2f33"));
  s.push(T(425, Y(291), `Reads ${nm(c.tin, c.tf.inputs[0] ?? "")} and writes ${nm(c.tout, c.tf.output_dataset_id)} in ${c.tf.steps.length} steps.`, 15.5, "#2a2f33"));
  s.push(T(425, Y(342), "Description", 16, "#2a2f33", 700));
  const steps = c.tf.steps.map((st) => `${st.type}(${st.expr || st.column})`).join(", ");
  s.push(T(425, Y(371), `Steps: ${steps}`, 14.5, "#2a2f33"), T(425, Y(394), "See more", 14, "#2a2f33", 400, "text-decoration:underline"));
  s.push(L(326, Y(433), 1588, Y(433), "#e1e6e8"));
  s.push(I("git-merge", 435, Y(479), 22, "#2a2f33"), T(457, Y(479), `Builds (${c.tfBuilds.length})`, 22, "#2a2f33", 600));
  s.push(
    R(1382, Y(463), 107, 32, "#fff", "#8fb0dc", "border-radius:2px"),
    I("add", 1401, Y(479), 16, "#2f6fd0"),
    T(1415, Y(479), "Run build", 13.5, "#2f6fd0"),
  );
  if (h.runMsg) s.push(T(1370, Y(479), h.runMsg, 12.5, "#6a7378", 400, "", "", "r"));
  s.push(R(424, Y(510), 1065, 272, "#fff", "#d9dfe2"));
  for (const [x, hd] of [[440, "BUILD"], [767, "DATE STARTED"], [947, "SCOPE"], [1084, "CHECKS"], [1204, "STATUS"], [1300, "ROWS OUT"]] as const)
    s.push(T(x, Y(527), hd, 10.5, "#4a5358", 700, "letter-spacing:.02em"));
  s.push(I("info-sign", 1137, Y(526), 13, "#4a5358"), L(425, Y(542), 1488, Y(542), "#e1e6e8"));
  const rows = c.tfBuilds.slice(0, 5);
  rows.forEach((b, i) => {
    const yy = Y(563 + i * 42);
    s.push(I("git-merge", 447, yy, 15, "#7a4fd0"), T(460, yy, b.id, 13.2, "#2a2f33"), T(767, yy, tsFmt(b.started_at), 12.5, "#2a2f33"));
    s.push(T(947, yy, b.scope + (b.transform_id === null ? " (all transforms)" : ""), 12.5, "#6a7378"));
    s.push(T(1084, yy, "No checks yet", 11.5, "#6a7378"));
    s.push(
      b.status === "succeeded" ? I("tick-circle", 1212, yy, 17, "#2e8a4a") : b.status === "failed" ? I("error", 1212, yy, 17, "#c62828") : I("time", 1212, yy, 17, "#8a9397"),
      T(1300, yy, String(b.rows_out), 12, "#2a2f33"),
    );
    s.push(T(1434, yy, "•••", 15, "#2a2f33", 700, "", "", "c"));
    if (i < rows.length - 1) s.push(L(425, yy + 21, 1488, yy + 21, "#eef1f3"));
  });
  s.push(T(439, Y(766), "View all builds", 13.5, "#2a2f33"));
  s.push(I("timeline-bar-chart", 435, Y(845), 22, "#2a2f33"), T(457, Y(845), "Checks", 22, "#2a2f33", 600), R(566, Y(836), 38, 17, "#30c6a0", "", "border-radius:9px"), T(585, Y(845), "NEW", 9.5, "#fff", 700, "", "", "c"));
  s.push(R(424, Y(876), 1065, 160, "#fff", "#d9dfe2"), R(1153, Y(877), 335, 158, "#eaf1f8"));
  s.push(T(454, Y(915), "Datasets are checked using the following:", 13, "#2a2f33"));
  const ck = c.checks;
  const c0 = ck?.[0];
  const lines: [string, N][] =
    ck === null
      ? [["0", unavailable("Checks", null)], ["0", "dataset (n/a)"], ["0", "evaluation libraries (no labelled evaluation set on this box)"]]
      : [
          [
            String(ck.length),
            c0 ? (
              <>
                check (<span style={{ color: "#2f6fd0" }}>{c0.name}</span>: {c0.type} on {c0.params.column}, max age {c0.params.max_age_s} s)
              </>
            ) : (
              "checks (none)"
            ),
          ],
          [
            c0 ? "1" : "0",
            c0 ? (
              <>
                dataset (<span style={{ color: "#2f6fd0" }}>{nm(c.ds.get(c0.dataset_id), c0.dataset_id)}</span>)
              </>
            ) : (
              "dataset (n/a)"
            ),
          ],
          ["0", "evaluation libraries (no labelled evaluation set on this box)"],
        ];
  lines.forEach(([n, t], i) => {
    const yy = Y(949 + i * 30);
    s.push(R(459, yy - 9, 17, 17, "#eef1f3", "", "border-radius:2px"), T(467, yy, n, 10, "#4a5358", 400, "", "", "c"), T(484, yy, t, 13.5, "#2a2f33"));
  });
  s.push(R(1200, Y(944), 242, 42, "#fff", "#8fb0dc", "border-radius:2px"), T(1220, Y(965), "View check results", 15.5, "#2f6fd0"), I("arrow-right", 1415, Y(965), 16, "#2f6fd0"));
  s.push(I("tag", 435, Y(1119), 21, "#2a2f33"), T(457, Y(1119), "Versions", 22, "#2a2f33", 600));
  s.push(R(424, Y(1150), 1065, 190, "#fff", "#d9dfe2"), R(1153, Y(1151), 335, 188, "#eaf1f8"));
  s.push(T(454, Y(1189), "Latest version", 13, "#2a2f33"), I("help", 593, Y(1189), 14, "#6a7378"));
  const outName = nm(c.tout, c.tf.output_dataset_id);
  const ver = c.tout ? `v${c.tout.latest_version}` : "n/a";
  s.push(R(454, Y(1208), 245, 120, "#fff", "#d9dfe2"), I("tag", 471, Y(1229), 14, "#2a2f33"), R(486, Y(1219), 62, 19, "#eef1f3"), T(493, Y(1229), ver, 11, "#2a2f33"));
  s.push(I("th", 471, Y(1267), 14, "#4a7fc8"), T(488, Y(1267), outName, 13, "#2a2f33"));
  s.push(R(768, Y(1260), 42, 42, "#f1f4f7", "#d9dfe2", "border-radius:50%"), I("arrow-right", 789, Y(1281), 18, "#2f6fd0"));
  s.push(T(880, Y(1189), "Previous version", 13, "#2a2f33"), R(879, Y(1208), 245, 120, "#fff", "#d9dfe2"), I("tag", 1001, Y(1268), 40, "#d9dfe2"));
  s.push(T(1184, Y(1189), "PUBLISH A VERSION", 12, "#2a2f33", 700), R(1184, Y(1208), 275, 60, "#fff", "#d9dfe2", "border-radius:2px"));
  s.push(I("th", 1202, Y(1227), 14, "#4a7fc8"), T(1217, Y(1227), `${outName} ${ver}`, 12.5, "#2a2f33"));
  s.push(T(1196, Y(1250), c.tfBuilds[0] ? `Built ${tsFmt(c.tfBuilds[0].started_at, false)}` : "Never built", 11.5, "#4a5358"));
  s.push(
    Hit(1382, Y(463), 107, 32, "Run build", h.onRun, "Building"),
    Hit(430, Y(752), 110, 28, "View all builds", h.onAll),
  );
  return [CLIP(326, 146, 1262, 868, s)];
}

function catalogue(tfs: Transform[], c: { ds: Map<string, Dataset>; builds: Build[]; bindings: number; tfName: string }, onOpen: (id: string) => void, setApp: (a: "models" | "foundry" | "workflows") => void): N[] {
  const s: N[] = [R(282, 98, 1590, 916, "#fff")];
  s.push(T(385, 126, "Manage Transforms, Models, and Flows", 28, "#2a2f33", 700));
  s.push(T(385, 160, "Explore and manage the lifecycle of transforms, builds and local language models per task.", 14, "#2a2f33"));
  const links: [number, string, string, () => void][] = [
    [188, "edit", "Define Transforms", () => setApp("foundry")],
    [211, "upload", "Manage Installed Models", () => setApp("models")],
    [234, "desktop", "Deploy To Workflows And Monitors", () => setApp("workflows")],
  ];
  for (const [y, ic, t, fn] of links) s.push(I(ic, 393, y, 14, "#4a5358"), T(406, y, t, 13, "#2f6fd0", 400, "text-decoration:underline"), Hit(386, y - 10, t.length * 7 + 26, 20, t, fn));
  s.push(R(385, 273, 214, 40, "#287644", "", "border-radius:2px"), I("add", 408, 293, 17, "#fff"), T(426, 293, "New transform", 15.5, "#fff"));
  s.push(Hit(385, 273, 214, 40, "New transform", () => setApp("foundry")));
  s.push(R(327, 342, 1545, 672, "#f4f6f7"), R(327, 343, 244, 671, "#f4f6f7"), R(574, 427, 1294, 587, "#fff"), L(572, 343, 572, 1014, "#e1e6e8"));
  s.push(T(341, 367, "TRANSFORMS", 10.5, "#4a5358", 700), R(341, 380, 216, 29, "#fff", "#c9d0d5"), T(351, 395, "Search by transform name", 12.5, "#4a5358"));
  s.push(T(341, 438, "SCOPES", 10.5, "#4a5358", 700), R(341, 451, 216, 105, "#fff", "#c9d0d5"));
  const tf = tfs.find((t) => t.name === c.tfName);
  const nTfB = tf ? c.builds.filter((b) => b.transform_id === tf.id).length : 0;
  const nPipe = c.builds.filter((b) => b.scope === "pipeline").length;
  [`transform (${nTfB} builds of this transform)`, `pipeline (${nPipe} builds)`, `ontology binding (${c.bindings})`].forEach((t, i) =>
    s.push(R(347, 457 + i * 25, 205, 21, "#3a4248", "", "border-radius:2px"), T(358, 468 + i * 25, t.slice(0, 30), 10.5, "#fff"), I("cross", 541, 468 + i * 25, 9, "#fff")),
  );
  s.push(T(341, 584, "FILTERS", 10.5, "#4a5358", 700), T(341, 604, "Input", 11, "#2a2f33", 700));
  s.push(R(341, 616, 216, 30, "#fff", "#c9d0d5"), T(351, 631, "Select dataset", 12.5, "#4a5358"), I("caret-down", 540, 631, 12, "#2a2f33"));
  s.push(T(341, 673, "Output", 11, "#2a2f33", 700), R(341, 685, 216, 30, "#fff", "#c9d0d5"), T(351, 700, "Select dataset", 12.5, "#4a5358"), I("caret-down", 540, 700, 12, "#2a2f33"));
  s.push(T(341, 742, "Status", 11, "#2a2f33", 700));
  for (const [y, lab, desc, bg] of [
    [763, "Never built", "Transforms with no build yet", "#eef1f3"],
    [830, "Failed", "Transforms whose last build failed", "#fbe3e3"],
    [895, "Succeeded", "Transforms whose last build succeeded", "#e2ece4"],
  ] as const)
    s.push(R(341, y - 8, 15, 15, "#fff", "#8a9397", "border-radius:2px"), R(367, y - 9, lab.length * 7 + 14, 17, bg, "", "border-radius:2px"), T(374, y, lab, 10.5, "#2a2f33"), T(366, y + 24, desc, 10.5, "#4a5358"));
  s.push(T(583, 369, "Transforms", 17, "#2a2f33", 700), R(739, 360, 18, 19, "#e8ebed", "", "border-radius:2px"), T(748, 370, String(tfs.length), 10, "#4a5358", 400, "", "", "c"));
  for (const [x, hd] of [[583, "NAME"], [919, "INPUTS"], [1126, "OUTPUTS"], [1333, "STEPS"], [1527, "LAST BUILT"], [1760, "STATUS"]] as const) s.push(T(x, 409, hd, 10, "#4a5358", 700));
  tfs.forEach((t, i) => {
    const y = 458 + i * 65;
    s.push(L(574, y + 33, 1868, y + 33, "#e1e6e8"));
    s.push(T(583, y - 10, t.name, 13.5, "#2a2f33", 700), I("th-list", 591, y + 9, 11, "#4a5358"), T(602, y + 9, `Velocity Foundry · transform · ${t.id}`, 10.5, "#4a5358"));
    for (const [x, did] of [[919, t.inputs[0] ?? ""], [1126, t.output_dataset_id]] as const) {
      const d = c.ds.get(did);
      s.push(R(x, y - 17, 16, 16, "#2f6fd0", "", "border-radius:2px"), I("th", x + 8, y - 9, 10, "#fff"), T(x + 22, y - 9, nm(d, did).slice(0, 24), 13, "#2a2f33"), T(x, y + 10, `${d?.schema.length ?? "n/a"} properties`, 10.5, "#4a5358"));
    }
    s.push(T(1333, y - 9, t.steps.map((st) => st.type).join(", "), 13, "#2a2f33"), T(1333, y + 10, `${t.steps.length} steps`, 10.5, "#4a5358"));
    const bs = c.builds.filter((b) => b.transform_id === t.id);
    if (bs[0])
      s.push(
        T(1527, y, "Built " + tsFmt(bs[0].started_at), 12.5, "#2a2f33"),
        R(1762, y - 8, 56, 17, bs[0].status === "failed" ? "#fbe3e3" : "#e2ece4", "", "border-radius:2px"),
        T(1790, y + 1, bs[0].status === "succeeded" ? "Succeeded" : bs[0].status, 9.5, bs[0].status === "failed" ? "#a02830" : "#2e7d4a", 400, "", "", "c"),
      );
    else s.push(T(1527, y, "Never built", 12.5, "#6a7378"));
    s.push(Hit(575, y - 30, 1292, 62, `Open ${t.name}`, () => onOpen(t.id)));
  });
  return s;
}

function evalHead(c: Ctx, onBack: () => void, onHome: () => void): N[] {
  return [
    R(326, 147, 1546, 59, "#fff"),
    L(326, 206, 1872, 206, "#e1e6e8"),
    R(342, 161, 29, 29, "#fff", "#c9d0d5", "border-radius:2px"),
    I("arrow-left", 356, 176, 16, "#2a2f33"),
    I("home", 389, 176, 16, "#2a2f33"),
    T(401, 177, "Home", 14, "#2a2f33"),
    T(455, 177, "›", 14, "#4a5358"),
    I("timeline-bar-chart", 484, 177, 16, "#2a2f33"),
    T(498, 177, "Build comparison", 14, "#2a2f33", 700),
    Hit(342, 161, 29, 29, `Back to ${c.tf.name}`, onBack),
    Hit(380, 163, 60, 28, "Home: manage transforms", onHome),
  ];
}

const PAIR = ["#264eb2", "#30a230"];

function a27(c: Ctx, sel: Build[], picker: boolean, h: { onToggle: (b: Build) => void; onPicker: () => void; onClear: () => void; onRun?: (() => void) | undefined }): N[] {
  const s: N[] = [];
  const ok = c.builds.filter((b) => b.status === "succeeded").length;
  const fail = c.builds.filter((b) => b.status === "failed").length;
  s.push(
    R(1412, 161, 128, 30, "#eef1f3", "#dde2e5"),
    I("refresh", 1428, 176, 13, "#8a9397"),
    T(1440, 177, String(c.builds.length - ok - fail), 10, "#6a7378"),
    I("tick", 1470, 176, 12, "#2e8a4a"),
    T(1484, 177, String(ok), 10, "#2e8a4a"),
    I("cross", 1507, 176, 11, "#c62828"),
    T(1520, 177, String(fail), 10, "#c62828"),
  );
  s.push(R(1550, 161, 136, 30, "#fff", "#c9d0d5", "border-radius:2px"), I("build", 1567, 176, 15, "#2a2f33"), T(1583, 177, "Build all", 13, "#2a2f33"));
  s.push(R(1696, 161, 162, 30, "#fff", "#c9d0d5", "border-radius:2px"), I("settings", 1714, 176, 15, "#2a2f33"), T(1730, 177, "Configure checks", 13, "#2a2f33"));
  s.push(R(326, 207, 305, 807, "#fff"), L(631, 207, 631, 1014, "#e1e6e8"));
  const outName = nm(c.tout, c.tf.output_dataset_id);
  s.push(T(341, 226, "Viewing metrics on", 12.5, "#2a2f33", 600), R(341, 245, 240, 30, "#e6eaec"), I("th", 360, 260, 13, "#4a7fc8"), T(374, 260, outName, 12.5, "#2a2f33"), I("caret-down", 563, 260, 12, "#4a5358"));
  s.push(R(587, 245, 29, 30, "#fff", "#c9d0d5"), T(601, 260, "•••", 14, "#2a2f33", 700, "", "", "c"), I("time", 348, 294, 13, "#4a5358"), T(362, 294, "Using latest values for each build", 12.5, "#2a2f33"));
  s.push(R(326, 316, 305, 28, "#f4f6f7"), T(478, 330, "Select builds to view on dashboard", 12.5, "#2a2f33", 600, "", "", "c"));
  s.push(R(341, 356, 276, 190, "#fff", "#e1e6e8"), T(355, 381, "Select builds", 13, "#2a2f33", 700), T(601, 381, "Clear all", 12, "#2f6fd0", 400, "text-decoration:underline", "", "r"));
  s.push(T(355, 410, "Add specific builds to the comparison", 12, "#4a5358"), T(355, 427, "dashboard.", 12, "#4a5358"));
  sel.forEach((b, i) =>
    s.push(R(355, 446 + i * 27, 246, 22, PAIR[i]!, "", "border-radius:2px"), T(380, 457 + i * 27, b.id, 11.5, "#fff"), I("cross", 592, 457 + i * 27, 10, "#fff"), I("git-merge", 369, 457 + i * 27, 11, "#fff"), Hit(583, 448 + i * 27, 18, 18, `Remove ${b.id}`, () => h.onToggle(b))),
  );
  s.push(R(355, 506, 246, 28, "#fff", "#4a7fc8"), T(366, 520, "Select builds...", 12.5, "#4a5358"), Hit(355, 506, 246, 28, "Select builds", h.onPicker), Hit(560, 371, 44, 20, "Clear all", h.onClear));
  s.push(R(632, 207, 1240, 40, "#fff"), T(646, 227, "Overall", 14, "#2f6fd0"), R(646, 244, 47, 2, "#2f6fd0"), T(713, 227, outName, 14, "#2a2f33"));
  s.push(R(646, 262, 910, 146, "#fff", "#e1e6e8"), R(647, 263, 197, 59, "#fff"), L(844, 262, 844, 408, "#e1e6e8"), L(1162, 262, 1162, 408, "#e1e6e8"), L(647, 322, 1555, 322, "#e1e6e8"));
  const [b0, b1] = sel;
  if (b0) s.push(R(864, 282, 277, 29, PAIR[0]!, "", "border-radius:2px"), T(892, 297, b0.id, 12.5, "#fff"));
  if (b1) s.push(R(1182, 282, 355, 29, PAIR[1]!, "", "border-radius:2px"), T(1211, 297, b1.id, 12.5, "#fff"));
  const rows: [string, (b: Build) => string][] = [["Started", (b) => tsFmt(b.started_at)], ["Rows out", (b) => String(b.rows_out)], ["Scope", (b) => b.scope]];
  rows.forEach(([lab, f], i) => {
    const y = 336 + i * 28;
    s.push(T(652, y, lab, 12.5, "#4a5358"), T(849, y, b0 ? f(b0) : "", 12.5, "#2a2f33"), T(1167, y, b1 ? f(b1) : "", 12.5, "#2a2f33"));
  });
  s.push(I("pulse", 1243, 446, 44, "#c9d0d5"), T(1243, 502, "No evaluation metrics: no labelled evaluation set on this box", 15.5, "#4a5358", 400, "", "", "c"));
  if (picker) {
    s.push(Hit(282, 98, 1590, 916, "Close the build picker", h.onPicker));
    s.push(R(355, 535, 396, 300, "#fff", "#d9dfe2", "box-shadow:0 2px 10px rgba(0,0,0,.22)"));
    const list = [...c.tfBuilds.slice(0, 4), ...c.builds.filter((x) => x.transform_id !== c.tf.id && !c.tfBuilds.includes(x)).slice(0, 2)];
    list.forEach((b, i) => {
      const y = 553 + i * 53;
      if (sel.includes(b)) s.push(I("tick", 375, y, 13, "#2a2f33"));
      s.push(I("git-merge", 397, y, 12, "#7a4fd0"), T(409, y, b.id, 12.5, "#2a2f33"), T(390, y + 25, `Started ${tsFmt(b.started_at)}`, 11.5, "#4a5358"));
      s.push(Hit(356, y - 18, 394, 52, `Compare ${b.id}`, () => h.onToggle(b)));
    });
  }
  s.push(Hit(1550, 161, 136, 30, "Build all", h.onRun, "Building"));
  return s;
}

const HEADS = ["Precision", "Recall", "F1 Score", "Prior", "Accuracy", "Row Count", "Matthews Correlation Coefficient", "ROC AUC Score", "Root Mean Squared Error"];
const HX = [922, 995, 1049, 1118, 1166, 1237, 1320, 1528, 1635];

function a28(c: Ctx, sel: Build[], h: { onPicker: () => void }): N[] {
  const s: N[] = [R(326, 207, 305, 807, "#fff"), L(631, 207, 631, 1014, "#e1e6e8")];
  const outName = nm(c.tout, c.tf.output_dataset_id);
  s.push(T(341, 226, "Viewing metrics on", 12.5, "#2a2f33", 600), R(341, 245, 240, 30, "#fff", "#c9d0d5", "border-radius:2px"), I("th", 360, 260, 13, "#4a7fc8"), T(374, 260, outName, 12.5, "#2a2f33"), I("caret-down", 563, 260, 12, "#4a5358"));
  s.push(R(587, 245, 29, 30, "#fff", "#c9d0d5"), T(601, 260, "•••", 14, "#2a2f33", 700, "", "", "c"));
  s.push(R(341, 356, 276, 190, "#fff", "#e1e6e8"), T(355, 381, "Select builds", 13, "#2a2f33", 700));
  sel.forEach((b, i) => s.push(R(355, 446 + i * 27, 246, 22, PAIR[i]!, "", "border-radius:2px"), T(380, 457 + i * 27, b.id, 11.5, "#fff"), I("git-merge", 369, 457 + i * 27, 11, "#fff")));
  s.push(Hit(341, 356, 276, 190, "Select builds", h.onPicker));
  s.push(R(632, 207, 1240, 40, "#fff"), T(646, 227, "Overall", 14, "#2f6fd0"), R(646, 244, 47, 2, "#2f6fd0"));
  s.push(T(660, 362, "Overall", 9.5, "#2a2f33", 700), R(647, 382, 1152, 120, "#fff", "#e1e6e8"));
  HX.forEach((x, i) => s.push(T(x, 412, HEADS[i]!, 12.5, "#4a5358")));
  sel.forEach((b, r) => {
    const y = 442 + r * 35;
    s.push(R(661, y - 14, 257, 28, PAIR[r]!), T(671, y, b.id, 12.5, "#fff"));
    HX.forEach((x, i) => s.push(T(x, y, HEADS[i] === "Row Count" ? String(b.rows_out) : "n/a", 12.5, "#2a2f33")));
  });
  ["ROC Curve", "TPR Curve", "FPR Curve", "Lift Curve", "Score Distribution", "Residuals"].forEach((ch, i) => {
    const cx0 = 647 + (i % 3) * 389;
    const cy0 = 516 + Math.floor(i / 3) * 355;
    s.push(R(cx0, cy0, 375, 340, "#fff", "#e1e6e8", "box-shadow:0 1px 3px rgba(0,0,0,.1)"), T(cx0 + 14, cy0 + 20, ch, 12.5, "#2a2f33", 600), R(cx0 + 317, cy0 + 12, 45, 17, "#eef1f3", "", "border-radius:2px"), T(cx0 + 339, cy0 + 21, "Overall", 9, "#4a5358", 700, "", "", "c"));
    const [ax, ay0, ay1] = [cx0 + 60, cy0 + 50, cy0 + 245];
    s.push(L(ax, ay0, ax, ay1, "#4a5358"), L(ax, ay1, cx0 + 365, ay1, "#4a5358"));
    for (let t = 0; t < 5; t++) {
      const yy = ay1 - ((ay1 - ay0) * t) / 4;
      s.push(T(ax - 10, yy, t === 0 ? "n/a" : "", 9, "#4a5358", 400, "", "", "r"));
      if (t) s.push(L(ax, yy, cx0 + 365, yy, "#edf0f2"));
    }
    s.push(T(cx0 + 215, cy0 + 150, "n/a: no evaluation set", 13, "#8a9397", 400, "", "", "c"));
    sel.forEach((b, j) => s.push(R(cx0 + 20 + j * 180, cy0 + 285, 20, 8, PAIR[j]!), T(cx0 + 46 + j * 180, cy0 + 289, b.id.slice(0, 16), 10.5, "#2a2f33")));
  });
  s.push(R(1829, 262, 38, 204, "#fff", "#e1e6e8"), T(1848, 364, "Evaluation dashboard", 11, "#2a2f33", 400, "transform:translate(-50%,-52%) rotate(90deg)"), I("menu-open", 1848, 287, 14, "#2a2f33"));
  return s;
}

type Page = "catalogue" | "page" | "eval";

export function TransformsView({ nav, onLineage }: { nav: (v: FoundryNav) => void; onLineage: (id?: string) => void }): JSX.Element {
  const setAppView = useAppView((s) => s.setApp);
  const [nonce, setNonce] = useState(0);
  const tfR = useJson<Transform[]>("/api/foundry/transforms");
  const dsR = useJson<Dataset[]>("/api/foundry/datasets");
  const bR = useJson<Build[]>("/api/foundry/builds", nonce);
  const ckR = useJson<Check[]>("/api/foundry/checks");
  const bnd = useJson<Binding[]>("/api/foundry/bindings");
  const [page, setPage] = useState<Page>("catalogue");
  const [tfId, setTfId] = useState<string | null>(null);
  const [dy, setDy] = useState(0);
  const [picker, setPicker] = useState(false);
  const [pairIds, setPairIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [runMsg, setRunMsg] = useState("");

  const s: N[] = [R(282, 98, 1590, 916, page === "catalogue" ? "#fff" : "#f2f6f6")];
  const tfs = tfR?.data ?? [];
  const ds = new Map((dsR?.data ?? []).map((d) => [d.id, d]));
  const builds = bR?.data ?? [];
  const tf = tfs.find((t) => t.id === tfId) ?? tfs.find((t) => t.name === "fast_vessels_tf") ?? tfs[0];
  if (!tfR?.ok || !tf) {
    s.push(...rail44(nav), T(1100, 560, tfR?.ok ? "No transform on this box" : unavailable("Transforms", tfR), 17, "#59646a", 400, "", "", "c"));
    return frag(s);
  }
  const tfBuilds = builds.filter((b) => b.transform_id === tf.id || (b.log ?? []).some((l) => l.includes(tf.name + ":")));
  const ctx: Ctx = {
    tf,
    tin: ds.get(tf.inputs[0] ?? ""),
    tout: ds.get(tf.output_dataset_id),
    tfBuilds,
    builds,
    checks: ckR?.ok ? (ckR.data ?? []) : null,
    ds,
    boundKinds: (bnd?.data ?? []).filter((b) => b.dataset_id === tf.inputs[0] || b.dataset_id === tf.output_dataset_id).map((b) => b.object_kind),
  };
  const run = async (path: string): Promise<void> => {
    setBusy(true);
    setRunMsg("building…");
    try {
      const r = await apiFetch(path, { method: "POST" });
      setRunMsg(r.ok ? "" : `Build failed to start (HTTP ${r.status})`);
    } catch {
      setRunMsg("Build failed to start (network error)");
    }
    setBusy(false);
    setNonce((n) => n + 1);
  };
  const sel = (pairIds ? pairIds.map((id) => builds.find((b) => b.id === id)).filter((b): b is Build => Boolean(b)) : tfBuilds.slice(0, 2)).slice(0, 2);
  const toggle = (b: Build): void => {
    const cur = sel.map((x) => x.id);
    setPairIds(cur.includes(b.id) ? cur.filter((x) => x !== b.id) : [...cur, b.id].slice(-2));
  };
  const open = (id: string): void => {
    setTfId(id);
    setPage("page");
    setDy(0);
  };

  if (page === "catalogue") {
    s.push(...catalogue(tfs, { ds, builds, bindings: bnd?.data?.length ?? 0, tfName: tf.name }, open, setAppView), ...rail44(nav));
  } else if (page === "page") {
    const wheel = (e: WheelEvent): void => setDy((d) => Math.max(-330, Math.min(0, d - e.deltaY)));
    s.push(
      <div className="a" style={{ left: 0, top: 0 }} onWheel={wheel}>
        {frag(objPage(ctx, dy, { onRun: busy ? undefined : () => void run(`/api/foundry/transforms/${tf.id}/build`), runMsg, onAll: () => setPage("eval") }))}
      </div>,
      ...objRightPanel(ctx, onLineage),
      ...rail44(nav),
      ...resHeader(tf.name),
    );
  } else {
    s.push(...rail44(nav), ...resHeader(tf.name), ...evalHead(ctx, () => setPage("page"), () => setPage("catalogue")));
    if (picker) s.push(...a27(ctx, sel, true, { onToggle: toggle, onPicker: () => setPicker(false), onClear: () => setPairIds([]), onRun: busy ? undefined : () => void run("/api/foundry/pipeline/build") }));
    else s.push(...a28(ctx, sel, { onPicker: () => setPicker(true) }));
  }
  return frag(s);
}
