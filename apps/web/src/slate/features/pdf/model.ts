// One model for every section of the copy: the routes the builder snapshotted
// (fetch_live in _build_gotham_a.py), read once per open, and the selection.
import { useMemo, useState } from "react";
import {
  PORTS, chokesOf, gulfWarnings, placeFor, portsOf, results, series, shown, useJson, useVessels,
  type Alert, type Choke, type Evidence, type Fix, type Hit, type Port, type Res, type Rule, type Sanc,
  type Standing, type Status, type Vessel, type Warning, type Watch,
} from "./data.js";

export type Page = "explorer" | "browser" | "cov" | "chat" | "inbox" | "slides" | "dossier" | "menubar" | "graph2" | "timeline" | "gaia" | "video";

export interface Ctx {
  go: (p: Page) => void;
  kw: string;
  setKw: (s: string) => void;
  box: Vessel[];
  boxRes: Res<unknown> | null;
  status: Status | null;
  ports: Port[];
  place: Place;
  res: Hit[];
  list: Hit[];
  sel: Hit | null;
  pick: (mmsi: number) => void;
  alerts: Alert[];
  standing: Standing | null;
  rules: Rule[];
  evidence: Evidence[];
  warnings: Warning[];
  warnRes: Res<unknown> | null;
  chokes: Choke[];
  briefs: unknown[];
  watch: Watch | null;
  entity: { flag_country?: string | null } | null;
  sanc: Sanc | null;
  sancRes: Res<Sanc> | null;
  fixes: Fix[];
  tick: number;
  now: number;
}
type Place = Port | null;

export function useModel(go: (p: Page) => void): Ctx {
  const { res: boxR, tick } = useVessels();
  const st = useJson<Status>("/api/status");
  const pr = useJson<Parameters<typeof portsOf>[0]>(PORTS);
  const al = useJson<{ alerts: Alert[] }>("/api/alerts");
  const sd = useJson<Standing>("/api/alerts/standing");
  const ru = useJson<Rule[]>("/api/alerts/rules");
  const ev = useJson<Evidence[]>("/api/evidence");
  const wa = useJson<{ features: Warning[] }>("/api/maritime/warnings");
  const ch = useJson<Parameters<typeof chokesOf>[0]>("/api/maritime/chokepoints");
  const br = useJson<{ briefs: unknown[] }>("/api/watch-officer/briefs");
  const wt = useJson<Watch>("/api/intel/watch");
  const [kw, setKw] = useState("Al Hamriyah");
  const [selM, setSelM] = useState<number | null>(null);

  const box = useMemo(() => boxR?.data?.vessels ?? [], [boxR]);
  const ports = useMemo(() => portsOf(pr?.data), [pr]);
  const place = useMemo(() => placeFor(ports, kw), [ports, kw]);
  const res = useMemo(() => (place ? results(box, place) : []), [box, place]);
  // the default object is the nearest hit; the list keeps the copy's order
  // (selected third) for that default, so a click only moves the highlight
  const list = useMemo(() => shown(res, res[0] ?? null), [res]);
  const sel = (selM !== null ? res.find((r) => r.mmsi === selM) : undefined) ?? res[0] ?? null;
  const ent = useJson<{ flag_country?: string | null }>(sel ? `/api/entity/vessel:${sel.mmsi}` : null);
  const sc = useJson<Sanc>(sel ? `/api/sanctions/lookup?mmsi=${sel.mmsi}` : null);
  const hi = useJson<{ tracks: { points: number[][] }[] }>(
    sel ? `/api/history/track?id=vessel:${sel.mmsi}&limit=500` : null,
  );
  const fixes = useMemo(
    () => (sel ? series(sel.mmsi, hi?.data?.tracks?.[0]?.points ?? []) : []),
    // tick: the recorder appended a poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel?.mmsi, hi, tick],
  );
  return {
    go,
    kw,
    setKw: (s) => {
      setKw(s);
      setSelM(null);
    },
    box,
    boxRes: boxR,
    status: st?.data ?? null,
    ports,
    place,
    res,
    list,
    sel,
    pick: setSelM,
    alerts: al?.data?.alerts ?? [],
    standing: sd?.data ?? null,
    rules: ru?.data ?? [],
    evidence: ev?.data ?? [],
    warnings: gulfWarnings(wa?.data?.features ?? []),
    warnRes: wa,
    chokes: chokesOf(ch?.data),
    briefs: br?.data?.briefs ?? [],
    watch: wt?.data ?? null,
    entity: ent?.data ?? null,
    sanc: sc?.data ?? null,
    sancRes: sc,
    fixes,
    tick,
    now: Date.now() / 1000,
  };
}
