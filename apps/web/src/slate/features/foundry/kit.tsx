// Drawing kit for the Foundry apps copy (gotham/docs/foundry-apps.html, built
// by gotham/docs/_build_foundry_apps.py). Every helper mirrors the builder's
// helper of the same name and argument order (E, T/txt, I, bx, inp, sel_box,
// toggle, chk, hairline, vline, stepper, btn, tile_icon, ...), so each frame
// ports line for line in the copy's own logical coordinates. `st`/`extra`
// keep the builder's inline CSS strings verbatim. `kit(tsv)` binds the
// builder's per-section text scale TSV[0].
import type { CSSProperties, ReactNode } from "react";
import { css, frag } from "../aip/ui.js";

export type N = ReactNode;
export { frag };

export const LINE = "#d3d8de";
export const T0 = "#1c2127";
export const T1 = "#2f343c";
export const T2 = "#5f6b7c";
export const BLUE = "#2d72d2";
export const INK = "#215db0";
export const DARK = "#1c2127";
export const GREY = "#5f6b7c";
export const FAINT = "#8f99a8";
export const HAIR = "#d3d8de";
export const CONTENT = "#f6f6f8";
export const BLU = "#2d72d2";

const SPRITE = `${import.meta.env.BASE_URL}bp-sprite.svg#bp-`;

/** Python's round(): half to even (the builder's line heights use it). */
export function pyRound(x: number, nd = 0): number {
  const m = 10 ** nd;
  const v = x * m;
  const f = Math.floor(v);
  const d = v - f;
  const r =
    Math.abs(d - 0.5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(v);
  return r / m;
}

/** CSS text with a font-size override multiplied (sec_d191's post-pass). */
export function scaleFs(s: string, k: number): string {
  return s.replace(
    /font-size:(\d+)px/g,
    (_, n: string) => `font-size:${pyRound(Number(n) * k)}px`,
  );
}

export function E(
  x: number,
  y: number,
  w: number,
  h: number,
  st = "",
  inner: N = null,
  cls = "",
): N {
  return (
    <div
      className={cls}
      style={{ left: x, top: y, width: w, height: h, ...css(st) }}
    >
      {inner}
    </div>
  );
}

export function I(
  name: string,
  x: number,
  y: number,
  size = 16,
  col = "#404854",
  extra = "",
): N {
  return (
    <svg
      className="i"
      aria-hidden
      style={{
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        color: col,
        fill: "currentColor",
        ...css(extra),
      }}
    >
      <use href={SPRITE + name} />
    </svg>
  );
}

/** An inline sprite glyph inside a text run. */
export function Ii(name: string, size: number, col: string, st = ""): N {
  return (
    <svg
      className="i"
      aria-hidden
      style={{
        position: "static",
        width: size,
        height: size,
        color: col,
        verticalAlign: -2,
        ...css(st),
      }}
    >
      <use href={SPRITE + name} />
    </svg>
  );
}

/** A CSS triangle (the builder's border-trick carets). */
export function tri(x: number, y: number, st: string): N {
  return <div style={{ left: x, top: y, width: 0, height: 0, ...css(st) }} />;
}

export type Al = "l" | "c" | "r";

export interface Kit {
  T: (
    x: number,
    yc: number,
    s: N,
    size?: number,
    col?: string,
    wt?: number,
    w?: number | null,
    al?: Al,
    extra?: string,
  ) => N;
  txt: (
    x: number,
    yc: number,
    s: N,
    size?: number,
    col?: string,
    wt?: number,
    w?: number | null,
    al?: Al,
    it?: boolean,
    extra?: string,
  ) => N;
  bx: (
    x: number,
    y: number,
    w: number,
    h: number,
    bg?: string,
    bd?: string,
    r?: number,
    extra?: string,
    inner?: N,
  ) => N;
  inp: (
    x: number,
    y: number,
    w: number,
    h: number,
    val?: N,
    size?: number,
    col?: string,
    bg?: string,
    bd?: string,
    ph?: boolean,
  ) => N;
  sel_box: (
    x: number,
    y: number,
    w: number,
    h: number,
    val: N,
    size?: number,
    bg?: string,
    o?: {
      icon?: N;
      clear?: boolean;
      ph?: boolean;
      idx?: number;
      cs?: number;
      bd?: string;
    },
  ) => N;
  btn: (
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    icon?: string | null,
    bg?: string,
    bd?: string,
    col?: string,
    size?: number,
    wt?: number,
  ) => N;
  stepper: (x: number, y: number, h?: number) => N;
  tile_icon: (
    x: number,
    y: number,
    s: number,
    bg: string,
    glyph: string,
    gl?: string,
  ) => N;
  /** font-size multiplier applied to `extra` strings (sec_d191 scales them by 1.16) */
  fs: number;
}

export function kit(tsv = 1, fs = 1): Kit {
  const T: Kit["T"] = (
    x,
    yc,
    s,
    size = 12.5,
    col = T0,
    wt = 400,
    w = null,
    al = "l",
    extra = "",
  ) => {
    const sz = pyRound(size * tsv, 2);
    const lh = pyRound(sz * 1.25);
    let pos: CSSProperties;
    if (al === "c")
      pos = { left: x - (w || 400) / 2, textAlign: "center", width: w || 400 };
    else if (al === "r")
      pos = { left: x - (w || 400), textAlign: "right", width: w || 400 };
    else
      pos = w
        ? { left: x, width: w, overflow: "hidden", textOverflow: "ellipsis" }
        : { left: x };
    return (
      <div
        className="t"
        style={{
          ...pos,
          top: yc - lh / 2,
          lineHeight: `${lh}px`,
          height: lh,
          fontSize: sz,
          color: col,
          fontWeight: wt,
          ...css(fs !== 1 ? scaleFs(extra, fs) : extra),
        }}
      >
        {Array.isArray(s) ? frag(s as N[]) : s}
      </div>
    );
  };
  const txt: Kit["txt"] = (
    x,
    yc,
    s,
    size = 12.5,
    col = DARK,
    wt = 400,
    w = null,
    al = "l",
    it = false,
    extra = "",
  ) =>
    T(x, yc, s, size, col, wt, w, al, (it ? "font-style:italic;" : "") + extra);
  const bx: Kit["bx"] = (
    x,
    y,
    w,
    h,
    bg = "#fff",
    bd = HAIR,
    r = 2,
    extra = "",
    inner = null,
  ) =>
    E(
      x,
      y,
      w,
      h,
      `background:${bg};border:1px solid ${bd};border-radius:${r}px;${extra}`,
      inner,
    );
  const inp: Kit["inp"] = (
    x,
    y,
    w,
    h,
    val = "",
    size = 12.5,
    col = DARK,
    bg = "#fff",
    bd = "#abb3bf",
    ph = false,
  ) =>
    frag([
      bx(x, y, w, h, bg, bd, 2),
      val ? txt(x + 8, y + h / 2 + 0.5, val, size, ph ? FAINT : col) : null,
    ]);
  const sel_box: Kit["sel_box"] = (
    x,
    y,
    w,
    h,
    val,
    size = 12.5,
    bg = "#f6f7f9",
    o = {},
  ) => {
    const cs = o.cs ?? 1;
    const idx = o.idx ?? 26;
    const cx = x + w - 15 * cs;
    return frag([
      bx(
        x,
        y,
        w,
        h,
        bg,
        o.bd ?? "#c5cbd3",
        2,
        "box-shadow:inset 0 -1px 0 rgba(17,20,24,.08)",
      ),
      o.icon ?? null,
      txt(
        x + 9 + (o.icon ? idx : 0),
        y + h / 2 + 0.5,
        val,
        size,
        o.ph ? FAINT : DARK,
      ),
      tri(
        cx - 5 * cs,
        y + h / 2 - 2 * cs,
        `border-left:${5 * cs}px solid transparent;border-right:${5 * cs}px solid transparent;border-top:${5 * cs}px solid #5f6b7c`,
      ),
      o.clear ? I("small-cross", cx - 26, y + h / 2, 14, "#5f6b7c") : null,
    ]);
  };
  const btn: Kit["btn"] = (
    x,
    y,
    w,
    h,
    label,
    icon = null,
    bg = "#f6f7f9",
    bd = "#c5cbd3",
    col = DARK,
    size = 12.5,
    wt = 400,
  ) => {
    const tw = label.length * size * 0.47 + (icon ? 22 : 0);
    let xx = x + (w - tw) / 2;
    const o: N[] = [
      bx(
        x,
        y,
        w,
        h,
        bg,
        bd,
        2,
        bg !== "#fff" ? "box-shadow:inset 0 -1px 0 rgba(17,20,24,.08)" : "",
      ),
    ];
    if (icon) {
      o.push(I(icon, xx + 7, y + h / 2, 14, col));
      xx += 22;
    }
    o.push(txt(xx, y + h / 2 + 0.5, label, size, col, wt));
    return frag(o);
  };
  const stepper: Kit["stepper"] = (x, y, h = 30) =>
    frag([
      bx(x, y, 30, h, "#f6f7f9", "#c5cbd3", 2),
      I("chevron-up", x + 15, y + h / 2 - 5.5, 11, "#5f6b7c"),
      I("chevron-down", x + 15, y + h / 2 + 5.5, 11, "#5f6b7c"),
    ]);
  const tile_icon: Kit["tile_icon"] = (x, y, s, bg, glyph, gl) =>
    frag([
      E(x, y, s, s, `background:${bg};border-radius:2px`),
      I(glyph, x + s / 2, y + s / 2, pyRound(s * 0.62), gl ?? "#fff"),
    ]);
  return { T, txt, bx, inp, sel_box, btn, stepper, tile_icon, fs };
}

export function toggle(
  x: number,
  y: number,
  on: boolean,
  w = 30,
  h = 16,
  dis = false,
): N {
  const bg = on ? BLU : dis ? "#e5e8ec" : "#d3d8de";
  const kx = on ? x + w - h + 2 : x + 2;
  return frag([
    E(x, y, w, h, `background:${bg};border-radius:${h / 2}px`),
    E(
      kx,
      y + 2,
      h - 4,
      h - 4,
      on
        ? "background:#fff;border-radius:50%;box-shadow:0 0 0 1px rgba(17,20,24,.15)"
        : "background:#fff;border-radius:50%;box-shadow:0 0 0 1px rgba(17,20,24,.25)",
    ),
  ]);
}

export function chk(x: number, y: number, on: boolean, s = 16): N {
  if (on)
    return frag([
      E(x, y, s, s, `background:${BLU};border-radius:2px`),
      I("tick", x + s / 2, y + s / 2, s - 3, "#fff"),
    ]);
  return E(
    x,
    y,
    s,
    s,
    "background:#fff;border:1px solid #a5acb6;border-radius:2px;box-shadow:inset 0 1px 1px rgba(17,20,24,.1)",
  );
}

export const hairline = (x: number, y: number, w: number, col = HAIR): N =>
  E(x, y, w, 1, `background:${col}`);
export const vline = (x: number, y: number, h: number, col = HAIR): N =>
  E(x, y, 1, h, `background:${col}`);

/** A transparent hit target over a drawn control: the copy's pixels stay the
 *  copy's and the control under them runs (or says why it cannot). */
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
      className="sl-hit"
      aria-label={label}
      title={onClick ? label : (disabledWhy ?? label)}
      disabled={!onClick}
      onClick={onClick}
      style={{ left: x, top: y, width: w, height: h }}
    />
  );
}

/** The logical frame (builder frame(1, W, H, ...)). */
export function Fr({
  W,
  H,
  bg,
  children,
}: {
  W: number;
  H: number;
  bg?: string;
  children: N;
}): JSX.Element {
  return (
    <div
      className="fr"
      style={{ width: W, height: H, ...(bg ? { background: bg } : {}) }}
    >
      {children}
    </div>
  );
}

/** A blue link run inside a text line (the builder's inline <span> links). */
export const lnk = (s: string, extra = ""): N => (
  <span style={{ color: "#215db0", ...css(extra) }}>{s}</span>
);
export const span = (s: N, st: string): N => <span style={css(st)}>{s}</span>;
