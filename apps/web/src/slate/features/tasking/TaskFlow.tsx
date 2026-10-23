import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { create } from "zustand";
import "./tasking.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import { toast } from "../../../shell/toast.js";
import { useDetected } from "../../../situations/detectedStore.js";
import { passesOverAoi, type Pass } from "../../../sim/tasking.js";
import { usePortName } from "../../SlateSituations.js";
import { catalogue } from "../imagery/ImageryWorkspace.js";
import { OrderModal } from "./orders.js";
import { Assets } from "./Assets.js";
import { useSitFlow } from "../situation/flow.js";

// The SAR tasking flow (features copy): G33 "Satellite collection analysis"
// modal, opened from the "Task SAR pass over the cluster" card, and G36 "Task
// Asset" model chooser behind its Explore. Geometry is the copy's: the modal's
// origin is frame (701, 377), the chooser's frame (157, 108).
//
// G33 runs SGP4 (sim/tasking.passesOverAoi) for every SENTINEL-1 and CAPELLA
// element set in GET /api/space/gp over the live detection, 20 deg mask, for
// the next WINDOW_MIN minutes, exactly the copy's test. G36's chips are each
// analysis's own count: the SAR sweep's Strait of Hormuz row
// (GET /api/intel/sar/sweep, the copy's scope) and an optical detection over
// the detection's box (GET /api/imagery/detect).

export const WINDOW_MIN = 60;
const MASK_DEG = 20;

export type TaskStep = null | "analysis" | "assets" | "models" | "order";
export type TaskTab = "feeders" | "aircraft" | "satellite";
export const useTaskFlow = create<{
  step: TaskStep;
  tab: TaskTab;
  set: (s: TaskStep) => void;
  setTab: (t: TaskTab) => void;
}>((set) => ({
  step: null,
  tab: "feeders",
  set: (step) => set({ step }),
  setTab: (tab) => set({ tab }),
}));

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

/** First SAR pass above the mask over a point in the window, or null. */
export function firstSarPass(
  items: { OBJECT_NAME?: string; TLE_LINE1?: string; TLE_LINE2?: string }[],
  lat: number,
  lon: number,
  startMs: number,
  endMs: number,
): Pass | null {
  let best: Pass | null = null;
  for (const it of items) {
    const name = (it.OBJECT_NAME ?? "").trim();
    if (!/^(SENTINEL-1|CAPELLA)/.test(name)) continue;
    if (!it.TLE_LINE1 || !it.TLE_LINE2) continue;
    const p = passesOverAoi(
      it.TLE_LINE1,
      it.TLE_LINE2,
      { lat, lon },
      { startMs, endMs },
      20,
      MASK_DEG,
      name,
    )[0];
    if (p && (!best || p.startMs < best.startMs)) best = p;
  }
  return best;
}

type Analysis =
  | { state: "run" }
  | { state: "err"; msg: string }
  | { state: "done"; at: number; pass: Pass | null; n: number };

function Analysis(): JSX.Element | null {
  const det = useDetected((s) => s.det);
  const port = usePortName((s) => s.name);
  const set = useTaskFlow((s) => s.set);
  const [a, setA] = useState<Analysis>({ state: "run" });

  const run = useCallback((): void => {
    if (!det) return;
    setA({ state: "run" });
    void catalogue().then((items) => {
      if (typeof items === "string") return setA({ state: "err", msg: items });
      const at = Date.now();
      const sats = items.filter((x) =>
        /^(SENTINEL-1|CAPELLA)/.test((x.OBJECT_NAME ?? "").trim()),
      );
      setA({
        state: "done",
        at,
        n: sats.length,
        pass: firstSarPass(
          sats,
          det.lat,
          det.lon,
          at,
          at + WINDOW_MIN * 60_000,
        ),
      });
    });
  }, [det]);
  useEffect(run, [run]);

  if (!det) return null;
  const area = (
    port ?? `${det.lat.toFixed(2)}, ${det.lon.toFixed(2)}`
  ).toUpperCase();
  const at = a.state === "done" ? a.at : Date.now();
  const head =
    a.state === "run"
      ? "Propagating SAR element sets over this collection area…"
      : a.state === "err"
        ? a.msg
        : a.pass
          ? `Window detected: ${a.pass.satName ?? "SAR"} at ${mdhm(a.pass.startMs).slice(6)}, peak elevation ${a.pass.maxElevDeg.toFixed(0)}°`
          : "No available window detected for satellite image capture for this collection area and time";
  return (
    <div className="sl-task-backdrop">
      <div
        className="sl-g33"
        role="dialog"
        aria-label="Satellite collection analysis"
      >
        <div
          style={box(1, 1, 564, 29, {
            background: "#101618",
            borderBottom: "1.5px solid #222c30",
            borderRadius: "6px 6px 0 0",
          })}
        />
        <div
          className="t"
          style={box(15, 7, undefined, undefined, {
            fontSize: 14,
            fontWeight: 600,
            color: "#eef2f3",
          })}
        >
          Satellite collection analysis
        </div>
        <button
          type="button"
          className="sl-link"
          style={box(535.5, 7.5, 17, 17, { color: "#eef2f3" })}
          aria-label="Close"
          onClick={() => set(null)}
        >
          <BpIcon name="cross" size={17} />
        </button>
        <div
          className="t"
          style={box(24, 50, 520, undefined, {
            fontSize: 13,
            letterSpacing: ".05em",
            color: "#aab4b9",
            overflow: "hidden",
            textOverflow: "ellipsis",
          })}
        >
          COLLECTION AREA: {area} {" • "} TIME: {mdhm(at)} + {WINDOW_MIN} MIN
        </div>
        <div
          className="sl-g33-head"
          style={box(23, 79, 520, 44)}
          title={
            a.state === "done"
              ? `SGP4 on ${a.n} SENTINEL-1 and CAPELLA element sets, ${MASK_DEG}° mask`
              : undefined
          }
        >
          {head}
        </div>
        <div
          style={box(12, 140, 542, 65, {
            background: "#12282a",
            borderRadius: 2,
          })}
        />
        <BpIcon
          name="predictive-analysis"
          size={25}
          style={{
            position: "absolute",
            left: 25.5,
            top: 161.5,
            color: "#5fd6cb",
          }}
        />
        <div
          className="t"
          style={box(62, 166, undefined, undefined, {
            fontSize: 16.5,
            color: "#eef2f3",
          })}
        >
          Explore available ground feeders to collect
        </div>
        <button
          type="button"
          className="sl-g33-explore"
          style={box(433, 157, 104, 36)}
          onClick={() => set("assets")}
        >
          Explore <BpIcon name="arrow-top-right" size={16} />
        </button>
        <div style={box(1, 219, 564, 1, { background: "#222c30" })} />
        <button
          type="button"
          className="t sl-link"
          style={box(26, 234, undefined, undefined, {
            fontSize: 16.5,
            color: "#eef2f3",
          })}
          onClick={() => set(null)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="sl-g33-retry"
          style={box(414, 225, 134, 36)}
          onClick={run}
          disabled={a.state === "run"}
        >
          Retry analysis
        </button>
      </div>
    </div>
  );
}

interface Row {
  key: string;
  name: string;
  scope: string;
  n: number | null;
  why?: string;
  kind: "sat" | "feed";
}

const TABS = [
  ["feeders", "antenna", "Ground feeders", 9],
  ["aircraft", "airplane", "Aircraft", 208],
  ["satellite", "satellite", "Satellite", 310],
] as const;

/** The Task Asset header: title, close, the three asset tabs, panel art. */
export function TaskHead(): JSX.Element {
  const set = useTaskFlow((s) => s.set);
  const tab = useTaskFlow((s) => s.tab);
  const setTab = useTaskFlow((s) => s.setTab);
  const tabs = TABS;
  return (
    <>
      <div
        className="t"
        style={box(17, 11, undefined, undefined, {
          fontSize: 17,
          fontWeight: 700,
          color: "#f6f7f9",
        })}
      >
        Task Asset
      </div>
      <button
        type="button"
        className="sl-link"
        style={box(388.5, 11.5, 17, 17, { color: "#d5dce0" })}
        aria-label="Close"
        onClick={() => set(null)}
      >
        <BpIcon name="cross" size={17} />
      </button>
      {tabs.map(([k, ic, l, x]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={tab === k}
          className="sl-g36-tab"
          style={box(
            x,
            45,
            k === "feeders" ? 184 : undefined,
            39,
            tab === k ? { background: "#183e56" } : {},
          )}
          onClick={() => setTab(k)}
        >
          <BpIcon name={ic} size={19} />
          {l}
        </button>
      ))}
      {tab === "satellite" ? (
        <SatArt />
      ) : (
        <>
          <svg
            style={box(1, 88, 418, 104, { overflow: "hidden" })}
            viewBox="0 0 418 104"
            aria-hidden="true"
          >
            {Array.from({ length: 22 }, (_, k) => (k - 8) * 46).map((a) => (
              <g key={a} stroke="#2c3a40" strokeWidth="1">
                <line x1={a} y1="0" x2={a + 176.8} y2="104" />
                <line x1={a + 176.8} y1="0" x2={a} y2="104" />
              </g>
            ))}
            <path
              d="M75 70 C95 30 120 34 130 34 H330"
              fill="none"
              stroke="#6ca9df"
              strokeWidth="2"
            />
            <path
              d="M330 34 L322 29 M330 34 L322 39"
              stroke="#6ca9df"
              strokeWidth="2"
              fill="none"
            />
            <line
              x1="330"
              y1="34"
              x2="418"
              y2="34"
              stroke="#6ca9df"
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
            {[120, 212, 303, 395].map((gx) => (
              <g key={gx}>
                <line
                  x1={gx}
                  y1="34"
                  x2={gx}
                  y2="70"
                  stroke="#4c5a62"
                  strokeWidth="1.4"
                />
                <ellipse cx={gx} cy="72" rx="8" ry="4" fill="#4c5a62" />
              </g>
            ))}
            <ellipse
              cx="75"
              cy="70"
              rx="27"
              ry="12"
              fill="#3f9be3"
              opacity=".95"
            />
            <circle
              cx="268"
              cy="34"
              r="18"
              fill="#18262d"
              stroke="#6ca9df"
              strokeWidth="1.6"
            />
          </svg>
          <BpIcon
            name="antenna"
            size={18}
            style={{
              position: "absolute",
              left: 260,
              top: 113,
              color: "#8fc4f0",
            }}
          />
        </>
      )}
    </>
  );
}

/** G29's panel art: a globe horizon, footprint and orbit (copy, frame 153,192). */
function SatArt(): JSX.Element {
  return (
    <>
      <div
        style={box(1, 89, 420, 109, {
          background: "#1a2327",
          borderBottom: "1px solid #2a3438",
        })}
      />
      <svg
        style={box(1, 89, 420, 109, { overflow: "hidden" })}
        viewBox="153 192 420 109"
        aria-hidden="true"
      >
        <path
          d="M236 300 C240 255 290 218 362 218 C434 218 484 255 489 300 Z"
          fill="#1e2a2f"
          stroke="#c9d2d6"
          strokeWidth="1.5"
        />
        <g fill="none" stroke="#5c6a72" strokeWidth="1">
          <path d="M250 270 C300 258 420 258 475 270" />
          <path d="M243 286 C300 274 430 274 483 286" />
          <path d="M362 218 V300" />
          <path d="M362 218 C320 240 312 270 308 300" />
          <path d="M362 218 C404 240 412 270 416 300" />
          <path d="M362 218 C282 240 262 270 258 300" />
          <path d="M362 218 C442 240 462 270 466 300" />
        </g>
        <ellipse
          cx="423"
          cy="263"
          rx="21"
          ry="12"
          transform="rotate(35 423 263)"
          fill="#8f9ba2"
          opacity=".6"
        />
        <path
          d="M398 300 C440 280 468 250 478 224 C484 208 470 208 460 214"
          fill="none"
          stroke="#9aa6ac"
          strokeWidth="1.3"
        />
      </svg>
      <BpIcon
        name="satellite"
        size={22}
        style={{ position: "absolute", left: 308, top: 106, color: "#e5e8eb" }}
      />
    </>
  );
}

function Models(): JSX.Element | null {
  const det = useDetected((s) => s.det);
  const set = useTaskFlow((s) => s.set);
  const tab = useTaskFlow((s) => s.tab);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [all, setAll] = useState<Row[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<Row[]> => {
    if (!det) return [];
    const out: Row[] = [];
    const sw = await apiFetch("/api/intel/sar/sweep")
      .then(async (r) =>
        r.ok
          ? ((await r.json()) as { aois?: Record<string, unknown>[] })
          : { err: r.status },
      )
      .catch(() => ({ err: 0 }));
    const aois = "aois" in sw ? (sw.aois ?? []) : [];
    const h = aois.find((x) => x["aoi"] === "hormuz");
    const label =
      typeof h?.["label"] === "string" ? h["label"] : "Strait of Hormuz";
    const why =
      "err" in sw
        ? `SAR sweep unavailable (HTTP ${sw.err})`
        : h
          ? undefined
          : "No sweep row for this AOI";
    const num = (k: string): number | null =>
      typeof h?.[k] === "number" ? (h[k] as number) : null;
    out.push(
      {
        key: "sar",
        name: "SAR vessel detection",
        scope: `Sentinel-1 · ${label}`,
        n: num("detections"),
        kind: "sat",
        ...(why ? { why } : {}),
      },
      {
        key: "dark",
        name: "Dark-vessel correlation",
        scope: `SAR vs AIS · ${label}`,
        n: num("dark_candidates"),
        kind: "feed",
        ...(why ? { why } : {}),
      },
      {
        key: "mil",
        name: "Military-hint screen",
        scope: `SAR shape · ${label}`,
        n: num("mil_hints"),
        kind: "sat",
        ...(why ? { why } : {}),
      },
      {
        key: "ais",
        name: "AIS coverage check",
        scope: `SAR vs AIS · ${label}`,
        n: num("ais_coverage"),
        kind: "feed",
        ...(why ? { why } : {}),
      },
    );
    const d = new Date().toISOString().slice(0, 10);
    const q = new URLSearchParams({
      min_lon: (det.lon - 0.05).toFixed(4),
      min_lat: (det.lat - 0.05).toFixed(4),
      max_lon: (det.lon + 0.05).toFixed(4),
      max_lat: (det.lat + 0.05).toFixed(4),
      date: d,
    });
    const opt = await apiFetch(`/api/imagery/detect?${q.toString()}`)
      .then(async (r) =>
        r.ok
          ? {
              n: (((await r.json()) as { features?: unknown[] }).features ?? [])
                .length,
            }
          : { n: null, why: `Optical detect unavailable (HTTP ${r.status})` },
      )
      .catch(() => ({ n: null, why: "Optical detect unavailable" }));
    out.push({
      key: "opt",
      name: "Optical vessel detection",
      scope: "YOLO · detection bbox",
      kind: "sat",
      ...opt,
    });
    setAll(
      aois
        .filter((x) => typeof x["detections"] === "number")
        .map((x) => ({
          key: `aoi:${String(x["aoi"])}`,
          name: "SAR vessel detection",
          scope: `Sentinel-1 · ${String(x["label"] ?? x["aoi"])}`,
          n: x["detections"] as number,
          kind: "sat" as const,
        })),
    );
    return out.sort((a, b) => (b.n ?? -1) - (a.n ?? -1));
  }, [det]);

  useEffect(() => {
    let live = true;
    void load().then((r) => live && setRows(r));
    return () => {
      live = false;
    };
  }, [load]);

  if (!det) return null;
  const base = showAll ? [...(rows ?? []), ...all] : (rows ?? []);
  const shown = base.filter(
    (r) => tab === "feeders" || (tab === "satellite" && r.kind === "sat"),
  );
  const on = shown.filter((r) => !off.has(r.key));
  return (
    <div className="sl-g36" role="dialog" aria-label="Task Asset">
      <TaskHead />
      <div style={box(1, 192, 419, 1, { background: "#2a343a" })} />
      <div
        className="t"
        style={box(15, 209, undefined, undefined, {
          fontSize: 16,
          color: "#f1f4f6",
        })}
      >
        Choose a model
      </div>
      <div
        className="t"
        style={box(143, 212, 260, undefined, {
          textAlign: "right",
          fontSize: 13.5,
          color: "#aab4ba",
        })}
      >
        Sorted by detections
      </div>
      <div className="sl-g36-rows" style={box(15, 238, 394, 360)}>
        {rows === null && (
          <p className="sl-g36-empty">
            Running the sweep and the optical detect…
          </p>
        )}
        {rows !== null && shown.length === 0 && (
          <p className="sl-g36-empty">
            {tab === "aircraft"
              ? "No airborne analyses: the console has no aircraft sensor feed to task."
              : "No analyses for this asset."}
          </p>
        )}
        {shown.map((r) => {
          const good = typeof r.n === "number" && r.n > 0;
          const sel = !off.has(r.key);
          return (
            <div key={r.key} className="sl-g36-row" title={r.why}>
              <div className="ic">
                <BpIcon name="timeline-line-chart" size={26} />
              </div>
              <div className="nm">{r.name}</div>
              <div className="sc">{r.scope}</div>
              <div className={`cnt${good ? " ok" : ""}`}>
                {r.n === null ? "n/a" : r.n}
              </div>
              <button
                type="button"
                className="ck"
                aria-pressed={sel}
                aria-label={`${sel ? "Exclude" : "Include"} ${r.name}`}
                onClick={() =>
                  setOff((o) => {
                    const n = new Set(o);
                    if (n.has(r.key)) n.delete(r.key);
                    else n.add(r.key);
                    return n;
                  })
                }
              >
                {sel && <BpIcon name="tick" size={22} />}
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="t sl-link"
        style={box(15, 589, 408, undefined, {
          textAlign: "center",
          fontSize: 15.5,
          color: "#5da7ef",
        })}
        onClick={() => setShowAll((v) => !v)}
        disabled={!all.length}
      >
        {showAll ? "Show fewer analyses" : "See all analyses"}
      </button>
      <button
        type="button"
        className="sl-g36-btn"
        style={box(16, 623, 191, 35)}
        onClick={() => set("assets")}
      >
        Back
      </button>
      <button
        type="button"
        className="sl-g36-btn pri"
        style={box(213, 623, 191, 35)}
        disabled={busy || on.length === 0}
        onClick={() => {
          setBusy(true);
          void load()
            .then((r) => {
              setRows(r);
              toast.ok(
                `Re-ran ${on.length} ${on.length === 1 ? "analysis" : "analyses"}; counts updated`,
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Running…" : `Deploy ${on.length} & Task...`}
      </button>
    </div>
  );
}

export function TaskFlow(): JSX.Element | null {
  const step = useTaskFlow((s) => s.step);
  const set = useTaskFlow((s) => s.set);
  useEffect(() => {
    if (!step) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") set(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, set]);
  if (step === "analysis") return <Analysis />;
  if (step === "assets") return <Assets />;
  if (step === "models") return <Models />;
  if (step === "order")
    return (
      <OrderModal
        onClose={() => set(null)}
        onSubmitted={() => {
          set(null);
          useSitFlow.getState().select("sar");
        }}
      />
    );
  return null;
}
