// E7 / E8 / E9: the slides editor and presentation mode of the copy
// (slides_editor(), present1(), present2() in _build_features.py), crop
// 730,273 1140x641 (E9 713,273). The map clip is the live E5 map; slide 1
// carries the newest evidence item's SHA prefix; slide 2 profiles the freshest
// named cargo-type AIS track in the mosaic with a live sanctions lookup.
import { A, I, T, Hit, frag, hexlogo, insetFrame, type N } from "./ui.js";
import {
  SATW,
  UTC,
  unavailable,
  type Evid,
  type Res,
  type SatV,
} from "./data.js";
import {
  MX,
  MY,
  Mosaic,
  rail,
  satBg,
  satLayer,
  thumbsRow,
  topChrome,
  type Go,
} from "./SatMap.js";

export interface Sanctions {
  matched: boolean;
  lists?: string[];
}

function thumbSlide(
  x: number,
  y: number,
  w: number,
  h: number,
  kind: string,
): N {
  if (kind === "map")
    return frag([
      A(x, y, w, h, "background:#aeb4b8;box-shadow:0 1px 3px rgba(0,0,0,.35)"),
      satBg(
        x + 14,
        y,
        w - 28,
        h,
        -Math.round((MX + 240) * 0.17),
        -Math.round((MY + 150) * 0.17),
        SATW * 0.17,
      ),
    ]);
  const s: N[] = [
    A(x, y, w, h, "background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35)"),
  ];
  if (kind === "title")
    s.push(
      A(x + 4, y + 4, 34, 2, "background:#2c343a"),
      A(x + 5, y + 16, 22, 1.4, "background:#6a747b"),
      A(x + 5, y + 20, 18, 1.2, "background:#aab2b8"),
      A(x + 4, y + h - 5, 10, 1.5, "background:#aab2b8"),
    );
  else if (kind === "profile") {
    s.push(
      A(x + 4, y + 3, 26, 2, "background:#2c343a"),
      A(x + 6, y + 9, 30, 28, "background:#7a8a93"),
    );
    for (let i = 0; i < 5; i++)
      s.push(
        A(x + 42, y + 10 + i * 5, 28 - (i % 2) * 8, 1.6, "background:#6a747b"),
      );
  } else {
    s.push(A(x + 4, y + 3, 28, 2, "background:#2c343a"));
    for (const [yy, x0, ww, col] of [
      [13, 14, 14, "#e0b82c"],
      [19, 20, 6, "#2c343a"],
      [25, 24, 30, "#3fa35a"],
      [31, 30, 14, "#4a78d8"],
      [38, 28, 44, "#c8283a"],
    ] as const)
      s.push(A(x + x0, y + yy, ww, 3, `background:${col}`));
  }
  return frag(s);
}

export function SlidesFrame({
  vs,
  pv,
  ev,
  briefsN,
  now,
  go,
}: {
  vs: SatV[];
  pv: SatV | null;
  ev: Evid[];
  briefsN: number | null;
  now: number;
  go: Go;
}): N {
  const s: N[] = [
    insetFrame(730, 273, 1870, 914),
    A(731, 316, 1138, 598, "background:#f2f6f8"),
    A(748, 316, 100, 598, "background:#f2f6f8"),
    A(848, 316, 1, 598, "background:#dde3e8"),
    T(753, 324, "Slides", 6.2, "#3a6fb4", 600),
    A(751, 330, 18, 1.2, "background:#3a6fb4"),
    T(777, 324, "Outline", 6.2, "#5a646b", 600),
  ];
  const items: [number, string, string, number, (() => void) | undefined][] = [
    [337, "Title", "title", 1, () => go("present1")],
    [398, `${pv?.name ?? "Track"} Profile`, "profile", 2, () => go("present2")],
    [457, "Dubai Creek Watch", "map", 3, () => undefined],
    [518, "Collection Schedule", "gantt", 4, () => go("globe")],
  ];
  for (const [y, lab, kind, n, open] of items) {
    const sel = n === 3;
    s.push(
      T(755, y + 4, String(n), 5.4, "#5a646b"),
      thumbSlide(763, y, 77, 44, kind),
    );
    if (sel)
      s.push(
        A(
          762,
          y - 1,
          79,
          46,
          "border:1.5px solid #4b78c8;box-sizing:border-box;border-radius:1px",
        ),
        I("eye-open", 837, y + 3, 6, "#434b52"),
        I("share", 801, y + 23, 11, "#f4f6f8"),
      );
    s.push(
      T(
        765,
        y + 50,
        lab.length < 22 ? lab : lab.slice(0, 22),
        4.8,
        sel ? "#3a6fb4" : "#434b52",
        400,
      ),
      Hit(762, y - 1, 79, 56, `Slide ${n}: ${lab}`, open),
    );
  }
  s.push(
    A(748, 898, 100, 16, "background:#f2f6f8"),
    I("add", 783, 906, 7, "#434b52"),
    T(791, 906.5, "New slide", 5, "#2c343a"),
    Hit(
      776,
      900,
      40,
      12,
      "New slide",
      undefined,
      "The deck is built from live sources, not edited here",
    ),
    A(852, 899, 14, 13, "background:#e4eaee;border-radius:2px"),
    I("layout-two-columns", 859, 905.5, 7, "#434b52"),
    // middle pane
    T(853, 330, "Dubai Creek Watch", 7.4, "#1c2228", 600),
    A(853, 345, 180, 1, "background:#e4eaee"),
    T(853, 357, "Clip", 5.6, "#5a646b"),
    A(853, 367, 180, 28, "background:#fff;box-shadow:0 0 1px rgba(0,0,0,.25)"),
    satBg(859, 370, 23, 22, -45, -70, SATW * 0.12),
    T(886, 374, "Dubai Creek Watch", 5.8, "#1c2228", 600),
    T(
      886,
      383,
      `by ${ev[0]?.captured_by || "local"} · ${UTC(now, "%m/%d/%Y")}`,
      4.8,
      "#5a646b",
    ),
    I("cross", 1021, 377, 6, "#434b52"),
    A(1038, 316, 1, 598, "background:#dde3e8"),
    // canvas
    A(1040, 316, 822, 582, "background:#f2f6f8"),
    A(
      1049,
      323,
      812,
      457,
      "background:#f4f6f8;box-shadow:0 0 1px rgba(0,0,0,.35)",
    ),
    satLayer(
      vs,
      1151,
      323,
      609,
      457,
      MX + 60,
      MY + 20,
      1.0,
      true,
      true,
      true,
      0.9,
      1.3,
    ),
    A(1727, 329, 131, 15, "background:#444c54;border-radius:2px"),
    I("share", 1735, 336.5, 6, "#e8ecef"),
    T(
      1743,
      337,
      "This slide will open in its source application",
      4.8,
      "#f0f3f5",
    ),
    Hit(1727, 329, 131, 15, "Open in the map", () => go("map")),
    // pager
    T(1330, 906, "‹ Slide", 5, "#434b52"),
    Hit(1328, 900, 20, 12, "Previous slide", () => go("present2")),
    A(
      1350,
      901,
      10,
      9,
      "background:#fff;color:#2c343a;border:1px solid #9aa4ab;box-sizing:border-box;font-size:5px;display:grid;place-items:center",
      "3",
    ),
    T(1364, 906, "of 4 ›", 5, "#434b52"),
    Hit(1362, 900, 22, 12, "Next slide", () => go("globe")),
    I("print", 1832, 906, 6, "#434b52"),
    Hit(1828, 902, 9, 9, "Print", () => window.print()),
    I("desktop", 1846, 906, 6, "#434b52"),
    Hit(1842, 902, 9, 9, "Present", () => go("present1")),
    I("panel-table", 1859, 906, 6, "#434b52"),
    rail(briefsN, ev.length, go),
  );
  const title = frag([
    A(1252, 303, 8, 8, "background:#7a3d9c;border-radius:1px"),
    T(1266, 308, "Dubai Creek Watch Briefing", 6, "#f0f3f5", 600),
    I("star-empty", 1350, 308, 6, "#c4ccd2"),
    I("chevron-down", 1360, 308, 5, "#c4ccd2"),
  ]);
  const right = frag([
    A(1754, 302.5, 21, 9, "background:#3e8a52;border-radius:1px"),
    T(1764.5, 307, "Publish", 4.8, "#fff", 600, "c"),
    Hit(
      1754,
      302,
      21,
      10,
      "Publish",
      undefined,
      "Publishing needs a signed-in workspace",
    ),
    T(1786, 308, "Share", 5.8, "#f0f3f5", 600),
    T(1803, 308, "1", 5, "#aab2b8"),
    I("shield", 1818, 308, 6.5, "#c4ccd2"),
    T(1826, 308, "UNCLAS", 5.8, "#f0f3f5", 600),
    I("refresh", 1863, 308, 6, "#c4ccd2"),
  ]);
  const menu: [number, string, number][] = [
    [757, "File", 0],
    [776, "Edit", 0],
    [796, "View", 0],
    [818, "Form", 0],
    [845, "Navigate", 0],
    [874, "Window", 0],
    [906, "Support", 0],
    [936, "Saving...", 1],
  ];
  s.push(
    topChrome("Search: creek", thumbsRow(2, go), menu, title, right, false),
  );
  return frag(s);
}

const SLIDE_FONT =
  "font-family:Arimo,'Liberation Sans',Arial,Helvetica,sans-serif;";

function presentBar(x0: number, n: number, go: Go, broadcastWhy: string): N {
  return frag([
    A(x0, 273, 1140, 27, "background:#0c1012"),
    A(x0 + 1, 283, 1138, 16, "background:#161c1e"),
    I("minus", x0 + 1103, 277, 5, "#aab2b8"),
    I("square", x0 + 1117, 277, 5, "#aab2b8"),
    I("cross", x0 + 1131, 277, 5, "#aab2b8"),
    I("th-list", x0 + 9, 291, 6, "#aab2b8"),
    I("edit", x0 + 22, 291, 6, "#aab2b8"),
    Hit(x0 + 17, 286, 10, 10, "Edit deck", () => go("slides")),
    T(x0 + 543, 291, "‹  Slide", 4.6, "#aab2b8"),
    Hit(
      x0 + 541,
      286,
      8,
      10,
      "Previous slide",
      n > 1 ? () => go("present1") : undefined,
      "This is the first slide",
    ),
    A(
      x0 + 571,
      286,
      10,
      9,
      "background:#e8ecef;border-radius:1px;color:#1c2228;font-size:4.6px;display:grid;place-items:center",
      String(n),
    ),
    T(x0 + 584, 291, "of 4  ›", 4.6, "#aab2b8"),
    Hit(x0 + 598, 286, 8, 10, "Next slide", () =>
      go(n === 1 ? "present2" : "slides"),
    ),
    A(x0 + 1063, 285, 49, 12, "background:#aa3042;border-radius:1px"),
    I("feed", x0 + 1072, 291, 6, "#fff"),
    T(x0 + 1078, 291.5, "Broadcast...", 4.6, "#fff", 600),
    Hit(x0 + 1063, 285, 49, 12, "Broadcast", undefined, broadcastWhy),
    T(x0 + 1125, 291.5, "Exit", 4.6, "#cfd6da"),
    Hit(x0 + 1119, 285, 16, 12, "Exit presentation", () => go("slides")),
  ]);
}

const slideFooter = (x: number, y: number): N =>
  frag([
    hexlogo(x + 7, y, 8, "#1c2228"),
    A(x + 22, y - 9, 1.5, 18, "background:#1c2228"),
    T(x + 31, y, "Velocity", 17, "#1c2228", 400, "l", 0.0, SLIDE_FONT),
  ]);

export function Present1({
  ev,
  evRes,
  now,
  go,
  chatWhy,
}: {
  ev: Evid[];
  evRes: Res<unknown> | null;
  now: number;
  go: Go;
  chatWhy: string;
}): N {
  return frag([
    A(730, 273, 1140, 641, "background:#0c1012"),
    insetFrame(730, 273, 1870, 914),
    presentBar(730, 1, go, chatWhy),
    A(770, 300, 1060, 597, "background:#fff"),
    A(814, 322, 972, 1, "background:#8a9096"),
    T(
      817,
      347,
      `Dubai Creek Watch Briefing - ${UTC(now, "%Y")}`,
      31,
      "#14181c",
      400,
      "l",
      0,
      SLIDE_FONT,
    ),
    T(
      817,
      553,
      ev[0]
        ? `Evidence ID: ${ev[0].sha256.slice(0, 12)}`
        : unavailable("Evidence", evRes),
      22.5,
      "#14181c",
      400,
      "l",
      0,
      SLIDE_FONT,
    ),
    T(
      817,
      587,
      UTC(now, "%-d %B %Y"),
      22.5,
      "#6e7f8a",
      400,
      "l",
      0,
      SLIDE_FONT,
    ),
    slideFooter(814, 867),
  ]);
}

export function Present2({
  pv,
  vRes,
  sanc,
  go,
  chatWhy,
}: {
  pv: SatV | null;
  vRes: Res<unknown> | null;
  sanc: Res<Sanctions> | null;
  go: Go;
  chatWhy: string;
}): N {
  const sx = 713;
  const F = (x: number, y: number, t: string, b = false): N =>
    T(x, y, t, 22, "#14181c", b ? 700 : 400, "l", 0, SLIDE_FONT);
  const s: N[] = [
    A(sx, 273, 1140, 641, "background:#0c1012"),
    insetFrame(sx, 273, sx + 1140, 914),
    presentBar(sx, 2, go, chatWhy),
    A(753, 300, 1060, 597, "background:#fff"),
    A(797, 322, 972, 1, "background:#8a9096"),
    slideFooter(797, 867),
  ];
  if (!pv) {
    s.push(
      F(
        802,
        355,
        pv === null && vRes?.ok
          ? "No named track in the view"
          : unavailable("AIS tracks", vRes),
      ),
    );
    return frag(s);
  }
  const k = 1.5;
  const [px, py] = pv.px;
  const sog = pv.sog != null ? `${pv.sog.toFixed(1)} kn` : "n/a";
  const matched = sanc?.data?.matched;
  s.push(
    T(
      802,
      355,
      pv.name ?? `MMSI ${pv.mmsi}`,
      30,
      "#14181c",
      400,
      "l",
      0,
      SLIDE_FONT,
    ),
    <div
      key="photo"
      style={{
        left: 801,
        top: 417,
        width: 439,
        height: 318,
        overflow: "hidden",
        background: "#05070a",
      }}
    >
      <Mosaic
        left={-Math.round(px * k - 219)}
        top={-Math.round(py * k - 159)}
        k={k}
      />
    </div>,
    A(
      801 + 219 - 22,
      417 + 159 - 22,
      44,
      44,
      "border:2px solid #d11e32;box-sizing:border-box;border-radius:2px",
    ),
    A(801, 717, 439, 18, "background:rgba(12,16,18,.72)"),
    T(
      808,
      726,
      `Last AIS fix ${(pv.ageS ?? 0).toFixed(0)} s before this frame · ${pv.lat.toFixed(4)} N ${pv.lon.toFixed(4)} E · Esri World Imagery`,
      9,
      "#e8ecef",
      400,
      "l",
      0,
    ),
    F(1275, 430, "Name(s):", true),
    F(1277, 465, `"${pv.name}"`),
    F(1277, 502, `"MMSI ${pv.mmsi}"`),
    F(1275, 549, "Type:", true),
    F(1277, 584, `"${pv.shipType || "n/a"}"`),
    F(1275, 631, "Position(s):", true),
    F(1277, 666, `"${pv.lat.toFixed(4)} N, ${pv.lon.toFixed(4)} E"`),
    F(1277, 704, `"Flag ${pv.flag || "n/a"}, sog ${sog}"`),
    <div
      key="sanc"
      className="t"
      title={sanc?.data?.lists?.join(", ")}
      style={{
        left: 880,
        top: 752,
        fontSize: 22,
        lineHeight: "34px",
        color: "#14181c",
        fontWeight: 700,
        fontFamily: "Arimo,'Liberation Sans',Arial,Helvetica,sans-serif",
      }}
    >
      Sanctions Registry:{" "}
      <span
        style={{
          color: matched === false ? "#0f7a3a" : "#d4182b",
          fontWeight: 400,
        }}
      >
        {sanc?.ok
          ? matched
            ? '"Match"'
            : '"No match"'
          : `"${unavailable("Lookup", sanc)}"`}
      </span>
    </div>,
  );
  return frag(s);
}
