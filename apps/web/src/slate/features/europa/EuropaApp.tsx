// The Reports app under the Slate scheme: the Europa copy
// (gotham/europa/features.html, E1-E15) wired to the live routes. Ten pages,
// all native reflowing layouts: the Gaia home, chat, map, the slides editor, two
// presentation slides, the link graph, the data lineage and the simulation
// globe in two states. Pages link to each other through their toolbar (Gaia
// home, the page switcher, the slide pager); the Gaia "Reports" tab and "Case
// export" open the Reports app this surface replaced.
import { useEffect, useMemo, useState } from "react";
import type * as Cesium from "cesium";
import { ErrorBoundary } from "../../../shell/ErrorBoundary.js";
import { ReportsApp } from "../../../reports/ReportsApp.js";
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
import { ChatPage } from "./Chat.js";
import { GaiaFrame } from "./Gaia.js";
import { MapPage, type Page } from "./SatMap.js";
import { Present1, Present2, SlidesPage, type Sanctions } from "./Slides.js";
import { GraphPage } from "./Graph.js";
import { LineagePage } from "./Lineage.js";
import { SimPage, type Mark } from "./Meta.js";

const on = (p: Page, ...ps: Page[]): boolean => ps.includes(p);

export function EuropaApp({
  viewer,
  initial = "gaia",
}: {
  viewer: Cesium.Viewer | null;
  initial?: Page;
}): JSX.Element {
  const [page, setPage] = useState<Page | "reports">(initial);
  const [nonce, setNonce] = useState(0);
  const [drawer, setDrawer] = useState(true);
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const p: Page = page === "reports" ? "gaia" : page;

  // routes, each pulled only by the pages that read it
  const ch = useJson<unknown>("/api/collab/channels");
  const chatWhy = `Broadcast needs a chat channel: ${unavailable("Chat", ch)}`;
  const ev = useJson<{ props: Evid }[]>("/api/evidence", nonce);
  const evid = useMemo(() => (ev?.data ?? []).map((x) => x.props), [ev]);
  const chokeRes = useJson<FC<never>>(
    on(p, "gaia", "globe", "ring") ? "/api/maritime/chokepoints" : null,
  );
  const chokes = useMemo(() => chokesOf(chokeRes?.data ?? null), [chokeRes]);
  const warnRes = useJson<FC<{ msgYear: number }>>(
    p === "gaia" ? "/api/maritime/warnings" : null,
  );
  const adsb = useJson<FC<{ on_ground?: boolean }>>(
    p === "gaia" ? "/api/adsb/global" : null,
  );
  const vRes = useJson<{ vessels: Vessel[] }>(
    on(p, "map", "slides", "present2")
      ? `/api/maritime/vessels?bbox=${SAT_BBOX.join(",")}&limit=2000`
      : null,
    nonce,
  );
  const vs = useMemo(() => withPx(vRes?.data?.vessels ?? []), [vRes]);
  const pv = useMemo(() => profileVessel(vs), [vs]);
  const sanc = useJson<Sanctions>(
    p === "present2" && pv
      ? `/api/sanctions/lookup?mmsi=${pv.mmsi}&name=${encodeURIComponent(pv.name ?? "")}`
      : null,
  );
  const briefs = useJson<{ briefs?: unknown[] }>(
    on(p, "map", "slides") ? "/api/watch-officer/briefs" : null,
  );
  const linRes = useJson<Lineage>(
    p === "lineage" ? "/api/foundry/lineage" : null,
  );
  const fsRes = useJson<FSummary>(
    p === "lineage" ? "/api/foundry/summary" : null,
  );
  const sweepRes = useJson<{ aois: SweepAoi[] }>(
    on(p, "globe", "ring") ? "/api/intel/sar/sweep" : null,
  );
  const quakeRes = useJson<FC<{ place: string; mag: number }>>(
    on(p, "globe", "ring") ? "/api/seismic/emsc" : null,
  );

  const warns = useMemo(
    () =>
      (warnRes?.data?.features ?? [])
        .filter((f) => f.geometry)
        .map((f) => ({
          y: f.properties.msgYear,
          lon: f.geometry!.coordinates[0]!,
          lat: f.geometry!.coordinates[1]!,
        })),
    [warnRes],
  );
  const aircraft = useMemo(() => {
    const fs = adsb?.data?.features ?? [];
    const step = Math.max(1, Math.floor(fs.length / 400));
    return fs
      .filter((f, i) => i % step === 0 && f.geometry && !f.properties.on_ground)
      .map(
        (f) =>
          [f.geometry!.coordinates[0]!, f.geometry!.coordinates[1]!] as [
            number,
            number,
          ],
      );
  }, [adsb]);
  const quakes: Mark[] = useMemo(
    () =>
      (quakeRes?.data?.features ?? [])
        .filter((f) => f.geometry)
        .map((f) => ({
          lon: f.geometry!.coordinates[0]!,
          lat: f.geometry!.coordinates[1]!,
          name: `quake M${f.properties.mag} ${f.properties.place}`,
        })),
    [quakeRes],
  );

  // E10: the twelve ontology searches the copy's builder ran
  const [inc, setInc] = useState<{
    all: Incident[];
    done: number;
    status: string | null;
  }>({ all: [], done: 0, status: null });
  useEffect(() => {
    if (p !== "graph") return;
    let live = true;
    const lists: (OntoObj[] | null)[] = [];
    let failed: Res<unknown> | null = null;
    void Promise.all(
      INC_QUERIES.map((q) =>
        fetchJson<OntoObj[]>(
          `/api/ontology/search?q=${encodeURIComponent(q)}&limit=100`,
        ).then((r) => {
          lists.push(r.data);
          if (!r.ok) failed = r;
          if (live)
            setInc({
              all: incidentsOf(lists).inc,
              done: lists.length,
              status: null,
            });
        }),
      ),
    ).then(() => {
      if (live)
        setInc({
          all: incidentsOf(lists).inc,
          done: lists.length,
          status: failed ? unavailable("Ontology search", failed) : null,
        });
    });
    return () => {
      live = false;
    };
  }, [p]);

  // E12-E15: SGP4 over the active catalogue, off the first paint
  const [gpRun, setGpRun] = useState(0);
  const [gp, setGp] = useState<{
    res: Res<{ items?: Omm[]; count?: number }> | null;
    plan: Plan | null;
  }>({ res: null, plan: null });
  useEffect(() => {
    if (!on(p, "globe", "ring")) return;
    let live = true;
    void fetchJson<{ items?: Omm[]; count?: number }>(
      "/api/space/gp?group=active&limit=20000",
      gpRun > 0,
    ).then((res) => {
      if (!live) return;
      if (!res.ok) return setGp({ res, plan: null });
      setTimeout(
        () =>
          live && setGp({ res, plan: planPasses(res.data?.items ?? [], now) }),
        0,
      );
    });
    return () => {
      live = false;
    };
  }, [p, gpRun, now]);

  if (page === "reports")
    return (
      <div className="absolute inset-0 z-(--z-overlay) flex flex-col bg-bg-0">
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
      body = <ChatPage ch={ch} toGaia={() => go("gaia")} />;
      break;
    case "gaia":
      body = (
        <GaiaFrame
          ev={ev}
          chokes={chokes}
          chokeRes={chokeRes}
          warns={warns}
          aircraft={aircraft}
          toMap={() => go("map")}
          toChat={() => go("chat")}
          toReports={() => setPage("reports")}
          reload={reload}
        />
      );
      break;
    case "map":
      body = (
        <MapPage
          vs={vs}
          vRes={vRes}
          ev={evid}
          briefsN={briefsN}
          drawer={drawer}
          setDrawer={setDrawer}
          reload={reload}
          go={go}
        />
      );
      break;
    case "slides":
      body = <SlidesPage vs={vs} pv={pv} ev={evid} briefsN={briefsN} go={go} />;
      break;
    case "present1":
      body = (
        <Present1 ev={evid} evRes={ev} now={now} go={go} chatWhy={chatWhy} />
      );
      break;
    case "present2":
      body = (
        <Present2 pv={pv} vRes={vRes} sanc={sanc} go={go} chatWhy={chatWhy} />
      );
      break;
    case "graph":
      body = (
        <GraphPage
          all={inc.all}
          done={inc.done}
          total={INC_QUERIES.length}
          status={inc.status}
          go={go}
        />
      );
      break;
    case "lineage":
      body = (
        <LineagePage
          lin={linRes?.data ?? null}
          linRes={linRes}
          fs={fsRes?.data ?? null}
          go={go}
        />
      );
      break;
    default:
      body = (
        <SimPage
          state={p === "ring" ? "ring" : "globe"}
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
          go={go}
        />
      );
  }
  return <ErrorBoundary label="Reports">{body}</ErrorBoundary>;
}
