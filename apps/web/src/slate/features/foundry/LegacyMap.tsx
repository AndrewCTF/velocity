// Legacy map pages, native: D200 (selection card, radius circle, departure
// colours) and D201 (icon legend, page tabs) on live OpenFlights and AIS data.
// `VesselMap` is also the plate behind the Workshop layer-style page.
import { useMemo } from "react";
import { APP_GROUPS, useAppView } from "../../../state/appView.js";
import { Glyph, Ii } from "./kit.js";
import {
  Bar,
  Btn,
  Float,
  MapNote,
  MapStage,
  Page,
  useMap,
  useScale,
} from "./native.js";
import {
  aisType,
  airportsOf,
  d200,
  densCenter,
  depsOf,
  ofvOf,
  proj,
  useJson,
  vesselsOf,
  why,
  type Route,
} from "./data.js";
import type { Nav } from "./nav.js";

export function D200({ nav }: { nav: Nav }): JSX.Element {
  const m = useMap(5.7, 897);
  const lon0 = 10;
  const lat0 = 49;
  const fn = useMemo(() => proj(lon0, lat0, m.zf, m.w, m.h), [m.zf, m.w, m.h]);
  const kmpx = useScale(lat0, m.zf);
  const rr = useJson<{ routes: Route[] }>("/api/aviation/routes");
  const ar = useJson<Parameters<typeof airportsOf>[0]>(
    "/api/aviation/airports/openflights",
  );
  const r = useMemo(() => {
    if (!rr?.data || !ar?.data || m.w <= 0) return null;
    const deps = depsOf(rr.data.routes);
    const x = d200(ofvOf(airportsOf(ar.data), deps), deps, fn, m.w, m.h);
    return x ? { ...x, deps } : null;
  }, [rr, ar, fn, m.w, m.h]);
  let svg: JSX.Element | null = null;
  if (r) {
    const [sx, sy] = fn(r.sel.lon, r.sel.lat);
    const [nx, ny] = fn(r.nb.lon, r.nb.lat);
    svg = (
      <>
        <circle
          cx={sx}
          cy={sy}
          r={r.rkm / kmpx}
          fill="#f5a460"
          fillOpacity=".45"
          stroke="#f0a060"
          strokeWidth="1.4"
        />
        <line
          x1={sx}
          y1={sy}
          x2={nx}
          y2={ny}
          stroke="#e8923a"
          strokeWidth="1.4"
          strokeDasharray="4 3"
        />
        <circle
          cx={sx}
          cy={sy}
          r="14"
          fill="none"
          stroke="#e8923a"
          strokeWidth="1.6"
        />
        <g className="fxn-halo">
          {[...r.inview]
            .sort((p, q) => fn(p.lon, p.lat)[1] - fn(q.lon, q.lat)[1])
            .map((a) => {
              const [x, y] = fn(a.lon, a.lat);
              return (
                <Glyph
                  key={a.iata}
                  name="airplane"
                  x={x}
                  y={y}
                  s={20}
                  col={r.col(r.deps.get(a.iata)!)}
                />
              );
            })}
        </g>
        <text
          x={(sx + nx) / 2 + 4}
          y={(sy + ny) / 2 - 8}
        >{`${Math.round(r.rkm)} km`}</text>
      </>
    );
  }
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Map (legacy) · <b>Selection card</b>
          </>
        }
      />
      <div className="fxn-body">
        <MapStage m={m} lon={lon0} lat={lat0} svg={svg} kmPx={kmpx}>
          {r ? (
            <Float pos="tr" title="Selection">
              <div className="fxn-leg">
                <span className="fxn-pin" style={{ background: "#0e7f77" }}>
                  {Ii("map-marker", 16, "#fff")}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>
                    [{r.sel.iata}] {r.sel.name}
                  </b>
                  <div className="fxn-by">Airport (OpenFlights)</div>
                </div>
                <Btn primary onClick={() => nav.go("d192")}>
                  Open
                </Btn>
              </div>
            </Float>
          ) : null}
          <MapNote
            text={
              why("OpenFlights routes", rr) ?? why("OpenFlights airports", ar)
            }
          />
        </MapStage>
      </div>
    </Page>
  );
}

// the app's AIS palette (apps/web/src/globe/adapters/styles.ts:47-56, not exported)
const PALV: Record<string, string> = {
  Cargo: "#14b8a6",
  Tanker: "#d97706",
  Fishing: "#5eead4",
  Passenger: "#38bdf8",
  Tug: "#c084fc",
  "Pleasure craft": "#4ade80",
  Sailing: "#a5f3fc",
  SAR: "#ef4444",
  Military: "#f59e0b",
};

/** Every vessel of the live AIS snapshot in view, at its densest cell, coloured by ship type. */
export function VesselMap({ legend }: { legend: boolean }): JSX.Element {
  const m = useMap(10, 1661);
  const vr = useJson<Parameters<typeof vesselsOf>[0]>("/api/maritime/snapshot");
  const ves = useMemo(() => (vr?.data ? vesselsOf(vr.data) : null), [vr]);
  const [lo, la] = useMemo(
    () => (ves && m.w > 0 ? densCenter(m.zf, m.w, m.h, ves) : [0, 0, 0]),
    [ves, m.zf, m.w, m.h],
  );
  const fn = useMemo(
    () => proj(lo, la, m.zf, m.w, m.h),
    [lo, la, m.zf, m.w, m.h],
  );
  const vin = useMemo(
    () =>
      (ves ?? []).filter((v) => {
        const [x, y] = fn(v.lon, v.lat);
        return x > 0 && x < m.w && y > 0 && y < m.h;
      }),
    [ves, fn, m.w, m.h],
  );
  const { cmap, rows } = useMemo(() => {
    const tc = new Map<string, number>();
    for (const v of vin)
      tc.set(aisType(v.shipType), (tc.get(aisType(v.shipType)) ?? 0) + 1);
    const top3 = [...tc.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
      .filter((t) => t !== "No value")
      .slice(0, 3);
    const cm = new Map(top3.map((t) => [t, PALV[t] ?? "#8f99a8"]));
    const extra: Array<[string, string]> = [
      ["Other", "#2d72d2"],
      ["No value", "#8f99a8"],
    ];
    return {
      cmap: cm,
      rows: [
        ...top3.map((t) => [t, cm.get(t)!] as [string, string]),
        ...extra.slice(0, 4 - top3.length),
      ],
    };
  }, [vin]);
  const svg = ves ? (
    <g className="fxn-halo">
      {[...vin]
        .sort((a, b) => fn(a.lon, a.lat)[1] - fn(b.lon, b.lat)[1])
        .map((v, i) => {
          const [x, y] = fn(v.lon, v.lat);
          const t = aisType(v.shipType);
          return (
            <Glyph
              key={i}
              name="ship"
              x={x}
              y={y}
              s={18}
              col={cmap.get(t) ?? (t !== "No value" ? "#2d72d2" : "#8f99a8")}
            />
          );
        })}
    </g>
  ) : null;
  return (
    <MapStage m={m} lon={ves ? lo : null} lat={ves ? la : null} svg={svg}>
      {legend ? (
        <Float pos="br" title="Vessels by ship type" className="fxn-lift">
          {rows.map(([lab, c]) => (
            <div key={lab} className="fxn-leg">
              {Ii("ship", 16, c)}
              <span>{lab}</span>
            </div>
          ))}
        </Float>
      ) : null}
      <MapNote text={why("AIS snapshot", vr)} />
    </MapStage>
  );
}

export function D201({ nav }: { nav: Nav }): JSX.Element {
  const setApp = useAppView((s) => s.setApp);
  return (
    <Page>
      <Bar
        nav={nav}
        crumb={
          <>
            Map (legacy) · <b>Legend and page tabs</b>
          </>
        }
      >
        <nav className="fxn-pages" aria-label="Velocity apps">
          {APP_GROUPS.map((gr) => {
            const first = gr.apps[0];
            return (
              <button
                key={gr.label}
                type="button"
                className="fxn-btn"
                onClick={first ? () => setApp(first) : undefined}
                disabled={!first}
                title={first ? `Open ${gr.label}` : "No app in this group"}
              >
                {gr.label}
              </button>
            );
          })}
        </nav>
      </Bar>
      <div className="fxn-body">
        <VesselMap legend />
      </div>
    </Page>
  );
}
