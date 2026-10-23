// Custom object view, dark (gotham-006-026, D12 D13): sec_cov() of
// _build_gotham_a.py in the 1000 x 702 figure's pixels. The map card's
// highlight is drawn from the live box pull: a heat dot per hull and the
// selection ring (62 scene px, about 10.7 km).
import {
  A,
  Hit,
  N_MEDIA,
  I,
  T,
  Tc,
  frag,
  sceneBg,
  shipicon,
  toPx,
  KM_PER_PX,
  type N,
} from "./kit.js";
import { TRK, dmy, hhmm, nProps, title } from "./data.js";
import { linksOf, sancLine } from "./Browser.js";
import type { Ctx } from "./model.js";

export function Cov({ c }: { c: Ctx }): JSX.Element {
  const W = 1000,
    H = 702;
  const CB = "#242832",
    CBD = "#3b424d",
    TXD = "#aab4bc";
  const o: N[] = [A(0, 0, W, H, "background:#1c2024")];
  o.push(
    A(
      6,
      6,
      988,
      690,
      "background:#1c2024;border:1px solid #3b424d;border-radius:3px",
    ),
  );
  const SELR = c.sel;
  if (!SELR) {
    o.push(
      T(18, 21, "No object selected: search in the Browser", "#f1f4f5", 11),
      Hit(18, 12, 240, 18, "Open the Browser", () => c.go("browser")),
    );
    return frag(o);
  }
  const [sx, sy] = toPx(SELR.v.lon, SELR.v.lat);
  const SELT = TRK(SELR.mmsi);
  o.push(
    A(
      18,
      13,
      30,
      32,
      `${sceneBg(sx, sy, 30, 32, 3.0)};border:1px solid #6b7680`,
    ),
    T(56, 21, SELR.name, "#f1f4f5", 11, 400, "font-weight:700"),
    T(56, 36, `Vessel • ${SELT}`, "#e5e8eb", 8.5),
  );
  const tabs: [string, number][] = [
    ["Overview", 18],
    ["Properties", 79],
    ["Links", 145],
    ["Map", 187],
    ["Media", 226],
    ["History", 292],
  ];
  for (const [t_, x] of tabs)
    o.push(T(x, 57, t_, t_ === "Overview" ? "#6aa6e8" : "#e5e8eb", 9.5));
  o.push(
    Hit(14, 49, 56, 16, "Overview", undefined, "This is the open tab"),
    Hit(75, 49, 58, 16, "Properties: the Browser object view", () =>
      c.go("browser"),
    ),
    Hit(141, 49, 36, 16, "Links: the Browser object view", () =>
      c.go("browser"),
    ),
    Hit(183, 49, 32, 16, "Map", undefined, "The map card is on this tab"),
    Hit(222, 49, 52, 16, "Media: the Browser object view", () =>
      c.go("browser"),
    ),
    Hit(288, 49, 44, 16, "History: the inbox feed", () => c.go("inbox")),
    Hit(
      338,
      49,
      40,
      16,
      "Ava",
      undefined,
      "The assistant opens from the AI app",
    ),
  );
  o.push(
    A(255, 50, 17, 14, "background:#323a46;border-radius:2px"),
    Tc(263.5, 57, String(N_MEDIA), TXD, 8, 20),
    I("search-around", 344, 57, 12, "#16a4c4"),
    T(358, 57, "Ava", "#e5e8eb", 9.5),
  );
  o.push(
    A(18, 66, 44, 2, "background:#6aa6e8"),
    A(7, 70, 986, 1, "background:#3b424d"),
    T(925, 29, "Actions", "#f1f4f5", 9.5),
    I("caret-down", 968, 29, 9, "#e5e8eb"),
  );
  o.push(Hit(920, 21, 56, 16, "Actions: the inbox feed", () => c.go("inbox")));
  const card = (x: number, y: number, w: number, h: number): N =>
    A(x, y, w, h, `background:${CB};border:1px solid ${CBD};border-radius:2px`);
  // properties (lower part)
  const t0 = c.fixes[0]?.[0] ?? SELR.v.t;
  const t1 = c.fixes[c.fixes.length - 1]?.[0] ?? SELR.v.t;
  const FLAG = c.entity?.flag_country ?? (c.entity ? "n/a" : "loading…");
  o.push(card(18, 72, 472, 174));
  const rows: [number, number, string, string | null][] = [
    [75, 107, "Flag state", FLAG],
    [107, 155, "Fix times", null],
    [155, 187, "Ship type", SELR.type],
    [187, 217, "Speed over ground", `${SELR.sog.toFixed(1)} kn`],
  ];
  for (const [ya, yb, lab, val] of rows) {
    o.push(
      A(19, yb, 470, 1, `background:${CBD}`),
      T(26, ya + 16, lab, TXD, 9.5, 400, "font-weight:600"),
    );
    if (val)
      o.push(
        T(185, ya + 15, val, "#f1f4f5", 9.5),
        T(378, ya + 16, "AIS", "#8f99a8", 7.5),
      );
    else {
      [t1, t0].forEach((tt, j) =>
        o.push(
          T(
            185,
            ya + 17 + 15 * j,
            `${hhmm(tt, true)} ${dmy(tt)}`,
            "#f1f4f5",
            9.5,
          ),
          T(378, ya + 17 + 15 * j, "AIS", "#8f99a8", 7.5),
          I("time", 470, ya + 17 + 15 * j, 11, "#aab4bc"),
        ),
      );
      o.push(A(183, ya + 26, 296, 14, "background:#3b4350;opacity:.55"));
    }
  }
  o.push(
    T(421, 232, `View all ${nProps(SELR.v)}`, "#6aa6e8", 9.5),
    I("arrow-right", 478, 232, 11, "#6aa6e8"),
  );
  o.push(
    Hit(415, 224, 72, 16, "View all properties: the Browser", () =>
      c.go("browser"),
    ),
  );
  // media
  o.push(
    card(18, 255, 472, 187),
    I("camera", 32, 269, 12, "#6aa6e8"),
    T(46, 269, "Media", "#6aa6e8", 10, 400, "font-weight:700"),
  );
  o.push(
    A(26, 291, 96, 13, "background:#fad260"),
    Tc(74, 297, "Thumbnail", "#111", 9, 96),
  );
  const media: [number, number, number, number, number][] = [
    [35, 305, 79, 78, 2.6],
    [134, 315, 88, 60, 1.3],
    [255, 305, 53, 78, 0.65],
  ];
  media.forEach(([x, yy, w, h, kk], i) =>
    o.push(
      A(x, yy, w, h, sceneBg(sx, sy, w, h, kk)),
      Tc(x + w / 2, 391, `${SELT} (${i + 1})`, "#f1f4f5", 9.5, 130),
      Tc(x + w / 2, 404, "OSINT", "#8f99a8", 8, 60),
    ),
  );
  o.push(
    T(405, 427, `View all ${media.length}`, "#6aa6e8", 9.5),
    I("arrow-right", 478, 427, 11, "#6aa6e8"),
  );
  o.push(
    Hit(399, 419, 88, 16, "View all media: the Browser", () => c.go("browser")),
  );
  // map
  o.push(
    card(18, 452, 472, 244),
    I("map", 32, 464, 12, "#6aa6e8"),
    T(46, 464, "Map", "#6aa6e8", 10, 400, "font-weight:700"),
  );
  const k = 1.25;
  const mx0 = 20,
    my0 = 477,
    mw = 468,
    mh = 218;
  o.push(A(mx0, my0, mw, mh, sceneBg(sx, sy, mw, mh, k, "brightness(.62)")));
  // the highlight (_kit/highlight.py): a rose heat blob (sigma 14 scene px) per
  // live hull within 1.3 r of the selection, and the grey ring between dark
  // edges. shortcut: no water clip (the plate's coastline is not segmented
  // here), so the ring crosses land where highlight.py stops at the coast.
  const ring = 62 * k;
  const sig = 14 * k;
  const dots = c.box.flatMap((v) => {
    const [vx, vy] = toPx(v.lon, v.lat);
    const x = (vx - sx) * k + mw / 2,
      y = (vy - sy) * k + mh / 2;
    return Math.hypot(x - mw / 2, y - mh / 2) <= ring * 1.3
      ? [[x, y, v.mmsi] as const]
      : [];
  });
  o.push(
    <svg
      aria-hidden
      style={{ left: mx0, top: my0, width: mw, height: mh, overflow: "hidden" }}
      viewBox={`0 0 ${mw} ${mh}`}
    >
      <defs>
        <radialGradient id="pdf-heat">
          <stop offset="0" stopColor="rgb(205,98,108)" stopOpacity=".16" />
          <stop offset=".5" stopColor="rgb(205,98,108)" stopOpacity=".07" />
          <stop offset="1" stopColor="rgb(205,98,108)" stopOpacity="0" />
        </radialGradient>
      </defs>
      {dots.map(([x, y, m]) => (
        <circle key={m} cx={x} cy={y} r={sig * 2} fill="url(#pdf-heat)" />
      ))}
      <circle
        cx={mw / 2}
        cy={mh / 2}
        r={ring}
        fill="none"
        stroke="rgba(0,0,10,.63)"
        strokeWidth={3.6}
      />
      <circle
        cx={mw / 2}
        cy={mh / 2}
        r={ring}
        fill="none"
        stroke="rgb(154,154,164)"
        strokeWidth={1.8}
      />
    </svg>,
  );
  o.push(
    A(
      26,
      486,
      24,
      90,
      "background:#2a3038;border:1px solid #4a525a;border-radius:2px",
    ),
  );
  for (const [yy, ic] of [
    [497, "zoom-in"],
    [519, "zoom-out"],
    [541, "zoom-to-fit"],
    [563, "layers"],
  ] as const)
    o.push(I(ic, 38, yy, 12, "#dfe5e7"));
  for (const yy of [508, 530, 552])
    o.push(A(28, yy, 20, 1, "background:#4a525a"));
  o.push(
    Hit(
      26,
      486,
      24,
      88,
      "Map controls",
      undefined,
      `A fixed ${((ring / k) * KM_PER_PX).toFixed(1)} km card; the console's globe pans and zooms`,
    ),
  );
  o.push(
    A(
      mx0 + mw / 2 - 11,
      my0 + mh / 2 - 11,
      22,
      22,
      `${sceneBg(sx, sy, 22, 22, 1.2)};border:2px solid #e0a64a;border-radius:3px`,
    ),
  );
  // links lower
  o.push(card(500, 72, 475, 431));
  const L = linksOf(c);
  const grp = (y: number, name: string, n: number): N[] => [
    I("chevron-down", 515, y, 10, "#e5e8eb"),
    T(525, y, name, "#f1f4f5", 10, 400, "font-weight:700"),
    T(525 + 6.1 * name.length + 8, y, `(${n})`, TXD, 10),
  ];
  o.push(...grp(89, "Nearby events", L.alt.length));
  L.alt.forEach((w, k2) =>
    o.push(
      I("high-priority", 518, 108 + 23 * k2, 12, "#aab4bc"),
      T(530, 108 + 23 * k2, w, "#6aa6e8", 9.5),
    ),
  );
  o.push(...grp(207, "Place", L.ports5.length));
  L.ports5.forEach((w, k2) =>
    o.push(
      I(
        "geosearch",
        518 + (k2 % 3) * 148,
        227 + 23 * Math.floor(k2 / 3),
        12,
        "#d9a63a",
      ),
      T(530 + (k2 % 3) * 148, 227 + 23 * Math.floor(k2 / 3), w, "#6aa6e8", 9.5),
    ),
  );
  o.push(
    ...grp(279, "Sanctions lists", L.lists.length),
    I("shield", 518, 298, 12, "#6aa6e8"),
    T(530, 298, sancLine(c), "#6aa6e8", 9.5),
  );
  o.push(...grp(328, "Vessel", L.near6.length));
  L.near6.forEach((r, k2) => {
    const x = 518 + (k2 % 3) * 148,
      y = 348 + 23 * Math.floor(k2 / 3);
    o.push(
      shipicon(x, y, "#aab4bc", 12),
      T(x + 12, y, title(r.name), "#6aa6e8", 9.5),
      Hit(x - 7, y - 9, 140, 18, `Open ${r.name}`, () => c.pick(r.mmsi)),
    );
  });
  o.push(
    T(515, 397, "More object types", TXD, 9.5),
    I("waves", 530, 424, 12, "#6aa6e8"),
    T(544, 424, "Chokepoint", "#6aa6e8", 9.5, 400, "font-weight:700"),
    T(606, 424, `(${L.chokes.length})`, TXD, 9.5),
  );
  const nall =
    L.alt.length +
    L.ports5.length +
    L.lists.length +
    L.near6.length +
    L.chokes.length +
    L.wl.length;
  o.push(
    A(501, 468, 473, 1, `background:${CBD}`),
    T(902, 481, `View all ${nall}`, "#6aa6e8", 9.5),
    I("arrow-right", 966, 481, 11, "#6aa6e8"),
  );
  o.push(
    Hit(896, 473, 78, 16, "View all links: the Browser", () => c.go("browser")),
  );
  // related artifacts
  o.push(
    card(500, 505, 475, 171),
    I("document-share", 513, 518, 12, "#e5e8eb"),
    T(528, 518, "Related Artifacts", "#f1f4f5", 10, 400, "font-weight:700"),
  );
  c.evidence.slice(0, 4).forEach((e, k2) => {
    const x = 515 + k2 * 114.7;
    o.push(
      A(x, 546, 99, 79, "background:#343252"),
      I("edit", x + 49.5, 585, 12, "#7b6ff0"),
    );
    const ttl =
      e.props.title || e.props.source_url || e.props.filename || "capture";
    o.push(
      T(
        x,
        635,
        ttl.slice(0, 15) + (ttl.length > 15 ? "..." : ""),
        "#6aa6e8",
        8.7,
        400,
        "font-weight:700",
      ),
      T(x, 648, "OSINT", "#e5e8eb", 8.5),
    );
    o.push(
      Hit(x, 546, 99, 110, `${ttl}: the evidence locker`, () => c.go("chat")),
    );
  });
  if (!c.evidence.length)
    o.push(T(515, 560, "The evidence locker is empty", TXD, 9.5));
  o.push(
    A(
      500,
      683,
      475,
      14,
      "border:1px solid #1fb5b0;border-radius:2px;border-bottom:none",
    ),
  );
  return frag(o);
}
