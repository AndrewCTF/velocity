// Drawing kit for the document-figure copy (gotham/pdf/gotham-a.html, built by
// gotham/pdf/_build_gotham_a.py). Each helper mirrors the builder's helper of
// the same name and argument order (T, A, I, IS, HL, FR), so every section
// ports line for line in the evidence image's own pixel coordinates. `extra`
// / `style` keep the builder's inline CSS strings verbatim (parsed by css()).
import type { CSSProperties, ReactNode } from "react";
import { css } from "../aip/ui.js";
// shortcut: reference-derived image kept out of the repo; the page draws without it. Ship a licensed asset to restore it.
const scene: string = "";

export { css, frag, Hit } from "../aip/ui.js";
export type N = ReactNode;

/** T(x, yc, text, color, size, w, extra, right, center): a 14 px text line
 *  centred on yc. `w` is only the box width of a right/centre aligned line. */
export function T(
  x: number,
  yc: number,
  text: N,
  color = "#000",
  size = 10.5,
  w = 400,
  extra = "",
  right = false,
  center = false,
): N {
  const st: CSSProperties = center
    ? { left: x - w / 2, width: w, textAlign: "center" }
    : right
      ? { left: x - w, width: w, textAlign: "right" }
      : { left: x };
  return (
    <div
      className="t"
      style={{ ...st, top: yc - 7, color, fontSize: size, ...css(extra) }}
    >
      {text}
    </div>
  );
}
export const Tr = (
  x: number,
  yc: number,
  text: N,
  color: string,
  size: number,
  w: number,
  extra = "",
): N => T(x, yc, text, color, size, w, extra, true);
export const Tc = (
  x: number,
  yc: number,
  text: N,
  color: string,
  size: number,
  w: number,
  extra = "",
): N => T(x, yc, text, color, size, w, extra, false, true);

export function A(
  x: number,
  y: number,
  w: number,
  h: number,
  style = "",
  inner: N = null,
): N {
  return (
    <div style={{ left: x, top: y, width: w, height: h, ...css(style) }}>
      {inner}
    </div>
  );
}

const SPRITE = `${import.meta.env.BASE_URL}bp-sprite.svg#bp-`;

/** Blueprint sprite glyph centred on (xc, yc). */
export function I(
  name: string,
  xc: number,
  yc: number,
  size = 12,
  color = "currentColor",
  extra = "",
): N {
  return (
    <svg
      className="i"
      aria-hidden
      style={{
        left: xc - size / 2,
        top: yc - size / 2,
        width: size,
        height: size,
        color,
        ...css(extra),
      }}
    >
      <use href={SPRITE + name} />
    </svg>
  );
}

// The two stroke glyphs the builder takes from _kit/sprite.svg (i-globe, i-ship),
// inlined: that sprite is not served by the app.
const STROKE: Record<string, JSX.Element> = {
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  ship: (
    <>
      <path d="M12 10.189V14" />
      <path d="M12 2v3" />
      <path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6" />
      <path d="M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76" />
      <path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />
    </>
  ),
};

/** Stroke-outline glyph (the builder's IS). */
export function IS(
  name: "globe" | "ship",
  xc: number,
  yc: number,
  size = 14,
  color = "currentColor",
): N {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      style={{
        left: xc - size / 2,
        top: yc - size / 2,
        width: size,
        height: size,
        color,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.7,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }}
    >
      {STROKE[name]}
    </svg>
  );
}

/** The media card draws three crops of the plate at the vessel (the builder's
 *  scene_crop calls); the tab badge counts them. */
export const N_MEDIA = 3;

export const HL = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color = "#fdeeb5",
): N => A(x0, y0, x1 - x0, y1 - y0, `background:${color}`);

export const shipicon = (xc: number, yc: number, col = "#abb3bf", s = 20): N =>
  IS("ship", xc, yc, s, col);

/** hit(text, kw): the keyword highlighted in yellow where it occurs. */
export function hit(text: string, kw: string): N {
  const i = kw ? text.toLowerCase().indexOf(kw.toLowerCase()) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span style={{ background: "#fdeeb5" }}>
        {text.slice(i, i + kw.length)}
      </span>
      {text.slice(i + kw.length)}
    </>
  );
}

// ── the Gulf scene plate (the builder's scene_crop) ───────────────────────────
// scene px = [lon, mercator-lat, 1] . c (scene-gulf-live.geo.json, fitted on 19
// WPI ports, median 1.8 px)
const GEO = {
  cx: [583.9964771535901, -0.548780141312226, -31369.153900327492] as const,
  cy: [0.5652582975994047, -578.8459754290426, 15765.62913041825] as const,
};
export const SCENE_W = 1882;
export const SCENE_H = 1242;
export const KM_PER_PX = 0.1726;
export function toPx(lon: number, lat: number): [number, number] {
  const m =
    (180 / Math.PI) *
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));
  return [
    GEO.cx[0] * lon + GEO.cx[1] * m + GEO.cx[2],
    GEO.cy[0] * lon + GEO.cy[1] * m + GEO.cy[2],
  ];
}

/** scene_crop(cx, cy, w, h, k) as a background: the plate centred on scene px
 *  (cx, cy), scaled by k, filling a w x h box. `filter` replaces the builder's
 *  PIL enhance chain. */
export function sceneBg(
  cx: number,
  cy: number,
  w: number,
  h: number,
  k = 1,
  filter = "",
): string {
  const bx = w / 2 - cx * k;
  const by = h / 2 - cy * k;
  return (
    `background:${scene ? `url(${scene})` : "none"} ${bx.toFixed(1)}px ${by.toFixed(1)}px/${(SCENE_W * k).toFixed(1)}px ${(SCENE_H * k).toFixed(1)}px no-repeat #0a1220` +
    (filter ? `;filter:${filter}` : "")
  );
}

/** One copy section: the evidence image's W x H frame, cropped to (x0, y0, w,
 *  h), fitted into the surface with CSS zoom, as the copy page shows it. */
export function Frame({
  crop,
  W,
  H,
  bg,
  zoom,
  children,
}: {
  crop: [number, number, number, number];
  W: number;
  H: number;
  bg: string;
  zoom: number;
  children: N;
}): JSX.Element {
  const [x0, y0, w, h] = crop;
  return (
    <div
      className="copy"
      style={{
        width: w,
        height: h,
        position: "relative",
        overflow: "hidden",
        background: bg,
        zoom,
      }}
    >
      <div className="fr" style={{ left: -x0, top: -y0, width: W, height: H }}>
        {children}
      </div>
    </div>
  );
}
