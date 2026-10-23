// D182 Control Panel map defaults and D183 the custom base map dialog
// (sec_d182 / sec_d183, _build_foundry_apps.py:487-554), line for line.
import { THIRD_PARTY_BASEMAPS } from "../../../globe/GlobeCanvas.js";
import { useAppView } from "../../../state/appView.js";
import {
  BLU,
  CONTENT,
  DARK,
  E,
  FAINT,
  GREY,
  Fr,
  Hit,
  I,
  frag,
  hairline,
  kit,
  vline,
  type N,
} from "./kit.js";
import { useJson, why } from "./data.js";
import type { Nav } from "./nav.js";

export function D182({ nav }: { nav: Nav }): JSX.Element {
  const { txt, bx, inp, sel_box, btn, stepper } = kit(1.05);
  const setApp = useAppView((s) => s.setApp);
  const W = 2225;
  const H = 1158;
  const r = useJson<{ dates: string[] }>("/api/adsb/history/dates");
  const ndays = r?.data?.dates.length;
  const nd = ndays === undefined ? "" : String(ndays);
  const navRows: N[] = [];
  (
    [
      ["home", "Home"],
      ["grid-view", "All Settings"],
      ["tick", "Approvals"],
      ["search", "Search"],
    ] as const
  ).forEach(([ic, lab], i) =>
    navRows.push(
      I(ic, 26, 76 + 32 * i, 16, "#404854"),
      txt(45, 76 + 32 * i + 0.5, lab, 12.5),
    ),
  );
  navRows.push(txt(214, 172, "⌘J", 11, FAINT, 400, 40, "r"));
  const o: N[] = [
    E(0, 0, W, H, `background:${CONTENT}`),
    E(0, 0, 233, H, "background:#fff"),
    vline(233, 0, H),
    E(0, 0, W, 50, "background:#fff"),
    hairline(233, 49, W - 233),
    E(0, 0, 49, 50, "background:#eef3fb"),
    I("cog", 24, 25, 22, BLU),
    txt(69, 24.5, "Control Panel", 14),
    I("diagram-tree", 265, 24, 15, "#a5acb6"),
    txt(281, 24.5, "Velocity instance", 13, "#8f99a8", 600),
    I("chevron-down", 411, 24, 13, "#5f6b7c"),
    txt(430, 24, "/", 15, "#8f99a8"),
    I("office", 460, 24, 16, "#404854"),
    txt(477, 24.5, "OSINT workspace", 13, DARK, 600),
    I("cog", 618, 24, 16, "#5f6b7c"),
    vline(644, 11, 28),
    bx(655, 10, 179, 29, "#fff", "#c5cbd3", 3),
    I("cube", 670, 24.5, 15, "#5f6b7c"),
    txt(687, 24.5, "Open mode", 13, "#8f99a8", 600),
    I("chevron-down", 817, 24.5, 13, "#5f6b7c"),
    I("cog", 853, 24, 16, "#5f6b7c"),
    frag(navRows),
    hairline(8, 202, 225),
    txt(
      19,
      229,
      "FAVORITE SETTINGS",
      10,
      GREY,
      700,
      null,
      "l",
      false,
      "letter-spacing:.04em",
    ),
    txt(
      19,
      269,
      "ORGANIZATION",
      10,
      GREY,
      700,
      null,
      "l",
      false,
      "letter-spacing:.04em",
    ),
    E(5, 286, 228, 32, "background:#e2eaf8"),
    E(4, 286, 3, 32, `background:${BLU}`),
    txt(19, 302.5, "Map", 12.5),
    I("star-empty", 214, 302, 16, "#404854"),
    txt(
      19,
      341,
      "Suggested favorites based on your",
      10,
      GREY,
      400,
      null,
      "l",
      true,
    ),
    txt(19, 357, "recently visited settings", 10, GREY, 400, null, "l", true),
    txt(19, 385.5, "Space management", 12.5),
    hairline(0, 1066, 233),
    I("help", 24, 1087, 16, "#404854"),
    txt(45, 1087.5, "AIP Assist", 12.5),
    I("help", 24, 1118, 16, "#404854"),
    txt(45, 1118.5, "Help", 12.5),
    I("share", 24, 1149, 16, "#404854"),
    txt(45, 1149.5, "Open Velocity", 12.5),
    txt(254, 81, "Map", 17, DARK, 700),
    txt(
      254,
      103.5,
      "Manage defaults for new maps and data loading limits for the Map application.",
      12.5,
      GREY,
    ),
    txt(254, 137.5, "New map defaults", 12.5, BLU),
    E(254, 150, 105, 2, `background:${BLU}`),
    txt(380, 137.5, "Data loading", 12.5),
    txt(473, 137.5, "API keys", 12.5),
    txt(541, 137.5, "Base maps", 12.5),
    hairline(234, 152, W - 234),
    I("star-empty", 2193, 91, 16, "#404854"),
  ];
  const card = (y0: number, y1: number, title: string): N =>
    frag([
      bx(868, y0, 703, y1 - y0, "#fff", "#d3d8de", 3),
      txt(890, y0 + 29, title, 12.5, DARK, 700),
      hairline(869, y0 + 57, 701),
    ]);
  const numfield = (label: string, ly: number, val: string, dflt: string): N =>
    frag([
      txt(890, ly, label, 12.5),
      inp(890, ly + 17, 149, 30, val),
      stepper(1041, ly + 17),
      txt(890, ly + 59, `(default: ${dflt})`, 10, GREY, 400, null, "l", true),
    ]);
  o.push(
    card(172, 565, "Default viewport"),
    txt(
      890,
      259,
      "Controls the initial viewport shown on new maps by setting a point to center the map on and how far to zoom in.",
      12.5,
      GREY,
    ),
    // the literal arguments of flyToGlobal (apps/web/src/globe/camera.ts:89); the globe fits its altitude, so no numeric zoom
    numfield("Latitude", 297, "35", "35"),
    numfield("Longitude", 388, "20", "20"),
    numfield("Zoom", 479, "", "fit globe"),
    card(584, 770, "Default time selection"),
    txt(
      890,
      672,
      "The number of days that the default time selection spans.",
      12.5,
      GREY,
    ),
    inp(890, 700, 149, 30, nd),
    stepper(1041, 700),
    txt(890, 742, `(default: ${nd})`, 10, GREY, 400, null, "l", true),
    card(789, 1152, "Default unit system"),
    txt(890, 875, "Sets the default unit system for users.", 12.5, GREY),
    txt(890, 912, "Organization default", 12.5),
    sel_box(889, 929, 112, 27, "Feed native", 12.5, "#f6f7f9"),
    txt(890, 982, "Group overrides", 12.5),
    txt(
      890,
      1003,
      "For a Map user, the first group in the list below that they are a member of will take precedence and determine",
      12.5,
      GREY,
    ),
    txt(
      890,
      1021,
      "their default unit system. If a user is not in any of these groups, the organization default will be used.",
      12.5,
      GREY,
    ),
    bx(889, 1040, 664, 92, "#fff", "#d3d8de", 2),
    hairline(890, 1079, 662),
    txt(900, 1059, "No group overrides configured", 12.5, DARK),
    btn(900, 1091, 128, 28, "Add group override", null, "#f6f7f9"),
    E(2208, 140, 5, 1010, "background:#c5cbd3;border-radius:3px"),
  );
  const err = why("Replay archive", r);
  if (err) o.push(txt(1045, 715, err, 11, "#ac2f33"));
  o.push(
    Hit(0, 0, 49, 50, "Foundry apps", nav.menu),
    Hit(533, 126, 70, 24, "Base maps", () => nav.go("d183")),
    Hit(8, 1134, 220, 30, "Open Velocity", () => setApp("map")),
    Hit(
      900,
      1091,
      128,
      28,
      "Add group override",
      undefined,
      "Velocity has no user groups to override",
    ),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}

export function D183({ nav }: { nav: Nav }): JSX.Element {
  const { txt, bx, inp, btn } = kit(1.09);
  const W = 810;
  const H = 630;
  // the app's real OpenTopo entry (apps/web/src/globe/GlobeCanvas.tsx THIRD_PARTY_BASEMAPS)
  const ot = THIRD_PARTY_BASEMAPS.opentopo;
  const credit = ot.credit.replace(/:/g, "");
  const o: N[] = [
    E(0, 0, W, H, "background:#f6f6f8"),
    E(0, 0, W, 44, "background:#fff"),
    hairline(0, 44, W),
    txt(20, 24.5, "Custom base map configuration", 12.5, DARK, 700),
    txt(19, 73, "Type", 12.5, DARK, 700),
    bx(19, 92, 380, 43, "#f0f4f8", BLU, 3, `box-shadow:0 0 0 1px ${BLU}`),
    E(30, 104, 20, 20, `background:${BLU};border-radius:50%`),
    E(36, 110, 8, 8, "background:#fff;border-radius:50%"),
    txt(62, 114.5, "Raster", 12.5, "#215db0"),
    bx(410, 92, 379, 43, "#f6f6f8", "#c5cbd3", 3),
    E(
      419,
      104,
      20,
      20,
      "background:#fff;border:2px solid #8f99a8;border-radius:50%",
    ),
    txt(452, 114.5, "Mapbox", 12.5, GREY),
    txt(19, 165, "Name", 12.5, DARK, 700),
    inp(19, 184, 770, 30, "OpenTopo"),
    txt(19, 243, "Attribution", 12.5, DARK, 700),
    inp(19, 262, 770, 30, credit),
    txt(19, 321, "Raster tile URL", 12.5, DARK, 700),
    bx(19, 351, 92, 30, "#fff", BLU, 3),
    I("add", 39, 366, 16, BLU),
    txt(52, 366.5, "Add URL", 12.5, BLU),
    bx(125, 351, 664, 30, "#fff", "#c5cbd3", 2),
    txt(135, 366.5, ot.url, 12.5, DARK),
    I("small-cross", 770, 366, 14, GREY),
    txt(19, 409, "Tile size", 12.5, DARK, 700),
    // Cesium UrlTemplateImageryProvider's default tile size; the app does not set one
    inp(19, 428, 770, 30, "256"),
    txt(770, 443.5, "px", 10, GREY),
    txt(19, 487, "Zoom range", 12.5, DARK, 700),
    txt(
      19,
      504,
      "The maximum and minimum zoom levels for which the tileset has data",
      10.5,
      GREY,
    ),
  ];
  const zx = (n: number): number => 28 + 31.3 * n;
  const zmax = ot.maximumLevel;
  o.push(
    E(25, 527, 753, 5, "background:#d3d8de;border-radius:3px"),
    E(25, 527, zx(zmax) - 25, 5, `background:${BLU};border-radius:3px`),
  );
  for (const hx of [25, zx(zmax) - 1])
    o.push(
      E(
        hx - 4,
        520,
        9,
        17,
        "background:#f6f7f9;border:1px solid #5f6b7c;border-radius:3px",
      ),
    );
  for (let n = 0; n < 25; n += 2)
    if (n !== zmax && n !== 0)
      o.push(txt(zx(n), 551, String(n), 10, "#404854", 400, 30, "c"));
  for (const [n, xx] of [
    [0, 28],
    [zmax, zx(zmax) - 1],
  ] as const)
    o.push(
      E(xx - 10, 543, 22, 17, "background:#394048;border-radius:3px"),
      txt(xx + 1, 551.5, String(n), 10, "#fff", 600, 22, "c"),
    );
  o.push(
    btn(680, 578, 56, 29, "Cancel", null, "#f6f7f9"),
    btn(744, 578, 45, 29, "Save", null, "#238551", "#238551", "#fff"),
    Hit(680, 578, 56, 29, "Cancel", () => nav.go("d182")),
    Hit(
      744,
      578,
      45,
      29,
      "Save",
      undefined,
      "OpenTopo is already one of the app's base maps; custom base maps are not stored",
    ),
    Hit(0, 0, 810, 44, "Foundry apps", nav.menu),
  );
  return (
    <Fr W={W} H={H}>
      {frag(o)}
    </Fr>
  );
}
