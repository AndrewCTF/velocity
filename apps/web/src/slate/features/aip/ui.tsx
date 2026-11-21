// Small helpers still shared outside the AIP pages (pdf, foundry and europa
// kits import css, frag and Hit from here).
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
