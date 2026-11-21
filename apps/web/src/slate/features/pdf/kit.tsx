// Shared pieces of the native workspace pages: icon, button, card, key/value
// row, the satellite plate view and the keyword highlight. A control that has
// no behaviour is rendered disabled and says why in its title.
import type { ReactNode } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import { mosaic, TILE } from "./plate.js";

export type N = ReactNode;

/** The media card shows three crops of the plate at the vessel; the tab badge counts them. */
export const N_MEDIA = 3;
export const dash = (s: string | number | null | undefined): string =>
  s === null || s === undefined || s === "" ? "—" : String(s);

export const Ic = ({
  n,
  s = 14,
  className,
}: {
  n: string;
  s?: number;
  className?: string;
}): JSX.Element => (
  <BpIcon name={n} size={s} {...(className ? { className } : {})} />
);

/** The stroke ship glyph (not in the Blueprint sprite). */
export function Ship({ s = 14 }: { s?: number }): JSX.Element {
  return (
    <svg
      aria-hidden
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      <path d="M12 10.189V14" />
      <path d="M12 2v3" />
      <path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6" />
      <path d="M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76" />
      <path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />
    </svg>
  );
}

export function Btn({
  label,
  icon,
  onClick,
  why,
  pri = false,
  on,
  sq = false,
  className = "",
  children,
}: {
  label: string;
  icon?: string;
  onClick?: (() => void) | undefined;
  why?: string;
  pri?: boolean;
  on?: boolean;
  sq?: boolean;
  className?: string;
  children?: N;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`px-btn${pri ? " pri" : ""}${sq ? " sq" : ""} ${className}`.trim()}
      aria-label={label}
      title={onClick ? label : (why ?? label)}
      disabled={!onClick}
      {...(on === undefined ? {} : { "aria-pressed": on })}
      onClick={onClick}
    >
      {icon ? <Ic n={icon} /> : null}
      {children}
    </button>
  );
}

/** A tab of a page's own tab row; the open one carries aria-current. */
export function Tab({
  label,
  onClick,
  why,
  current = false,
  badge,
  icon,
}: {
  label: string;
  onClick?: (() => void) | undefined;
  why?: string;
  current?: boolean;
  badge?: N;
  icon?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="px-tab"
      aria-label={label}
      title={onClick ? label : (why ?? label)}
      disabled={!onClick && !current}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
    >
      {icon ? <Ic n={icon} /> : null}
      {label.split(":")[0]}
      {badge !== undefined ? <span className="px-badge">{badge}</span> : null}
    </button>
  );
}

export function Card({
  icon,
  title,
  right,
  className = "",
  children,
}: {
  icon?: string;
  title: N;
  right?: N;
  className?: string;
  children: N;
}): JSX.Element {
  return (
    <section className={`px-card ${className}`.trim()}>
      <header className="px-card-h">
        {icon ? <Ic n={icon} /> : null}
        <h3>{title}</h3>
        <span className="px-gap" />
        {right}
      </header>
      {children}
    </section>
  );
}

export const Kv = ({
  k,
  children,
  src,
}: {
  k: string;
  children: N;
  src?: string;
}): JSX.Element => (
  <div className="px-kv">
    <span className="px-k">{k}</span>
    <span className="px-v">{children}</span>
    {src ? <span className="px-src">{src}</span> : null}
  </div>
);

/** hit(text, kw): the keyword highlighted where it occurs. */
export function hit(text: string, kw: string): N {
  const i = kw ? text.toLowerCase().indexOf(kw.toLowerCase()) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="px-mk">{text.slice(i, i + kw.length)}</mark>
      {text.slice(i + kw.length)}
    </>
  );
}

/** A window of the app's own satellite tiles around a position. The viewBox is
 *  centred on (lon, lat), in plate pixels of zoom z, so overlays drawn as
 *  children use the same offsets and the whole view scales with its pane. */
export function Sat({
  lon,
  lat,
  z,
  w = 640,
  h = 360,
  className = "",
  label,
  children,
}: {
  lon: number;
  lat: number;
  z: number;
  w?: number;
  h?: number;
  className?: string;
  label?: string;
  children?: N;
}): JSX.Element {
  return (
    <svg
      className={`px-sat ${className}`.trim()}
      viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`}
      preserveAspectRatio="xMidYMid slice"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="#0a1220" />
      {mosaic(lon, lat, z, w, h).map((t) => (
        <image
          key={t.key}
          href={t.url}
          x={t.x}
          y={t.y}
          width={TILE + 0.5}
          height={TILE + 0.5}
        />
      ))}
      {children}
    </svg>
  );
}
