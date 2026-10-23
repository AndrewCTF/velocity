import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { create } from "zustand";
import type * as Cesium from "cesium";
import "./imagery.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import {
  fetchEnrichment,
  type VesselEnrichment,
} from "../../../transport/entity.js";
import {
  findEntity,
  readPosition,
  readProperties,
} from "../../../entity-panel/read.js";
import { nextSarPass } from "../../../situations/DetectedSituation.js";
import { skyView, type Pass } from "../../../sim/tasking.js";
import { shipTypeLabel } from "../../../entity-panel/EntityPanel.js";
import { tclass } from "../situation/model.js";
import { sunElevationDeg, zoneTime } from "./sun.js";

// The imagery half of the split document view (features copy t210: G5 split,
// G40 vessel record, G39 imagery pane with reticle, G41 sensor-platform
// widget, G42 capture angle), at the copy's geometry with the pane origin at
// frame (987, 92). Opened from the object panel's photo for a vessel; the map
// stays live on the left. Sources: the live entity and GET /api/entity/<id>,
// GET /api/imagery/chip (Sentinel-2 at the AIS fix), SGP4 on GET
// /api/space/gp (next Sentinel-1 pass) and the NOAA solar formula.

export const useImageryView = create<{
  id: string | null;
  set: (id: string | null) => void;
}>((set) => ({ id: null, set: (id) => set({ id }) }));

export type OmmItems = Parameters<typeof nextSarPass>[0];
let gpPromise: Promise<OmmItems | string> | null = null;
/** One catalogue pull per page load (the server caches CelesTrak too). */
export function catalogue(): Promise<OmmItems | string> {
  gpPromise ??= apiFetch("/api/space/gp?group=active&limit=20000")
    .then(async (r) =>
      r.ok
        ? (((await r.json()) as { items?: OmmItems }).items ?? [])
        : `Satellite catalogue unavailable (HTTP ${r.status})`,
    )
    .catch(() => "Satellite catalogue unavailable");
  return gpPromise;
}

const box = (
  left: number,
  top: number,
  width?: number,
  height?: number,
  extra: CSSProperties = {},
): CSSProperties => ({ left, top, width, height, ...extra });

/** The copy's ship_art, translated to the card origin (frame 993,103). */
function ShipArt({ cls }: { cls: string }): JSX.Element {
  const d =
    cls === "Tanker"
      ? [
          "M40 121 Q47 113 69 111 H391 L397 143 Q395 147 387 147 H67 Q49 147 40 121 Z",
          "M69 111 L71 147",
          "M97 111 V102 H337 V111 M117 102 V111 M157 102 V111 M197 102 V111 M237 102 V111 M277 102 V111 M317 102 V111",
          "M377 73 V63 M363 73 V59",
        ]
      : cls === "Tug / special craft"
        ? [
            "M107 129 Q117 119 137 117 H325 L331 143 Q329 147 323 147 H137 Q115 147 107 129 Z",
            "M231 75 V57 M221 57 H241",
          ]
        : [
            "M40 121 Q47 113 69 111 H391 L397 143 Q395 147 387 147 H67 Q49 147 40 121 Z",
            "M69 111 L71 147",
            "M93 111 V101 H143 V111 M153 111 V101 H203 V111 M213 111 V101 H263 V111 M273 111 V101 H323 V111",
            "M356 69 V55 M347 55 H365",
            "M59 111 V93 H69",
          ];
  const rects =
    cls === "Tanker"
      ? [
          [339, 85, 42, 26],
          [349, 73, 22, 12],
        ]
      : cls === "Tug / special craft"
        ? [
            [203, 91, 62, 26],
            [213, 75, 36, 16],
            [269, 103, 18, 14],
          ]
        : [
            [333, 83, 46, 28],
            [341, 69, 30, 14],
          ];
  return (
    <svg
      style={box(0, 0, 820, 205, { overflow: "visible" })}
      aria-hidden="true"
    >
      <g
        fill="none"
        stroke="#3f86c4"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {d.map((p) => (
          <path key={p} d={p} />
        ))}
        {rects.map(([x, y, w, h]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} />
        ))}
        <path d="M56 118 H393 M59 135 H389" strokeWidth="1.1" opacity=".8" />
      </g>
      <g stroke="#8a929a" strokeWidth="1.9" fill="none">
        <path d="M34 173 H400" />
        <path d="M40 168 L34 173 L40 178 M394 168 L400 173 L394 178" />
      </g>
    </svg>
  );
}

interface Peak {
  pass: Pass;
  az: number;
  el: number;
  tMs: number;
}

export function ImageryWorkspace({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element | null {
  const id = useImageryView((s) => s.id);
  const close = (): void => useImageryView.getState().set(null);
  const [props, setProps] = useState<Record<string, unknown>>({});
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  const [enr, setEnr] = useState<VesselEnrichment | null>(null);
  const [peak, setPeak] = useState<Peak | "none" | string | null>(null);
  const [shut, setShut] = useState({ feed: false, angle: false });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id]);

  // Live entity: props and position, every 2 s.
  useEffect(() => {
    setProps({});
    setPos(null);
    setShut({ feed: false, angle: false });
    if (!id || !viewer) return;
    const tick = (): void => {
      if (viewer.isDestroyed()) return;
      const e = findEntity(viewer, id);
      if (!e) return;
      setProps(readProperties(e));
      const p = readPosition(e, viewer);
      if (p) setPos({ lat: p.lat, lon: p.lon });
    };
    tick();
    const t = window.setInterval(tick, 2000);
    return () => window.clearInterval(t);
  }, [id, viewer]);

  useEffect(() => {
    setEnr(null);
    if (!id) return;
    const ac = new AbortController();
    fetchEnrichment(id, ac.signal)
      .then((e) =>
        setEnr(e?.kind === "vessel" ? (e as VesselEnrichment) : null),
      )
      .catch(() => undefined);
    return () => ac.abort();
  }, [id]);

  // Next Sentinel-1 pass over the fix and its peak look angle (SGP4).
  const cell = pos ? `${pos.lat.toFixed(1)},${pos.lon.toFixed(1)}` : "";
  useEffect(() => {
    setPeak(null);
    if (!pos) return;
    let live = true;
    void catalogue().then((items) => {
      if (!live) return;
      if (typeof items === "string") return setPeak(items);
      const t0 = Date.now();
      const pass = nextSarPass(items, pos.lat, pos.lon, t0);
      if (!pass) return setPeak("none");
      const it = items.find(
        (x) => (x.OBJECT_NAME ?? "").trim() === pass.satName,
      );
      const sky =
        it?.TLE_LINE1 && it.TLE_LINE2
          ? skyView(
              it.TLE_LINE1,
              it.TLE_LINE2,
              pos,
              {
                startMs: pass.startMs,
                endMs: pass.endMs,
              },
              10,
            )
          : [];
      const top = sky.reduce(
        (a, b) => (b.elDeg > (a?.elDeg ?? -1) ? b : a),
        sky[0],
      );
      setPeak({
        pass,
        az: top?.azDeg ?? 0,
        el: top?.elDeg ?? pass.maxElevDeg,
        tMs: top?.tMs ?? pass.startMs,
      });
    });
    return () => {
      live = false;
    };
  }, [cell]); // eslint-disable-line react-hooks/exhaustive-deps

  const code =
    typeof props["shipType"] === "number"
      ? props["shipType"]
      : Number(props["shipType"] ?? NaN);
  const typeText =
    shipTypeLabel(Number.isFinite(code) ? code : null) ??
    (typeof props["shipType"] === "string" ? props["shipType"] : null) ??
    enr?.vessel_type ??
    null;
  const cls = tclass(typeText ?? "");
  const sog = typeof props["sog"] === "number" ? props["sog"] : null;
  const sources = Array.isArray(props["sources"])
    ? (props["sources"] as unknown[]).map(String)
    : typeof props["source"] === "string"
      ? [props["source"]]
      : [];
  const chip = useMemo(() => {
    if (!pos) return null;
    const d = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
    const q = new URLSearchParams({
      lat: pos.lat.toFixed(3),
      lon: pos.lon.toFixed(3),
      radius_km: "1.8",
      date: d,
      source: "sentinel",
    });
    return `/api/imagery/chip?${q.toString()}`;
  }, [pos?.lat.toFixed(3), pos?.lon.toFixed(3)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!id || !id.startsWith("vessel:")) return null;
  const sun = pos ? sunElevationDeg(pos.lat, pos.lon, now) : null;
  const pk = peak && typeof peak === "object" ? peak : null;
  // G41 geometry, card-local (frame 993,818 origin).
  const cx = 202;
  const cy = 172;
  const rx = 112;
  const ry = 28;
  const th = ((pk?.az ?? 0) * Math.PI) / 180;
  const rim = [cx + rx * Math.sin(th), cy - ry * Math.cos(th)];
  const sat = [222, 118];
  // G42 dial, card-local (frame 1410,818 origin; svg at 1413,860).
  const dx = 136;
  const dy = 156.5;
  const e = ((sun ?? 0) * Math.PI) / 180;
  const sx = dx + 150 * Math.cos(e);
  const sy = dy - 150 * Math.sin(e);
  const utcHm = (ms: number): string =>
    `${new Date(ms).toISOString().slice(11, 16)}Z`;

  return (
    <section className="sl-imgws" aria-label="Imagery workspace">
      {/* G40 vessel record */}
      <div className="card" style={box(6, 11, 820, 205)}>
        <div
          style={box(1, 1, 818, 38, {
            background: "#1a262b",
            borderBottom: "1.5px solid #2c383e",
          })}
        />
        <div
          style={box(2, 2, 36, 36, {
            background: "#26323a",
            borderRight: "1.5px solid #2c383e",
            display: "grid",
            placeItems: "center",
            color: "#e08ab0",
          })}
        >
          <BpIcon name="timeline-line-chart" size={20} />
        </div>
        <div
          className="t"
          style={box(49, 8, undefined, undefined, {
            fontSize: 18,
            fontWeight: 600,
            color: "#f6f7f9",
          })}
        >
          AIS vessel record
        </div>
        <div
          className="t"
          style={box(221, 9, 400, undefined, {
            fontSize: 13.5,
            color: "#aab4ba",
            overflow: "hidden",
          })}
        >
          {"• "}
          {(typeof props["source"] === "string" ? props["source"] : null) ??
            "AIS"}
          {typeof props["name"] === "string" && props["name"]
            ? ` · ${props["name"]}`
            : ""}
        </div>
        <button
          type="button"
          className="t sl-link"
          style={box(756, 8, undefined, undefined, {
            fontSize: 14.5,
            fontWeight: 600,
            color: "#4a8fc0",
          })}
          title="Back to the object panel"
          onClick={close}
        >
          Explore
        </button>
        <ShipArt cls={cls} />
        {(
          [
            ["Vessel type", typeText ?? "—"],
            ["Speed", sog != null ? `${sog.toFixed(1)} knots` : "—"],
            [
              "Flag",
              enr?.flag_country ??
                enr?.flag ??
                (typeof props["flag"] === "string" ? props["flag"] : null) ??
                "—",
            ],
            ["Sources", null],
          ] as [string, string | null][]
        ).map(([k, v], i) => (
          <div key={k}>
            <div
              className="t"
              style={box(453, 52 + [0, 29, 58, 86][i]!, undefined, undefined, {
                fontSize: 14,
                color: "#aab4ba",
              })}
            >
              {k}
            </div>
            {v !== null && (
              <div
                className="t"
                style={box(579, 52 + [0, 29, 58, 86][i]!, 230, undefined, {
                  fontSize: 14.5,
                  color: "#f1f4f6",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                })}
              >
                {v}
              </div>
            )}
          </div>
        ))}
        {(sources.length ? sources : ["—"]).slice(0, 3).map((s, i) => (
          <div
            key={s}
            className="t"
            style={box(579, 138 + 17.5 * i, undefined, undefined, {
              fontSize: 14.5,
              color: "#f1f4f6",
            })}
          >
            {s}
          </div>
        ))}
      </div>

      {/* G39 imagery pane with reticle at the AIS fix */}
      <div
        className="sl-imgempty"
        style={box(0, 233, 831, 480, { background: "#10181c" })}
      >
        {pos ? "loading imagery…" : "No position for an imagery chip"}
      </div>
      <div
        style={box(0, 233, 831, 480, {
          background: chip ? `url(${chip}) center/cover no-repeat` : "none",
          overflow: "hidden",
        })}
        role="img"
        aria-label="Sentinel-2 chip centred on the vessel's AIS fix"
      ></div>
      <div
        style={box(0, 233, 831, 480, {
          background:
            "linear-gradient(90deg,rgba(6,12,16,.25),rgba(6,12,16,0) 40%)",
          pointerEvents: "none",
        })}
      />
      <svg
        style={box(0, 233, 831, 480, {
          overflow: "visible",
          pointerEvents: "none",
        })}
        aria-hidden="true"
      >
        {(() => {
          const c = [538, 243];
          const a = (32 * Math.PI) / 180;
          const ox = 98 * Math.cos(a);
          const oy = 98 * Math.sin(a);
          return (
            <>
              <circle
                cx={c[0]}
                cy={c[1]}
                r="130"
                fill="none"
                stroke="#f1f4f6"
                strokeWidth="1.4"
                strokeDasharray="2.5 3.5"
                opacity=".9"
              />
              <path
                d={`M${c[0]! - ox} ${c[1]! - oy} A98 98 0 0 0 ${c[0]! - ox} ${c[1]! + oy}`}
                fill="none"
                stroke="#f6f7f9"
                strokeWidth="3.6"
                strokeLinecap="round"
              />
              <path
                d={`M${c[0]! + ox} ${c[1]! - oy} A98 98 0 0 1 ${c[0]! + ox} ${c[1]! + oy}`}
                fill="none"
                stroke="#f6f7f9"
                strokeWidth="3.6"
                strokeLinecap="round"
              />
              <circle
                cx={c[0]}
                cy={c[1]}
                r="68"
                fill="none"
                stroke="#f1f4f6"
                strokeWidth="1"
                strokeDasharray="2 4"
                opacity=".55"
              />
              <g fill="#fff">
                {[
                  [-9, -9],
                  [5, -9],
                  [-9, 5],
                  [5, 5],
                  [-2, -2],
                ].map(([x, y]) => (
                  <rect
                    key={`${x}${y}`}
                    x={c[0]! + x!}
                    y={c[1]! + y!}
                    width="4"
                    height="4"
                  />
                ))}
              </g>
            </>
          );
        })()}
      </svg>

      {/* G41 sensor-platform widget */}
      {!shut.feed && (
        <div className="card" style={box(6, 726, 407, 252)}>
          <div style={box(1, 1, 405, 38, { background: "#1a262b" })} />
          <div
            className="t"
            style={box(13, 11, undefined, undefined, {
              fontSize: 17.5,
              fontWeight: 600,
              color: "#f6f7f9",
            })}
          >
            {pk?.pass.satName ? `${pk.pass.satName} Feed` : "Sentinel-1 Feed"}
          </div>
          <button
            type="button"
            className="sl-link"
            style={box(378.5, 11.5, 17, 17, { color: "#e5e8eb" })}
            aria-label="Close the feed widget"
            onClick={() => setShut((s) => ({ ...s, feed: true }))}
          >
            <BpIcon name="cross" size={17} />
          </button>
          <div style={box(1, 39, 405, 1.5, { background: "#2c383e" })} />
          <div style={box(5, 47, 397, 197, { background: "#222c2e" })} />
          <svg
            style={box(0, 0, 407, 252, { overflow: "visible" })}
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="sl-gw" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#f4f7f9" />
                <stop offset="1" stopColor="#aeb8be" />
              </linearGradient>
            </defs>
            <ellipse
              cx={cx}
              cy={cy}
              rx={rx}
              ry={ry}
              fill="none"
              stroke="#2b6bb0"
              strokeWidth="1.6"
            />
            <ellipse
              cx={cx}
              cy={cy}
              rx={rx * 0.55}
              ry={ry * 0.55}
              fill="none"
              stroke="#2b6bb0"
              strokeWidth="1"
              opacity=".6"
            />
            {pk && (
              <g stroke="#e08a3c" strokeWidth="1.4">
                <path
                  d={`M${sat[0]} ${sat[1]! + 8} L${rim[0]!.toFixed(1)} ${rim[1]!.toFixed(1)}`}
                />
                <path d={`M${sat[0]} ${sat[1]! + 8} L${cx} ${cy}`} />
              </g>
            )}
            <g transform={`translate(${sat[0]} ${sat[1]}) rotate(-28)`}>
              <rect
                x="-17"
                y="-9"
                width="34"
                height="18"
                rx="2"
                fill="url(#sl-gw)"
                stroke="#6d7880"
                strokeWidth="1"
              />
              <g fill="#dfe6ea" stroke="#7b868e" strokeWidth="1">
                <rect x="-86" y="-12" width="66" height="24" />
                <rect x="20" y="-12" width="66" height="24" />
              </g>
              <g stroke="#9aa5ad" strokeWidth=".8">
                <path d="M-64 -12 V12 M-42 -12 V12 M42 -12 V12 M64 -12 V12 M-86 0 H-20 M20 0 H86" />
              </g>
              <circle cx="0" cy="-14" r="3" fill="#cfd8dd" />
            </g>
          </svg>
          {(
            [
              ["W", 78, 151],
              ["E", 318, 151],
              ["S", 193, 184],
            ] as const
          ).map(([l, x, y]) => (
            <div
              key={l}
              className="t"
              style={box(x, y, 20, undefined, {
                fontSize: 19,
                fontWeight: 600,
                color: "#2f7fd6",
                textAlign: "center",
              })}
            >
              {l}
            </div>
          ))}
          <div
            className="t"
            style={box(12, 222, 380, undefined, {
              textAlign: "center",
              fontSize: 12.5,
              fontStyle: "italic",
              color: "#aab4ba",
            })}
          >
            {pk
              ? `Schematic, not to scale · az ${pk.az.toFixed(0)}° el ${pk.el.toFixed(0)}° at ${utcHm(pk.tMs)}`
              : peak === "none"
                ? "No Sentinel-1 pass above 30° in 48 h"
                : typeof peak === "string"
                  ? peak
                  : pos
                    ? "Propagating Sentinel-1…"
                    : "No position to propagate over"}
          </div>
        </div>
      )}

      {/* G42 capture angle */}
      {!shut.angle && (
        <div className="card" style={box(423, 726, 407, 252)}>
          <div style={box(1, 1, 405, 38, { background: "#1a262b" })} />
          <div
            className="t"
            style={box(13, 11, undefined, undefined, {
              fontSize: 17.5,
              fontWeight: 600,
              color: "#f6f7f9",
            })}
          >
            Capture angle
          </div>
          <button
            type="button"
            className="sl-link"
            style={box(377.5, 11.5, 17, 17, { color: "#e5e8eb" })}
            aria-label="Close the capture angle widget"
            onClick={() => setShut((s) => ({ ...s, angle: true }))}
          >
            <BpIcon name="cross" size={17} />
          </button>
          <div style={box(1, 39, 405, 1.5, { background: "#2c383e" })} />
          <div style={box(3, 42, 277, 207, { background: "#28323a" })} />
          <div style={box(280, 42, 124, 207, { background: "#162024" })} />
          <svg
            style={box(3, 42, 277, 207, { overflow: "hidden" })}
            viewBox="0 0 277 207"
            aria-hidden="true"
          >
            <path
              d={`M${dx - 124} ${dy} A124 124 0 0 1 ${dx + 124} ${dy} L${dx + 108} ${dy} A108 108 0 0 0 ${dx - 108} ${dy} Z`}
              fill="#2a4f70"
            />
            <path
              d={`M${dx - 108} ${dy} A108 108 0 0 1 ${dx + 108} ${dy} Z`}
              fill="#232e38"
            />
            {Array.from({ length: 37 }, (_, k) => k * 5).map((i) => {
              const a = (i * Math.PI) / 180;
              const r0 = i % 10 === 0 ? 90 : 96;
              return (
                <line
                  key={`o${i}`}
                  x1={dx + r0 * Math.cos(a)}
                  y1={dy - r0 * Math.sin(a)}
                  x2={dx + 106 * Math.cos(a)}
                  y2={dy - 106 * Math.sin(a)}
                  stroke="#3e5c76"
                  strokeWidth={i % 10 === 0 ? 1.6 : 1.1}
                />
              );
            })}
            {Array.from({ length: 19 }, (_, k) => k * 10).map((i) => {
              const a = (i * Math.PI) / 180;
              return (
                <g key={`i${i}`}>
                  <line
                    x1={dx + 50 * Math.cos(a)}
                    y1={dy - 50 * Math.sin(a)}
                    x2={dx + 72 * Math.cos(a)}
                    y2={dy - 72 * Math.sin(a)}
                    stroke="#506a80"
                    strokeWidth="1.5"
                  />
                  {i % 30 === 0 && (
                    <text
                      transform={`translate(${(dx + 82 * Math.cos(a)).toFixed(1)} ${(dy - 82 * Math.sin(a)).toFixed(1)}) rotate(${90 - i})`}
                      textAnchor="middle"
                      fontSize="7.5"
                      fill="#5f7a92"
                      fontFamily="Source Sans 3,sans-serif"
                    >
                      {i}
                    </text>
                  )}
                </g>
              );
            })}
            <line
              x1={dx}
              y1={dy - 30}
              x2={dx}
              y2={dy + 6}
              stroke="#58707f"
              strokeWidth="1"
            />
            {sun !== null && sun > 0 && (
              <g
                transform={`translate(${sx.toFixed(1)} ${sy.toFixed(1)})`}
                fill="#3b9a62"
              >
                <circle r="12" />
                {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
                  <path
                    key={a}
                    d="M0 -14 L3.8 -26 L-3.8 -26 Z"
                    transform={`rotate(${a})`}
                  />
                ))}
              </g>
            )}
          </svg>
          <div
            className="t"
            style={box(300, 75, undefined, undefined, {
              fontSize: 13.5,
              letterSpacing: ".06em",
              color: "#d5dce0",
            })}
          >
            SUN ANGLE
          </div>
          <div
            className="t"
            style={box(300, 105, undefined, 36, {
              fontSize: 32,
              fontWeight: 600,
              color: "#f6f7f9",
              lineHeight: "36px",
            })}
            title={
              sun !== null && sun <= 0
                ? "The sun is below the horizon here"
                : undefined
            }
          >
            {sun !== null ? `${sun.toFixed(0)}°` : "—"}
          </div>
          <div
            className="t"
            style={box(300, 158, undefined, undefined, {
              fontSize: 13.5,
              letterSpacing: ".06em",
              color: "#d5dce0",
            })}
            title="Nautical zone time, UTC plus longitude / 15 hours"
          >
            LOCAL TIME
          </div>
          <div
            className="t"
            style={box(300, 186, undefined, 36, {
              fontSize: 32,
              fontWeight: 600,
              color: "#f6f7f9",
              lineHeight: "36px",
            })}
          >
            {pos ? zoneTime(pos.lon, now) : "—"}
          </div>
        </div>
      )}
    </section>
  );
}
