// Drawing kit for the Europa copy (gotham/europa/features.html, built by
// gotham/europa/_build_features.py). Each helper mirrors the builder's helper
// of the same name and signature (T, A, I, circ, avatar, hexlogo, img,
// inset_frame, titlebar), so every frame ports line for line in the copy's own
// 1920x1080 frame coordinates. Style strings stay the builder's inline CSS.
import { createElement, Fragment, type ReactNode } from "react";
import { css } from "../aip/ui.js";

export type N = ReactNode;
export { css };

export const frag = (s: N[]): JSX.Element =>
  createElement(Fragment, null, ...s);

/** T(x, yc, txt, fs, col, w, al, ls, extra, sc): text centred on yc. */
export function T(
  x: number,
  yc: number,
  txt: N,
  fs = 9,
  col = "#e4e8ec",
  w = 400,
  al: "l" | "c" | "r" = "l",
  ls = 0.03,
  extra = "",
  sc: number | null = null,
): N {
  if (sc === null) sc = extra.includes("Arimo") ? 0 : 1.12;
  fs = fs * (sc || 1);
  ls = ls + (sc ? 0.016 : 0); // Source Sans 3 is narrower than the product face at equal cap height
  const lh = fs * 1.44;
  const tr = { l: undefined, c: "translateX(-50%)", r: "translateX(-100%)" }[
    al
  ];
  return (
    <div
      className="t"
      style={{
        left: x,
        top: +(yc - lh / 2).toFixed(1),
        fontSize: fs,
        lineHeight: `${lh.toFixed(1)}px`,
        color: col,
        fontWeight: w,
        letterSpacing: `${ls}em`,
        transform: tr,
        ...css(extra),
      }}
    >
      {txt}
    </div>
  );
}

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

const SPR = `${import.meta.env.BASE_URL}bp-sprite.svg#bp-`;
export function I(
  name: string,
  xc: number,
  yc: number,
  size = 10,
  col = "currentColor",
  extra = "",
): N {
  return (
    <svg
      className="i"
      aria-hidden
      style={{
        left: +(xc - size / 2).toFixed(1),
        top: +(yc - size / 2).toFixed(1),
        width: size,
        height: size,
        color: col,
        ...css(extra),
      }}
    >
      <use href={SPR + name} />
    </svg>
  );
}

export const circ = (
  xc: number,
  yc: number,
  r: number,
  fill: string,
  extra = "",
): N =>
  A(
    xc - r,
    yc - r,
    2 * r,
    2 * r,
    `border-radius:50%;background:${fill};${extra}`,
  );

export const avatar = (
  xc: number,
  yc: number,
  ini: string,
  r = 7,
  col = "#5840b8",
  fs = 5.2,
): N =>
  A(
    xc - r,
    yc - r,
    2 * r,
    2 * r,
    `border-radius:50%;background:${col};color:#fff;font-size:${fs}px;font-weight:700;display:grid;place-items:center;letter-spacing:0`,
    ini,
  );

export function hexlogo(xc: number, yc: number, s = 10, col = "#e4e8ec"): N {
  return (
    <svg
      aria-hidden
      style={{
        left: xc - s,
        top: yc - s,
        width: 2 * s,
        height: 2 * s,
        overflow: "visible",
      }}
      viewBox="-10 -10 20 20"
    >
      <path
        d="M0 -8 L7 -4 V4 L0 8 L-7 4 V-4Z"
        fill="none"
        stroke={col}
        strokeWidth="1.8"
      />
      <path
        d="M-3 -1 L0 4 L3 -4"
        fill="none"
        stroke={col}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const img = (
  src: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra = "",
): N => (
  <img
    alt=""
    src={src}
    style={{ left: x, top: y, width: w, height: h, ...css(extra) }}
  />
);

/** thin light border of the product inset inside the marketing slide */
export const insetFrame = (x0: number, y0: number, x1: number, y1: number): N =>
  frag([
    A(x0, y0, x1 - x0, 1, "background:#4a5258"),
    A(x0, y1 - 1, x1 - x0, 1, "background:#4a5258"),
    A(x0, y0, 1, y1 - y0, "background:#4a5258"),
    A(x1 - 1, y0, 1, y1 - y0, "background:#4a5258"),
  ]);

export function titlebar(
  title: string,
  icon: string,
  xc: number,
  yc = 293,
  x0 = 767,
  x1 = 1866,
  y0 = 280,
  y1 = 304,
): N {
  return frag([
    A(x0, y0, x1 - x0, y1 - y0, "background:#080a0c"),
    hexlogo(779, 292, 6, "#e4e8ec"),
    I(icon, xc - 21, yc, 10, icon === "chat" ? "#f0c040" : "#e4e8ec"),
    T(xc - 9, yc, title, 9.5, "#f2f4f6", 600),
  ]);
}

/** A transparent hit target over a drawn control: the copy's pixels stay the
 *  copy's and the control under them runs (or says why it cannot). */
export function Hit(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  onClick?: () => void,
  why?: string,
): N {
  return (
    <button
      type="button"
      className="sl-hit"
      aria-label={label}
      title={onClick ? label : (why ?? label)}
      disabled={!onClick}
      onClick={onClick}
      style={{ left: x, top: y, width: w, height: h }}
    />
  );
}

/** The builder's FR(): the 1920x1080 frame shifted so the crop's corner is at 0,0. */
export const FR = (x0: number, y0: number, inner: N): N => (
  <div
    className="fr"
    style={{ left: -x0, top: -y0, background: "transparent" }}
  >
    {inner}
  </div>
);
