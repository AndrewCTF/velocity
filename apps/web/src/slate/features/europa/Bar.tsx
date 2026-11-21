// Shared in-page toolbar and slide stage of the native Reports pages: a "Gaia
// home" back button, the breadcrumb and the page switcher (no second title bar,
// the Slate shell already names the app), and a 16:9 canvas that scales to fit
// its pane.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import { stageScale } from "./layout.js";
import type { Go, Page } from "./SatMap.js";
import "./euxpages.css";

const TABS: [string, string, Page][] = [
  ["Map", "map", "map"],
  ["Slides", "presentation", "slides"],
  ["Data lineage", "diagram-tree", "lineage"],
  ["Graph", "graph", "graph"],
  ["Simulation", "gantt-chart", "globe"],
  ["Chat", "chat", "chat"],
];
const GROUP: Partial<Record<Page, Page>> = { present1: "slides", present2: "slides", ring: "globe" };

export function EuBar({ go, here, crumb, children }: { go: Go; here: Page; crumb: string; children?: ReactNode }): JSX.Element {
  const cur = GROUP[here] ?? here;
  return (
    <div className="eu-bar">
      <button type="button" className="eu-btn" aria-label="Gaia home" title="Gaia home" onClick={() => go("gaia")}>
        <BpIcon name="chevron-left" size={14} />
        Gaia home
      </button>
      <span className="eu-crumb">
        <span className="eu-dim">Reports</span>
        <BpIcon name="chevron-right" size={12} />
        <b>{crumb}</b>
      </span>
      <span className="eu-gap" />
      {children}
      {TABS.map(([lab, ic, to]) => (
        <button key={to} type="button" className="eu-btn" aria-label={lab} title={lab} aria-pressed={to === cur} aria-current={to === cur ? "page" : undefined} onClick={() => go(to)}>
          <BpIcon name={ic} size={14} />
          {lab}
        </button>
      ))}
    </div>
  );
}

export const SLIDE_W = 1600;
export const SLIDE_H = 900;

/** A fixed 16:9 slide drawn in 1600x900 units and scaled to fit the pane. */
export function Stage({ children, label, className = "" }: { children: ReactNode; label: string; className?: string }): JSX.Element {
  const pane = useRef<HTMLDivElement>(null);
  const [sz, setSz] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const fit = (): void => setSz({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const s = stageScale(sz.w, sz.h, SLIDE_W, SLIDE_H);
  return (
    <div className="eux-stage" ref={pane}>
      {s > 0 && (
        <section
          className={`eux-slide ${className}`}
          aria-label={label}
          style={{ left: (sz.w - SLIDE_W * s) / 2, top: (sz.h - SLIDE_H * s) / 2, transform: `scale(${s})` }}
        >
          {children}
        </section>
      )}
    </div>
  );
}
