// E4 / E5 / E6: the Gaia map page, laid out natively (MapPage at the foot),
// and the shared frame pieces E7 and E9 still reuse: the satellite layer (Esri
// World Imagery z17 mosaic of Port Rashid / Dubai Creek with the live AIS
// tracks of its bbox), the rail and the window chrome.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import type { ReactNode as N } from "react";
import {
  NX,
  NY,
  SATW,
  SATH,
  UTC,
  grow,
  hull,
  pickMarkers,
  tileUrl,
  unavailable,
  watchBoxes,
  type Evid,
  type Res,
  type SatV,
} from "./data.js";
import "./eupages.css";

const NONE = "\u2014"; // no value reported
export const MX = 800;
export const MY = 45; // mosaic px shown at the map's top-left corner
export type Go = (page: Page) => void;
export type Page =
  | "chat"
  | "gaia"
  | "map"
  | "slides"
  | "present1"
  | "present2"
  | "graph"
  | "lineage"
  | "globe"
  | "ring";

/** The mosaic as one image of SATW x SATH px scaled by k, top-left at (left, top). */
export function Mosaic({
  left,
  top,
  k,
  style,
}: {
  left: number;
  top: number;
  k: number;
  style?: CSSProperties;
}): JSX.Element {
  const tiles: N[] = [];
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NY; j++)
      tiles.push(
        <img
          key={`${i}.${j}`}
          alt=""
          src={tileUrl(i, j)}
          style={{
            position: "absolute",
            left: 256 * i * k,
            top: 256 * j * k,
            width: 256 * k + 0.5,
            height: 256 * k + 0.5,
            maxWidth: "none",
          }}
        />,
      );
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: SATW * k,
        height: SATH * k,
        ...style,
      }}
    >
      {tiles}
    </div>
  );
}
const DUBAI_CREEK: [number, number][] = [
  [1522, 300],
  [1668, 300],
  [1690, 420],
  [1678, 500],
  [1562, 500],
  [1546, 420],
]; // hand-traced along the dark-water edge of the imagery (authored, as in the copy)

/** Cover-fit of the mosaic in a w x h pane: scale k and the mosaic px at the pane's top-left. */
export function coverView(
  w: number,
  h: number,
): { k: number; mx: number; my: number } {
  const k = Math.max(w / SATW, h / SATH);
  return { k, mx: (SATW - w / k) / 2, my: (SATH - h / k) / 2 };
}

export function MapPage({
  vs,
  vRes,
  ev,
  briefsN,
  drawer,
  setDrawer,
  reload,
  go,
}: {
  vs: SatV[];
  vRes: Res<unknown> | null;
  ev: Evid[];
  briefsN: number | null;
  drawer: boolean;
  setDrawer: (b: boolean) => void;
  reload: () => void;
  go: Go;
}): JSX.Element {
  const plate = useRef<HTMLDivElement>(null);
  const [sz, setSz] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = plate.current;
    if (!el) return;
    const fit = (): void => setSz({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { k, mx, my } = coverView(sz.w || 1, sz.h || 1);
  const P = ([px, py]: [number, number]): [number, number] => [
    (px - mx) * k,
    (py - my) * k,
  ];
  const pts = (ps: [number, number][]): string =>
    ps
      .map((p) =>
        P(p)
          .map((n) => n.toFixed(1))
          .join(","),
      )
      .join(" ");
  const boxes = watchBoxes(vs);
  const markers = sz.w ? pickMarkers(vs, 6, [mx, my, sz.w / k, sz.h / k]) : [];
  const live = vRes?.ok ?? false;
  const nav: [string, string, Page][] = [
    ["Slides", "presentation", "slides"],
    ["Data lineage", "diagram-tree", "lineage"],
    ["Graph", "graph", "graph"],
    ["Simulation", "gantt-chart", "globe"],
    ["Chat", "chat", "chat"],
  ];
  return (
    <div className="eum">
      <div className="eu-bar">
        <button
          type="button"
          className="eu-btn"
          aria-label="Gaia home"
          title="Gaia home"
          onClick={() => go("gaia")}
        >
          <BpIcon name="chevron-left" size={14} />
          Gaia home
        </button>
        <span className="eu-crumb">
          <span className="eu-dim">Reports</span>
          <BpIcon name="chevron-right" size={12} />
          <b>DubaiCreek_Watch_Plan</b>
        </span>
        <span className="eu-gap" />
        {nav.map(([lab, ic, to]) => (
          <button
            key={to}
            type="button"
            className="eu-btn"
            aria-label={lab}
            title={lab}
            onClick={() => go(to)}
          >
            <BpIcon name={ic} size={14} />
            {lab}
          </button>
        ))}
        <button
          type="button"
          className="eu-btn"
          aria-label="Evidence"
          title="Evidence"
          onClick={() => go("gaia")}
        >
          <BpIcon name="duplicate" size={14} />
          Evidence <span className="eu-dim">{ev.length}</span>
        </button>
        <button
          type="button"
          className="eu-btn"
          aria-label="Related clips"
          aria-pressed={drawer}
          title="Related clips"
          onClick={() => setDrawer(!drawer)}
        >
          <BpIcon name="film" size={14} />
          Related clips
        </button>
        <button
          type="button"
          className="eu-btn"
          aria-label="Refresh AIS tracks"
          title="Refresh AIS tracks"
          onClick={reload}
        >
          <BpIcon name="refresh" size={14} />
          Refresh
        </button>
      </div>
      <div className="eum-main">
        <aside className="eum-side" aria-label="Map layers">
          <div className="eum-h">
            <BpIcon name="layers" size={14} />
            Map layers
          </div>
          <div className="eum-lyr">
            <BpIcon name="polygon-filter" size={14} />
            <span>WATCH_DubaiCreek</span>
          </div>
          <div className="eum-lyr">
            <BpIcon name="satellite" size={14} />
            <span>
              Esri World Imagery
              <small>2 overlays</small>
            </span>
          </div>
          <div className="eum-stat">
            <b className={live ? "eum-on" : "eum-off"}>
              {live ? "Online" : "Offline"}
            </b>
            <span>
              {live ? `${vs.length} live AIS tracks` : unavailable("AIS", vRes)}
            </span>
            <span>{`${briefsN ?? NONE} watch-officer briefs`}</span>
          </div>
        </aside>
        <div className="eum-col">
          <div className="eum-plate" ref={plate}>
            {sz.w > 0 && (
              <>
                <Mosaic
                  left={-mx * k}
                  top={-my * k}
                  k={k}
                  style={{ filter: "contrast(.92)" }}
                />
                <svg aria-hidden className="eum-svg" width={sz.w} height={sz.h}>
                  {boxes.map((g, gi) => (
                    <polygon
                      key={gi}
                      points={pts(grow(hull(g.map((v) => v.px)), 14))}
                      fill="rgba(200,30,48,.13)"
                      stroke="#d11e32"
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                  ))}
                  <polygon
                    points={pts(DUBAI_CREEK)}
                    fill="rgba(48,110,214,.28)"
                    stroke="#3a7ad8"
                    strokeWidth="1.6"
                  />
                </svg>
                {boxes.map((g, gi) => {
                  const cx = g.reduce((s, v) => s + v.px[0], 0) / g.length;
                  const cy = g.reduce((s, v) => s + v.px[1], 0) / g.length;
                  const [lx, ly] = P([cx + 22, cy - 36]);
                  return (
                    <span
                      key={gi}
                      className="eum-tag eum-red"
                      style={{ left: lx, top: ly }}
                    >
                      {gi === 0 ? "Watch box A" : "Watch box B"}
                    </span>
                  );
                })}
                <span
                  className="eum-tag eum-blue"
                  style={{ left: P([1530, 308])[0], top: P([1530, 308])[1] }}
                >
                  Dubai Creek
                </span>
                {markers.map((v) => {
                  const [x, y] = P(v.px);
                  return (
                    <span
                      key={v.id}
                      className="eum-ship"
                      role="img"
                      aria-label={v.name ?? String(v.mmsi)}
                      title={`${v.name ?? NONE} · MMSI ${v.mmsi}`}
                      style={{ left: x, top: y }}
                    >
                      <BpIcon name="cargo-ship" size={14} />
                    </span>
                  );
                })}
              </>
            )}
            <button
              type="button"
              className="eu-btn eum-3d"
              aria-label="3D globe"
              title="3D globe"
              onClick={() => go("globe")}
            >
              <BpIcon name="globe" size={14} />
              3D
            </button>
            <span className="eum-attr">Esri World Imagery</span>
          </div>
          {drawer && (
            <section className="eum-clips" aria-label="Related clips">
              <div className="eum-ch">
                <b>Related clips</b>
                <span className="eu-gap" />
                <button
                  type="button"
                  className="eu-btn"
                  aria-label="New clip"
                  title="Clips are captured into the evidence locker from the console"
                  disabled
                >
                  <BpIcon name="plus" size={14} />
                  New
                </button>
                <button
                  type="button"
                  className="eu-ico"
                  aria-label="Close related clips"
                  title="Close related clips"
                  onClick={() => setDrawer(false)}
                >
                  <BpIcon name="cross" size={14} />
                </button>
              </div>
              <div className="eum-cl">
                {ev.length === 0 && (
                  <p className="eu-note">No clips in the evidence locker</p>
                )}
                {ev.slice(0, 14).map((e) => (
                  <div key={e.sha256} className="eum-clip" title={e.title}>
                    <button
                      type="button"
                      className="eu-ico"
                      aria-label="Copy SHA-256"
                      title="Copy SHA-256"
                      onClick={() =>
                        void navigator.clipboard?.writeText(e.sha256)
                      }
                    >
                      <BpIcon name="clipboard" size={14} />
                    </button>
                    <span>{e.title}</span>
                    <small>
                      By {e.captured_by || "local"} ·{" "}
                      {UTC(Date.parse(e.captured_at) / 1000, "%m/%d/%Y")}
                    </small>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
