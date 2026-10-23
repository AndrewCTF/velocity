// Target board: features A60-A64, ported from gotham/aip/_build_features_b.py
// (board_cols .. a64). /api/targets/board needs a sign-in, so the cards are the
// real watch items (gotham/_kit/watch_items.py ported to dataB.watchItems over
// the live routes), placed in the real targets.py stage columns by the
// builder's recorded rule (STAGE_OF). Approvals = /api/actions/proposals,
// Enabled rules = /api/alerts/rules, Evidence items = /api/evidence. "Send to"
// lists the real outputs: /api/export (GeoJSON, CSV), /api/report/pptx and the
// alert-rule channels.
import { useState } from "react";
import { apiFetch } from "../../../transport/http.js";
import { CLIP, Hit, I, L, R, T, frag, type N } from "./ui.js";
import {
  unavailable,
  useJson,
  type FC,
  type SarFC,
  type SancP,
} from "./data.js";
import {
  KIND_GROUP,
  SAR_AOIS,
  STAGE_OF,
  mgrs,
  watchItems,
  type Rule,
  type WItem,
  type WatchSrc,
} from "./dataB.js";
import { banner } from "./Titan.js";

const COLS: [string, string][] = [
  ["CONFIRM", "#c8a46a"],
  ["ATTACH INTEL", "#e8cd6a"],
  ["APPROVALS", "#c490e0"],
  ["ASSESS", "#e0605a"],
  ["COMPLETE", "#a8aeb6"],
];
const trunc = (t: string, n: number): string =>
  t.length <= n ? t : t.slice(0, n - 1) + "...";
const cardId = (it: WItem): string => "#" + it.id;
const RULE_KIND: Record<WItem["kind"], string> = {
  sar: "dark_vessel",
  jam: "jamming",
  quake: "quake",
  choke: "loiter",
  ofac: "ais_gap",
  nga: "incident",
};

function sym(x: number, y: number, it: WItem, sz = 13): N[] {
  const out: N[] =
    it.shape === "dia"
      ? [
          <svg
            className="a"
            aria-hidden
            style={{
              left: x - sz - 2,
              top: y - sz - 2,
              width: 2 * sz + 4,
              height: 2 * sz + 4,
            }}
          >
            <polygon
              points={`${sz + 2},2 ${2 * sz + 2},${sz + 2} ${sz + 2},${2 * sz + 2} 2,${sz + 2}`}
              fill="#4a2a30"
              stroke={it.color}
              strokeWidth={2}
            />
          </svg>,
        ]
      : [
          R(
            x - sz,
            y - sz,
            2 * sz,
            2 * sz,
            "#2a3640",
            it.color,
            "border-radius:50%;border-width:2px",
          ),
        ];
  return [...out, I(it.icon, x, y, 13, it.color)];
}

function boardCols(
  items: WItem[],
  nProp: number,
  x0: number,
  sel: string | null,
  onCard: (it: WItem) => void,
  only?: number[],
): N[] {
  const s: N[] = [];
  const by = new Map<number, Map<string, WItem[]>>();
  for (const it of items) {
    const c = STAGE_OF[it.kind];
    if (!by.has(c)) by.set(c, new Map());
    const g = by.get(c)!;
    g.set(KIND_GROUP[it.kind], [...(g.get(KIND_GROUP[it.kind]) ?? []), it]);
  }
  COLS.forEach(([cn, cc], ci) => {
    if (only && !only.includes(ci)) return;
    const x = x0 + ci * 295.4;
    const n =
      ci < 2
        ? [...(by.get(ci)?.values() ?? [])].reduce((a, v) => a + v.length, 0)
        : ci === 2
          ? nProp
          : 0;
    s.push(
      R(x, 290, 282, 648, "#1a1e22"),
      L(x + 284, 290, x + 284, 938, "#101418", 3),
    );
    s.push(
      <svg
        className="a"
        aria-hidden
        style={{ left: x + 7, top: 306, width: 12, height: 14 }}
      >
        <polygon points="6,0 12,7 6,14 0,7" fill={cc} />
      </svg>,
      T(x + 20, 313, cn, 14, "#e8ebee", 600),
      T(x + 228, 313, "><", 11, "#c6ccd2", 600, "", "", "c"),
      R(x + 248, 304, 20, 18, "#2c3034", "", "border-radius:9px"),
      T(x + 258, 313, String(n), 11, "#c6ccd2", 400, "", "", "c"),
    );
    let y = 352;
    const grs = [...(by.get(ci)?.entries() ?? [])].sort(
      (a, b) => b[1].length - a[1].length,
    );
    for (const [gn, its0] of grs) {
      s.push(
        I("chevron-down", x + 8, y, 12, "#c6ccd2"),
        T(x + 22, y, gn, 12.5, "#dfe3e7"),
        T(x + 258, y, String(its0.length), 11, "#c6ccd2", 400, "", "", "c"),
      );
      y += 20;
      const its = [...its0].sort(
        (a, b) => Number(a.id !== sel) - Number(b.id !== sel),
      );
      for (const it of its.slice(0, 6)) {
        if (y > 930) break;
        const on = it.id === sel;
        s.push(
          R(
            x + 1,
            y,
            267,
            57,
            on ? "#323e4e" : "#32363c",
            on ? "#5a8ae0" : "#3a3f45",
            "border-width:1px",
          ),
          ...sym(x + 27, y + 21, it),
        );
        s.push(
          T(
            x + 52,
            y + 21,
            <>
              <span style={{ color: "#9aa2aa" }}>{cardId(it)} /</span>{" "}
              {trunc(it.title, 30)}
            </>,
            12.5,
            "#e8ebee",
          ),
          T(x + 9, y + 49, "U", 8, "#9aa2aa"),
        );
        s.push(Hit(x + 1, y, 267, 57, `Open ${cardId(it)}`, () => onCard(it)));
        y += 63;
      }
      y += 6;
    }
  });
  return s;
}

function toolbar(nRules: number, nProp: number, nEvid: number): N[] {
  const s: N[] = [
    R(406, 244, 1461, 38, "#16141a"),
    I("add", 427, 263, 17, "#3aa655"),
    R(447, 248, 186, 29, "#101418", "#3a4046"),
    I("search", 461, 263, 14, "#c6ccd2"),
    T(476, 263, "Search...", 12, "#c6ccd2"),
    I("filter", 657, 263, 14, "#c6ccd2"),
  ];
  for (const [x0, w, ic, lab, n] of [
    [682, 159, "comment", "Enabled rules", nRules],
    [862, 150, "person", "Proposals", nProp],
    [1035, 150, "shield", "Evidence items", nEvid],
  ] as const)
    s.push(
      R(x0, 248, w, 29, "#18161c", "#2a2e34", "border-radius:2px"),
      I(ic, x0 + 17, 263, 14, "#8a9298"),
      T(x0 + 32, 263, lab, 11.5, "#aab2ba"),
      R(x0 + w - 28, 256, 20, 14, "#2c3034", "", "border-radius:7px"),
      T(x0 + w - 18, 263, String(n), 10, "#c6ccd2", 400, "", "", "c"),
    );
  s.push(
    I("sort", 1232, 263, 15, "#c6ccd2"),
    T(1257, 263, "Time created", 12.5, "#e8ebee"),
    I("caret-down", 1345, 263, 11, "#c6ccd2"),
    I("layout-grid", 1390, 263, 15, "#c6ccd2"),
    T(1412, 263, "Kind", 12.5, "#e8ebee"),
    I("caret-down", 1468, 263, 11, "#c6ccd2"),
  );
  s.push(
    T(1514, 263, "View", 12, "#e8ebee", 400, "", "", "c"),
    R(1538, 250, 27, 25, "#4464b6", "", "border-radius:2px"),
    I("list-columns", 1551, 263, 14, "#fff"),
    R(1567, 250, 27, 25, "#2c3034", "", "border-radius:2px"),
    I("panel-table", 1580, 263, 14, "#c6ccd2"),
  );
  s.push(
    T(1635, 263, "Links", 12, "#e8ebee", 400, "", "", "c"),
    R(1660, 249, 118, 27, "#32363c", "#3a4046", "border-radius:2px"),
    I("document", 1678, 263, 13, "#c6ccd2"),
    T(1692, 263, "Guidance", 12, "#e8ebee"),
    I("caret-down", 1760, 263, 10, "#c6ccd2"),
  );
  s.push(
    R(1790, 249, 68, 27, "#18222e", "#3a5aa0", "border-radius:2px"),
    I("globe", 1806, 263, 13, "#7a9cf0"),
    T(1822, 263, "Map", 12, "#7a9cf0"),
  );
  return s;
}
function menubar(onHome: () => void, y = 222): N[] {
  const s: N[] = [
    R(406, 214, 1461, 28, "#0a0d11"),
    R(
      414,
      215,
      14,
      14,
      "transparent",
      "#e8ecf0",
      "border-radius:50%;border-width:2px",
    ),
    I("caret-down", 444, y, 11, "#e8ecf0"),
    R(466, 214, 31, 18, "#a8aeb6", "", "border-radius:9px"),
    Hit(408, 214, 48, 24, "AIP terminal", onHome),
  ];
  for (const [it, x] of [
    ["File", 521],
    ["Edit", 562],
    ["View", 606],
    ["Insert", 655],
    ["Selection", 717],
    ["Help", 777],
    ["Develop", 832],
  ] as const)
    s.push(T(x, y, it, 12.5, "#f2f4f6", 400, "", "", "c"));
  s.push(
    I("diagram-tree", 1052, y, 13, "#4c7fd4"),
    T(1066, y, "GULF AND RED SEA WATCH", 12, "#f2f4f6"),
    I("star-empty", 1199, y, 12, "#c6ccd2"),
    I("chevron-down", 1220, y, 11, "#c6ccd2"),
    T(1557, y, "Share", 12, "#4c7fd4", 400, "", "", "c"),
    T(1619, y, "U", 12, "#e8ecf0", 400, "", "", "c"),
  );
  s.push(
    R(1657, 214, 205, 20, "#0e1318", "#3a4048", "border-radius:2px"),
    I("search", 1669, y, 12, "#c6ccd2"),
    T(1683, y, "Search", 11.5, "#c6ccd2"),
  );
  return s;
}

type Tab = "Overview" | "Assessment";
function panel(
  it: WItem,
  tab: Tab,
  nEvid: number,
  boardWhy: string,
  h: { onClose: () => void; onTab: (t: Tab) => void; onSend: () => void },
  form: N[] | null,
): N[] {
  const s: N[] = [
    R(1326, 290, 542, 648, "#22242a"),
    L(1326, 290, 1326, 938, "#101418", 2),
    R(1297, 296, 28, 100, "#22242a"),
  ];
  for (const [y, ic] of [
    [313, "record"],
    [343, "comment"],
    [372, "pulse"],
  ] as const)
    s.push(
      R(1298, y - 14, 26, 28, "#2c3034", "", "border-radius:3px"),
      I(ic, 1311, y, 14, "#c6ccd2"),
    );
  s.push(
    R(1326, 290, 542, 28, "#2a2e32"),
    T(1336, 303, `${trunc(it.title, 28)} ☆ ▾`, 12, "#e8ebee"),
    I("chevron-left", 1733, 303, 12, "#c6ccd2"),
    T(1798, 303, "U", 12, "#e8ecf0", 400, "", "", "c"),
    I("cross", 1853, 303, 12, "#c6ccd2"),
    Hit(1845, 295, 16, 16, "Close the target", h.onClose),
  );
  s.push(
    ...sym(1360, 351, it, 15),
    T(
      1389,
      342,
      <>
        <span style={{ color: "#9aa2aa" }}>{cardId(it)} /</span>{" "}
        <b>{trunc(it.title, 26)}</b>
      </>,
      15,
      "#f2f4f6",
    ),
    T(1389, 361, it.link.replace("·", "-"), 12, "#c6ccd2"),
  );
  for (const x of [1771, 1805, 1839])
    s.push(R(x - 13, 337, 26, 30, "#2c3034", "#3a4046", "border-radius:3px"));
  s.push(
    I("share", 1771, 352, 14, "#e8ebee"),
    I("shield", 1805, 352, 14, "#e8ebee"),
    I("more", 1839, 352, 14, "#e8ebee"),
    Hit(1758, 337, 26, 30, "Send to", h.onSend),
  );
  for (const [lab, x] of [
    ["Overview", 1362],
    ["Details", 1428],
    ["Location", 1491],
    ["Intelligence", 1568],
    ["Evidence", 1656],
    ["Approvals", 1739],
    ["Assessment", 1820],
  ] as const) {
    const a = lab === tab;
    s.push(T(x, 391, lab, 12, a ? "#7a9cf0" : "#c6ccd2", 400, "", "", "c"));
    if (a) s.push(R(x - lab.length * 3.3, 407, lab.length * 6.6, 2, "#4c7fd4"));
    const live = lab === "Overview" || lab === "Assessment";
    s.push(
      Hit(
        x - lab.length * 3.6,
        380,
        lab.length * 7.2,
        24,
        lab,
        live && !a ? () => h.onTab(lab) : undefined,
        live
          ? undefined
          : "This tab reads the target board, which needs a sign-in",
      ),
    );
  }
  s.push(L(1326, 409, 1868, 409, "#2c3034"));
  if (form) return [...s, ...form];
  const loc = mgrs(it.ll[1], it.ll[0]);
  s.push(
    T(1343, 433, "Priority", 12, "#c6ccd2"),
    T(1343, 454, "n/a", 12.5, "#f2f4f6"),
    T(1614, 433, "Location", 12, "#c6ccd2"),
    T(1614, 454, loc, 12.5, "#f2f4f6"),
  );
  s.push(
    T(1343, 484, "Linked entity", 12, "#c6ccd2"),
    T(1614, 484, "Assigned to", 12, "#c6ccd2"),
    T(1614, 504, "Unassigned ▾", 12.5, "#f2f4f6"),
  );
  const nxt = COLS[STAGE_OF[it.kind] + 1]![0];
  const nx = nxt.charAt(0) + nxt.slice(1).toLowerCase();
  s.push(
    R(1336, 541, 522, 29, "#3c64be", "", "border-radius:2px"),
    T(1597, 556, `Move to ${nx}`, 12.5, "#fff", 400, "", "", "c"),
    I("arrow-right", 1658 + (nx.length - 9) * 3.3, 556, 13, "#fff"),
    Hit(1336, 541, 522, 29, `Move to ${nx}`, undefined, boardWhy),
  );
  s.push(T(1336, 604, "Properties", 12, "#c6ccd2"));
  const rows: [string, string, [string, "o" | "l" | null][]][] = [
    [
      "th-derived",
      "Details",
      [[it.kind === "sar" ? "SAR candidate" : it.title.split(",")[0]!, null]],
    ],
    [
      "map-marker",
      "Location",
      [
        ["Single source", "o"],
        ["Automatic", null],
      ],
    ],
    ["zoom-in", "Intelligence", [["None", "o"]]],
    [
      "shield",
      "Evidence",
      [[nEvid ? `${nEvid} attached` : "None attached", "o"]],
    ],
    ["time", "Review", [["Not completed", "o"]]],
    ["filter", "Audit trail", [["View changes", "l"]]],
  ];
  rows.forEach(([ic, lab, chips], i) => {
    const y = 642 + i * 48.4;
    s.push(
      R(1336, y - 19, 522, 38, "#32363c", "", "border-radius:2px"),
      I(ic, 1353, y, 14, "#c6ccd2"),
      T(1371, y, lab, 12.5, "#e8ebee"),
    );
    let x = 1815;
    for (const [t, c] of [...chips].reverse()) {
      s.push(
        T(x, y, t, 10.5, c === "o" ? "#e4a864" : "#e8ebee", 400, "", "", "r"),
      );
      x -= t.length * 5.7 + 12;
    }
    s.push(I("arrow-right", 1835, y, 14, "#c6ccd2"));
  });
  return s;
}

// A62: the outcome labels have no Velocity vocabulary (targets.py has only the stage `assess`); the form submits nothing
const PILLS: [string, string, string][] = [
  ["Confirmed", "#3a4844", "#7ed0a0"],
  ["Likely", "#48443c", "#e0b068"],
  ["Reclassified", "#3c4454", "#8aa8e8"],
  ["Not observed", "#484444", "#b4b0b0"],
  ["Mismatch", "#4a4048", "#e88a90"],
  ["Undetermined", "#484444", "#b4b0b0"],
];
function assessForm(
  outcome: string,
  open: boolean,
  h: { onOpen: () => void; onPick: (o: string) => void },
): N[] {
  const f: N[] = [
    T(1336, 432, "Assessment", 13, "#f2f4f6", 600),
    I("edit", 1811, 432, 12, "#c6ccd2"),
    T(1838, 432, "Edit", 12, "#e8ebee", 400, "", "", "c"),
  ];
  f.push(
    R(1326, 453, 542, 1, "#2c3034"),
    T(1336, 479, "Conduct review", 12.5, "#f2f4f6", 600),
    I("refresh", 1812, 479, 13, "#c6ccd2"),
    I("cross", 1844, 479, 12, "#c6ccd2"),
    T(1336, 503, "Document the review result", 12, "#c6ccd2"),
  );
  const [, , fg] = PILLS.find((p) => p[0] === outcome) ?? PILLS[0]!;
  f.push(
    T(1336, 534, "Review outcome*", 11.5, "#c6ccd2"),
    R(1336, 549, 522, 28, "#34423e", "#3a8a5a"),
    T(1347, 563, outcome, 12, fg),
    I("caret-down", 1840, 563, 11, "#c6ccd2"),
    Hit(1336, 549, 522, 28, "Review outcome", h.onOpen),
  );
  f.push(
    R(1520, 614, 338, 96, "#1c2022", "#2c3034"),
    R(1520, 726, 338, 49, "transparent", "#4c7fd4", "border-style:dashed"),
    T(1535, 751, "Drop media here", 12, "#c6ccd2"),
    T(1652, 751, "Choose file", 12, "#7a9cf0"),
    T(1723, 751, "Paste", 12, "#7a9cf0"),
  );
  f.push(
    R(1520, 787, 338, 28, "#30426e", "", "border-radius:2px"),
    T(1689, 801, "Submit review", 12.5, "#7a96d0", 400, "", "", "c"),
    Hit(
      1520,
      787,
      338,
      28,
      "Submit review",
      undefined,
      "No review store exists on this box; nothing is submitted",
    ),
  );
  if (open) {
    f.push(
      R(
        1336,
        577,
        164,
        245,
        "#282c30",
        "#2c3034",
        "box-shadow:0 4px 14px rgba(0,0,0,.4)",
      ),
    );
    PILLS.forEach(([t, bg, c], i) =>
      f.push(
        R(1346, 587 + i * 39, 154, 28, bg, "#4a4e52", "border-radius:14px"),
        T(1423, 601 + i * 39, t, 12, c, 400, "", "", "c"),
        Hit(1346, 587 + i * 39, 154, 28, t, () => h.onPick(t)),
      ),
    );
  }
  return f;
}

const SEND = [
  "GeoJSON - Current picture",
  "CSV - Current picture",
  "PPTX - Case report",
  "Alert rule - In-app",
  "Alert rule - Discord",
  "Alert rule - Webhook",
];
function sendMenu(
  msg: string | null,
  onPick: (i: number) => void,
  onClose: () => void,
): N[] {
  const s: N[] = [Hit(406, 214, 1461, 724, "Close the menu", onClose)];
  s.push(
    R(
      1568,
      388,
      217,
      58,
      "#282c30",
      "#3a3f45",
      "box-shadow:0 4px 14px rgba(0,0,0,.45)",
    ),
    T(1576, 399, "Send to", 11.5, "#f2f4f6", 600),
    R(1572, 415, 209, 26, "#32363c"),
    T(1580, 427, "Export or alert rule (GeoJSON, CSV or ...", 11, "#e8ebee"),
    I("caret-right", 1766, 427, 10, "#c6ccd2"),
  );
  s.push(
    R(
      1340,
      408,
      228,
      229,
      "#282c30",
      "#3a3f45",
      "box-shadow:0 4px 14px rgba(0,0,0,.45)",
    ),
    T(1350, 426, "Export or alert rule (GeoJSON, CSV or", 11, "#9aa2aa"),
    T(1350, 443, "alert channel) message types", 11, "#9aa2aa"),
  );
  SEND.forEach((t, i) => {
    const y = 471 + i * 29.2;
    if (i === 0) s.push(R(1342, y - 14, 224, 29, "#363a40"));
    s.push(
      T(1352, y, t, 11.5, "#e8ebee"),
      Hit(1342, y - 14, 224, 29, t, () => onPick(i)),
    );
  });
  if (msg) s.push(T(1350, 650, msg, 11.5, "#e8ebee"));
  return s;
}

function ruleForm(it: WItem, channel: string, onClose: () => void): N[] {
  const s: N[] = [
    R(406, 214, 1461, 724, "rgba(10,12,14,.55)"),
    Hit(406, 214, 376, 724, "Close the form", onClose),
    R(782, 229, 698, 709, "#e4e8ec"),
    R(792, 229, 678, 709, "#fefefe"),
    R(810, 229, 640, 40, "#e4e8ec", "#c9d0d5"),
    T(820, 249, `Alert rule: ${channel}`, 14, "#2a2f33", 700),
    I("cross", 1432, 249, 12, "#4a5358"),
    Hit(1424, 241, 16, 16, "Close the form", onClose),
  ];
  const fld = (
    y: number,
    lab: string,
    val: string,
    kind: "sel" | "txt" = "sel",
    dis = false,
  ): N[] => {
    const o: N[] = [
      T(830, y, lab, 14, "#2a2f33"),
      T(940, y - 3, "*", 14, "#c0392b"),
      R(
        995,
        y - 15,
        436,
        30,
        dis ? "#e4e8ec" : "#fff",
        "#c9d0d5",
        "border-radius:2px",
      ),
      T(1005, y, val, 13.5, dis ? "#6a7378" : "#2a2f33"),
    ];
    if (kind === "sel")
      o.push(
        I("cross", 1387, y, 10, "#4a5358"),
        I("caret-down", 1416, y, 11, "#4a5358"),
      );
    return o;
  };
  s.push(
    ...fld(297, "Classification", "U"),
    ...fld(366, "Created by", "local", "txt", true),
    ...fld(424, "Channel", channel),
    ...fld(482, "Rule kind", RULE_KIND[it.kind]),
    ...fld(540, "Item number", it.id, "txt"),
    ...fld(598, "Minimum severity", "1"),
  );
  s.push(
    R(830, 652, 601, 283, "#f2f6f8", "#c9d0d5"),
    R(831, 653, 599, 29, "#eef1f3"),
    T(841, 668, "Area", 13.5, "#2a2f33", 700),
  );
  s.push(
    T(851, 710, "MGRS", 13.5, "#2a2f33"),
    T(892, 707, "*", 14, "#c0392b"),
    R(1015, 695, 395, 30, "#fff", "#c9d0d5", "border-radius:2px"),
    T(1025, 710, mgrs(it.ll[1], it.ll[0]), 13.5, "#2a2f33"),
    I("locate", 1396, 710, 13, "#4a5358"),
  );
  s.push(
    T(851, 768, "Latitude", 13.5, "#2a2f33"),
    T(910, 765, "*", 14, "#c0392b"),
    R(1015, 753, 395, 30, "#fff", "#c9d0d5", "border-radius:2px"),
    T(1025, 768, it.ll[1].toFixed(5), 13.5, "#2a2f33"),
  );
  s.push(
    T(851, 826, "Longitude", 13.5, "#2a2f33"),
    T(917, 823, "*", 14, "#c0392b"),
    R(1015, 811, 395, 30, "#fff", "#c9d0d5", "border-radius:2px"),
    T(1025, 826, it.ll[0].toFixed(5), 13.5, "#2a2f33"),
  );
  s.push(
    T(851, 895, "Radius (nm)", 13.5, "#2a2f33"),
    R(1015, 881, 395, 30, "#fff", "#c9d0d5", "border-radius:2px"),
    T(1025, 896, "50", 13.5, "#2a2f33"),
  );
  return s;
}

async function download(
  path: string,
  init: RequestInit | undefined,
  name: string,
): Promise<string> {
  try {
    const r = await apiFetch(path, init);
    if (!r.ok) return `${name} failed (HTTP ${r.status})`;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return `${name} downloaded`;
  } catch {
    return `${name} failed (network error)`;
  }
}

export function useWatch(): { items: WItem[]; loading: boolean } {
  type SarR = SarFC & { summary: { date: string; label: string } };
  const sar = [
    useJson<SarR>(`/api/intel/dark-vessels/sar?aoi=${SAR_AOIS[0]}`),
    useJson<SarR>(`/api/intel/dark-vessels/sar?aoi=${SAR_AOIS[1]}`),
    useJson<SarR>(`/api/intel/dark-vessels/sar?aoi=${SAR_AOIS[2]}`),
    useJson<SarR>(`/api/intel/dark-vessels/sar?aoi=${SAR_AOIS[3]}`),
  ];
  const choke = useJson<WatchSrc["choke"]>("/api/maritime/chokepoints");
  const jam = useJson<WatchSrc["jam"]>("/api/jamming/nacp");
  const quake = useJson<WatchSrc["quake"]>(
    "/api/seismic/emsc?minmag=2.5&hours=24",
  );
  const warn = useJson<WatchSrc["warn"]>("/api/maritime/warnings");
  const sanc = useJson<FC<SancP>>("/api/sanctions/vessels");
  const [now] = useState(() => Date.now() / 1000);
  const loading = [...sar, choke, jam, quake, warn, sanc].some(
    (r) => r === null,
  );
  const items = watchItems({
    sar: sar
      .map((r) => r?.data)
      .filter((x): x is NonNullable<typeof x> => !!x) as WatchSrc["sar"],
    choke: choke?.data ?? null,
    jam: jam?.data ?? null,
    quake: quake?.data ?? null,
    warn: warn?.data ?? null,
    sanc: sanc?.data ?? null,
    now,
  });
  return { items, loading };
}

type St =
  | { v: "board" }
  | { v: "target"; it: WItem; tab: Tab; send: boolean }
  | { v: "rule"; it: WItem; channel: string };
export function BoardView({
  onHome,
  ban,
  onMap,
}: {
  onHome: () => void;
  ban: string;
  onMap: () => void;
}): JSX.Element {
  const { items, loading } = useWatch();
  const rules = useJson<Rule[]>("/api/alerts/rules");
  const prop = useJson<unknown[]>("/api/actions/proposals");
  const evid =
    useJson<{ props?: { title?: string; source_context?: string } }[]>(
      "/api/evidence",
    );
  const board = useJson<unknown[]>("/api/targets/board");
  const [st, setSt] = useState<St>({ v: "board" });
  const [outcome, setOutcome] = useState({ v: "Confirmed", open: true });
  const [msg, setMsg] = useState<string | null>(null);
  const nProp = prop?.data?.length ?? 0;
  const nEvid = evid?.data?.length ?? 0;
  const boardWhy = board?.ok
    ? "Moves run on the target board"
    : unavailable("Target board", board);
  const s: N[] = [
    R(282, 98, 1590, 916, "#1a1e22"),
    R(405, 184, 1463, 754, "#1a1e22"),
    ...banner(ban),
    ...menubar(onHome),
    ...toolbar(rules?.data?.length ?? 0, nProp, nEvid),
    Hit(1790, 249, 68, 27, "Open the map", onMap),
  ];
  const open = (it: WItem): void =>
    setSt({ v: "target", it, tab: "Overview", send: false });
  if (st.v === "target") {
    const it = st.it;
    // the evidence locker items that name this item (none on this box today)
    const ev = (evid?.data ?? []).filter((e) =>
      JSON.stringify(e).includes(it.ref || it.id),
    ).length;
    // the Send to menu sits over the unshifted board (a63); the panel tabs over the shifted one (a61, a62)
    s.push(
      st.send
        ? frag(boardCols(items, nProp, 406, it.id, open))
        : CLIP(
            406,
            290,
            1461,
            648,
            boardCols(items, nProp, 148.6, it.id, open),
          ),
    );
    const form =
      st.tab === "Assessment"
        ? st.send
          ? [
              T(1336, 432, "Assessment", 13, "#f2f4f6", 600),
              R(1336, 497, 522, 29, "#3c64be", "", "border-radius:2px"),
              T(1597, 512, "Conduct review", 12.5, "#fff", 400, "", "", "c"),
              I("arrow-right", 1664, 512, 13, "#fff"),
            ]
          : assessForm(outcome.v, outcome.open, {
              onOpen: () => setOutcome((o) => ({ ...o, open: !o.open })),
              onPick: (v) => setOutcome({ v, open: false }),
            })
        : null;
    s.push(
      ...panel(
        it,
        st.tab,
        ev,
        boardWhy,
        {
          onClose: () => setSt({ v: "board" }),
          onTab: (tab) => setSt({ ...st, tab }),
          onSend: () => {
            setMsg(null);
            setSt({ ...st, tab: "Assessment", send: !st.send });
          },
        },
        form,
      ),
    );
    if (st.send)
      s.push(
        ...sendMenu(
          msg,
          (i) => {
            const bbox = "bbox=32,10,62,31";
            if (i === 0)
              void download(
                `/api/export?fmt=geojson&kinds=vessel&${bbox}`,
                undefined,
                "velocity-export.geojson",
              ).then(setMsg);
            else if (i === 1)
              void download(
                `/api/export?fmt=csv&kinds=vessel&${bbox}`,
                undefined,
                "velocity-export.csv",
              ).then(setMsg);
            else if (i === 2)
              void download(
                "/api/report/pptx",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    title: `${cardId(it)} ${it.title}`,
                    alerts: items
                      .slice(0, 12)
                      .map((x) => `${cardId(x)} ${x.title}`),
                    sources: [it.link],
                  }),
                },
                "case-report.pptx",
              ).then(setMsg);
            else
              setSt({
                v: "rule",
                it,
                channel: ["inapp", "discord", "webhook"][i - 3]!,
              });
          },
          () => setSt({ ...st, send: false }),
        ),
      );
  } else {
    s.push(
      ...boardCols(
        items,
        nProp,
        406,
        null,
        open,
        st.v === "rule" ? [0] : undefined,
      ),
    );
    if (st.v === "rule")
      s.push(
        ...ruleForm(st.it, st.channel, () =>
          setSt({ v: "target", it: st.it, tab: "Assessment", send: false }),
        ),
      );
    if (!loading && !items.length)
      s.push(
        T(
          1136,
          600,
          "No watch item in the region from the live routes",
          15,
          "#c6ccd2",
          400,
          "",
          "",
          "c",
        ),
      );
  }
  return frag(s);
}
