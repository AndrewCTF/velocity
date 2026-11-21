// Shared parts of the native Foundry pages: the slim page toolbar, cards and
// form controls, the pane-measured map stage and the timeline strip. Every page
// reflows to its host; nothing here is a fixed-size frame.
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Ii } from "./kit.js";
import { Plate } from "./Plate.js";
import { scaleBar } from "./data.js";
import { scaleNm, zoomFor } from "./view.js";
import type { Nav } from "./nav.js";
import "./native.css";

export const ATTR = "© Esri, HERE, Garmin, FAO, NOAA, USGS";
export const INK = "#404854";
export const MUTE = "#5f6b7c";
export const dash = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === "" ? "—" : String(v);
export const WHY_SCHEMA =
  "Set by the backend block registry; not editable here";

/** The page root: fills the host, light Blueprint. */
export function Page({ children }: { children: ReactNode }): JSX.Element {
  return <div className="fxn">{children}</div>;
}

/** Slim toolbar: Apps menu button, breadcrumb, page actions. */
export function Bar({
  nav,
  crumb,
  children,
}: {
  nav: Nav;
  crumb: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <header className="fxn-bar">
      <button type="button" className="fxn-btn" onClick={nav.menu}>
        {Ii("applications", 16, INK)}
        Apps
      </button>
      <nav className="fxn-crumb" aria-label="Breadcrumb">
        {crumb}
      </nav>
      <span className="fxn-grow" />
      {children}
    </header>
  );
}

export function Btn({
  icon,
  children,
  onClick,
  why,
  primary,
}: {
  icon?: string;
  children: ReactNode;
  onClick?: () => void;
  why?: string;
  primary?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={primary ? "fxn-btn fxn-primary" : "fxn-btn"}
      onClick={onClick}
      disabled={!onClick}
      title={onClick ? undefined : why}
    >
      {icon ? Ii(icon, 16, primary ? "#fff" : INK) : null}
      {children}
    </button>
  );
}

export function Card({
  title,
  children,
  className = "",
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={`fxn-card ${className}`}>
      {title ? <h2 className="fxn-card-h">{title}</h2> : null}
      <div className="fxn-card-b">{children}</div>
    </section>
  );
}

export function Field({
  label,
  value,
  hint,
  why,
  placeholder,
}: {
  label: string;
  value?: string;
  hint?: string;
  why?: string;
  placeholder?: string;
}): JSX.Element {
  return (
    <label className="fxn-field">
      <span className="fxn-lbl">{label}</span>
      <input
        className="fxn-in"
        readOnly
        value={value ?? ""}
        placeholder={placeholder}
        title={why}
      />
      {hint ? <span className="fxn-hint">{hint}</span> : null}
    </label>
  );
}

export function Pick({
  label,
  value,
  why,
}: {
  label: string;
  value: string;
  why: string;
}): JSX.Element {
  return (
    <label className="fxn-field">
      <span className="fxn-lbl">{label}</span>
      <select
        className="fxn-in"
        disabled
        title={why}
        value={value}
        onChange={() => undefined}
      >
        <option value={value}>{value}</option>
      </select>
    </label>
  );
}

export function Switch({
  on,
  label,
  why,
}: {
  on: boolean;
  label: string;
  why: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="fxn-sw"
      disabled
      title={why}
    />
  );
}

export function Seg({
  options,
  value,
  why,
  label,
}: {
  options: string[];
  value: string;
  why: string;
  label: string;
}): JSX.Element {
  return (
    <div className="fxn-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={o === value}
          disabled
          title={why}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/** A collapsible panel section (header button + body), or a locked one with the reason. */
export function Sec({
  title,
  open,
  onToggle,
  why,
  children,
}: {
  title: string;
  open?: boolean;
  onToggle?: () => void;
  why?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <section className="fxn-sec">
      <button
        type="button"
        className="fxn-sec-h"
        aria-expanded={open}
        onClick={onToggle}
        disabled={!onToggle}
        title={onToggle ? undefined : why}
      >
        <b>{title}</b>
        {Ii(open ? "chevron-up" : "chevron-down", 16, MUTE)}
      </button>
      {open && children ? <div className="fxn-sec-b">{children}</div> : null}
    </section>
  );
}

/** A floating map card with a collapse button. */
export function Float({
  pos,
  title,
  count,
  children,
  className = "",
}: {
  pos: "tl" | "tr" | "bl" | "br";
  title: string;
  count?: number | string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <section className={`fxn-float fxn-at-${pos} ${className}`}>
      <button
        type="button"
        className="fxn-float-h"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <b>{title}</b>
        {count !== undefined ? (
          <span className="fxn-count">{count}</span>
        ) : null}
        <span className="fxn-grow" />
        {Ii(open ? "chevron-down" : "chevron-up", 16, MUTE)}
      </button>
      {open ? <div className="fxn-float-b">{children}</div> : null}
    </section>
  );
}

// ----------------------------------------------------------------- map stage
export function useBox(): {
  ref: RefObject<HTMLDivElement | null>;
  w: number;
  h: number;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [s, setS] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const f = (): void =>
      setS((p) =>
        p.w === el.clientWidth && p.h === el.clientHeight
          ? p
          : { w: el.clientWidth, h: el.clientHeight },
      );
    f();
    const ro = new ResizeObserver(f);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...s };
}

export interface MapView {
  ref: RefObject<HTMLDivElement | null>;
  w: number;
  h: number;
  zf: number;
  zoomIn: () => void;
  zoomOut: () => void;
  canIn: boolean;
  canOut: boolean;
}

/** The pane's measured size and a zoom that keeps the page's reference extent as it resizes. */
export function useMap(base: number, ref: number, world = false): MapView {
  const box = useBox();
  const [dz, setDz] = useState(0);
  const zf = zoomFor(base, ref, box.w, dz, world);
  return {
    ...box,
    zf,
    zoomIn: () => setDz((d) => d + 1),
    zoomOut: () => setDz((d) => d - 1),
    canIn: zf < 16,
    canOut: zoomFor(base, ref, box.w, dz - 1, world) < zf,
  };
}

export const useScale = (lat: number, zf: number): number =>
  useMemo(() => scaleBar(lat, zf), [lat, zf]);

/** The Esri light plate filling its pane, an SVG overlay in pane pixels, zoom tools, scale and credit. */
export function MapStage({
  m,
  lon,
  lat,
  svg,
  kmPx,
  children,
}: {
  m: MapView;
  lon: number | null;
  lat: number | null;
  svg?: ReactNode;
  kmPx?: number;
  children?: ReactNode;
}): JSX.Element {
  const ready = m.w > 0 && m.h > 0 && lon !== null && lat !== null;
  const sc = kmPx ? scaleNm(kmPx) : null;
  return (
    <div className="fxn-map" ref={m.ref}>
      {ready ? (
        <div className="fxn-plate" aria-hidden>
          <Plate lon={lon} lat={lat} zf={m.zf} W={m.w} H={m.h} />
        </div>
      ) : null}
      {ready && svg ? (
        <svg className="fxn-ovl" width={m.w} height={m.h} aria-hidden>
          {svg}
        </svg>
      ) : null}
      {children}
      <div className="fxn-tools" role="group" aria-label="Map zoom">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={m.zoomIn}
          disabled={!m.canIn}
        >
          {Ii("zoom-in", 16, INK)}
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={m.zoomOut}
          disabled={!m.canOut}
        >
          {Ii("zoom-out", 16, INK)}
        </button>
      </div>
      <div className="fxn-foot">
        {sc ? (
          <span className="fxn-scale">
            <i style={{ width: sc.px }} />
            {sc.nm} nm
          </span>
        ) : null}
        <span className="fxn-attr">{ATTR}</span>
      </div>
    </div>
  );
}

export function MapNote({ text }: { text: string | null }): JSX.Element | null {
  return text ? (
    <div className="fxn-note" role="status">
      {text}
    </div>
  ) : null;
}

// ------------------------------------------------------------------ timeline
export interface TimelineProps {
  from: string;
  to: string;
  /** cursor position, 0..1 */
  cursor: number;
  chip: string;
  ticks: Array<[number, string]>;
  /** one colour per bin (null = empty), drawn as a histogram */
  bars?: Array<string | null>;
  /** event positions, 0..1 */
  marks?: number[];
  note?: string | undefined;
  className?: string;
}

export function Timeline({
  from,
  to,
  cursor,
  chip,
  ticks: tk,
  bars,
  marks,
  note,
  className = "",
}: TimelineProps): JSX.Element {
  const c = `${(cursor * 100).toFixed(3)}%`;
  return (
    <div className={`fxn-tl ${className}`}>
      <div className="fxn-tl-h">
        <b>Time range</b>
        <span className="fxn-box">{from}</span>
        <span aria-hidden>–</span>
        <span className="fxn-box">{to}</span>
        {note ? <span className="fxn-tl-note">{note}</span> : null}
      </div>
      <div className="fxn-tl-track">
        {bars?.length ? (
          <svg
            className="fxn-tl-bars"
            viewBox={`0 0 ${bars.length} 20`}
            preserveAspectRatio="none"
            aria-hidden
          >
            {bars.map((col, i) =>
              col ? (
                <rect key={i} x={i} y={0} width={0.75} height={20} fill={col} />
              ) : null,
            )}
          </svg>
        ) : null}
        {marks?.map((p, i) => (
          <i
            key={i}
            className="fxn-tl-mark"
            style={{ left: `${(p * 100).toFixed(3)}%` }}
          />
        ))}
        {tk.map(([p, label]) => (
          <span
            key={label}
            className="fxn-tl-tick"
            style={{ left: `${(p * 100).toFixed(3)}%` }}
          >
            {label}
          </span>
        ))}
        <i className="fxn-tl-cur" style={{ left: c }} />
        <em
          className="fxn-tl-chip"
          style={{ left: `clamp(80px, ${c}, calc(100% - 80px))` }}
        >
          {chip}
        </em>
      </div>
    </div>
  );
}
