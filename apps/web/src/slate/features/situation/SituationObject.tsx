import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { create } from "zustand";
import "./situation.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import { useSelection } from "../../../state/stores.js";
import { useDetected } from "../../../situations/detectedStore.js";
import type { Detection } from "../../../situations/DetectedSituation.js";
import { detTitle, detectedAtMs, usePortName } from "../../SlateSituations.js";
import { distKm } from "../object/activity.js";
import { ActivityCard } from "./ActivityCard.js";
import {
  CLASS_ABBR,
  authorityShort,
  classCounts,
  farthestPick,
  nearestWarnings,
  published,
  tclass,
  warnId,
  wrapChips,
  type Warning,
} from "./model.js";

// The situation object view (features copy t66: G6 header, G7 filter, G8
// DETAILS, G9 warning dossier, G10 anchorage pattern), element for element at
// the copy's pixel geometry (frame coordinates minus the copy box at 150,100).
// It opens over the map from the Situations panel's title and shows the LIVE
// detection: GET /api/situations/detect, the nearest NGA broadcast warnings
// (GET /api/maritime/warnings), the members' AIS positions and types
// (GET /api/maritime/vessels) and a Sentinel-2 chip (GET /api/imagery/chip).

export const useSitView = create<{
  open: boolean;
  set: (v: boolean) => void;
}>((set) => ({ open: false, set: (open) => set({ open }) }));

const TABS = [
  ["Summary", 127, 74],
  ["Intel", 232, 40],
  ["Reporting", 297, 84],
  ["Properties", 402, 88],
  ["Link", 512, 34],
  ["Media", 576, 50],
] as const;
type Tab = (typeof TABS)[number][0];

interface Hull {
  id: string;
  name: string | null;
  type: unknown;
  lat: number;
  lon: number;
  sog: number | null;
  t: number | null;
}

const box = (
  left: number,
  top: number,
  width?: number,
  height?: number,
  extra: CSSProperties = {},
): CSSProperties => ({ left, top, width, height, ...extra });

const mdhm = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
};

function chipUrl(lat: number, lon: number, rKm: number): string {
  const d = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  const q = new URLSearchParams({
    lat: lat.toFixed(3),
    lon: lon.toFixed(3),
    radius_km: rKm.toFixed(1),
    date: d,
    source: "sentinel",
  });
  return `/api/imagery/chip?${q.toString()}`;
}

/** The detection's NGA warnings and members' AIS fixes. */
function useSitData(det: Detection | null): {
  warns: Warning[] | null;
  warnErr: string | null;
  hulls: Hull[] | null;
  hullErr: string | null;
} {
  const [warns, setWarns] = useState<Warning[] | null>(null);
  const [warnErr, setWarnErr] = useState<string | null>(null);
  const [hulls, setHulls] = useState<Hull[] | null>(null);
  const [hullErr, setHullErr] = useState<string | null>(null);
  const key = det ? `${det.lat.toFixed(3)},${det.lon.toFixed(3)}` : "";
  useEffect(() => {
    if (!det) return;
    const ac = new AbortController();
    setWarns(null);
    setWarnErr(null);
    apiFetch("/api/maritime/warnings", { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) {
          setWarnErr(`Warnings unavailable (HTTP ${r.status})`);
          return;
        }
        setWarns(nearestWarnings(await r.json(), det.lat, det.lon));
      })
      .catch(() => undefined);
    const pad = (det.r_km + 2) / 100;
    const ids = new Map(det.members.map((m) => [m.id, m]));
    apiFetch(
      `/api/maritime/vessels?bbox=${det.lon - pad},${det.lat - pad},${det.lon + pad},${det.lat + pad}&limit=5000`,
      { signal: ac.signal },
    )
      .then(async (r) => {
        if (!r.ok) {
          setHullErr(`Live AIS unavailable (HTTP ${r.status})`);
          return;
        }
        const j = (await r.json()) as {
          vessels?: {
            id: string;
            lat: number;
            lon: number;
            sog: number | null;
            name: string | null;
            shipType: unknown;
            t: number | null;
          }[];
        };
        setHulls(
          (j.vessels ?? [])
            .filter((v) => ids.has(v.id))
            .map((v) => ({
              id: v.id,
              name: v.name ?? ids.get(v.id)?.name ?? null,
              type: ids.get(v.id)?.shipType ?? v.shipType,
              lat: v.lat,
              lon: v.lon,
              sog: v.sog,
              t: v.t,
            })),
        );
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { warns, warnErr, hulls, hullErr };
}

/** One NGA abbreviation diamond (the copy's `diamond`). */
function Diamond({
  cx,
  cy,
  r,
  label,
  anchor,
}: {
  cx: number;
  cy: number;
  r: number;
  label?: string;
  anchor?: boolean;
}): JSX.Element {
  return (
    <svg
      style={box(cx - r - 2, cy - r - 2, 2 * r + 4, 2 * r + 4, {
        overflow: "visible",
      })}
      viewBox={`${-r - 2} ${-r - 2} ${2 * r + 4} ${2 * r + 4}`}
    >
      <path
        d={`M0 ${-r} L${r} 0 L0 ${r} L${-r} 0 Z`}
        fill="#8cc3ee"
        stroke="#05080a"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {label && (
        <text
          x="0"
          y={r * 0.2}
          textAnchor="middle"
          fontSize={(r * 0.7).toFixed(1)}
          fontWeight="700"
          fill="#05080a"
          fontFamily="Source Sans 3,sans-serif"
        >
          {label}
        </text>
      )}
      {anchor && (
        <g fill="none" stroke="#05080a" strokeWidth="2.2" strokeLinecap="round">
          <circle cx="0" cy={-r * 0.42} r={r * 0.14} />
          <path
            d={`M0 ${-r * 0.28} V${r * 0.42} M${-r * 0.34} ${-r * 0.02} H${r * 0.34} M${-r * 0.46} ${r * 0.16} Q${-r * 0.34} ${r * 0.46} 0 ${r * 0.46} Q${r * 0.34} ${r * 0.46} ${r * 0.46} ${r * 0.16}`}
          />
        </g>
      )}
    </svg>
  );
}

function Tile({
  cx,
  cy,
  size,
  stacked,
  dashed,
}: {
  cx: number;
  cy: number;
  size: number;
  stacked?: boolean;
  dashed?: boolean;
}): JSX.Element {
  return (
    <>
      {stacked && (
        <div
          style={box(cx - size / 2 + 8, cy - size / 2 - 7, size, size, {
            border: "1.5px solid #3e4a50",
            background: "#2a343a",
            borderRadius: 3,
          })}
        />
      )}
      <div
        style={box(cx - size / 2, cy - size / 2, size, size, {
          border: dashed ? "1.5px dashed #6a767c" : "1.5px solid #4a565c",
          background: dashed ? "transparent" : "#323c40",
          borderRadius: 3,
        })}
      />
    </>
  );
}

export function SituationObject({
  onExploreActions,
}: {
  onExploreActions: () => void;
}): JSX.Element | null {
  const open = useSitView((s) => s.open);
  const setOpen = useSitView((s) => s.set);
  const det = useDetected((s) => s.det);
  const port = usePortName((s) => s.name);
  const [tab, setTab] = useState<Tab>("Summary");
  const [q, setQ] = useState("");
  const { warns, warnErr, hulls, hullErr } = useSitData(open ? det : null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const ql = q.trim().toLowerCase();
  const shownWarns = useMemo(
    () =>
      (warns ?? []).filter(
        (w) =>
          !ql ||
          `NGA warning ${warnId(w)} ${w.text ?? ""}`.toLowerCase().includes(ql),
      ),
    [warns, ql],
  );
  const classes = useMemo(
    () => (det ? classCounts(det.members.map((m) => m.shipType)) : []),
    [det],
  );

  if (!open || !det) return null;
  const title = detTitle(det, port);
  const area = port ?? `${det.lat.toFixed(2)}, ${det.lon.toFixed(2)}`;
  const w0 = shownWarns[0] ?? null;
  const w1 = shownWarns[1] ?? null;
  // The replay candidate: the member with the oldest fix (as the cards pick).
  const gap = [...det.members]
    .filter((m) => typeof m.t === "number")
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))[0];
  const gapHull = gap && hulls?.find((h) => h.id === gap.id);
  const gapName = gap ? gap.name?.trim() || `MMSI ${gap.mmsi ?? "n/a"}` : null;

  const paras: { text: string; chips: string[] }[] = [
    { text: "(U) OPEN SOURCE DATA UNCLASSIFIED /// NGA MSI", chips: [] },
  ];
  if (w0) {
    paras.push({
      text: `(U) NGA broadcast warning ${warnId(w0)}: ${(w0.text ?? "").split(/\s+/).join(" ")}`,
      chips: [],
    });
    const sel = gapHull
      ? ` ${gapName} (${tclass(gapHull.type)}${gapHull.sog != null ? `, ${gapHull.sog.toFixed(1)} kn` : ""}) is ${distKm(det.lat, det.lon, gapHull.lat, gapHull.lon).toFixed(1)} km from that centre.`
      : "";
    paras.push({
      text: `(U) The warning lies ${w0.d_km.toFixed(1)} km from the centre of the ${area} cluster, where ${det.n} vessels were stationary at ${mdhm(detectedAtMs() || Date.now()).slice(6)}.${sel}`,
      chips: gapName ? [gapName] : [],
    });
  }
  if (w1)
    paras.push({
      text: `(U) Warning ${warnId(w1)}, ${w1.d_km.toFixed(1)} km from the centre: ${(w1.text ?? "").split(/\s+/).join(" ")}`,
      chips: [],
    });
  const lines: { segs: { t: string; chip: boolean }[] }[] = [];
  for (const p of paras) {
    for (const segs of wrapChips(p.text, p.chips, 40)) lines.push({ segs });
    lines.push({ segs: [] });
  }

  // Layout card: five members apart from each other, at real relative
  // positions (km east and south of the centre), scaled into the card.
  const kx = 111.32 * Math.cos((det.lat * Math.PI) / 180);
  const pool = [...(hulls ?? [])]
    .sort(
      (a, b) =>
        distKm(det.lat, det.lon, a.lat, a.lon) -
        distKm(det.lat, det.lon, b.lat, b.lon),
    )
    .slice(0, 30)
    .map((h) => ({
      x: (h.lon - det.lon) * kx,
      y: -(h.lat - det.lat) * 110.57,
      h,
    }));
  const pick = farthestPick(pool, 5);
  const xs = pick.map((p) => p.x);
  const ys = pick.map((p) => p.y);
  const sc = pick.length
    ? Math.min(
        150 / Math.max(Math.max(...xs) - Math.min(...xs), 0.3),
        100 / Math.max(Math.max(...ys) - Math.min(...ys), 0.3),
      )
    : 1;
  const mx = pick.length ? (Math.max(...xs) + Math.min(...xs)) / 2 : 0;
  const my = pick.length ? (Math.max(...ys) + Math.min(...ys)) / 2 : 0;
  const top2 = classes.filter(([c]) => c !== "Other").slice(0, 2);

  const created = detectedAtMs();
  const select = (id: string): void => useSelection.getState().select(id);

  return (
    <div
      className="sl-sitobj"
      role="dialog"
      aria-label={`${title}, situation object`}
    >
      <div style={box(0, 0, 870, 968, { background: "#0c1420" })} />
      <div
        style={box(2, 4, 860, 964, {
          background: "#161e26",
          border: "1px solid #2a343a",
        })}
      />
      {/* G6 header */}
      <div
        style={box(13, 18, 98, 97, {
          border: "1px solid #232d33",
          background: "#141c22",
        })}
      />
      <svg
        style={box(13, 18, 98, 97, { overflow: "visible" })}
        viewBox="163 118 98 97"
      >
        <g
          fill="#f0d068"
          stroke="#f0d068"
          strokeWidth="3.2"
          strokeLinecap="round"
        >
          <circle cx="212" cy="148" r="9" />
          <circle cx="182.5" cy="186.5" r="9" />
          <circle cx="212" cy="186.5" r="9" />
          <circle cx="241.5" cy="186.5" r="9" />
          <path
            d="M212 157 V165 M182.5 165 H241.5 M182.5 165 V177.5 M212 165 V177.5 M241.5 165 V177.5"
            fill="none"
          />
        </g>
      </svg>
      <button
        type="button"
        className="t sl-link"
        style={box(127, 19, undefined, undefined, {
          fontSize: 16,
          letterSpacing: ".075em",
          color: "#aab4ba",
          display: "flex",
          alignItems: "center",
        })}
        title="Back to the situations list"
        onClick={() => setOpen(false)}
      >
        DETECTED SITUATIONS
        <BpIcon
          name="chevron-right"
          size={13}
          style={{ verticalAlign: -1, marginLeft: 5 }}
        />
      </button>
      <div
        className="t"
        style={box(127, 47, 540, undefined, {
          fontSize: 25,
          fontWeight: 600,
          color: "#f6f7f9",
          letterSpacing: ".02em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          height: 30,
          lineHeight: "30px",
        })}
      >
        {title}
      </div>
      <div
        className="t"
        style={box(127, 79, undefined, undefined, {
          fontSize: 16,
          color: "#aab4ba",
        })}
      >
        Situation
      </div>
      <button
        type="button"
        className="sl-btn"
        style={box(686, 30, 155, 46)}
        onClick={() => {
          setOpen(false);
          onExploreActions();
        }}
      >
        Explore actions
      </button>
      {TABS.map(([t, x]) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          className="t sl-link"
          style={box(x, 104, undefined, undefined, {
            fontSize: 16.5,
            color: tab === t ? "#5ca6ce" : "#e5e8eb",
          })}
          onClick={() => setTab(t)}
        >
          {t}
        </button>
      ))}
      {TABS.filter(([t]) => t === tab).map(([t, x, w]) => (
        <div key={t} style={box(x, 129, w, 3, { background: "#5ca6ce" })} />
      ))}
      <div style={box(2, 132, 860, 1, { background: "#2a3436" })} />
      {/* G7 filter */}
      <div
        style={box(27, 137, 365, 38, {
          background: "#1a2426",
          borderRadius: 19,
        })}
      />
      <BpIcon
        name="search"
        size={20}
        style={{ position: "absolute", left: 28, top: 146, color: "#c7d0d5" }}
      />
      <input
        className="t sl-filter"
        style={box(57, 145, 325, 24, { fontSize: 16.5 })}
        placeholder="Filter by intel title..."
        aria-label="Filter by intel title"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div style={box(2, 182, 860, 1, { background: "#2a3436" })} />

      {tab === "Summary" ? (
        <>
          {/* G8 DETAILS */}
          <div
            style={box(25, 198, 820, 172, {
              border: "1.5px solid #3a464c",
              background: "#161e24",
              borderRadius: 2,
            })}
          />
          <div
            style={box(26, 199, 818, 42, {
              background: "#1c262c",
              borderBottom: "1.5px solid #3a464c",
            })}
          />
          <BpIcon
            name="list"
            size={20}
            style={{
              position: "absolute",
              left: 35,
              top: 210,
              color: "#d5dce0",
            }}
          />
          <div
            className="t"
            style={box(63, 211, undefined, undefined, {
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: ".03em",
              color: "#f1f4f6",
            })}
          >
            DETAILS
          </div>
          <div
            style={box(44, 254, 230, 102, {
              background: `url(${chipUrl(det.lat, det.lon, 3.5)}) center/cover no-repeat #1c2a30`,
              overflow: "hidden",
            })}
            role="img"
            aria-label="Sentinel-2 chip at the detection centre"
          />
          {(
            [
              [259, "Location"],
              [289, "Created"],
              [318, "Dossier"],
            ] as const
          ).map(([y, l]) => (
            <div
              key={l}
              className="t"
              style={box(300, y, undefined, undefined, {
                fontSize: 16,
                color: "#e5e8eb",
              })}
            >
              {l}
            </div>
          ))}
          <div
            className="t"
            style={box(437, 260, 400, undefined, {
              fontSize: 16,
              color: "#f1f4f6",
              overflow: "hidden",
              textOverflow: "ellipsis",
            })}
          >
            {port ? `Near ${port}, ` : ""}
            {det.lat.toFixed(3)}, {det.lon.toFixed(3)}
          </div>
          <div
            className="t"
            style={box(437, 289, undefined, undefined, {
              fontSize: 16,
              color: "#f1f4f6",
            })}
          >
            {created ? mdhm(created) : "n/a"}
          </div>
          <svg
            style={box(435, 316, 24, 24, { overflow: "visible" })}
            viewBox="0 0 24 24"
          >
            <rect
              x="1.5"
              y="1.5"
              width="19"
              height="21"
              rx="2"
              fill="none"
              stroke="#d5dce0"
              strokeWidth="1.6"
            />
            <path
              d="M12 2 V9 H20"
              fill="none"
              stroke="#d5dce0"
              strokeWidth="1.6"
            />
          </svg>
          {w0 ? (
            <button
              type="button"
              className="t sl-link"
              style={box(468, 319, undefined, undefined, {
                fontSize: 16,
                color: "#4a8fc0",
              })}
              onClick={() => setTab("Intel")}
            >
              NGA warning {warnId(w0)}
            </button>
          ) : (
            <div
              className="t"
              style={box(468, 319, undefined, undefined, {
                fontSize: 16,
                color: "#9fabb2",
              })}
            >
              {warnErr ?? (warns ? "No NGA warning within 60 km" : "loading…")}
            </div>
          )}

          {/* G9 warning dossier */}
          <div
            style={box(26, 383, 401, 577, {
              border: "1.5px solid #3a464c",
              background: "#1a262c",
              borderRadius: 2,
              overflow: "hidden",
            })}
          >
            <div style={box(0, 0, 399, 126, { background: "#202a2c" })} />
            <div
              style={box(0, 126, 399, 460, {
                background: "linear-gradient(180deg,#1d2a30,#182228)",
              })}
            />
          </div>
          <div
            style={box(43, 404, 34, 37, {
              background: "#5e707c",
              borderRadius: 3,
            })}
          />
          <svg
            style={box(43, 404, 34, 37, { overflow: "visible" })}
            viewBox="0 0 34 37"
          >
            <path
              d="M9 7 H19 L26 14 V30 H9 Z M19 7 V14 H26"
              fill="none"
              stroke="#c9d3d9"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
          <div
            className="t"
            style={box(88, 407, undefined, undefined, {
              fontSize: 17.5,
              fontWeight: 700,
              letterSpacing: ".02em",
              color: "#f1f4f6",
            })}
          >
            MARITIME SAFETY WARNING
          </div>
          <div
            className="t"
            style={box(88, 424, undefined, undefined, {
              fontSize: 13.5,
              color: "#8f99a3",
            })}
          >
            Dossier
          </div>
          <button
            type="button"
            className="sl-link"
            style={box(385.5, 405.5, 19, 19, { color: "#4a90d0" })}
            aria-label="Open the warnings list"
            title="Open the warnings list"
            onClick={() => setTab("Intel")}
          >
            <BpIcon name="arrow-top-right" size={19} />
          </button>
          <div
            className="t"
            style={box(45, 454, undefined, undefined, {
              fontSize: 16,
              color: "#9aa5ab",
            })}
          >
            Published
          </div>
          <div
            className="t"
            style={box(149, 454, 270, undefined, {
              fontSize: 16,
              color: "#e5e9ec",
              overflow: "hidden",
              textOverflow: "ellipsis",
            })}
          >
            {w0
              ? [published(w0.issueDate), authorityShort(w0.authority)]
                  .filter(Boolean)
                  .join(" by ") || "—"
              : "—"}
          </div>
          <div
            className="t"
            style={box(45, 477, undefined, undefined, {
              fontSize: 16,
              color: "#9aa5ab",
            })}
          >
            Source
          </div>
          <div
            className="t"
            style={box(149, 477, undefined, undefined, {
              fontSize: 16,
              color: "#e5e9ec",
            })}
          >
            NGA Maritime Safety Information
          </div>
          <div style={box(27, 384, 399, 574, { overflow: "hidden" })}>
            {w0 ? (
              lines.map((l, i) => (
                <div
                  key={i}
                  className="mono"
                  style={box(18, 145.4 + i * 17.25, undefined, 17.2)}
                >
                  {l.segs.map((s, j) =>
                    s.chip ? (
                      <span key={j} className="chip">
                        {s.t}
                      </span>
                    ) : (
                      <span key={j}>{s.t}</span>
                    ),
                  )}
                </div>
              ))
            ) : (
              <div className="sl-sitempty" style={box(18, 145, 360)}>
                {warnErr
                  ? `${warnErr}. The dossier body is the nearest NGA broadcast warning, so there is nothing to show until the feed answers.`
                  : warns
                    ? ql
                      ? `No NGA warning within 60 km matches "${q}".`
                      : "No NGA broadcast warning within 60 km of the detection."
                    : "loading…"}
              </div>
            )}
          </div>

          {/* G10 anchorage pattern */}
          <div
            style={box(443, 383, 402, 577, {
              border: "1.5px solid #3a464c",
              background: "#161e24",
              borderRadius: 2,
            })}
          />
          <div
            style={box(444, 384, 400, 41, {
              background: "#161e24",
              borderBottom: "1.5px solid #3a464c",
            })}
          />
          <BpIcon
            name="layout-hierarchy"
            size={18}
            style={{
              position: "absolute",
              left: 454,
              top: 395,
              color: "#aab4ba",
            }}
          />
          <div
            className="t"
            style={box(481, 395, undefined, undefined, {
              fontSize: 17.5,
              fontWeight: 700,
              letterSpacing: ".02em",
              color: "#f1f4f6",
            })}
          >
            ANCHORAGE PATTERN
          </div>
          <div
            style={box(454, 432, 379, 292, {
              border: "1.5px solid #3a464c",
              background: "#2c363c",
              borderRadius: 3,
              overflow: "hidden",
            })}
          >
            <div
              style={box(0, 0, 377, 35, {
                background: "#161e24",
                borderBottom: "1.5px solid #3a464c",
              })}
            />
            <div className="gridbg" style={box(0, 36, 377, 260)} />
          </div>
          <div
            className="t"
            style={box(466, 442, undefined, undefined, {
              fontSize: 16,
              fontWeight: 700,
              color: "#f1f4f6",
            })}
          >
            Anchorage composition
          </div>
          <button
            type="button"
            className="t sl-link"
            style={box(761, 442, undefined, undefined, {
              fontSize: 16,
              fontWeight: 600,
              color: "#4a8fc0",
            })}
            onClick={() => setTab("Link")}
          >
            Explore
          </button>
          <Tile cx={640} cy={521} size={43} />
          <Diamond cx={640} cy={521} r={19} anchor />
          <div
            className="t"
            style={box(590, 548, 100, undefined, {
              textAlign: "center",
              fontSize: 14,
              color: "#9fabb2",
              letterSpacing: ".05em",
            })}
          >
            ANCHORAGE
          </div>
          {top2.length > 0 && (
            <>
              <div style={box(589, 582, 103, 1.5, { background: "#626c74" })} />
              <div style={box(589, 582, 1.5, 25, { background: "#626c74" })} />
              <div style={box(691, 582, 1.5, 25, { background: "#626c74" })} />
              <div
                style={box(639.5, 588, 1.5, 13, { background: "#626c74" })}
              />
            </>
          )}
          {top2.map(([c, n], i) => {
            const cx = i === 0 ? 591 : 695;
            return (
              <Fragment key={c}>
                <Tile cx={cx} cy={642} size={42} stacked />
                <Diamond
                  cx={cx}
                  cy={642}
                  r={18}
                  label={CLASS_ABBR[c] ?? "OT"}
                />
                <div
                  className="t"
                  style={box(cx - 55, 673, 110, undefined, {
                    textAlign: "center",
                    fontSize: 14,
                    color: "#9fabb2",
                    letterSpacing: ".05em",
                  })}
                >
                  {c.split(" / ")[0]!.toUpperCase()}
                </div>
                <div className="sl-pill" style={box(cx + 6, 608, 40, 25)}>
                  {n}x
                </div>
              </Fragment>
            );
          })}
          <div
            style={box(454, 736, 379, 224, {
              border: "1.5px solid #3a464c",
              background: "#2c363c",
              borderRadius: 3,
              overflow: "hidden",
            })}
          >
            <div
              style={box(0, 0, 377, 36, {
                background: "#161e24",
                borderBottom: "1.5px solid #3a464c",
              })}
            />
            <div className="gridbg" style={box(0, 37, 377, 200)} />
          </div>
          <div
            className="t"
            style={box(466, 745, undefined, undefined, {
              fontSize: 16,
              fontWeight: 700,
              color: "#f1f4f6",
            })}
          >
            Observed layout
          </div>
          <div className="sl-tag" style={box(622, 742, 84, 23)}>
            STATIONARY
          </div>
          <button
            type="button"
            className="t sl-link"
            style={box(761, 745, undefined, undefined, {
              fontSize: 16,
              fontWeight: 600,
              color: "#4a8fc0",
            })}
            onClick={() => setTab("Link")}
          >
            Explore
          </button>
          <svg style={box(633, 810, 20, 16, { overflow: "visible" })}>
            <path d="M10 3 L16 12 H4 Z" fill="#c9d1d6" />
          </svg>
          {pick.map((p) => {
            const x = 644 + (p.x - mx) * sc;
            const y = 872 + (p.y - my) * sc;
            return (
              <button
                key={p.h.id}
                type="button"
                className="sl-hull"
                style={box(x - 22, y - 22, 44, 44)}
                title={`${p.h.name ?? p.h.id} · ${tclass(p.h.type)}`}
                aria-label={`Select ${p.h.name ?? p.h.id}`}
                onClick={() => select(p.h.id)}
              >
                <Tile cx={22} cy={22} size={44} dashed />
                <Diamond
                  cx={22}
                  cy={22}
                  r={18}
                  label={CLASS_ABBR[tclass(p.h.type)] ?? "OT"}
                />
              </button>
            );
          })}
          {!pick.length && (
            <div className="sl-sitempty" style={box(470, 800, 350)}>
              {hullErr ??
                (hulls
                  ? "No member fixes in the live AIS window."
                  : "loading…")}
            </div>
          )}
        </>
      ) : (
        <div className="sl-sittab" style={box(25, 198, 820, 760)}>
          {tab === "Intel" &&
            (warnErr ? (
              <p>{warnErr}</p>
            ) : !warns ? (
              <p>loading…</p>
            ) : shownWarns.length === 0 ? (
              <p>
                No NGA broadcast warning within 60 km
                {ql ? ` matches "${q}"` : ""}.
              </p>
            ) : (
              shownWarns.map((w) => (
                <div key={warnId(w)} className="row">
                  <b>
                    NGA warning {warnId(w)} · {w.d_km.toFixed(1)} km
                  </b>
                  <span className="mono">{w.text}</span>
                </div>
              ))
            ))}
          {tab === "Reporting" && (
            <>
              <ActivityCard lat={det.lat} lon={det.lon} km={det.r_km} />
              <p>
                {det.sanctioned} of {det.n} hulls match a sanctions list (
                {det.sanctions_lists.join(", ") || "no list loaded"})
                {det.sanctions_failed.length
                  ? `. Not loaded: ${det.sanctions_failed.join(", ")}`
                  : ""}
                .
              </p>
            </>
          )}
          {tab === "Properties" &&
            (
              [
                ["Centre", `${det.lat.toFixed(4)}, ${det.lon.toFixed(4)}`],
                ["Radius", `${det.r_km} km`],
                ["Vessels at anchor", String(det.n)],
                ["Sanctions matches", String(det.sanctioned)],
                ["Detected", created ? mdhm(created) : "n/a"],
                ...classes.map(([c, n]) => [c, String(n)] as [string, string]),
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="kvrow">
                <span>{k}</span>
                <span>{v}</span>
              </div>
            ))}
          {tab === "Link" &&
            det.members
              .filter((m) => !ql || (m.name ?? "").toLowerCase().includes(ql))
              .slice(0, 200)
              .map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="kvrow sl-link"
                  onClick={() => select(m.id)}
                >
                  <span>{m.name?.trim() || `MMSI ${m.mmsi ?? "n/a"}`}</span>
                  <span>
                    {tclass(m.shipType)}
                    {m.sanctioned ? " · sanctions match" : ""}
                  </span>
                </button>
              ))}
          {tab === "Media" && (
            <img
              src={chipUrl(det.lat, det.lon, Math.max(3.5, det.r_km))}
              alt="Sentinel-2 chip over the detection"
              style={{ width: "100%", display: "block" }}
            />
          )}
        </div>
      )}
    </div>
  );
}
