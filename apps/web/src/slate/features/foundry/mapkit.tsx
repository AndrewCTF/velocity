// Shared Workshop map chrome (map_tools, mini_bar, timeline_strip, scale_nm,
// plane, pin_tile, swatch_legend, attribution; _build_foundry_apps.py:338-929).
import { BLU, DARK, E, I, frag, hairline, kit, tri, type Kit, type N } from "./kit.js";
import { fmt_d, fmt_t } from "./data.js";

export const PBLUE = "#3d6fd1";
export const PLBLUE = "#7fc1ed";
export const PLAV = "#b9a9ee";
export const PRED = "#c14a4a";
export const WSEL = "#d5dff2";
export const ATTR = "© Esri, HERE, Garmin, FAO, NOAA, USGS";

const k1 = kit(1);

export function attribution(x: number, y: number, text = ATTR): N {
  return (
    <div className="t" style={{ left: x, top: y, fontSize: 8, color: "#2d72d2", background: "rgba(255,255,255,.7)", padding: "0 3px", lineHeight: "11px" }}>
      {text}
    </div>
  );
}

export function map_tools(x: number, y: number): N {
  const sh = "box-shadow:0 1px 3px rgba(17,20,24,.2)";
  return frag([
    k1.bx(x, y, 34, 66, "#fff", "#d3d8de", 3, sh),
    I("send-to-map", x + 17, y + 17, 17, "#394048"),
    I("zoom-to-fit", x + 17, y + 49, 17, "#394048"),
    k1.bx(x, y + 74, 34, 66, "#fff", "#d3d8de", 3, sh),
    I("zoom-in", x + 17, y + 91, 17, "#394048"),
    I("zoom-out", x + 17, y + 123, 17, "#394048"),
    k1.bx(x, y + 148, 34, 34, "#fff", "#d3d8de", 3, sh),
    I("compass", x + 17, y + 165, 17, "#394048"),
  ]);
}

export const mini_bar = (x: number, y: number, w: number, h: number, bg = "#fff", bd = "#d3d8de", r = 2, sh = true): N =>
  k1.bx(x, y, w, h, bg, bd, r, sh ? "box-shadow:0 1px 4px rgba(17,20,24,.22)" : "");

export function scale_nm(x: number, y: number, kmPx: number): N {
  const nice = [5, 10, 20, 50, 100, 200, 500, 1000];
  const best = nice.reduce((b, v) => (Math.abs((v * 1.852) / kmPx - 80) < Math.abs((b * 1.852) / kmPx - 80) ? v : b));
  return frag([k1.bx(x, y, 121, 18, "#fff", "#d3d8de", 2), E(x + 4, y + 15, (best * 1.852) / kmPx, 1, "background:#394048"), k1.txt(x + 6, y + 8, `${best} nm`, 9.5, DARK)]);
}

export function plane(x: number, y: number, col: string, size = 22, sel = false, rot = 0): N {
  const halo = "filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1.5px #fff);";
  const ring = sel ? `filter:drop-shadow(0 0 1.5px ${BLU}) drop-shadow(0 0 2px ${BLU}) drop-shadow(0 0 1px #fff);` : halo;
  return I("airplane", x, y, size, col, `${ring}transform:rotate(${rot}deg);`);
}

export const pin_tile = (x: number, y: number, col: string, s = 34): N =>
  frag([E(x, y, s, s, `background:${col};border-radius:2px`), I("map-marker", x + s / 2, y + s / 2, Math.round(s * 0.5), "#fff")]);

export function swatch_legend(x: number, y: number, w: number, labels: string[], cols: string[]): N {
  const n = cols.length;
  const bw = (w - 3 * (n - 1)) / n;
  return frag(
    cols.map((c, i) =>
      frag([E(x + i * (bw + 3), y, bw, 12, `background:${c};border-radius:2px`), k1.txt(x + i * (bw + 3) + bw / 2, y + 20, labels[i] ?? "", 10.8, "#5f6b7c", 400, bw, "c")]),
    ),
  );
}

/** Palantir timeline: Time filter, date, View Latest, play, 1x, Time range, fit/+/-, axis, event row, cursor. */
export function timeline_strip(
  x0: number,
  y0: number,
  W: number,
  nowLbl: number,
  rng: [string, string],
  axis: Array<[number, string]>,
  cursorX: number,
  dots: N,
  chip: string,
  chipCol = "#6b7480",
  chipX: number | null = null,
  layout: "dt" | "d" = "dt",
  h = 75,
): N {
  const { txt, bx }: Kit = k1;
  const L = {
    dt: { d: [407, 146], vl: [557, 93], pl: 655, x1: 683, tr: 746, r1: [813, 243], dash: 968, btn: 1059 },
    d: { d: [402, 156], vl: [562, 91], pl: 657, x1: 686, tr: 810, r1: [875, 177], dash: 962, btn: 1058 },
  }[layout];
  const ex = x0 + L.btn;
  const cwd = chip.length > 20 ? 138 : 120;
  const cx0 = x0 + (chipX === null ? cursorX - cwd / 2 : chipX);
  return frag([
    E(x0, y0, W, h, "background:#fff"),
    hairline(x0, y0, W, "#c5cbd3"),
    bx(x0, y0 + 4, 22, 30, "#f6f7f9", "#c5cbd3", 2),
    I("double-chevron-up", x0 + 11, y0 + 19, 14, "#404854"),
    bx(x0 + 26, y0 + 4, 105, 30, "#f6f7f9", "#c5cbd3", 2),
    txt(x0 + 38, y0 + 19.5, "Time filter", 12, DARK),
    I("add", x0 + 113, y0 + 19, 16, "#404854"),
    bx(x0 + L.d[0]!, y0 + 4, L.d[1]!, 30, "#fff", "#c5cbd3", 2),
    txt(x0 + L.d[0]! + 8, y0 + 19.5, [<b key="b">{fmt_d(nowLbl)}</b>, `\u00a0 ${fmt_t(nowLbl)}`], 11.8, DARK),
    bx(x0 + L.vl[0]!, y0 + 4, L.vl[1]!, 30, "#eaf0fa", "#c5cbd3", 2),
    txt(x0 + L.vl[0]! + 10, y0 + 19.5, <span style={{ color: "#215db0", fontWeight: 600 }}>View Latest {"→"}</span>, 11.8, "#215db0"),
    bx(x0 + L.pl, y0 + 4, 25, 30, "#f6f7f9", "#c5cbd3", 2),
    I("play", x0 + L.pl + 12, y0 + 19, 12, "#404854"),
    bx(x0 + L.x1, y0 + 4, 41, 30, "#fff", "#c5cbd3", 2),
    txt(x0 + L.x1 + 20, y0 + 19.5, "1x", 11.5, DARK, 400, 41, "c"),
    txt(x0 + L.tr, y0 + 19.5, "Time range", 12.5, DARK),
    bx(x0 + L.r1[0]!, y0 + 4, L.r1[1]!, 30, "#fff", "#c5cbd3", 2),
    txt(x0 + L.r1[0]! + 8, y0 + 19.5, rng[0], 11.8, DARK),
    txt(x0 + L.dash, y0 + 19.5, "–", 11, DARK),
    txt(x0 + L.dash + 15, y0 + 19.5, rng[1], 11.8, DARK),
    bx(ex, y0 + 4, 29, 30, "#f6f7f9", "#c5cbd3", 2),
    I("arrows-horizontal", ex + 14, y0 + 19, 14, "#404854"),
    bx(ex + 31, y0 + 4, 21, 30, "#f6f7f9", "#c5cbd3", 2),
    I("plus", ex + 41, y0 + 19, 12, "#404854"),
    bx(ex + 54, y0 + 4, 21, 30, "#f6f7f9", "#c5cbd3", 2),
    I("minus", ex + 64, y0 + 19, 12, "#404854"),
    frag(axis.map(([ax, lab]) => txt(x0 + ax, y0 + 45, lab, 11, "#404854", 400, 90, "c"))),
    dots,
    E(x0 + cursorX, y0 + 40, 1, h - 40, "background:#2d72d2"),
    tri(x0 + cursorX - 5, y0 + 38, "border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #2d72d2"),
    E(cx0, y0 + 43, cwd, 17, `background:${chipCol};border-radius:2px`),
    txt(cx0 + cwd / 2, y0 + 52, chip, 9.5, "#fff", 400, cwd, "c"),
  ]);
}
