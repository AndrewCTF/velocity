// Registry Watch Manager: features A29-A33, ported from
// gotham/aip/_build_features_a.py (fm_rail .. a33) over the real sanctions
// registry (/api/sanctions/vessels). Priority = number of sanction programs
// (1 Low, 2 Medium, 3+ High); status from parked/sog. The drawer's actions and
// the modal's Confirm are the real governed actions (POST /api/actions/{name}).
import { useState } from "react";
import { apiFetch } from "../../../transport/http.js";
import { Hit, I, L, R, T, frag, spinner, type N } from "./ui.js";
import { railHits, type FoundryNav } from "./Lineage.js";
import type { Rule } from "./dataB.js";
import {
  comma,
  counter,
  dmy,
  inWatchRegion,
  prio,
  sancRows,
  tsFmt,
  unavailable,
  useJson,
  type FC,
  type Guardrails,
  type Prio,
  type Sanc,
  type SancP,
  type VStatus,
} from "./data.js";

const P_TINT: Record<Prio, [string, string]> = {
  Low: ["#e6f2e8", "#2f6a40"],
  Medium: ["#f6eee4", "#8a5a1a"],
  High: ["#f8eaea", "#9a2a30"],
};
const S_TINT: Record<VStatus, string> = {
  Parked: "#e6f2e8",
  Underway: "#e6eefa",
  Slow: "#f6eee4",
  Stationary: "#f6eee4",
};
const flagOf = (s: Sanc): string => s.vessel_flag || s.flag || "n/a";

function fmRail(nav: (v: FoundryNav) => void): N[] {
  const s: N[] = [R(282, 98, 56, 916, "#1e2224")];
  const items: [number, string][] = [
    [131, "menu-open"],
    [205, "home"],
    [247, "search"],
    [289, "notifications"],
    [366, "history"],
    [410, "folder-open"],
    [494, "search-template"],
    [548, "layers"],
    [601, "data-lineage"],
    [655, "applications"],
    [708, "double-chevron-right"],
    [789, "globe-network"],
    [831, "random"],
    [891, "help"],
  ];
  for (const [y, ic] of items)
    s.push(
      I(
        ic,
        307,
        y,
        18,
        y === 494 || y === 708 ? "#b9a8ff" : y === 548 ? "#e8a24a" : "#cfd5d8",
      ),
    );
  s.push(
    R(302, 284, 8, 8, "#e98a2c", "", "border-radius:50%"),
    T(307, 937, "LP", 13, "#cfd5d8", 400, "", "", "c"),
    I("share", 307, 980, 16, "#cfd5d8"),
  );
  s.push(
    ...railHits(
      nav,
      "registry",
      {
        home: 205,
        build: 494,
        apps: 655,
        lineage: 601,
        board: 289,
        map: 548,
        titan: 789,
        control: 831,
      },
      282,
      56,
    ),
  );
  return s;
}

function fmHeader(nav: (v: FoundryNav) => void): N[] {
  return [
    R(338, 98, 1534, 64, "#fff"),
    L(338, 162, 1872, 162, "#e1e6e8"),
    R(338, 99, 64, 63, "#e8f4ec"),
    I("tick", 369, 130, 24, "#48a268"),
    T(422, 131, "Registry Watch Manager", 20, "#2a2f33", 700),
    I("timeline-bar-chart", 1429, 131, 18, "#2f6fd0"),
    T(1448, 131, "View Chokepoint Counts", 16, "#2a2f33"),
    I("data-lineage", 1657, 131, 18, "#2f6fd0"),
    T(1676, 131, "View Ontology", 16, "#2a2f33"),
    I("help", 1834, 131, 20, "#2a2f33"),
    Hit(1418, 115, 220, 32, "View chokepoint counts in the AIP terminal", () =>
      nav("terminal"),
    ),
    Hit(1646, 115, 160, 32, "View the ontology lineage", () => nav("lineage")),
  ];
}

interface Kpi {
  n: number;
  bg: string;
  label: string;
}
function fmBand(
  rows: Sanc[],
  onConfirm?: () => void,
  kpi?: Kpi,
  onRules?: () => void,
): N[] {
  const watch = kpi ? kpi.n : rows.filter((s) => inWatchRegion(s.xy)).length;
  const park = rows.length
    ? (100 * rows.filter((s) => s.parked).length) / rows.length
    : 0;
  return [
    R(359, 184, 1496, 114, "#e8f4ec", "#d6e6dc"),
    R(380, 224, 36, 35, "#48a268", "", "border-radius:3px"),
    I("box", 398, 241, 20, "#fff"),
    R(437, 224, 316, 38, "#eef2f0", "", "border-radius:2px"),
    T(
      445,
      243,
      <>
        Viewing Registry Matches for{" "}
        <b style={{ color: "#2a2f33" }}>All areas</b>
      </>,
      16.5,
      "#59646a",
    ),
    R(833, 204, 375, 76, kpi?.bg ?? "#facac0"),
    T(
      852,
      242,
      <span style={{ fontSize: 30, color: "#2a2f33" }}>{watch}</span>,
      14,
      "#2a2f33",
    ),
    T(
      876,
      242,
      kpi?.label ?? "REGISTRY WATCH ITEMS PENDING REVIEW",
      13.5,
      "#4a5358",
    ),
    Hit(833, 204, 375, 76, "View the active watch rules", onRules),
    R(1208, 204, 373, 76, "#c4eafc"),
    T(
      1225,
      242,
      <span style={{ fontSize: 30, color: "#2a2f33" }}>
        {park.toFixed(2)}%
      </span>,
      14,
      "#2a2f33",
    ),
    T(1326, 242, "OF REGISTRY MATCHES PARKED", 13.5, "#4a5358"),
    R(1601, 222, 232, 38, "#30844e", "", "border-radius:2px"),
    I("take-action", 1622, 241, 18, "#fff"),
    T(1641, 241, "Confirm Selected Vessels", 16, "#fff"),
    Hit(
      1601,
      222,
      232,
      38,
      "Confirm the selected vessels: add to watch",
      onConfirm,
      "Select a vessel, or filter a status, first",
    ),
  ];
}

function filterPanel(
  rows: Sanc[],
  filtered: VStatus | null,
  onStatus: (s: VStatus) => void,
): N[] {
  const s: N[] = [
    R(359, 319, 375, 675, "#fff", "#e1e6e8"),
    I("filter", 390, 351, 20, "#4a5358"),
    T(419, 352, "Filter Vessels", 16.5, "#2a2f33", 700),
    I("collapse-all", 694, 351, 17, "#4a5358"),
    L(360, 384, 733, 384, "#e1e6e8"),
  ];
  const base = filtered ? rows.filter((r) => r.status === filtered) : rows;
  for (const [y, k, ic] of [
    [425, "HIGH", "double-chevron-up"],
    [471, "MEDIUM", "menu"],
    [517, "LOW", "double-chevron-down"],
  ] as const) {
    const n = base.filter((r) => prio(r.np).toUpperCase() === k).length;
    s.push(
      R(380, y - 21, 333, 42, "#f1f3f5"),
      I(ic, 399, y, 16, "#2a2f33"),
      T(419, y, k, 15, "#2a2f33"),
      T(704, y, comma(n), 15, "#2a2f33", 400, "", "", "r"),
    );
  }
  const cst = counter(rows.map((r) => r.status));
  s.push(T(380, filtered ? 596 : 586, "CURRENT STATUS", 11.5, "#4a5358", 700));
  if (!filtered) {
    s.push(
      T(
        380,
        606,
        <>
          <span style={{ color: "#2f5fc0" }}>Keeping</span> {cst.length} values
        </>,
        11.5,
        "#4a5358",
      ),
      I("search", 704, 597, 17, "#2a2f33"),
    );
    const mx = Math.max(1, ...cst.map(([, n]) => n));
    cst.forEach(([k, n], i) => {
      const y = 634 + i * 35.5;
      s.push(
        R(380, y - 9, 19, 19, "#fff", "#8a9397", "border-radius:2px"),
        T(421, y, k, 15, "#2a2f33"),
        T(642, y, comma(n), 14.5, "#2a2f33", 400, "", "", "r"),
      );
      s.push(
        R(651, y - 7, 63, 14, "#dfe6f4", "", "border-radius:2px"),
        R(651, y - 7, (63 * n) / mx, 14, "#2f5fc0", "", "border-radius:2px"),
      );
      s.push(
        Hit(378, y - 17, 340, 34, `Filter status ${k}`, () => onStatus(k)),
      );
    });
    s.push(
      R(380, 872, 333, 26, "#f4f6f7"),
      T(546, 885, "Show fewer", 13, "#4a5358", 400, "", "", "c"),
    );
    s.push(T(380, 958, "SHIP TYPE", 11.5, "#4a5358", 700));
  } else {
    const k = filtered;
    const y = 634;
    const n = cst.find(([x]) => x === k)?.[1] ?? 0;
    s.push(
      R(380, y - 9, 19, 19, "#2f5fc0", "", "border-radius:2px"),
      I("tick", 390, y, 14, "#fff"),
      T(421, y, k, 15, "#2a2f33"),
      T(642, y, comma(n), 14.5, "#2a2f33", 400, "", "", "r"),
      R(651, y - 7, 63, 14, "#2f5fc0", "", "border-radius:2px"),
    );
    s.push(
      Hit(378, y - 17, 340, 34, `Clear the ${k} filter`, () => onStatus(k)),
    );
    const cc = counter(base.map((r) => r.cls));
    const cf = counter(base.map(flagOf));
    s.push(T(380, 711, "SHIP TYPE", 11.5, "#4a5358", 700));
    cc.slice(0, 2).forEach(([nm, c], i) => {
      const y2 = 749 + i * 35;
      s.push(
        R(380, y2 - 9, 19, 19, "#fff", "#8a9397", "border-radius:2px"),
        T(421, y2, nm, 15, "#2a2f33"),
        T(642, y2, String(c), 14.5, "#2a2f33", 400, "", "", "r"),
        R(651, y2 - 7, 63, 14, "#2f5fc0", "", "border-radius:2px"),
      );
    });
    s.push(T(380, 845, "FLAG", 11.5, "#4a5358", 700));
    cf.slice(0, 2).forEach(([nm, c], i) => {
      const y2 = 885 + i * 35;
      s.push(
        R(380, y2 - 9, 19, 19, "#fff", "#8a9397", "border-radius:2px"),
        T(421, y2, nm.slice(0, 22), 15, "#2a2f33"),
        T(642, y2, String(c), 14.5, "#2a2f33", 400, "", "", "r"),
        R(651, y2 - 7, 63, 14, "#2f5fc0", "", "border-radius:2px"),
      );
    });
  }
  return s;
}

function sancTable(rows: Sanc[], onRow: (r: Sanc) => void): N[] {
  const s: N[] = [
    R(735, 319, 1120, 675, "#fff", "#e1e6e8"),
    R(736, 320, 1118, 62, "#f4f6f7"),
    L(736, 382, 1854, 382, "#e1e6e8"),
  ];
  const cx = [755, 982, 1132, 1416, 1566];
  [
    "Vessel Type",
    "Speed (kn)",
    "Vessel Name",
    "Programs",
    "Current Status",
  ].forEach((h, i) => s.push(T(cx[i]!, 351, h, 14, "#2a2f33", 700)));
  for (const x of [967, 1116, 1401, 1551]) s.push(L(x, 320, x, 994, "#e6eaec"));
  if (rows.length < 6)
    for (
      let j = 0;
      j < Math.trunc((994 - (383 + rows.length * 51)) / 25.5);
      j++
    ) {
      const yy = 383 + rows.length * 51 + (j + 1) * 25.5;
      s.push(L(736, Math.trunc(yy), 1854, Math.trunc(yy), "#dfe4e7"));
    }
  for (let i = 0; i < 11; i++) {
    const y = 383 + i * 51;
    if (rows.length >= 6) s.push(L(736, y + 51, 1854, y + 51, "#e8ecee"));
    const r = rows[i];
    if (!r) continue;
    s.push(L(736, y + 51, 1854, y + 51, "#e8ecee"));
    const yc = y + 25.5;
    const pr = prio(r.np);
    const [pb, pf] = P_TINT[pr];
    const sb = S_TINT[r.status];
    s.push(
      R(1402, y, 148, 50, pb),
      R(1552, y, 286, 50, sb),
      R(1839, y, 15, 50, sb),
    );
    s.push(
      R(755, yc - 12, 110, 24, "#cfe2f8", "", "border-radius:3px"),
      R(759, yc - 8, 16, 16, "#2f6fd0", "", "border-radius:3px"),
      I("cube", 767, yc, 10, "#fff"),
      T(783, yc, r.cls, 13.5, "#2f5fc0"),
    );
    s.push(
      T(982, yc, r.sogN.toFixed(1), 15.5, "#2a2f33"),
      T(1132, yc, r.name.slice(0, 24), 15.5, "#2a2f33"),
      T(1416, yc, `${pr} (${r.np})`, 15.5, pf),
      T(1566, yc, r.status, 15.5, "#2a2f33"),
    );
    s.push(Hit(736, y, 1118, 50, `Open ${r.name}`, () => onRow(r)));
  }
  return s;
}

type Phase = {
  name: string;
  state: "busy" | "ok" | "error";
  msg: string;
} | null;

async function act(
  name: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; msg: string }> {
  try {
    const r = await apiFetch(`/api/actions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (r.ok) return { ok: true, msg: "" };
    const j = (await r.json().catch(() => ({}))) as { detail?: unknown };
    const d = typeof j.detail === "string" ? `: ${j.detail.slice(0, 60)}` : "";
    return { ok: false, msg: `HTTP ${r.status}${d}` };
  } catch {
    return { ok: false, msg: "network error" };
  }
}

function drawer(
  v: Sanc,
  all: Sanc[],
  phase: Phase,
  h: {
    onClose: () => void;
    onAct: (name: string) => void;
    onAck: () => void;
    tools: string[];
  },
): N[] {
  const nm = `${v.name}_${v.mmsi}`;
  const s: N[] = [
    R(282, 98, 210, 916, "rgba(30,34,38,.55)"),
    Hit(282, 98, 210, 916, "Close the vessel view", h.onClose),
  ];
  s.push(
    R(492, 98, 1380, 916, "#f2f6f6", "", "border-left:1px solid #d9dfe2"),
    R(492, 98, 1380, 54, "#fff"),
    L(492, 152, 1872, 152, "#e3e8ea"),
  );
  s.push(
    I("box", 529, 125, 22, "#4a5358"),
    T(554, 125, "Vessel Object View", 20, "#2a2f33", 700),
    I("cross", 1850, 125, 17, "#2a2f33"),
    Hit(1836, 111, 28, 28, "Close the vessel view", h.onClose),
  );
  s.push(R(513, 172, 1342, 78, "#fff", "#e3e8ea"));
  const btns: [number, string, string, string, string][] = [
    [533, "#f0a65c", "refresh", "Update", "flag_entity"],
    [971, "#b63242", "upload", "Escalate", "promote_incident"],
    [1408, "#3268c2", "comment", "Comment", ""],
  ];
  for (const [x0, c, ic, lab, tool] of btns) {
    s.push(
      R(x0, 193, 425, 38, c, "", "border-radius:1px"),
      I(ic, x0 + 425 / 2 - 38, 212, 19, "#fff"),
      T(x0 + 425 / 2 - 20, 212, lab, 16, "#fff"),
    );
    const live = tool && h.tools.includes(tool) && phase?.state !== "busy";
    s.push(
      Hit(
        x0,
        193,
        425,
        38,
        tool ? `${lab}: ${tool}` : lab,
        live ? () => h.onAct(tool) : undefined,
        tool ? "Action not available" : "No comment action on this box",
      ),
    );
  }
  if (phase)
    s.push(
      T(
        1853,
        162,
        phase.state === "busy"
          ? `${phase.name}: running`
          : phase.state === "ok"
            ? `${phase.name}: done`
            : `${phase.name} failed (${phase.msg})`,
        12.5,
        phase.state === "error" ? "#b63242" : "#4a5358",
        400,
        "",
        "",
        "r",
      ),
    );
  s.push(
    R(513, 273, 1342, 62, "#f8eaea"),
    I("envelope", 543, 305, 20, "#b63242"),
    R(572, 288, 218, 34, "#f1dede", "", "border-radius:2px"),
    T(
      581,
      305,
      <>
        New Registry Match <b>{all.filter((r) => r.mmsi === v.mmsi).length}</b>
      </>,
      15.5,
      "#4a5358",
    ),
  );
  s.push(
    I("tick-circle", 1533, 305, 20, "#2e8a4a"),
    T(1552, 305, "Acknowledge Registry Match", 16, "#2e6a4a"),
    Hit(1520, 290, 240, 30, "Acknowledge: add to watch", h.onAck),
  );
  s.push(
    R(513, 357, 1342, 62, "#fff"),
    R(531, 365, 51, 49, "#3f73d6", "", "border-radius:3px"),
    I("th", 556, 389, 28, "#fff"),
  );
  s.push(
    T(
      595,
      379,
      <>
        {nm} <span style={{ color: "#8a9397" }}>☆</span>
      </>,
      15.5,
      "#2a2f33",
      700,
    ),
    T(595, 404, "[Velocity] Vessel", 14.5, "#4a5358"),
  );
  const card = (
    x: number,
    y: number,
    w: number,
    hh: number,
    ic: string,
    big: string,
    small: string,
    color = "#2a2f33",
    icc = "#2a2f33",
  ): N[] => [
    R(x, y, w, hh, "#fff", "#e3e8ea"),
    I(ic, x + 33, y + hh / 2, 28, icc),
    T(x + 66, y + hh / 2 - 12, big, 22, color),
    T(x + 66, y + hh / 2 + 17, small, 14.5, "#4a5358"),
  ];
  s.push(...card(551, 448, 1265, 72, "home", v.name, "Vessel Name"));
  s.push(
    ...card(
      551,
      547,
      1265,
      72,
      "comment",
      `${v.sanction_list}: ${(v.sanction_programs ?? []).join(", ")}`,
      `Registry Match (matched on ${v.sanction_matched_on}, ${v.sanction_confidence})`,
      "#2a2f33",
      "#e0705a",
    ),
  );
  s.push(
    ...card(
      551,
      646,
      413,
      85,
      "warning-sign",
      `${prio(v.np)} (${v.np})`,
      "Programs",
      "#9a2a30",
    ),
  );
  s.push(
    ...card(
      978,
      646,
      412,
      85,
      "box",
      `${v.sogN.toFixed(1)} kn`,
      "Speed over Ground",
    ),
  );
  s.push(
    ...card(
      1404,
      646,
      412,
      85,
      "search-template",
      `${v.cls} (AIS ${v.shipType ?? "n/a"})`,
      "Ship Type",
    ),
  );
  s.push(
    ...card(
      551,
      757,
      626,
      73,
      "calendar",
      dmy(new Date(v.t * 1000)),
      "Last Fix At (UTC)",
    ),
    ...card(
      1190,
      757,
      626,
      73,
      "person",
      v.source || "n/a",
      "Last Updated By (feed)",
    ),
  );
  const others = all.filter((r) => r.mmsi !== v.mmsi);
  s.push(
    R(550, 856, 1267, 140, "#fff", "#e3e8ea"),
    I("inbox", 579, 881, 19, "#4a5358"),
    T(602, 881, "More Registry Matches", 15.5, "#2a2f33"),
    T(1673, 881, `${others.length} results`, 14.5, "#6a7378", 400, "", "", "r"),
  );
  s.push(
    I("th-list", 1698, 881, 17, "#4a5358"),
    T(1741, 881, "•••", 14, "#2a2f33", 700, "", "", "c"),
    I("filter", 1779, 881, 17, "#2a2f33"),
  );
  s.push(
    L(551, 907, 1816, 907, "#e1e6e8"),
    R(569, 917, 18, 18, "#fff", "#8a9397", "border-radius:2px"),
  );
  for (const [x, hd] of [
    [646, "TITLE"],
    [934, "PROGRAMS"],
    [1220, "LAST FIX"],
    [1469, "VESSEL NAME"],
    [1757, "CR…"],
  ] as const)
    s.push(T(x, 926, hd, 12.5, "#4a5358", 700));
  const r0 = others[0];
  if (r0)
    s.push(
      R(569, 960, 18, 18, "#fff", "#8a9397", "border-radius:2px"),
      I("th", 661, 970, 14, "#2f6fd0"),
      T(683, 970, `${r0.name}_${r0.mmsi}`.slice(0, 20), 14.5, "#2f6fd0"),
      T(934, 970, String(r0.np), 14.5, "#2a2f33"),
      T(1220, 970, tsFmt(new Date(r0.t * 1000).toISOString()), 14.5, "#2a2f33"),
      T(1469, 970, r0.name, 14.5, "#2a2f33"),
      I("cog", 1796, 926, 18, "#2a2f33"),
    );
  return s;
}

function modal(
  v: Sanc,
  phase: Phase,
  h: { onCancel: () => void; onConfirm?: (() => void) | undefined },
): N[] {
  const nm = `${v.name}_${v.mmsi}`;
  const s: N[] = [
    R(282, 98, 1590, 916, "#4a4f52"),
    R(
      764,
      396,
      623,
      321,
      "#fff",
      "#d9dfe2",
      "box-shadow:0 6px 30px rgba(0,0,0,.35);border-radius:2px",
    ),
  ];
  s.push(
    R(765, 397, 621, 52, "#fff"),
    L(765, 449, 1386, 449, "#e3e8ea"),
    T(789, 423, "Confirm Add to Watch", 18, "#2a2f33"),
    I("cross", 1362, 423, 18, "#2a2f33"),
  );
  s.push(
    T(
      789,
      477,
      <>
        [VELOCITY] VESSEL <span style={{ color: "#b63242" }}>*</span>
      </>,
      12.5,
      "#4a5358",
    ),
    R(789, 495, 573, 36, "#eef2f4", "#c9d0d5", "border-radius:2px"),
  );
  s.push(
    R(802, 505, 20, 18, "#3f73d6", "", "border-radius:2px"),
    I("th", 812, 514, 12, "#fff"),
    T(830, 513, nm, 15.5, "#2a2f33"),
    I("cross", 1315, 513, 13, "#4a5358"),
    I("caret-down", 1340, 513, 14, "#4a5358"),
  );
  s.push(
    T(
      789,
      560,
      <>
        ACTION <span style={{ color: "#b63242" }}>*</span>
      </>,
      12.5,
      "#4a5358",
    ),
    R(789, 578, 573, 38, "#fff", "#8a9397", "border-radius:2px"),
    T(801, 597, "add_watch", 15.5, "#2a2f33"),
  );
  s.push(R(765, 654, 621, 62, "#f4f6f7"), L(765, 654, 1386, 654, "#e3e8ea"));
  if (phase?.state === "busy") s.push(spinner(801, 686, 9));
  else if (phase)
    s.push(
      T(
        789,
        686,
        phase.state === "ok"
          ? "Watch added"
          : `add_watch failed (${phase.msg})`,
        13.5,
        phase.state === "ok" ? "#2e6a4a" : "#b63242",
      ),
    );
  s.push(
    R(1193, 667, 73, 38, "#fff", "#c9d0d5", "border-radius:2px"),
    T(1229, 686, "Cancel", 15.5, "#2a2f33", 400, "", "", "c"),
    R(1279, 667, 83, 38, "#308450", "", "border-radius:2px"),
    T(1320, 686, "Confirm", 15.5, "#fff", 400, "", "", "c"),
  );
  s.push(
    Hit(1348, 409, 28, 28, "Close", h.onCancel),
    Hit(1193, 667, 73, 38, "Cancel", h.onCancel),
    Hit(
      1279,
      667,
      83,
      38,
      "Confirm: add to watch",
      h.onConfirm,
      "add_watch is not in this box's action tools",
    ),
  );
  return s;
}

/** A34: the after-state of a real add_watch: the toast and the rule panel quote the rule the API now holds. */
function savedPanel(rules: Rule[], toast: boolean, onClose: () => void): N[] {
  const rule = rules[rules.length - 1];
  const s: N[] = [
    R(282, 98, 1051, 916, "rgba(30,34,38,0.49)"),
    Hit(282, 98, 1051, 916, "Close", onClose),
  ];
  // the toast only after an add_watch this session actually ran
  if (toast)
    s.push(
      R(
        877,
        126,
        398,
        50,
        "#2d8a46",
        "",
        "border-radius:2px;box-shadow:0 2px 8px rgba(0,0,0,.25)",
      ),
      I("tick", 901, 151, 18, "#fff"),
      T(925, 151, "Watch rule saved!", 16.5, "#fff"),
      I("cross", 1250, 151, 15, "#fff"),
      Hit(1238, 139, 26, 26, "Dismiss", onClose),
    );
  s.push(
    R(1333, 98, 539, 916, "#fff", "", "box-shadow:-4px 0 14px rgba(0,0,0,.18)"),
    I("box", 1370, 125, 22, "#4a5358"),
    T(1395, 125, "Vessel Object View", 20, "#2a2f33", 700),
    L(1334, 152, 1871, 152, "#e3e8ea"),
  );
  s.push(
    R(1353, 172, 519, 78, "#fff", "#e3e8ea"),
    R(1374, 193, 444, 38, "#f0a65c", "", "border-radius:1px"),
    I("refresh", 1556, 212, 19, "#fff"),
    T(1583, 212, "Update", 16, "#fff"),
    R(1831, 193, 41, 38, "#b63242"),
  );
  s.push(
    R(1353, 273, 519, 62, "#f8eaea"),
    I("envelope", 1384, 305, 20, "#b63242"),
    R(1413, 288, 218, 34, "#f1dede", "", "border-radius:2px"),
    T(
      1422,
      305,
      <>
        Active Watch Rules <b>{rules.length}</b>
      </>,
      15.5,
      "#4a5358",
    ),
  );
  s.push(
    R(1353, 357, 519, 62, "#fff"),
    R(1372, 364, 50, 50, "#3f73d6", "", "border-radius:3px"),
    I("th", 1397, 389, 28, "#fff"),
  );
  s.push(
    T(
      1435,
      379,
      <>
        {rule?.label ?? "n/a"} <span style={{ color: "#8a9397" }}>☆</span>
      </>,
      15.5,
      "#2a2f33",
      700,
    ),
    T(1435, 404, "[Velocity] Alert Rule", 14.5, "#4a5358"),
  );
  s.push(R(1393, 446, 479, 252, "#e8eaec"), R(1393, 727, 479, 253, "#e8eaec"));
  return s;
}

/** A35: confirm add_watch for every vessel the status filter keeps. */
function bulkModal(
  sel: Sanc[],
  phase: Phase,
  h: { onCancel: () => void; onGo?: (() => void) | undefined },
): N[] {
  const progs = new Set(sel.flatMap((v) => v.sanction_programs ?? []));
  const s: N[] = [
    R(282, 98, 1590, 916, "rgba(30,34,38,0.49)"),
    Hit(282, 98, 1590, 916, "Cancel", h.onCancel),
  ];
  s.push(
    R(
      582,
      426,
      988,
      263,
      "#fff",
      "#d9dfe2",
      "box-shadow:0 6px 30px rgba(0,0,0,.35)",
    ),
    R(602, 446, 948, 121, "#fff", "#e3e8ea"),
    R(602, 589, 948, 79, "#fff", "#e3e8ea"),
  );
  s.push(
    R(623, 468, 233, 77, "#fff", "#e3e8ea"),
    R(641, 486, 40, 40, "#2f6fd0", "", "border-radius:2px"),
    I("shield", 661, 506, 22, "#fff"),
    T(
      698,
      506,
      <span style={{ fontSize: 17 }}>{sel.length}</span>,
      17,
      "#2a2f33",
    ),
    T(745, 507, "Registry matches", 14.5, "#4a5358"),
  );
  s.push(
    R(857, 468, 233, 77, "#fff", "#e3e8ea"),
    R(875, 486, 40, 40, "#2f6fd0", "", "border-radius:2px"),
    I("tag", 895, 506, 22, "#fff"),
    T(
      932,
      506,
      <span style={{ fontSize: 17 }}>{progs.size}</span>,
      17,
      "#2a2f33",
    ),
    T(962, 507, "Sanction programs", 14.5, "#4a5358"),
  );
  s.push(
    R(1111, 468, 418, 77, "#c4f6b0", "#d6e8d0"),
    R(1129, 486, 40, 40, "#2f8a4a", "", "border-radius:2px"),
    I("tick", 1149, 506, 20, "#fff"),
    T(
      1187,
      507,
      "Selected vessels are on the active registry list",
      16,
      "#2a2f33",
    ),
  );
  s.push(
    R(622, 610, 906, 38, "#2e8a48", "", "border-radius:2px"),
    I("take-action", 976, 629, 20, "#fff"),
    T(995, 629, "Create Watch Rules for Selected", 16.5, "#fff"),
    Hit(
      622,
      610,
      906,
      38,
      `add_watch for ${sel.length} vessels`,
      h.onGo,
      "add_watch is not in this box's action tools",
    ),
  );
  if (phase)
    s.push(
      T(
        1075,
        675,
        phase.state === "busy"
          ? `add_watch: ${phase.msg}`
          : phase.state === "ok"
            ? "Watch rules added"
            : `add_watch failed (${phase.msg})`,
        13.5,
        phase.state === "error" ? "#b63242" : "#4a5358",
        400,
        "",
        "",
        "c",
      ),
    );
  return s;
}

export function RegistryView({
  nav,
}: {
  nav: (v: FoundryNav) => void;
}): JSX.Element {
  const res = useJson<FC<SancP>>("/api/sanctions/vessels");
  const guard = useJson<Guardrails>("/api/ai/guardrails");
  const [filtered, setFiltered] = useState<VStatus | null>(null);
  const [open, setOpen] = useState<Sanc | null>(null);
  const [picked, setPicked] = useState<Sanc | null>(null);
  const [confirm, setConfirm] = useState<Sanc | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [bulk, setBulk] = useState<Sanc[] | null>(null);
  const [saved, setSaved] = useState(0);
  const [rulesView, setRulesView] = useState<"none" | "view" | "saved">("none");
  const rules = useJson<Rule[]>("/api/alerts/rules", saved);
  const tools = guard?.data?.action_tools ?? [];
  const all = sancRows(res?.data ?? null);
  const order = [...all].sort(
    (a, b) => b.np - a.np || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const rows = order.filter((r) => !filtered || r.status === filtered);

  const run = async (name: string, v: Sanc): Promise<void> => {
    setPhase({ name, state: "busy", msg: "" });
    const target_id = `vessel:${v.mmsi}`;
    const params: Record<string, unknown> =
      name === "add_watch"
        ? { target_id, label: v.name, lat: v.xy[1], lon: v.xy[0] }
        : name === "promote_incident"
          ? {
              target_id,
              title: `Registry match: ${v.name}`,
              note: `${v.sanction_list}: ${(v.sanction_programs ?? []).join(", ")}`,
            }
          : {
              target_id,
              note: `Registry match reviewed: ${v.sanction_list}`,
              severity: Math.min(5, 2 + v.np),
            };
    // as EntityPanel's ActionsCard does: mint the vessel with its registry
    // props first and await it, so the action's upsert keeps them
    const trigger = { flag_entity: "flag", add_watch: "watch" }[name];
    if (trigger)
      await apiFetch("/api/ontology/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: target_id,
          props: {
            name: v.name,
            mmsi: v.mmsi,
            sog: v.sog,
            shipType: v.shipType,
            sanction_list: v.sanction_list,
            sanction_programs: v.sanction_programs,
          },
          trigger,
        }),
      }).catch(() => undefined);
    const r = await act(name, params);
    setPhase({ name, state: r.ok ? "ok" : "error", msg: r.msg });
    if (r.ok && name === "add_watch") {
      setConfirm(null);
      setOpen(null);
      setSaved((n) => n + 1);
      setRulesView("saved");
    }
  };
  const runBulk = async (sel: Sanc[]): Promise<void> => {
    for (const [i, v] of sel.entries()) {
      setPhase({
        name: "add_watch",
        state: "busy",
        msg: `${i + 1} of ${sel.length}`,
      });
      const target_id = `vessel:${v.mmsi}`;
      const r = await act("add_watch", {
        target_id,
        label: v.name,
        lat: v.xy[1],
        lon: v.xy[0],
      });
      if (!r.ok)
        return setPhase({ name: "add_watch", state: "error", msg: r.msg });
    }
    setBulk(null);
    setPhase(null);
    setSaved((n) => n + 1);
    setRulesView("saved");
  };

  const s: N[] = [
    R(282, 98, 1590, 916, "#f2f6f6"),
    ...fmRail(nav),
    ...fmHeader(nav),
  ];
  const kpi =
    rulesView !== "none" && rules?.data
      ? { n: rules.data.length, bg: "#c9f0bf", label: "WATCH RULES ACTIVE" }
      : undefined;
  const onBand = picked
    ? () => {
        setPhase(null);
        setConfirm(picked);
      }
    : filtered
      ? () => {
          setPhase(null);
          setBulk(rows);
        }
      : undefined;
  s.push(...fmBand(all, onBand, kpi, () => setRulesView("view")));
  if (!res?.ok) {
    s.push(
      ...filterPanel([], null, () => undefined),
      ...sancTable([], () => undefined),
    );
    s.push(
      T(
        1295,
        420,
        unavailable("Sanctions registry", res),
        16,
        "#59646a",
        400,
        "",
        "",
        "c",
      ),
    );
    return frag(s);
  }
  s.push(
    ...filterPanel(all, filtered, (k) =>
      setFiltered((f) => (f === k ? null : k)),
    ),
  );
  s.push(
    ...sancTable(rows, (r) => {
      setPhase(null);
      setOpen(r);
      setPicked(r);
    }),
  );
  if (bulk) {
    s.push(
      ...bulkModal(bulk, phase, {
        onCancel: () => {
          setBulk(null);
          setPhase(null);
        },
        onGo:
          tools.includes("add_watch") && phase?.state !== "busy"
            ? () => void runBulk(bulk)
            : undefined,
      }),
    );
  } else if (rulesView !== "none" && rules?.data && !confirm && !open) {
    s.push(
      ...savedPanel(rules.data, rulesView === "saved", () =>
        setRulesView("none"),
      ),
    );
  } else if (confirm) {
    s.push(
      ...modal(confirm, phase, {
        onCancel: () => {
          setConfirm(null);
          setPhase(null);
        },
        onConfirm:
          tools.includes("add_watch") && phase?.state !== "busy"
            ? () => void run("add_watch", confirm)
            : undefined,
      }),
    );
  } else if (open) {
    s.push(
      ...drawer(open, all, phase, {
        onClose: () => {
          setOpen(null);
          setPhase(null);
        },
        onAct: (name) => void run(name, open),
        onAck: () => {
          setPhase(null);
          setConfirm(open);
        },
        tools,
      }),
    );
  }
  return frag(s);
}
