// Drawing kit for the AIP copy (gotham/aip/features-a.html, built by
// gotham/aip/_build_features_a.py). Every helper mirrors the builder's helper of
// the same name and signature (T, R, I, L, CLIP, SVG), so each frame ports line
// for line in the copy's own 1920x1080 frame coordinates. `ex` keeps the
// builder's inline CSS strings verbatim and is parsed here.
import {
  Fragment,
  createElement,
  type CSSProperties,
  type ReactNode,
} from "react";

export type N = ReactNode;

const camel = (k: string): string =>
  k.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** "border-radius:2px;box-shadow:0 1px 5px rgba(0,0,0,.18)" -> style object. */
export function css(s: string | undefined): CSSProperties {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const part of s.split(";")) {
    const i = part.indexOf(":");
    if (i < 1) continue;
    out[camel(part.slice(0, i))] = part.slice(i + 1).trim();
  }
  return out as CSSProperties;
}

/** Children as varargs, so a frame's flat element list needs no keys. */
export const frag = (s: N[]): JSX.Element =>
  createElement(Fragment, null, ...s);

export function T(
  x: number,
  y: number,
  text: N,
  size = 16,
  color = "#2e3438",
  w = 400,
  ex = "",
  cls = "",
  align: "l" | "r" | "c" = "l",
): N {
  const c = { l: "", r: "tr", c: "tc" }[align];
  return (
    <div
      className={`t ${c} ${cls}`}
      style={{
        left: x,
        top: y,
        fontSize: size,
        color,
        fontWeight: w,
        ...css(ex),
      }}
    >
      {text}
    </div>
  );
}

export function R(
  x: number,
  y: number,
  w: number,
  h: number,
  bg = "transparent",
  bd = "",
  ex = "",
  inner: N = null,
  cls = "",
): N {
  return (
    <div
      className={`a ${cls}`}
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        background: bg,
        ...(bd ? { border: `1px solid ${bd}` } : {}),
        ...css(ex),
      }}
    >
      {inner}
    </div>
  );
}

const SPRITE = `${import.meta.env.BASE_URL}bp-sprite.svg#bp-`;

export function I(
  name: string,
  cx: number,
  cy: number,
  size = 16,
  color = "currentColor",
  ex = "",
): N {
  return (
    <svg
      className="i"
      aria-hidden
      style={{
        left: cx - size / 2,
        top: cy - size / 2,
        width: size,
        height: size,
        color,
        ...css(ex),
      }}
    >
      <use href={SPRITE + name} />
    </svg>
  );
}

/** Inline (flowing) icon, as hand_card writes it. */
export function Ii(name: string, color: string): N {
  return (
    <svg
      className="i"
      aria-hidden
      style={{ width: 16, height: 16, verticalAlign: -3, color }}
    >
      <use href={SPRITE + name} />
    </svg>
  );
}

export function L(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  col = "#d9dfe2",
  wd = 1,
  ex = "",
): N {
  const st: CSSProperties =
    y1 === y2
      ? {
          left: Math.min(x1, x2),
          top: y1,
          width: Math.abs(x2 - x1),
          height: wd,
        }
      : {
          left: x1,
          top: Math.min(y1, y2),
          width: wd,
          height: Math.abs(y2 - y1),
        };
  return <div className="a" style={{ ...st, background: col, ...css(ex) }} />;
}

export function CLIP(
  x: number,
  y: number,
  w: number,
  h: number,
  inner: N[],
  bg = "transparent",
  ex = "",
): N {
  return (
    <div
      className="a"
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        overflow: "hidden",
        background: bg,
        ...css(ex),
      }}
    >
      <div className="fr" style={{ left: -x, top: -y }}>
        {frag(inner)}
      </div>
    </div>
  );
}

export function SVG(inner: N[], x = 0, y = 0, w = 1920, h = 1080, ex = ""): N {
  return (
    <svg
      className="a"
      aria-hidden
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        overflow: "visible",
        ...css(ex),
      }}
      viewBox={`${x} ${y} ${w} ${h}`}
    >
      {frag(inner)}
    </svg>
  );
}

/** A transparent hit target over a drawn control: the copy's pixels stay the
 *  copy's, and the control under them runs. */
export function Hit(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  onClick?: () => void,
  disabledWhy?: string,
): N {
  return (
    <button
      type="button"
      className="a sl-hit"
      aria-label={label}
      title={onClick ? label : (disabledWhy ?? label)}
      disabled={!onClick}
      onClick={onClick}
      style={{ left: x, top: y, width: w, height: h }}
    />
  );
}

/** The builder's spinner(): a grey ring with a 70 degree blue arc. */
export function spinner(cx: number, cy: number, r = 30): N {
  const s = 2 * r + 8;
  const a = (70 * Math.PI) / 180;
  const ex = 4 + r * (1 - Math.cos(a));
  const ey = r + 4 - r * Math.sin(a);
  return (
    <svg
      className="a sl-spin"
      aria-hidden
      style={{ left: cx - r - 4, top: cy - r - 4, width: s, height: s }}
      viewBox={`0 0 ${s} ${s}`}
    >
      <circle
        cx={r + 4}
        cy={r + 4}
        r={r}
        fill="none"
        stroke="#dfe4e8"
        strokeWidth={5}
      />
      <path
        d={`M${r + 4} 4 A${r} ${r} 0 0 0 ${ex} ${ey}`}
        fill="none"
        stroke="#2c4f9c"
        strokeWidth={5}
        strokeLinecap="round"
        transform={`rotate(-40 ${r + 4} ${r + 4})`}
      />
    </svg>
  );
}

/** Fits the copy's window crop (x0, y0, w, h of the 1920x1080 frame) into the
 *  surface with CSS zoom, as the copy page itself scales each section. */
export function Frame({
  x0,
  y0,
  w,
  h,
  zoom,
  children,
}: {
  x0: number;
  y0: number;
  w: number;
  h: number;
  zoom: number;
  children: N;
}): JSX.Element {
  return (
    <div
      className="copy"
      style={{
        width: w,
        height: h,
        position: "relative",
        overflow: "hidden",
        zoom,
        background: "#fff",
      }}
    >
      <div className="fr" style={{ left: -x0, top: -y0 }}>
        {children}
      </div>
    </div>
  );
}
