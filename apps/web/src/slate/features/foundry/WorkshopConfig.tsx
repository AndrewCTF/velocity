// Workshop map widget configuration frames D197-D199 (sec_d197-d199,
// _build_foundry_apps.py:1162-1262): the layer card from the layer registry,
// the base map picker from basemaps.ts, the TimeDock behaviour, and layer
// styling by a real Foundry transform.
import { useMemo } from "react";
import { BASEMAP_OPTIONS } from "../../../globe/basemaps.js";
import { defaultLayers } from "../../../registry/defaults.js";
import {
  BLU,
  DARK,
  E,
  Fr,
  Hit,
  I,
  frag,
  hairline,
  kit,
  span,
  toggle,
  tri,
  vline,
  type N,
} from "./kit.js";
import { mini_bar, plane } from "./mapkit.js";
import { Plate } from "./Plate.js";
import {
  aircraftOf,
  densCenter,
  nf,
  proj,
  useJson,
  why,
  type Dataset,
  type Status,
  type Transform,
} from "./data.js";
import type { Nav } from "./nav.js";

const HATCH =
  "background:repeating-linear-gradient(135deg,#f4f4f6 0 3px,#d6d9de 3px 4px)";

/** The builder's 80x80 base map thumbnail (plate d197t at zoom 6), drawn at `s` px. */
function thumb(x: number, y: number, s: number, lo: number, la: number): N {
  return (
    <div
      key={`t${x}`}
      style={{
        left: x,
        top: y,
        width: s,
        height: s,
        overflow: "hidden",
        borderRadius: 3,
        border: "1px solid #c5cbd3",
        background: "#e9ecef",
      }}
    >
      <div
        style={{
          left: 0,
          top: 0,
          width: 80,
          height: 80,
          transform: `scale(${s / 80})`,
          transformOrigin: "0 0",
        }}
      >
        <Plate lon={lo} lat={la} zf={6} W={80} H={80} />
      </div>
    </div>
  );
}

export function D197({ nav }: { nav: Nav }): JSX.Element {
  const { txt, bx, sel_box } = kit(2.0);
  const W = 1544;
  const H = 1038;
  const MW = 795;
  const zf = 10.2;
  const g = useJson<Parameters<typeof aircraftOf>[0]>("/api/adsb/global");
  const st = useJson<Status>("/api/status");
  const ac = useMemo(() => (g?.data ? aircraftOf(g.data) : null), [g]);
  const [lo, la] = useMemo(
    () =>
      ac
        ? densCenter(
            zf,
            MW,
            H,
            ac.filter((a) => !a.on_ground),
          )
        : [0, 0, 0],
    [ac],
  );
  const fn = useMemo(() => proj(lo, la, zf, MW, H), [lo, la]);
  const nAc = st?.data?.aircraft_count;
  const L0 = defaultLayers.find((l) => l.id === "aviation.adsb.global");
  const bmLabels = BASEMAP_OPTIONS.map((b) => b.label);
  const bmT = BASEMAP_OPTIONS.find((b) => b.value === "3d-sat");
  const o: N[] = [E(0, 0, W, H, "background:#fff")];
  if (ac) {
    o.push(
      <Plate key={`p${lo},${la}`} lon={lo} lat={la} zf={zf} W={MW} H={H} />,
    );
    for (const a of ac) {
      const [x, y] = fn(a.lon, a.lat);
      if (!(x > 0 && x < MW && y > 0 && y < H)) continue;
      const em = a.emergency && a.emergency !== "none";
      o.push(
        plane(
          x,
          y,
          em ? "#c14a4a" : a.on_ground ? "#b9a9ee" : "#3d6fd1",
          34,
          false,
          (a.track_deg || 45) - 45,
        ),
      );
    }
  } else o.push(E(0, 0, MW, H, "background:rgb(200,205,207)"));
  const err = why("Live aircraft", g);
  if (err) o.push(mini_bar(40, 60, 420, 46), txt(56, 83, err, 12.5, "#ac2f33"));
  o.push(
    E(795, 0, 5, H, "background:#2d5fc0"),
    E(800, 0, 43, H, HATCH),
    mini_bar(637, 0, 146, 54, "#fff", "#d3d8de", 3),
    txt(710, 27.5, "Selection", 12.5, DARK, 400, 146, "c"),
  );
  const P = 843;
  const big = (n: number): string => `font-size:${n}px`;
  o.push(
    E(P, 0, W - P, H, "background:#fff"),
    vline(P, 0, H, "#d3d8de"),
    txt(875, 39, "LAYERS", 12.5, "#1c2127", 700, null, "l", false, big(25)),
    I("chevron-up", 1497, 38, 32, "#394048"),
    bx(875, 97, 319, 58, "#dce0e4", "#c5cbd3", 3),
    txt(1034, 126.5, "Local configuration", 12.5, DARK, 400, 319, "c"),
    bx(1195, 97, 318, 58, "#f6f6f8", "#c5cbd3", 3),
    txt(1354, 126.5, "Import map template", 12.5, DARK, 400, 318, "c"),
    vline(887, 185, 645, "#d3d8de"),
    txt(
      906,
      206,
      "OBJECT LAYERS",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    bx(906, 233, 607, 59, "#f6f6f8", "#c5cbd3", 3),
    I("add", 1108, 263, 34, "#394048"),
    txt(1139, 263.5, "Add object layer", 12.5, DARK),
    bx(906, 313, 607, 112, "#f6f6f8", "#c5cbd3", 3),
    txt(924, 349, L0?.title ?? "", 12.5, DARK),
    txt(924, 391, "Current value:", 12.5, "#5f6b7c"),
    txt(1115, 391, nAc === undefined ? "" : nf(nAc), 12.5, DARK),
    E(1228, 376, 31, 31, "background:#3d8bf2;border-radius:4px"),
    I("airplane", 1243, 391, 20, "#fff"),
    txt(1268, 391.5, "Aircraft", 12.5, DARK),
    I("chevron-right", 1475, 369, 28, "#5f6b7c"),
    txt(906, 486, "OVERLAYS", 12.5, "#5f6b7c", 400, null, "l", false, big(22)),
    bx(906, 523, 607, 59, "#f6f6f8", "#c5cbd3", 3),
    I("add", 1133, 553, 34, "#394048"),
    txt(1164, 553.5, "Add overlay", 12.5, DARK),
    txt(906, 632, "BASE MAP", 12.5, "#5f6b7c", 400, null, "l", false, big(22)),
    bx(906, 658, 607, 83, "#f6f6f8", "#c5cbd3", 3),
    thumb(928, 670, 60, lo, la),
    txt(1008, 701, "Esri light gray", 12.5, DARK),
    txt(
      906,
      782,
      "SHOW BASE LAYER PICKER",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    toggle(1458, 765, true, 55, 32),
    hairline(P + 1, 830, W - P - 1, "#d3d8de"),
    txt(
      875,
      879,
      "INTERACTION",
      12.5,
      "#1c2127",
      700,
      null,
      "l",
      false,
      big(25),
    ),
    I("chevron-down", 1497, 878, 32, "#394048"),
    hairline(P + 1, 928, W - P - 1, "#d3d8de"),
    txt(
      875,
      977,
      "TIME CONFIGURATION",
      12.5,
      "#1c2127",
      700,
      null,
      "l",
      false,
      big(25),
    ),
    I("chevron-down", 1497, 976, 32, "#394048"),
    hairline(P + 1, 1025, W - P - 1, "#d3d8de"),
  );
  // popover: Base map + Elevation source (the real 3D terrain base map option)
  o.push(
    bx(
      178,
      400,
      701,
      600,
      "#fff",
      "#d3d8de",
      3,
      "box-shadow:0 2px 12px rgba(17,20,24,.3)",
    ),
    tri(
      872,
      688,
      "border-top:12px solid transparent;border-bottom:12px solid transparent;border-left:12px solid #fff",
    ),
    txt(198, 439, "Base map", 12.5, DARK),
    sel_box(198, 465, 660, 98, "Esri light gray", 12.5, "#f6f6f8", {
      icon: thumb(218, 474, 80, lo, la),
      idx: 100,
      cs: 2,
    }),
    txt(198, 612, "Base map options", 12.5, DARK),
    txt(
      198,
      653,
      `The picker lists ${bmLabels.length} base maps; the default is ${bmLabels[0] ?? ""}.`,
      12.5,
      "#5f6b7c",
    ),
    txt(
      198,
      684,
      "Esri light gray is a proposed light Esri canvas.",
      12.5,
      "#5f6b7c",
    ),
    sel_box(
      198,
      709,
      660,
      58,
      bmLabels.slice(0, 5).join(", ") + ", ...",
      12.5,
      "#f6f6f8",
      { cs: 2 },
    ),
    hairline(198, 799, 660, "#d3d8de"),
    txt(198, 849, "Elevation source", 12.5, DARK),
    txt(
      198,
      893,
      (bmT?.title ?? "").replace(
        / \(ion token adds OSM Buildings\)$/,
        " (ion token adds",
      ),
      12.5,
      "#5f6b7c",
    ),
    txt(
      198,
      924,
      `${/\(ion token adds OSM Buildings\)$/.test(bmT?.title ?? "") ? "OSM Buildings). " : ""}Choose the ${bmT?.label ?? ""} base map to use it.`,
      12.5,
      "#5f6b7c",
    ),
    bx(198, 980, 660, 20, "#f6f6f8", "#c5cbd3", 3),
    Hit(P, 940, W - P, 80, "Time configuration", () => nav.go("d198")),
    Hit(875, 97, 638, 58, "Foundry apps", nav.menu),
    Hit(
      906,
      233,
      607,
      59,
      "Add object layer",
      undefined,
      "Object layers come from the layer registry (registry/defaults.ts)",
    ),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}

export function D198({ nav }: { nav: Nav }): JSX.Element {
  const { txt, bx } = kit(2.0);
  const W = 722;
  const H = 942;
  const big = (n: number): string => `font-size:${n}px`;
  const o: N[] = [
    E(0, 0, W, H, "background:#fff"),
    E(0, 0, 17, H, HATCH),
    vline(17, 0, H, "#d3d8de"),
    txt(38, 58, "Map", 12.5, DARK, 400, null, "l", false, big(26)),
    txt(688, 58, "MAP", 12.5, "#a5acb6", 400, 100, "r", false, big(23)),
    hairline(18, 97, W - 18, "#d3d8de"),
    txt(
      38,
      138,
      "Widget setup",
      12.5,
      "#215db0",
      400,
      null,
      "l",
      false,
      big(26),
    ),
    E(38, 176, 151, 4, `background:${BLU}`),
    txt(231, 138, "Metadata", 12.5, DARK, 400, null, "l", false, big(26)),
    txt(380, 138, "Display", 12.5, DARK, 400, null, "l", false, big(26)),
    hairline(18, 179, W - 18, "#d3d8de"),
    txt(
      80,
      202,
      "SHOW BASE LAYER PICKER",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    toggle(634, 186, false, 54, 32),
    hairline(18, 248, W - 18, "#d3d8de"),
    txt(
      48,
      298,
      "INTERACTION",
      12.5,
      "#1c2127",
      700,
      null,
      "l",
      false,
      big(25),
    ),
    I("chevron-down", 673, 298, 28, "#394048"),
    hairline(18, 346, W - 18, "#d3d8de"),
    txt(
      48,
      396,
      "TIME CONFIGURATION",
      12.5,
      "#1c2127",
      700,
      null,
      "l",
      false,
      big(25),
    ),
    I("chevron-up", 673, 396, 28, "#394048"),
    txt(
      48,
      482,
      "ENABLE TIMELINE",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
  ];
  const seg = (
    x0: number,
    x1: number,
    y: number,
    a: string,
    b: string,
    sel: 0 | 1,
  ): N => {
    const mid = (x0 + x1) / 2;
    return frag([
      bx(x0, y, x1 - x0, 59, "#f6f6f8", "#c5cbd3", 3),
      vline(Math.floor((x0 + x1) / 2), y + 1, 57, "#c5cbd3"),
      E(
        sel === 0 ? x0 + 1 : mid + 1,
        y + 1,
        (x1 - x0) / 2 - 2,
        57,
        "background:#dce0e4",
      ),
      txt((x0 + mid) / 2, y + 30, a, 12.5, DARK, 400, 300, "c"),
      txt((mid + x1) / 2, y + 30, b, 12.5, DARK, 400, 300, "c"),
    ]);
  };
  // states read from apps/web/src/shell/TimeDock.tsx: dock always mounted (timeline Enabled), playhead
  // scrubbable (selected time Enabled), coverage window fixed to retention (TimeDock.tsx:735, off), open at boot (on)
  o.push(
    seg(48, 688, 508, "Disabled", "Enabled", 1),
    vline(51, 595, 275, "#d3d8de"),
    txt(
      80,
      624,
      "ALLOW USER TO CHANGE SELECTED TIME",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    seg(80, 688, 649, "Disabled", "Enabled", 1),
    txt(
      80,
      788,
      "ALLOW USER TO CHANGE TIME WINDOW",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    toggle(634, 772, false, 54, 32),
    txt(
      80,
      853,
      "OPEN TIMELINE BY DEFAULT",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    toggle(634, 837, true, 54, 32),
    Hit(18, 360, W - 18, 70, "Back to the layers panel", () => nav.go("d197")),
    Hit(18, 20, W - 18, 70, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}

// the app's AIS ship-type and aircraft category colours (apps/web/src/globe/adapters/styles.ts:38-56, not exported):
// cargo, tanker, fishing, passenger, military, sailing, pleasure, tug, SAR, airliner, private, glider
const PAL = [
  "#14b8a6",
  "#d97706",
  "#5eead4",
  "#38bdf8",
  "#f59e0b",
  "#a5f3fc",
  "#4ade80",
  "#c084fc",
  "#ef4444",
  "#facc15",
  "#2dd4bf",
  "#93c5fd",
];

export function D199({ nav }: { nav: Nav }): JSX.Element {
  const { txt, bx, sel_box, inp } = kit(2.0);
  const W = 794;
  const H = 1953;
  const tR = useJson<Transform[]>("/api/foundry/transforms");
  const dR = useJson<Dataset[]>("/api/foundry/datasets");
  const tf = tR?.data?.find((t) => t.name === "fast_vessels_tf");
  const dsn = tf
    ? dR?.data?.find((d) => d.id === tf.inputs[0])?.name
    : undefined;
  const steps = tf?.steps ?? [];
  const s0 = steps[0];
  const s1 = steps[1];
  const inputs: Array<[string, string]> =
    s0 && s1
      ? [
          [`${s0.type.toUpperCase()} EXPR`, String(s0.expr ?? "")],
          [`${s1.type.toUpperCase()} COLUMN`, String(s1.column ?? "")],
          [`${s1.type.toUpperCase()} EXPR`, String(s1.expr ?? "")],
        ]
      : [];
  const vis = defaultLayers.find((l) => l.id === "maritime.aisstream")
    ?.visibleByDefault
    ? "Visible"
    : "Hidden";
  const big = (n: number): string => `font-size:${n}px`;
  const err =
    why("Foundry transforms", tR) ??
    (tR?.ok && !tf ? "Transform fast_vessels_tf not found" : null);
  const o: N[] = [
    E(0, 0, W, H, "background:#fff"),
    E(0, 0, 92, H, "background:#f4f4f6"),
    E(52, 95, 40, H - 95, HATCH),
    vline(92, 0, H, "#d3d8de"),
    E(36, 12, 297, 58, "background:#2d6fd2;border-radius:3px"),
    txt(56, 41.5, "Save and publish", 12.5, "#fff", 400, 220),
    vline(275, 12, 58, "#1f56a8"),
    I("caret-down", 304, 41, 24, "#fff"),
    bx(344, 12, 140, 58, "#f6f6f8", "#c5cbd3", 3),
    txt(363, 41.5, "View", 12.5, DARK),
    I("play", 449, 41, 22, "#394048"),
    vline(505, 18, 46, "#d3d8de"),
    I("people", 562, 41, 30, "#394048"),
    txt(593, 41.5, "Share", 12.5, DARK),
    I("properties", 721, 41, 34, "#394048"),
    txt(113, 133, "AIS vessels", 12.5, DARK, 400, null, "l", false, big(26)),
    txt(719, 133, "MAP", 12.5, "#a5acb6", 400, null, "l", false, big(22)),
    hairline(93, 172, W - 93, "#d3d8de"),
    txt(
      113,
      214,
      "Widget setup",
      12.5,
      "#215db0",
      400,
      null,
      "l",
      false,
      big(26),
    ),
    E(113, 248, 151, 4, `background:${BLU}`),
    txt(306, 214, "Metadata", 12.5, DARK, 400, null, "l", false, big(26)),
    txt(454, 214, "Display", 12.5, DARK, 400, null, "l", false, big(26)),
    hairline(93, 254, W - 93, "#d3d8de"),
    txt(
      123,
      297,
      "LAYER VISIBILITY",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    I("help", 308, 297, 22, "#8f99a8"),
    txt(
      732,
      292,
      "Use variable input",
      12.5,
      "#215db0",
      400,
      300,
      "r",
      false,
      big(23),
    ),
    bx(123, 323, 608, 59, "#f6f6f8", "#c5cbd3", 3),
    E(vis === "Visible" ? 124 : 428, 324, 298, 57, "background:#dce0e4"),
    txt(273, 353, "Visible", 12.5, DARK, 400, 300, "c"),
    txt(577, 353, "Hidden", 12.5, DARK, 400, 300, "c"),
    txt(
      123,
      433,
      "LOCK LAYER",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    I("help", 262, 433, 22, "#8f99a8"),
    toggle(677, 417, false, 54, 32),
    hairline(93, 480, W - 93, "#d3d8de"),
    txt(123, 530, "STYLE", 12.5, "#1c2127", 700, null, "l", false, big(25)),
    I("chevron-up", 715, 530, 28, "#394048"),
    txt(155, 611, "COLOR", 12.5, "#5f6b7c", 400, null, "l", false, big(22)),
    E(664, 592, 68, 36, "background:#eceff2;border-radius:3px"),
    I("link", 686, 610, 22, "#5f6b7c"),
    txt(708, 610.5, "1", 12.5, "#5f6b7c", 400, null, "l", false, big(22)),
    vline(124, 660, 1170, "#d3d8de"),
    txt(155, 680, "COLOR BY", 12.5, "#5f6b7c", 400, null, "l", false, big(22)),
    sel_box(155, 707, 577, 45, "Function", 12.5, "#f6f6f8", { cs: 2 }),
    vline(156, 785, 790, "#d3d8de"),
    bx(187, 785, 545, 102, "#fff", "#c5cbd3", 3),
    txt(
      208,
      815,
      tf?.name ?? err ?? "",
      12.5,
      tf ? DARK : "#ac2f33",
      400,
      null,
      "l",
      false,
      big(25),
    ),
    txt(208, 854, "on", 12.5, DARK, 400, null, "l", false, big(23)),
    E(246, 840, 30, 30, "background:#e2ecfa;border-radius:3px"),
    I("th", 261, 855, 20, "#2d72d2"),
    txt(287, 854, dsn ?? "", 12.5, DARK, 400, null, "l", false, big(23)),
    I("info-sign", 660, 838, 30, "#394048"),
    I("caret-down", 692, 838, 24, "#394048"),
    // Velocity transforms are not semver-versioned: the version box shows updated_at
    sel_box(
      187,
      908,
      545,
      58,
      tf ? tf.updated_at.slice(0, 10) : "",
      12.5,
      "#f6f6f8",
      { cs: 2 },
    ),
    toggle(187, 991, false, 56, 32, true),
    txt(
      263,
      1007,
      "Auto upgrade to compatible versions",
      12.5,
      "#a5acb6",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    bx(186, 1043, 547, 57, "#f6f6f8", "#c5cbd3", 2),
    txt(
      207,
      1073,
      "Function inputs",
      12.5,
      DARK,
      400,
      null,
      "l",
      false,
      big(24),
    ),
  ];
  inputs.forEach(([lab, val], i) => {
    const yy = 1152 + 158 * i;
    o.push(
      txt(
        207,
        yy,
        [lab, span("*", "color:#c23030")],
        12.5,
        "#5f6b7c",
        400,
        null,
        "l",
        false,
        big(22),
      ),
      txt(
        712,
        yy - 10,
        "Use a variable input",
        12.5,
        "#215db0",
        400,
        300,
        "r",
        false,
        big(23),
      ),
      inp(207, yy + 28, 505, 57, val, 12.5, DARK, "#fff", "#c5cbd3"),
      i < 2 ? hairline(187, yy + 107, 545, "#d3d8de") : null,
    );
  });
  o.push(
    txt(
      155,
      1624,
      "COLOR MAPPING",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    sel_box(155, 1650, 577, 47, "Automatic", 12.5, "#f6f6f8", { cs: 2 }),
    txt(
      155,
      1748,
      "SELECT COLORS",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    bx(155, 1775, 577, 46, "#f6f6f8", "#c5cbd3", 3),
  );
  PAL.forEach((c, i) =>
    o.push(E(170 + i * 41.7, 1784, 41.7, 28, `background:${c}`)),
  );
  o.push(
    tri(
      695,
      1796,
      "border-left:8px solid transparent;border-right:8px solid transparent;border-top:8px solid #5f6b7c",
    ),
    txt(155, 1871, "OPACITY", 12.5, "#5f6b7c", 400, null, "l", false, big(22)),
    E(664, 1853, 68, 36, "background:#eceff2;border-radius:3px"),
    I("link", 686, 1871, 22, "#5f6b7c"),
    txt(708, 1871.5, "1", 12.5, "#5f6b7c", 400, null, "l", false, big(22)),
    vline(124, 1900, 53, "#d3d8de"),
    txt(
      155,
      1913,
      "VALUE FROM",
      12.5,
      "#5f6b7c",
      400,
      null,
      "l",
      false,
      big(22),
    ),
    Hit(
      36,
      12,
      297,
      58,
      "Save and publish",
      undefined,
      "The layer style is the app's own palette; there is nothing to publish",
    ),
    Hit(344, 12, 140, 58, "View", () => nav.go("d201")),
    Hit(
      660,
      820,
      60,
      40,
      "Open the transform in the pipeline",
      tf ? () => nav.workbench("pipeline") : undefined,
      "Transform not loaded",
    ),
    Hit(93, 100, W - 93, 60, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}
