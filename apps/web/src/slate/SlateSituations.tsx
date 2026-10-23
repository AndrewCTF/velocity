import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import * as Cesium from "cesium";
import { useSituations, type Situation } from "../situations/situationStore.js";
import { useDetected } from "../situations/detectedStore.js";
import {
  nextSarPass,
  type Detection,
  type DetectMember,
} from "../situations/DetectedSituation.js";
import { useSelection } from "../state/stores.js";
import { altitudeForWidth, flyToPosition } from "../globe/camera.js";
import { useSettings, validHomeView } from "../state/settings.js";
import { apiFetch } from "../transport/http.js";
import { BpIcon } from "../shell/BpIcon.js";
import { useSitView } from "./features/situation/SituationObject.js";
import { useTaskFlow } from "./features/tasking/TaskFlow.js";
import {
  ExpandedAction,
  ExplanationCard,
  SelectedAction,
} from "./features/situation/ActionCards.js";
import { useSitFlow } from "./features/situation/flow.js";
import { useOrders } from "./features/tasking/orders.js";
import {
  useSituationFocus,
  type SituationRow,
} from "../state/situationFocus.js";

// The left panel's Situations view, in the reference `.sit` grammar: title row
// with a back button, two key/value rows, three chevroned bands (Details,
// Possible explanations, Recommended actions) and course-of-action cards.
//
// The default is the LIVE detected situation: the densest cluster of hulls at
// anchor anywhere right now (GET /api/situations/detect over the whole map),
// its sanctions join (OFAC / UK / UN, identifier-backed), and the next
// Sentinel-1 pass over it (SGP4 on the CelesTrak catalogue). Every number on
// a card is one of those values; nothing is composed for show. Saved situations
// (GET /api/situations) open the same way, from the back button's list.

const STALE_S = 3600; // a hull whose last AIS fix is older than this has a gap

interface LinkedObject {
  id: string;
  kind: string;
  props: Record<string, unknown>;
  created_at?: string | null;
}

/** "detected" = the live detection; otherwise a saved situation id. */
export const useSlateSituation = create<{
  id: string | null;
  set: (id: string | null) => void;
  listed: boolean;
  setListed: (v: boolean) => void;
}>((set) => ({
  id: null,
  set: (id) => set({ id }),
  listed: false,
  setListed: (v) => set({ listed: v }),
}));

/** The nearest seaport's name for the detection, from the WPI port index. */
export const usePortName = create<{
  name: string | null;
  set: (n: string | null) => void;
}>((set) => ({ name: null, set: (name) => set({ name }) }));

function newest(list: Situation[]): Situation | undefined {
  const active = list.filter((s) => s.status === "active");
  const pool = active.length ? active : list;
  return [...pool].sort((a, b) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  )[0];
}

/** Title of what the panel has open, for the menu row. */
export function useOpenSituation(): { name: string } | undefined {
  const list = useSituations((s) => s.situations);
  const id = useSlateSituation((s) => s.id);
  const listed = useSlateSituation((s) => s.listed);
  const det = useDetected((s) => s.det);
  const port = usePortName((s) => s.name);
  if (listed) return undefined;
  if (det && (id === null || id === "detected"))
    return { name: detTitle(det, port) };
  return (id ? list.find((s) => s.id === id) : undefined) ?? newest(list);
}

export function detTitle(det: Detection, port: string | null): string {
  return port
    ? `${port} Situation`
    : `Anchorage ${det.lat.toFixed(2)}, ${det.lon.toFixed(2)}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "n/a";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "n/a";
  return agoMs(now - t);
}
function agoMs(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 120) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}
/** A duration as the reference chips word it: "minutes", "3 hours". */
function span(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return "minutes";
  const r = Math.round(h);
  return `${r} hour${r === 1 ? "" : "s"}`;
}
const utcShort = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
};

let landed = false;
let detecting = false;
let detectedAt = 0;
/** Wall-clock ms the live detection answered (0 before it has). */
export const detectedAtMs = (): number => detectedAt;
let detSettled = false;

function regionAlt(viewer: Cesium.Viewer, rKm: number): number {
  return altitudeForWidth(viewer, Math.max(400_000, rKm * 2_000 * 1.5));
}

// One detection per page load over the whole map, then the SAR pass. Results
// go to the shared detected store, so globe/DetectedLayer draws the footprint.
// One promise per page load: StrictMode runs the mount effect twice, and the
// second caller must wait on the same detection, not report it finished.
let detectPromise: Promise<void> | null = null;
function detectOnce(): Promise<void> {
  detectPromise ??= runDetect();
  return detectPromise;
}
async function runDetect(): Promise<void> {
  if (detecting || useDetected.getState().det) return;
  detecting = true;
  const put = useDetected.getState().set;
  try {
    const r = await apiFetch("/api/situations/detect?bbox=-180,-80,180,80");
    if (!r.ok) return;
    const j = (await r.json()) as Detection | { ok: false };
    if (!j.ok) return;
    detectedAt = Date.now();
    put({ det: j, sar: null });
    // The landing camera needs only the detection; the SAR pass follows.
    detSettled = true;
    const pad = 0.25;
    void apiFetch(
      `/api/places/ports?bbox=${j.lon - pad},${j.lat - pad},${j.lon + pad},${j.lat + pad}&limit=50`,
    )
      .then((pr) => (pr.ok ? pr.json() : null))
      .then(
        (
          fc: {
            features?: {
              geometry: { coordinates: number[] };
              properties: { name?: string };
            }[];
          } | null,
        ) => {
          const near = (fc?.features ?? [])
            .map((f) => ({
              name: f.properties.name,
              d: Math.hypot(
                (f.geometry.coordinates[0] ?? 0) - j.lon,
                (f.geometry.coordinates[1] ?? 0) - j.lat,
              ),
            }))
            .filter((x) => x.name)
            .sort((a, b) => a.d - b.d)[0];
          usePortName.getState().set(near?.name ?? null);
        },
      )
      .catch(() => undefined);
    const g = await apiFetch("/api/space/gp?group=active&limit=20000");
    if (!g.ok) {
      put({ sar: "err" });
      return;
    }
    const items = ((await g.json()) as { items?: unknown[] }).items ?? [];
    put({
      sar:
        nextSarPass(
          items as Parameters<typeof nextSarPass>[0],
          j.lat,
          j.lon,
          Date.now(),
        ) ?? "none",
    });
  } catch {
    /* the saved situations still load; the panel says what it has */
  } finally {
    detecting = false;
  }
}

interface Coa {
  id: string;
  title: string;
  dur: string;
  tag: { text: string; tone: "r" | "g" } | null;
  by: string;
  icon: string;
  foot: string;
  /** Effort on the Gantt, in ms from hour 0. */
  ms: number;
  select?: string;
  /** The expanded card's rows (features-b G50): every value from the model. */
  detail?: CoaDetail;
}
export interface CoaDetail {
  est: string;
  feas: string;
  /** Reasons the action carries risk; empty = low risk. */
  risks: string[];
  tile: string;
  tIcon: string;
  tText: string;
}
/** "95 minutes", "3 hours": an effort in ms as the expanded card words it. */
function est(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 120) return `${m} minutes`;
  return `${Math.round(m / 60)} hours`;
}
/** The Gantt row id for a card: the contact it selects, else the action. */
function rowId(c: Coa): string {
  return c.select ?? `action:${c.id}`;
}
interface Hyp {
  text: string;
  n: number;
  /** A hypothesis that implies concealment or a listed party. */
  risk: boolean;
}

/** The detection's hypotheses and actions. Exported for tests. */
export function detectionModel(
  det: Detection,
  sar: ReturnType<typeof useDetected.getState>["sar"],
  nowMs: number,
): { hyps: Hyp[]; coas: Coa[] } {
  const nowS = nowMs / 1000;
  const stale = det.members.filter(
    (m) => typeof m.t === "number" && nowS - m.t > STALE_S,
  );
  const hyps: Hyp[] = [
    { text: `${det.n} vessels stationary at anchorage`, n: det.n, risk: false },
  ];
  if (det.sanctioned > 0)
    hyps.push({
      text: `${det.sanctioned} hulls match a sanctions list`,
      n: det.sanctioned,
      risk: true,
    });
  if (stale.length > 0)
    hyps.push({
      text: `AIS gaps on ${stale.length} hulls (no fix for over an hour)`,
      n: stale.length,
      risk: true,
    });

  const coas: Coa[] = [];
  if (sar && typeof sar === "object") {
    coas.push({
      id: "sar",
      title: "Task SAR pass over the cluster",
      dur: span(sar.startMs - nowMs),
      tag: null,
      by: "Analyzed by orbit propagation (SGP4)",
      icon: "satellite",
      foot: `${sar.satName ?? "Sentinel-1"} · ${utcShort(sar.startMs)}`,
      ms: Math.max(0, sar.startMs - nowMs),
      detail: {
        est: est(sar.startMs - nowMs),
        feas: "Feasible",
        risks:
          sar.maxElevDeg < 45
            ? [`Low pass elevation (${sar.maxElevDeg.toFixed(0)}°)`]
            : [],
        tile: "SAR",
        tIcon: "satellite",
        tText: sar.satName ?? "Sentinel-1",
      },
    });
  } else {
    coas.push({
      id: "sar",
      title: "Task SAR pass over the cluster",
      dur: sar === "none" ? "none in 48 h" : sar === "err" ? "n/a" : "…",
      tag: null,
      by: "Analyzed by orbit propagation (SGP4)",
      icon: "satellite",
      foot:
        sar === "none"
          ? "No Sentinel-1 pass above 30° in 48 h"
          : sar === "err"
            ? "Satellite catalogue unavailable"
            : "Propagating Sentinel-1…",
      ms: 0,
      detail: {
        est: "n/a",
        feas:
          sar === "none"
            ? "No pass in 48 h"
            : sar === "err"
              ? "Catalogue unavailable"
              : "Feasibility unknown",
        risks: [],
        tile: "SAR",
        tIcon: "satellite",
        tText: "Sentinel-1",
      },
    });
  }
  // The hull with the oldest last fix is the one worth replaying.
  const gap: DetectMember | undefined = [...det.members]
    .filter((m) => typeof m.t === "number")
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))[0];
  if (gap && typeof gap.t === "number") {
    const gapMs = Math.max(0, nowMs - gap.t * 1000);
    coas.push({
      id: "track",
      title: `Follow ${gap.name?.trim() || `MMSI ${gap.mmsi ?? "n/a"}`} on replay`,
      dur: span(gapMs),
      tag:
        gapMs > STALE_S * 1000
          ? { text: "Track gaps", tone: "r" }
          : { text: "Feasible", tone: "g" },
      by: "Analyzed by AIS freshness (local)",
      icon: "ship",
      foot: `MMSI ${gap.mmsi ?? "n/a"} · last fix ${agoMs(gapMs)}`,
      ms: gapMs,
      select: gap.id,
      detail: {
        est: est(gapMs),
        feas: "Feasible",
        risks:
          gapMs > STALE_S * 1000
            ? [`AIS gap: no fix for ${agoMs(gapMs).replace(/ ago$/, "")}`]
            : [],
        tile: "RPL",
        tIcon: "history",
        tText: "Replay archive",
      },
    });
  }
  const first = det.sanctions_lists[0] ?? "no list";
  const more = det.sanctions_lists.length - 1;
  const lists = more > 0 ? `${first} +${more}` : first;
  coas.push({
    id: "sanctions",
    title: "Check sanctions registry",
    dur: "minutes",
    tag:
      det.sanctions_failed.length === 0
        ? { text: "Feasible", tone: "g" }
        : { text: "List gaps", tone: "r" },
    by: `Analyzed by registry watch (${lists})`,
    icon: "document",
    foot: `${det.sanctioned} matched · ${det.n} vessels checked`,
    ms: 5 * 60_000,
    detail: {
      est: "5 minutes",
      feas: det.sanctions_failed.length === 0 ? "Feasible" : "List gaps",
      risks: det.sanctions_failed.map((l) => `${l} not loaded`),
      tile: "REG",
      tIcon: "document",
      tText: lists,
    },
  });
  return { hyps, coas };
}

export function SlateSituations({
  viewer,
}: {
  viewer: Cesium.Viewer | null;
}): JSX.Element {
  const list = useSituations((s) => s.situations);
  const load = useSituations((s) => s.load);
  const createSit = useSituations((s) => s.create);
  const id = useSlateSituation((s) => s.id);
  const setId = useSlateSituation((s) => s.set);
  const listed = useSlateSituation((s) => s.listed);
  const setListed = useSlateSituation((s) => s.setListed);
  const det = useDetected((s) => s.det);
  const sar = useDetected((s) => s.sar);
  const port = usePortName((s) => s.name);
  const selected = useSelection((s) => s.selectedEntityId);

  const [loaded, setLoaded] = useState(false);
  const [detTried, setDetTried] = useState(false);
  useEffect(() => {
    void load().finally(() => setLoaded(true));
    void detectOnce().finally(() => setDetTried(true));
    const poll = window.setInterval(() => {
      if (detSettled) {
        setDetTried(true);
        window.clearInterval(poll);
      }
    }, 200);
    return () => window.clearInterval(poll);
  }, [load]);

  const showDet = !listed && det !== null && (id === null || id === "detected");
  const sit: Situation | undefined = showDet
    ? undefined
    : listed
      ? undefined
      : ((id && id !== "detected"
          ? list.find((s) => s.id === id)
          : undefined) ?? (det ? undefined : newest(list)));

  // Landing view: the open situation, framed regionally (~400 km across, or
  // its area if wider). Neither: the saved home view; else the boot globe.
  // Once per page load, so it never fights the operator's camera.
  useEffect(() => {
    if (landed || !viewer || viewer.isDestroyed()) return;
    if (!det && (!loaded || !detTried)) return;
    landed = true;
    if (det) {
      flyToPosition(viewer, det.lon, det.lat, regionAlt(viewer, det.r_km), 0);
      return;
    }
    if (sit?.centroid) {
      flyToPosition(
        viewer,
        sit.centroid.lon,
        sit.centroid.lat,
        regionAlt(viewer, sit.radius_km),
        0,
      );
      return;
    }
    const home = validHomeView(useSettings.getState().homeView);
    if (home)
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          home.lon,
          home.lat,
          home.height,
        ),
      });
  }, [viewer, loaded, detTried, det, sit]);

  // Saved situation detail.
  const [objects, setObjects] = useState<LinkedObject[]>([]);
  useEffect(() => {
    setObjects([]);
    if (!sit) return;
    let live = true;
    apiFetch(`/api/situations/${encodeURIComponent(sit.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setObjects(d.objects ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const model = useMemo(
    () => (det ? detectionModel(det, sar, now) : null),
    [det, sar, now],
  );
  const savedModel = useMemo(() => {
    const coas = objects.filter((o) => o.kind === "coa");
    const toCoa = (o: LinkedObject): Coa => {
      const p = o.props ?? {};
      const lk = typeof p.likelihood === "string" ? p.likelihood : null;
      return {
        id: o.id,
        title: String(p.title ?? o.id),
        dur: lk ? `${lk} likelihood` : "n/a",
        tag: p.status === "confirmed" ? { text: "Confirmed", tone: "g" } : null,
        by: `Analyzed by ${String(p.source ?? "analyst")}`,
        icon: "flows",
        foot: String(p.rationale ?? "").slice(0, 60) || o.id,
        ms: 0,
        select: o.id,
      };
    };
    return {
      explanations: coas.filter((o) => o.props?.side === "enemy").map(toCoa),
      actions: coas.filter((o) => o.props?.side !== "enemy").map(toCoa),
      linked: objects.filter((o) => o.kind !== "coa"),
    };
  }, [objects]);

  const [open, setOpen] = useState<"details" | "hyp" | "act">("act");
  const flow = useSitFlow();
  const orders = useOrders((st) => st.orders);
  // The replay action's archive check: a hull the position archive holds no
  // fix for cannot be replayed, which is the action's real risk.
  const replayId = model?.coas.find((c) => c.id === "track")?.select ?? null;
  const [archGap, setArchGap] = useState<{ id: string; empty: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!replayId) return;
    const ac = new AbortController();
    const from = Math.floor(Date.now() / 1000 - 86400);
    apiFetch(
      `/api/history/track?id=${encodeURIComponent(replayId)}&from_ts=${from}&limit=50`,
      { signal: ac.signal },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { tracks?: { points?: unknown[] }[] } | null) => {
        if (j)
          setArchGap({
            id: replayId,
            empty: !(j.tracks?.[0]?.points?.length ?? 0),
          });
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [replayId]);
  const pick = useSituationFocus((st) => st.pick);
  const setPick = useSituationFocus((st) => st.setPick);
  // The reference opens with the replay action picked; so does this, when the
  // detection has one.
  useEffect(() => {
    if (pick !== null || !model) return;
    const track = model.coas.find((c) => c.id === "track");
    if (track) setPick(rowId(track));
  }, [model, pick, setPick]);

  // Publish to the map (linked contacts keep labels) and the time dock (the
  // actions become Gantt rows from hour 0 = now, the detection's instant).
  useEffect(() => {
    const setFocus = useSituationFocus.getState().setSituation;
    if (showDet && det && model) {
      const rows: SituationRow[] = model.coas.map((c) => ({
        id: rowId(c),
        label: c.title,
        start: now,
        end: now + c.ms,
      }));
      // Labels for the hulls the cards name (the sanctions hits and the
      // replay candidate), not for every member of a 500-hull anchorage.
      const named = new Set(
        det.members.filter((m) => m.sanctioned).map((m) => m.id),
      );
      for (const c of model.coas) if (c.select) named.add(c.select);
      setFocus(named, rows, now);
      return;
    }
    if (sit) {
      const start = Date.parse(sit.created_at ?? "");
      setFocus(
        new Set(objects.map((o) => o.id)),
        [...savedModel.actions, ...savedModel.explanations].map((c) => ({
          id: c.id,
          label: c.title,
          start: Number.isFinite(start) ? start : now,
          end: null,
        })),
        Number.isFinite(start) ? start : null,
      );
      return;
    }
    setFocus(new Set(), [], null);
  }, [showDet, det, model, sit, objects, savedModel, now]);

  const band = (
    key: "details" | "hyp" | "act",
    text: string,
    n?: number,
  ): JSX.Element => (
    <button
      type="button"
      className="band sl-flow"
      aria-expanded={open === key}
      onClick={() => setOpen(key)}
    >
      <BpIcon
        name={open === key ? "chevron-down" : "chevron-right"}
        size={12}
      />
      {text}
      {n !== undefined && <span className="n">{n}</span>}
    </button>
  );
  const coaCards = (items: Coa[]): JSX.Element => (
    <div className="sl-cards">
      {items.length === 0 && <p className="sl-empty">None yet.</p>}
      {items.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`coa sl-flow${pick === rowId(c) || (c.select && selected === c.select) ? " sel" : ""}`}
          onClick={() => {
            setPick(rowId(c));
            if (c.select) useSelection.getState().select(c.select);
          }}
        >
          <span className="t1">{c.title}</span>
          <span className="chips">
            <span className="chip">{c.dur}</span>
            {c.tag && (
              <span className={`chip ${c.tag.tone}`}>{c.tag.text}</span>
            )}
          </span>
          <span className="by">{c.by}</span>
          <span className="ft">
            <BpIcon name={c.icon} size={16} />
            {c.foot}
          </span>
        </button>
      ))}
    </div>
  );

  // features-b states for the live detection's actions: collapsed (G48),
  // expanded (G50, the picked card or all in compare mode), selected (G54).
  const actionCards = (items: Coa[]): JSX.Element => {
    const ordered = flow.selected
      ? [
          ...items.filter((c) => c.id === flow.selected),
          ...items.filter((c) => c.id !== flow.selected),
        ]
      : items;
    const review = (c: Coa): void => {
      if (c.id === "sar") useTaskFlow.getState().set("analysis");
      else if (c.select) useSelection.getState().select(c.select);
      else useSitView.getState().set(true);
    };
    return (
      <div className="sl-cards">
        {ordered.map((c0) => {
          const d =
            c0.detail &&
            c0.id === "track" &&
            archGap !== null &&
            archGap.id === c0.select &&
            archGap.empty
              ? {
                  ...c0.detail,
                  feas: "Archive empty",
                  risks: [
                    ...c0.detail.risks,
                    "No archived fixes for this hull in 24 h",
                  ],
                }
              : c0.detail;
          // A card whose action carries a known risk says so in its header.
          const c: Coa =
            d && d.risks.length
              ? { ...c0, tag: { text: "High risk", tone: "r" } }
              : c0;
          if (d && flow.selected === c.id)
            return (
              <SelectedAction
                key={c.id}
                c={c}
                d={d}
                status={
                  c.id !== "sar"
                    ? "Selected"
                    : ({
                        queued: "Awaiting approval",
                        approved: "Tasked",
                        rejected: "Rejected",
                        failed: "Failed",
                      }[orders[0]?.state ?? "queued"] ?? "Awaiting approval")
                }
                resolveDisabled={
                  flow.resolved
                    ? "Already resolved"
                    : flow.resolving
                      ? "Resolving…"
                      : null
                }
                onResolve={() =>
                  det &&
                  flow.startResolve(detTitle(det, port), {
                    severity: det.sanctioned > 0 ? "high" : "med",
                    centroid: { lat: det.lat, lon: det.lon },
                    radius_km: det.r_km,
                    summary: `${det.n} vessels at anchor within ${det.r_km} km. Selected action: ${c.title}.`,
                  })
                }
              />
            );
          if (d && (pick === rowId(c) || flow.compare))
            return (
              <div key={c.id} onClick={() => setPick(rowId(c))}>
                <ExpandedAction
                  c={c}
                  d={d}
                  reviewStatus="Unvalidated"
                  onReview={() => review(c)}
                  onCompare={flow.toggleCompare}
                  onSelect={() =>
                    c.id === "sar"
                      ? useTaskFlow.getState().set("order")
                      : flow.select(c.id)
                  }
                  onAnalysis={() => useSitView.getState().set(true)}
                />
              </div>
            );
          return coaCards([c]);
        })}
      </div>
    );
  };

  if (showDet && det && model) {
    const sev = det.sanctioned > 0 ? "HIGH" : "MED";
    return (
      <div className="sl-sit">
        <div className="ttl sl-flow">
          <button
            type="button"
            className="bk"
            aria-label="All situations"
            title="All situations"
            onClick={() => setListed(true)}
          >
            <BpIcon name="arrow-left" size={16} />
          </button>
          <button
            type="button"
            className="truncate sl-ttlbtn"
            title="Open the situation object"
            onClick={() => useSitView.getState().set(true)}
          >
            {detTitle(det, port)}
          </button>
          {flow.resolved && <span className="sl-sittag">Archived</span>}
        </div>
        <div className="kv sl-flow sl-kv1">
          <span className="k">Detected</span>
          <span className="v">{agoMs(now - (detectedAt || now))}</span>
        </div>
        <div className="kv sl-flow sl-kv2">
          {flow.resolved ? (
            <>
              <span className="k">Status</span>
              <span className="sl-resolvedchip">Resolved</span>
            </>
          ) : (
            <>
              <span className="k">Severity</span>
              {sev === "HIGH" ? (
                <span className="sev">HIGH</span>
              ) : (
                <span className="chip">MED</span>
              )}
            </>
          )}
        </div>
        <div className="sl-bands">
          {band("details", "Details")}
          {open === "details" && (
            <div className="sl-details">
              <p>
                {det.n} vessels at anchor within {det.r_km} km of{" "}
                {det.lat.toFixed(3)}, {det.lon.toFixed(3)}. Stationary together
                now; no claim about why.
              </p>
              <p className="sl-mute">
                Sanctions joined on IMO or MMSI against{" "}
                {det.sanctions_lists.join(", ") || "no list"}
                {det.sanctions_failed.length
                  ? `. Not loaded: ${det.sanctions_failed.join(", ")}`
                  : ""}
              </p>
            </div>
          )}
          {band("hyp", "Possible explanations", model.hyps.length)}
          {open === "hyp" && (
            <div className="sl-cards">
              {model.hyps.map((h) => (
                <ExplanationCard
                  key={h.text}
                  title={h.text}
                  risk={h.risk}
                  by={`Hypothetical • ${h.n} hulls, anchorage detector`}
                  state={flow.hyps[h.text] ?? "open"}
                  onState={(st) => flow.setHyp(h.text, st)}
                />
              ))}
            </div>
          )}
          {band(
            "act",
            "Recommended actions",
            flow.selected ? 1 : model.coas.length,
          )}
          {open === "act" && actionCards(model.coas)}
        </div>
      </div>
    );
  }

  if (listed || !sit) {
    return (
      <div className="sl-sitlist">
        <div className="ttl sl-flow">
          Situations <span className="n">{list.length + (det ? 1 : 0)}</span>
        </div>
        {det && (
          <button
            type="button"
            className="coa sl-flow"
            onClick={() => {
              setId("detected");
              setListed(false);
            }}
          >
            <span className="t1">{detTitle(det, port)}</span>
            <span className="chips">
              <span className={`chip${det.sanctioned > 0 ? " r" : ""}`}>
                {det.sanctioned > 0 ? "HIGH" : "MED"}
              </span>
            </span>
            <span className="by">Detected live · not saved</span>
            <span className="ft">
              <BpIcon name="map-marker" size={16} />
              {det.n} vessels at anchor · {det.r_km} km
            </span>
          </button>
        )}
        {list.length === 0 && !det && (
          <p className="sl-empty">
            No situations yet. A situation gathers the contacts, events and
            courses of action around one area.
          </p>
        )}
        {list.map((s) => (
          <button
            key={s.id}
            type="button"
            className="coa sl-flow"
            onClick={() => {
              setId(s.id);
              setListed(false);
              if (viewer && s.centroid)
                flyToPosition(
                  viewer,
                  s.centroid.lon,
                  s.centroid.lat,
                  regionAlt(viewer, s.radius_km),
                  1.0,
                );
            }}
          >
            <span className="t1">{s.name}</span>
            <span className="chips">
              <span
                className={`chip${s.severity === "high" || s.severity === "critical" ? " r" : ""}`}
              >
                {s.severity.toUpperCase()}
              </span>
            </span>
            <span className="by">Created {ago(s.created_at)}</span>
            <span className="ft">
              <BpIcon name="map-marker" size={16} />
              {s.centroid
                ? `${s.centroid.lat.toFixed(2)}, ${s.centroid.lon.toFixed(2)} · ${s.radius_km} km`
                : "No area set"}{" "}
              · {s.status}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="band sl-flow sl-new"
          onClick={async () => {
            const nid = await createSit({ name: "New situation" });
            setId(nid);
            setListed(false);
          }}
        >
          <BpIcon name="add" size={12} />
          New situation
        </button>
      </div>
    );
  }

  const sev = sit.severity;
  return (
    <div className="sl-sit">
      <div className="ttl sl-flow">
        <button
          type="button"
          className="bk"
          aria-label="All situations"
          title="All situations"
          onClick={() => setListed(true)}
        >
          <BpIcon name="arrow-left" size={16} />
        </button>
        <span className="truncate">{sit.name}</span>
      </div>
      <div className="kv sl-flow sl-kv1">
        <span className="k">Created</span>
        <span className="v">{ago(sit.created_at)}</span>
      </div>
      <div className="kv sl-flow sl-kv2">
        <span className="k">Severity</span>
        {sev === "high" || sev === "critical" ? (
          <span className="sev">{sev.toUpperCase()}</span>
        ) : (
          <span className="chip">{sev.toUpperCase()}</span>
        )}
      </div>
      <div className="sl-bands">
        {band("details", "Details")}
        {open === "details" && (
          <div className="sl-details">
            <p>{sit.summary || "No summary written."}</p>
            {sit.report && <p>{sit.report}</p>}
            <p className="sl-mute">
              {sit.status} · radius {sit.radius_km} km
              {sit.centroid
                ? ` · ${sit.centroid.lat.toFixed(3)}, ${sit.centroid.lon.toFixed(3)}`
                : ""}
              {savedModel.linked.length
                ? ` · ${savedModel.linked.length} linked: ${savedModel.linked
                    .slice(0, 5)
                    .map((o) => o.id)
                    .join(", ")}`
                : ""}
            </p>
          </div>
        )}
        {band("hyp", "Possible explanations", savedModel.explanations.length)}
        {open === "hyp" && coaCards(savedModel.explanations)}
        {band("act", "Recommended actions", savedModel.actions.length)}
        {open === "act" && coaCards(savedModel.actions)}
      </div>
    </div>
  );
}
