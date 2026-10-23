// The Reports app under the Slate scheme: the Europa copy
// (gotham/europa/features.html, E1-E15) wired to the live routes. Ten pages,
// each the copy's own crop of the 1920x1080 frame scaled to the surface: chat,
// Gaia home, the Gaia map, the slides editor, two presentation slides, the
// link graph, the data lineage and the simulation globe in two states. Pages
// link to each other through the copy's own chrome (title bar logos, thumbnail
// tabs, the rail, slide thumbnails and pager); the Gaia "Reports" tab and
// "Case export" open the Reports app this surface replaced.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as Cesium from "cesium";
import { ErrorBoundary } from "../../../shell/ErrorBoundary.js";
import { ReportsApp } from "../../../reports/ReportsApp.js";
import { FR } from "./ui.js";
import {
  INC_QUERIES,
  SAT_BBOX,
  chokesOf,
  fetchJson,
  incidentsOf,
  planPasses,
  profileVessel,
  unavailable,
  useJson,
  withPx,
  type Evid,
  type FC,
  type FSummary,
  type Incident,
  type Lineage,
  type Omm,
  type OntoObj,
  type Plan,
  type Res,
  type SweepAoi,
  type Vessel,
} from "./data.js";
import { ChatFrame } from "./Chat.js";
import { GaiaFrame } from "./Gaia.js";
import { GaiaMapFrame, type Page } from "./SatMap.js";
import { Present1, Present2, SlidesFrame, type Sanctions } from "./Slides.js";
import { GraphFrame } from "./Graph.js";
import { LineageFrame } from "./Lineage.js";
import { MetaFrame, type Mark } from "./Meta.js";
import "./europa.css";

type Crop = [number, number, number, number];
const CHAT: Crop = [766, 279, 1100, 631];
const MAP: Crop = [730, 273, 1140, 641];
const CROP: Record<Page, Crop> = {
  chat: CHAT,
  gaia: CHAT,
  map: MAP,
  slides: MAP,
  present1: MAP,
  present2: [713, 273, 1140, 641],
  graph: [720, 255, 690, 535],
  lineage: [0, 0, 1920, 1080],
  globe: [507, 162, 905, 510],
  ring: [507, 162, 905, 510],
};
const on = (p: Page, ...ps: Page[]): boolean => ps.includes(p);

export function EuropaApp({ viewer, initial = "gaia" }: { viewer: Cesium.Viewer | null; initial?: Page }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<Page | "reports">(initial);
  const [k, setK] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [drawer, setDrawer] = useState(true);
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const p: Page = page === "reports" ? "gaia" : page;
  const [x0, y0, W, H] = CROP[p];
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const fit = (): void => setK(Math.min(el.clientWidth / W, el.clientHeight / H));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page, W, H]);

  // routes, each pulled only by the pages that read it
  const ch = useJson<unknown>("/api/collab/channels");
  const chatWhy = `Broadcast needs a chat channel: ${unavailable("Chat", ch)}`;
  const ev = useJson<{ props: Evid }[]>("/api/evidence", nonce);
  const evid = useMemo(() => (ev?.data ?? []).map((x) => x.props), [ev]);
  const chokeRes = useJson<FC<never>>(on(p, "gaia", "globe", "ring") ? "/api/maritime/chokepoints" : null);
  const chokes = useMemo(() => chokesOf(chokeRes?.data ?? null), [chokeRes]);
  const warnRes = useJson<FC<{ msgYear: number }>>(p === "gaia" ? "/api/maritime/warnings" : null);
  const adsb = useJson<FC<{ on_ground?: boolean }>>(p === "gaia" ? "/api/adsb/global" : null);
  const vRes = useJson<{ vessels: Vessel[] }>(
    on(p, "map", "slides", "present2") ? `/api/maritime/vessels?bbox=${SAT_BBOX.join(",")}&limit=2000` : null,
    nonce,
  );
  const vs = useMemo(() => withPx(vRes?.data?.vessels ?? []), [vRes]);
  const pv = useMemo(() => profileVessel(vs), [vs]);
  const sanc = useJson<Sanctions>(p === "present2" && pv ? `/api/sanctions/lookup?mmsi=${pv.mmsi}&name=${encodeURIComponent(pv.name ?? "")}` : null);
  const briefs = useJson<{ briefs?: unknown[] }>(on(p, "map", "slides") ? "/api/watch-officer/briefs" : null);
  const linRes = useJson<Lineage>(p === "lineage" ? "/api/foundry/lineage" : null);
  const fsRes = useJson<FSummary>(p === "lineage" ? "/api/foundry/summary" : null);
  const sweepRes = useJson<{ aois: SweepAoi[] }>(on(p, "globe", "ring") ? "/api/intel/sar/sweep" : null);
  const quakeRes = useJson<FC<{ place: string; mag: number }>>(on(p, "globe", "ring") ? "/api/seismic/emsc" : null);

  const warns = useMemo(
    () =>
      (warnRes?.data?.features ?? [])
        .filter((f) => f.geometry)
        .map((f) => ({ y: f.properties.msgYear, lon: f.geometry!.coordinates[0]!, lat: f.geometry!.coordinates[1]! })),
    [warnRes],
  );
  const aircraft = useMemo(() => {
    const fs = adsb?.data?.features ?? [];
    const step = Math.max(1, Math.floor(fs.length / 400));
    return fs.filter((f, i) => i % step === 0 && f.geometry && !f.properties.on_ground).map((f) => [f.geometry!.coordinates[0]!, f.geometry!.coordinates[1]!] as [number, number]);
  }, [adsb]);
  const quakes: Mark[] = useMemo(
    () => (quakeRes?.data?.features ?? []).filter((f) => f.geometry).map((f) => ({ lon: f.geometry!.coordinates[0]!, lat: f.geometry!.coordinates[1]!, name: `quake M${f.properties.mag} ${f.properties.place}` })),
    [quakeRes],
  );

  // E10: the twelve ontology searches the copy's builder ran
  const [inc, setInc] = useState<{ all: Incident[]; done: number; status: string | null }>({ all: [], done: 0, status: null });
  useEffect(() => {
    if (p !== "graph") return;
    let live = true;
    const lists: (OntoObj[] | null)[] = [];
    let failed: Res<unknown> | null = null;
    void Promise.all(
      INC_QUERIES.map((q) =>
        fetchJson<OntoObj[]>(`/api/ontology/search?q=${encodeURIComponent(q)}&limit=100`).then((r) => {
          lists.push(r.data);
          if (!r.ok) failed = r;
          if (live) setInc({ all: incidentsOf(lists).inc, done: lists.length, status: null });
        }),
      ),
    ).then(() => {
      if (live) setInc({ all: incidentsOf(lists).inc, done: lists.length, status: failed ? unavailable("Ontology search", failed) : null });
    });
    return () => {
      live = false;
    };
  }, [p]);

  // E12-E15: SGP4 over the active catalogue, off the first paint
  const [gpRun, setGpRun] = useState(0);
  const [gp, setGp] = useState<{ res: Res<{ items?: Omm[]; count?: number }> | null; plan: Plan | null }>({ res: null, plan: null });
  useEffect(() => {
    if (!on(p, "globe", "ring")) return;
    let live = true;
    void fetchJson<{ items?: Omm[]; count?: number }>("/api/space/gp?group=active&limit=20000", gpRun > 0).then((res) => {
      if (!live) return;
      if (!res.ok) return setGp({ res, plan: null });
      setTimeout(() => live && setGp({ res, plan: planPasses(res.data?.items ?? [], now) }), 0);
    });
    return () => {
      live = false;
    };
  }, [p, gpRun, now]);

  if (page === "reports")
    return (
      <div className="absolute inset-0 z-(--z-overlay) flex flex-col bg-bg-0">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-2 bg-bg-1 px-3">
          <button type="button" className="text-[12px] text-accent" onClick={() => setPage("gaia")}>
            Gaia home
          </button>
          <span className="text-[12px] text-txt-3">· Reports</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto csl2-app-measure">
          <ReportsApp viewer={viewer} />
        </div>
      </div>
    );

  const go = (to: Page): void => setPage(to);
  const reload = (): void => setNonce((n) => n + 1);
  const briefsN = briefs?.ok ? (briefs.data?.briefs?.length ?? 0) : null;
  const sweep = sweepRes?.data?.aois.find((a) => a.aoi === "hormuz") ?? null;
  let body: JSX.Element;
  switch (p) {
    case "chat":
      body = <ChatFrame ch={ch} toGaia={() => go("gaia")} />;
      break;
    case "gaia":
      body = <GaiaFrame ev={ev} chokes={chokes} chokeRes={chokeRes} warns={warns} aircraft={aircraft} toMap={() => go("map")} toChat={() => go("chat")} toReports={() => setPage("reports")} />;
      break;
    case "map":
      body = <GaiaMapFrame vs={vs} vRes={vRes} ev={evid} briefsN={briefsN} drawer={drawer} setDrawer={setDrawer} reload={reload} go={go} />;
      break;
    case "slides":
      body = <SlidesFrame vs={vs} pv={pv} ev={evid} briefsN={briefsN} now={now} go={go} />;
      break;
    case "present1":
      body = <Present1 ev={evid} evRes={ev} now={now} go={go} chatWhy={chatWhy} />;
      break;
    case "present2":
      body = <Present2 pv={pv} vRes={vRes} sanc={sanc} go={go} chatWhy={chatWhy} />;
      break;
    case "graph":
      body = <GraphFrame all={inc.all} done={inc.done} total={INC_QUERIES.length} status={inc.status} go={() => go("gaia")} />;
      break;
    case "lineage":
      body = <LineageFrame lin={linRes?.data ?? null} linRes={linRes} fs={fsRes?.data ?? null} go={go} />;
      break;
    default:
      body = (
        <MetaFrame
          state={p === "ring" ? "ring" : "globe"}
          setState={(s) => go(s)}
          plan={gp.plan}
          gpRes={gp.res}
          gpTotal={gp.res?.data?.count ?? gp.res?.data?.items?.length ?? null}
          sweep={sweep}
          sweepRes={sweepRes}
          chokes={chokes}
          quakes={quakes}
          now={now}
          rerun={() => {
            setGp({ res: null, plan: null });
            setGpRun((n) => n + 1);
          }}
          go={() => go("gaia")}
        />
      );
  }
  return (
    <div className="sl-eu" ref={host} data-page={p}>
      <ErrorBoundary label="Reports">
        <div className="copy" style={{ width: W, height: H, position: "relative", overflow: "hidden", zoom: k, background: "#0b1018", border: "1px solid #2b353b", boxSizing: "content-box" }}>
          {FR(x0, y0, body)}
        </div>
      </ErrorBoundary>
    </div>
  );
}
