// E11: the data lineage pipeline graph with the workspace sidebar (lineage()
// in _build_features.py), the whole 1920x1080 frame. Nodes, edges, legend
// counts and build counts are /api/foundry/lineage and /api/foundry/summary;
// the chain rows are derived from the live edges (data.ts lineageChains).
import { A, I, T, Hit, frag, type N } from "./ui.js";
import {
  lineageLayoutEu,
  unavailable,
  type FSummary,
  type Lineage,
  type LinNode,
  type Res,
} from "./data.js";
import type { Go } from "./SatMap.js";

const KCOL: Record<string, string> = {
  raw: "#32863c",
  reference: "#7e888c",
  derived: "#4a86c0",
  transform: "#8c3032",
  stale: "#c8a43c",
};
const NW = 138;
const NH = 28;
const kindOf = (n: LinNode): string =>
  n.type === "transform" ? "transform" : (n.kind ?? "raw");

export function LineageFrame({
  lin,
  linRes,
  fs,
  go,
}: {
  lin: Lineage | null;
  linRes: Res<unknown> | null;
  fs: FSummary | null;
  go: Go;
}): N {
  const s: N[] = [
    A(0, 0, 1920, 1080, "background:#969c9e"),
    A(0, 74, 343, 1006, "background:#262e34"),
    A(0, 0, 343, 74, "background:#262e34"),
  ];
  const side: [number, string, string, (() => void) | undefined][] = [
    [123, "home", "Home", () => go("gaia")],
    [173, "search", "Search...", () => go("graph")],
    [222, "notifications", "Alerts", undefined],
    [314, "history", "Recent", undefined],
    [363, "folder-close", "Foundry datasets", undefined],
  ];
  for (const [yc, ic, lab, f] of side)
    s.push(
      I(ic, 36, yc, 22, "#aab6bc"),
      T(62, yc + 1, lab, 17.5, "#c8d2d8", 400, "l", 0),
      Hit(20, yc - 18, 300, 36, lab, f, "Opens in the Foundry app"),
    );
  s.push(
    T(249, 173, "Ctrl + J", 14, "#5a666d", 400, "l", 0),
    A(0, 412, 343, 1, "background:#3a444a"),
    T(28, 442, "APPS", 14, "#8c989f", 400, "l", 0.02),
    T(85, 442, "·", 14, "#8c989f"),
    T(
      101,
      442,
      "View all",
      14,
      "#8aa4b8",
      400,
      "l",
      0,
      "text-decoration:underline",
    ),
  );
  const apps: [number, string, string, string, (() => void) | undefined][] = [
    [497, "cube", "Ontology", "#5a78d0", () => go("graph")],
    [558, "satellite", "SAR sweeps", "#e0a43c", () => go("globe")],
    [620, "timeline-events", "Replay", "#a64fc9", undefined],
    [681, "data-lineage", "Data lineage", "#e0803c", () => undefined],
  ];
  for (const [yc, ic, lab, col, f] of apps) {
    if (lab === "Data lineage")
      s.push(A(9, 650, 316, 40, "background:#3a444a;border-radius:3px"));
    s.push(
      A(
        24,
        yc - 19,
        38,
        38,
        "background:rgba(255,255,255,.04);border-radius:4px",
      ),
      I(ic, 43, yc, 24, col),
      T(78, yc + 1, lab, 20, "#e4eaee", 400, "l", 0),
      Hit(9, yc - 20, 280, 40, lab, f, "Replay lives on the map's time dock"),
    );
  }
  s.push(
    I("star-empty", 297, 681, 20, "#c4ccd2"),
    A(
      62,
      701,
      216,
      42,
      "background:#2a4d3a;border-radius:21px;border:1px solid #3a6a50",
    ),
    A(
      76,
      711,
      32,
      22,
      "background:#4a9a7a;border-radius:11px;color:#0c1c14;font-size:12px;display:grid;place-items:center;font-weight:700",
      "NEW",
    ),
    T(126, 722, "See what's new", 18.5, "#d8ece4", 400, "l", 0),
    I("globe", 36, 802, 22, "#aab6bc"),
    A(
      63,
      785,
      251,
      35,
      "background:#2e373d;border:1px solid #4a545a;border-radius:2px",
    ),
    T(75, 802.5, "English", 17, "#e4eaee", 400, "l", 0),
    I("caret-down", 291, 802, 14, "#c4ccd2"),
    I("swap-horizontal", 36, 861, 22, "#aab6bc"),
    T(63, 861, "Track", 19, "#e4eaee", 400, "l", 0),
    A(
      131,
      845,
      183,
      34,
      "background:#2e373d;border:1px solid #4a545a;border-radius:2px",
    ),
    T(142, 861.5, "Default", 17, "#e4eaee", 400, "l", 0),
    I("caret-down", 291, 861, 14, "#c4ccd2"),
    I("help", 36, 939, 22, "#aab6bc"),
    T(62, 940, "Help & support", 18, "#c8d2d8", 400, "l", 0),
    I("log-out", 36, 1041, 22, "#aab6bc"),
    T(62, 1042, "Open other workspaces", 19, "#e4eaee", 400, "l", 0),
    Hit(20, 1022, 300, 40, "Open other workspaces", () => go("chat")),
    // header
    A(343, 0, 1577, 74, "background:#a0a4a6"),
    A(360, 14, 44, 44, "background:#8a9092"),
    I("data-lineage", 382, 36, 34, "#c8782c"),
    I("document", 449, 22, 20, "#4a545a"),
    T(469, 22.5, "Foundry", 19, "#3a444a", 400, "l", 0),
    T(610, 22.5, "›", 20, "#3a444a", 400, "l", 0),
    T(633, 22.5, "Dataset lineage", 21, "#14181c", 600, "l", 0),
    T(434, 51, "File", 16, "#2c343a", 400, "l", 0),
    I("caret-down", 469, 51, 10, "#2c343a"),
    T(487, 51, "Help", 16, "#2c343a", 400, "l", 0),
    I("caret-down", 531, 51, 10, "#2c343a"),
    I("database", 575, 51, 16, "#2c343a"),
    T(594, 51, fs ? String(fs.datasets) : "—", 16, "#2c343a", 400, "l", 0),
    A(
      878,
      14,
      322,
      44,
      "background:#9aa0a2;border:1px solid #6a7278;border-radius:3px;box-sizing:border-box",
    ),
    I("git-branch", 901, 36, 22, "#2c343a"),
    T(923, 36.5, "Latest build", 20, "#2c343a", 400, "l", 0),
    I("caret-down", 1179, 36, 14, "#2c343a"),
    I("git-new-branch", 1232, 36, 24, "#2c343a"),
    I("chevron-up", 1287, 36, 20, "#2c343a"),
    I("cog", 1341, 36, 26, "#2c343a"),
  );
  const rb = fs?.recent_builds ?? [];
  const nsucc = rb.filter((b) => b.status === "succeeded").length;
  const nfail = rb.filter((b) => b.status === "failed").length;
  s.push(
    A(
      1381,
      14,
      181,
      44,
      "background:#9aa0a2;border:1px solid #6a7278;border-radius:3px;box-sizing:border-box",
    ),
    I("refresh", 1408, 36, 22, "#6a7278"),
    T(1422, 36.5, "0", 16, "#6a7278", 400, "l", 0),
    I("tick", 1465, 36, 20, "#1c5a34"),
    T(1480, 36.5, fs ? String(nsucc) : "—", 16, "#2c343a", 400, "l", 0),
    I("cross", 1523, 36, 18, "#6a7278"),
    T(
      1535,
      36.5,
      fs ? String(fs.failed_builds_24h + nfail) : "—",
      16,
      "#6a7278",
      400,
      "l",
      0,
    ),
    T(1594, 36.5, "Actions", 19, "#2c343a", 400, "l", 0),
    I("caret-down", 1681, 36, 14, "#2c343a"),
    A(1724, 18, 1, 36, "background:#8a9092"),
    I("share", 1766, 36, 22, "#2c343a"),
    T(1790, 36.5, "Share", 19, "#2c343a", 400, "l", 0),
    I("panel-stats", 1886, 36, 24, "#2c343a"),
    A(343, 74, 1577, 106, "background:#a0a4a6"),
  );
  const tools: [number, string, string][] = [
    [380, "move", "Tools"],
    [491, "layout-auto", "Layout"],
    [580, "undo", "Undo/redo"],
    [669, "clean", "Clean"],
    [737, "target", "Select"],
    [805, "expand-all", "Expand"],
    [872, "tint", "Color"],
    [939, "zoom-in", "Find"],
    [1007, "remove", "Remove"],
    [1074, "grid-view", "Align"],
    [1142, "flow-linear", "Flow"],
  ];
  for (const [x, ic, lab] of tools) {
    if (lab === "Tools")
      s.push(
        A(
          x - 22,
          90,
          44,
          44,
          "background:#8e9498;border-radius:3px;border:1px solid #6a7278;box-sizing:border-box",
        ),
      );
    s.push(
      I(ic, x, 112, 26, "#2c343a"),
      T(x, 153, lab, 17.5, "#767d82", 400, "c", 0),
    );
  }
  for (const [x, ic, l1, l2] of [
    [1409, "layout-grid", "Layout", "by color"],
    [1482, "group-objects", "Group", "by color"],
    [1559, "eye-open", "Legend", ""],
  ] as const) {
    s.push(
      I(ic, x, 112, 26, "#2c343a"),
      T(x, 153, l1, 17.5, "#767d82", 400, "c", 0),
    );
    if (l2) s.push(T(x, 176, l2, 17.5, "#767d82", 400, "c", 0));
  }
  s.push(
    A(
      1612,
      90,
      237,
      44,
      "background:#9aa0a2;border:1px solid #6a7278;border-radius:3px;box-sizing:border-box",
    ),
    I("tint", 1635, 112, 20, "#14181c"),
    T(1657, 112.5, "Dataset kind", 20, "#2c343a", 400, "l", 0),
    I("caret-down", 1827, 112, 14, "#2c343a"),
    T(1730, 153, "Node color options", 17.5, "#767d82", 400, "c", 0),
    A(343, 180, 1470, 850, "background:#969c9e"),
  );
  const nodes = lin?.nodes ?? [];
  const cnt: Record<string, number> = {
    raw: 0,
    reference: 0,
    derived: 0,
    transform: 0,
  };
  for (const n of nodes) cnt[kindOf(n)] = (cnt[kindOf(n)] ?? 0) + 1;
  const stale = nodes.filter((n) => n.stale).length;
  s.push(
    A(
      1361,
      195,
      488,
      210,
      "background:#a2a6a6;border:1px solid #858c90;box-shadow:0 2px 6px rgba(0,0,0,.3)",
    ),
  );
  for (const [x, y, k, lab] of [
    [1381, 230, "raw", `Raw (${cnt["raw"]})`],
    [1601, 230, "reference", `Reference (${cnt["reference"]})`],
    [1381, 281, "transform", `Transform (${cnt["transform"]})`],
    [1601, 281, "stale", `Stale (${stale})`],
    [1381, 332, "derived", `Derived (${cnt["derived"]})`],
  ] as const)
    s.push(
      A(
        x,
        y - 15,
        30,
        30,
        `background:${KCOL[k]};border:1px solid rgba(0,0,0,.25);border-radius:2px`,
      ),
      T(x + 41, y + 0.5, lab, 20, "#2c343a", 400, "l", 0),
    );
  s.push(
    T(1383, 378, "Show Color Group Editor", 19, "#1c4a8a", 400, "l", 0),
    I("caret-down", 1610, 378, 14, "#1c4a8a"),
  );
  if (!lin)
    s.push(
      T(780, 600, unavailable("Lineage", linRes), 22, "#14181c", 600, "c", 0),
    );
  // nodes + edges
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pos = lin ? lineageLayoutEu(lin) : new Map<string, [number, number]>();
  s.push(
    <svg
      key="edges"
      aria-hidden
      style={{
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
        overflow: "visible",
      }}
    >
      <defs>
        <marker
          id="eu-ah"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8Z" fill="#4a545a" />
        </marker>
      </defs>
      {(lin?.edges ?? [])
        .filter((e) => pos.has(e.src) && pos.has(e.dst))
        .map((e) => {
          const [ax, ay] = pos.get(e.src)!;
          const [bx, by] = pos.get(e.dst)!;
          return (
            <line
              key={`${e.src}${e.dst}`}
              x1={Math.round(ax + NW)}
              y1={Math.round(ay)}
              x2={Math.round(bx - 2)}
              y2={Math.round(by)}
              stroke="#4a545a"
              strokeWidth="1.4"
              markerEnd="url(#eu-ah)"
            />
          );
        })}
    </svg>,
  );
  const node = (x: number, y: number, n: LinNode, fsz = 11.5): N[] => {
    const k = kindOf(n);
    return [
      A(
        x,
        y - NH / 2,
        NW,
        NH,
        `background:${KCOL[k]};border:1px solid rgba(0,0,0,.3);border-radius:2px;box-sizing:border-box`,
      ),
      T(
        x + NW / 2,
        y + 0.5,
        n.name,
        fsz,
        k !== "reference" ? "#e8f0ea" : "#2c343a",
        400,
        "c",
        0,
      ),
    ];
  };
  for (const [id, [x, y]] of pos) {
    const n = byId.get(id);
    if (n) s.push(...node(x, y, n));
  }
  const isoRaw = nodes.filter(
    (n) => n.type === "dataset" && n.kind === "raw" && !pos.has(n.id),
  );
  const isoRef = nodes.filter(
    (n) => n.type === "dataset" && n.kind === "reference",
  );
  if (lin)
    for (const [gx0, gy0, grp, title] of [
      [1400, 462, isoRef, `[SEED] Reference datasets (${isoRef.length})`],
      [
        1400,
        462 + 4 * 62 + 52,
        isoRaw,
        `[RAW] Unlinked datasets (${isoRaw.length})`,
      ],
    ] as const) {
      s.push(
        A(gx0, gy0 - 18, 290, 34, "background:#14181c"),
        I("data-lineage", gx0 + 20, gy0 - 1, 16, "#c4ccd2"),
        T(gx0 + 44, gy0 - 0.5, title, 16, "#e4e8ec", 400, "l", 0),
      );
      grp.forEach((n, i) =>
        s.push(
          ...node(
            gx0 + (i % 2) * 150,
            gy0 + 36 + Math.floor(i / 2) * 44,
            n,
            n.name.length < 20 ? 11.5 : 8.6,
          ),
        ),
      );
    }
  for (const [y, ic] of [
    [859, "locate"],
    [903, "zoom-in"],
    [946, "zoom-out"],
    [990, "zoom-to-fit"],
  ] as const)
    s.push(
      A(
        360,
        y - 20,
        41,
        41,
        "background:#8e9498;border:1px solid #6a7278;border-radius:3px;box-sizing:border-box",
      ),
      I(ic, 380.5, y, 24, "#2c343a"),
    );
  s.push(
    A(343, 1030, 1577, 50, "background:#8e9498"),
    A(343, 1030, 1577, 1, "background:#6a7278"),
  );
  for (const [x, ic, lab, on] of [
    [358, "eye-open", "Preview", 0],
    [492, "history", "History", 0],
    [620, "code", "Code", 0],
    [729, "timeline-bar-chart", "Build timeline", 1],
    [921, "pulse", "Data health", 1],
  ] as const)
    s.push(
      I(ic, x + 12, 1055, 22, on ? "#3a444a" : "#a0a6aa"),
      T(x + 36, 1055.5, lab, 20, on ? "#14181c" : "#a0a6aa", 400, "l", 0),
    );
  s.push(I("double-chevron-up", 1094, 1052, 20, "#2c343a"));
  return frag(s);
}
