// Object Explorer (gotham-007-031, D1 D3 D14 D15 D16 D17): sec_explorer() of
// _build_gotham_a.py in the 1161 x 653 figure's pixels.
import { createElement, useState } from "react";
import { A, Hit, I, T, Tc, Tr, frag, type N } from "./kit.js";
import {
  funnel,
  propCounts,
  unavailable,
  valueHist,
  type Step,
} from "./data.js";
import type { Ctx } from "./model.js";

export const BG = "#121418";
const PN = "#242a30";
const BLU = "#8abcfe";

/** nodes drawn at (dx, dy) from their figure position: how a region follows the
 *  surface edge it is pinned to */
const G = (dx: number, dy: number, nodes: N[]): N =>
  createElement(
    "div",
    { className: "g", style: { left: dx, top: dy } },
    ...nodes,
  );

const STEP_TXT: Record<Step, [string, string]> = {
  box: ["Keeping Objects with Last fix", "within the recorder box"],
  radius: ["Keeping Objects with Last fix", "within 10 km of"],
  stationary: ["Keeping Objects with Speed", "over ground matching any of"],
  origin: ["Keeping Objects with property", "types matching any of"],
};

/** dw / dh: how far the surface outgrows the figure's content crop; the
 *  results panel and the filter path stretch by them, as the live app does. */
export function Explorer({
  c,
  dw = 0,
  dh = 0,
}: {
  c: Ctx;
  dw?: number;
  dh?: number;
}): JSX.Element {
  const [steps, setSteps] = useState<Step[]>(["box", "radius", "stationary"]);
  const [prop, setProp] = useState("Origin");
  const W = 1161,
    H = 653;
  const HAMS = (c.place?.name ?? "").replace("Lpg", "LPG");
  const { stages, set: F_SET } = funnel(
    c.status?.vessel_count ?? 0,
    c.box,
    c.place,
    steps,
  );
  const PROPS = propCounts(F_SET);
  const nprop = PROPS.reduce((a, p) => a + p[1], 0);
  const TYPEH = valueHist(F_SET, prop);
  const o: N[] = [A(0, 0, W + dw, H + dh, `background:${BG}`)];
  // the banner, tabs bar, menu row and rail (y < 58, x < 26) are the console's own
  // shell chrome; PdfApp crops them off and the shell draws its own.
  // results panel
  o.push(
    A(41, 72, 927 + dw, 568 + dh, `background:${PN};border:1px solid #333a42`),
  );
  o.push(A(42, 73, 925 + dw, 59, `background:${BG}`));
  const n_set = F_SET.length;
  o.push(
    I("database", 59, 95, 14, "#c3ccd2"),
    T(73, 95, "Results", "#f1f4f5", 12.5),
    Tr(937 + dw, 95, `${n_set} objects`, "#c3ccd2", 9.5, 120),
  );
  const tabs: [string, number, string, string, number, number][] = [
    ["Types", 54, "#f1f4f5", String(n_set), 82, 105],
    ["Properties", 117, BLU, String(nprop), 166, 189],
    ["Links", 201, "#f1f4f5", "0", 228, 250],
  ];
  for (const [t_, x, col, b, bx, bx2] of tabs)
    o.push(
      T(x, 118, t_, col, 10, 400, "font-weight:500"),
      A(bx, 111, bx2 - bx, 14, "background:#323a42;border-radius:2px"),
      Tc((bx + bx2) / 2, 118, b, "#c3ccd2", 8, 40),
    );
  o.push(
    A(118, 130, 70, 2, `background:${BLU}`),
    T(264, 118, "Timeline", "#f1f4f5", 10.5),
    A(316, 112, 1, 14, "background:#4a525a"),
    I("search", 335, 118, 11, "#c3ccd2"),
    T(347, 118, "Search", "#f1f4f5", 10.5),
  );
  o.push(
    Hit(
      50,
      110,
      58,
      16,
      "Types",
      undefined,
      "Every object in this set is a Vessel",
    ),
    Hit(
      198,
      110,
      56,
      16,
      "Links",
      undefined,
      "Links of one object live in its object view",
    ),
    Hit(
      260,
      110,
      50,
      16,
      "Timeline",
      undefined,
      "The box pull carries only each hull's latest fix",
    ),
    Hit(328, 110, 54, 16, "Search: the Browser", () => c.go("browser")),
  );
  o.push(
    T(823 + dw, 118, "View as", "#c3ccd2", 9.5),
    T(858 + dw, 118, "Histogram chart", "#f1f4f5", 9.5),
    I("caret-down", 928 + dw, 118, 9, "#c3ccd2"),
  );
  o.push(
    A(42, 132, 193, 472 + dh, `background:${PN}`),
    A(235, 132, 1, 472 + dh, "background:#333a42"),
  );
  o.push(
    T(
      51,
      145,
      "OBJECT PROPERTIES",
      "#aab4bc",
      8.5,
      400,
      "font-weight:700;letter-spacing:.03em",
    ),
    I("search", 219, 145, 11, "#c3ccd2"),
  );
  const top = Math.max(PROPS[0]?.[1] ?? 1, 1);
  PROPS.slice(0, 15).forEach(([nm, cnt], k) => {
    const yc = 166 + k * 15.5;
    if (nm === prop)
      o.push(
        A(
          48,
          yc - 7.5,
          180,
          14,
          "background:#263850;border:1px solid #4a78b8;border-radius:1px",
        ),
      );
    o.push(A(63, yc - 3, 6, 6, "background:#4a525a;border-radius:3px"));
    o.push(T(76, yc, nm, nm === prop ? BLU : "#f1f4f5", 9.5));
    o.push(Tr(187, yc, String(cnt), "#aab4bc", 9, 30));
    o.push(
      A(192, yc - 4.5, 32, 9, "background:#1a1e24"),
      A(192, yc - 4.5, (32 * cnt) / top, 9, "background:#8abcfe"),
    );
    o.push(Hit(48, yc - 7.5, 180, 14, `Histogram of ${nm}`, () => setProp(nm)));
  });
  if (!c.boxRes?.ok)
    o.push(T(76, 166, unavailable("AIS box", c.boxRes), "#aab4bc", 9.5));
  o.push(
    T(
      261,
      145,
      prop.toUpperCase(),
      "#aab4bc",
      8.5,
      400,
      "font-weight:700;letter-spacing:.03em",
    ),
    I("search", 936 + dw, 145, 11, "#c3ccd2"),
  );
  const topn = Math.max(1, ...TYPEH.map((t) => t[1]));
  TYPEH.slice(0, 12).forEach(([nm, cnt], k) => {
    const yc = 166 + k * 15.5;
    o.push(
      T(254, yc, nm, "#f1f4f5", 9.5, 400, "max-width:390px;overflow:hidden"),
      Tr(678, yc, String(cnt), "#aab4bc", 9, 30),
      A(683, yc - 4.5, 258 + dw, 9, "background:#1a1e24"),
      A(
        683,
        yc - 4.5,
        Math.max(2, ((258 + dw) * cnt) / topn),
        9,
        "background:#8abcfe",
      ),
    );
  });
  // filter sentence bar
  const fb: N[] = [],
    fbr: N[] = [];
  fb.push(
    A(42, 604, 925 + dw, 36, `background:${PN};border-top:1px solid #333a42`),
  );
  fb.push(
    A(
      47,
      612,
      101,
      21,
      "background:#2a3038;border:1px solid #4a525a;border-radius:2px",
    ),
    T(54, 622, "Filter property type", "#f1f4f5", 9.5),
    I("caret-down", 137, 622, 9, "#c3ccd2"),
  );
  fb.push(
    T(155, 622, "Keeping", BLU, 9.5, 400, "text-decoration:underline"),
    T(190, 622, "Objects with property types matching any of", "#dfe5e7", 8.8),
    T(372, 622, prop, "#dfe5e7", 8.8, 400, "border-bottom:1px dashed #8a949c"),
  );
  fbr.push(
    T(780, 622, "Clear selection", "#f1f4f5", 9.5),
    A(855, 612, 92, 21, "background:#2e72d2;border-radius:2px"),
    I("filter", 868, 622, 10, "#fff"),
    T(881, 622, "Add to filter path", "#fff", 9.5, 400, "font-weight:600"),
  );
  const canAdd =
    prop === "Origin" && !steps.includes("origin") && steps.length < 4;
  fb.push(
    Hit(
      47,
      612,
      101,
      21,
      "Filter property type",
      undefined,
      "Pick a property in the list on the left",
    ),
  );
  fbr.push(
    Hit(
      776,
      614,
      74,
      16,
      "Clear selection",
      prop !== "Origin" ? () => setProp("Origin") : undefined,
      "Origin is the default selection",
    ),
    Hit(
      855,
      612,
      92,
      21,
      "Add to filter path",
      canAdd ? () => setSteps((s) => [...s, "origin"]) : undefined,
      prop === "Origin"
        ? "Origin is already on the filter path"
        : "Only the Origin property has a filter step",
    ),
  );
  o.push(G(0, dh, [...fb, G(dw, 0, fbr)]));
  // right panel: filter path
  const rp: N[] = [],
    rpb: N[] = [];
  rp.push(A(968, 58, 193, 595 + dh, `background:${BG}`));
  rp.push(
    A(968, 58, 193, 86, `background:${PN}`),
    I("chevron-left", 983, 75, 10, "#c3ccd2"),
    T(992, 75, "Back to home", "#c3ccd2", 9.5),
    A(969, 90, 191, 1, "background:#333a42"),
  );
  rp.push(
    Hit(978, 67, 70, 16, "Back to home: the Browser", () => c.go("browser")),
  );
  rp.push(
    I("layers", 985, 108, 13, "#ee3b86"),
    T(996, 108, "New exploration", "#f1f4f5", 11, 400, "font-weight:600"),
    A(1121, 107, 31, 20, "background:#323842;border-radius:2px"),
    Tc(1136, 117, "Save", "#6b7680", 9, 40),
  );
  rp.push(
    Hit(
      1121,
      107,
      31,
      20,
      "Save",
      undefined,
      "Explorations are not stored; the filter path lives while this app is open",
    ),
  );
  rp.push(T(977, 128, "Source: All objects", "#c3ccd2", 9.5));
  rp.push(
    A(969, 144, 191, 1, "background:#333a42"),
    A(968, 145, 193, 38, `background:${PN}`),
    T(977, 160, "Filter path", "#c3ccd2", 9.5),
    A(1107, 151, 45, 20, "border:1px solid #c3ccd2;border-radius:2px"),
    Tc(1129, 161, "Clear all", "#f1f4f5", 9.5, 60),
  );
  rp.push(
    Hit(
      1107,
      151,
      45,
      20,
      "Clear all",
      steps.length ? () => setSteps([]) : undefined,
      "The filter path is empty",
    ),
  );
  const slots: [number, number][] = [
    [184, 264],
    [264, 345],
    [345, 423],
    [423, 503],
  ];
  stages.forEach((sg, i) => {
    const [y0_, y1_] = slots[i]!;
    const lines = STEP_TXT[sg.step];
    const term =
      sg.step === "radius"
        ? HAMS
        : sg.step === "stationary"
          ? "0.0 kn"
          : sg.step === "origin"
            ? "Origin"
            : null;
    rp.push(
      A(
        975,
        y0_,
        180,
        y1_ - y0_ - 1,
        "background:#2a3038;border-bottom:1px solid #1a1e24",
      ),
    );
    rp.push(
      I("filter-keep", 990, y0_ + 17, 13, "#c3ccd2"),
      I("cross", 1141, y0_ + 14, 9, "#c3ccd2"),
    );
    rp.push(
      Hit(1134, y0_ + 7, 14, 14, `Remove the step: ${lines.join(" ")}`, () =>
        setSteps((s) => s.filter((x) => x !== sg.step)),
      ),
    );
    lines.forEach((ln, j) =>
      rp.push(T(1004, y0_ + 17 + 11 * j, ln, "#f1f4f5", 8.6)),
    );
    if (term)
      rp.push(
        T(
          1004,
          y0_ + 17 + 11 * lines.length,
          term,
          "#f1f4f5",
          9,
          400,
          "border-bottom:1px dashed #8a949c;display:inline-block",
        ),
      );
    rp.push(
      T(984, y1_ - 18, "Objects", "#c3ccd2", 9),
      Tr(
        1145,
        y1_ - 18,
        `${sg.from.toLocaleString("en")} > ${sg.to.toLocaleString("en")}`,
        "#c3ccd2",
        9,
        90,
      ),
    );
    if (i > 0)
      rp.push(
        A(
          1063,
          y0_ - 1,
          12,
          6,
          "background:#2a3038;clip-path:polygon(0 0,100% 0,50% 100%)",
        ),
      );
  });
  rpb.push(
    A(968, 530, 193, 123, `background:${PN};border-top:1px solid #333a42`),
  );
  rpb.push(
    I("database", 985, 551, 13, "#c3ccd2"),
    T(997, 551, "Results", "#f1f4f5", 10),
    I("refresh", 1144, 551, 12, "#c3ccd2"),
  );
  rpb.push(
    A(978, 582, 59, 20, "border:1px solid #3a4048;border-radius:2px"),
    Tc(1007, 592, "View results", "#6b84a0", 9, 70),
    Tr(1147, 596, String(n_set), "#c3ccd2", 9, 30),
  );
  rpb.push(
    Hit(978, 582, 59, 20, "View results: the Browser", () => c.go("browser")),
  );
  rpb.push(A(968, 612, 193, 1, "background:#333a42"));
  rpb.push(
    A(977, 623, 175, 19, "background:#2e72d2;border-radius:2px"),
    Tc(1060, 633, "Actions", "#fff", 10, 80, "font-weight:600"),
    I("caret-down", 1083, 633, 9, "#fff"),
  );
  rpb.push(
    Hit(977, 623, 175, 19, "Actions: the Browser's bulk actions", () =>
      c.go("browser"),
    ),
  );
  o.push(G(dw, 0, rp), G(dw, dh, rpb));
  return frag(o);
}
