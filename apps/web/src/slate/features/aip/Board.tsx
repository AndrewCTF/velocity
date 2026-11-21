// Target board: features A60-A64, as a native layout. /api/targets/board needs
// a sign-in, so the cards are the real watch items (gotham/_kit/watch_items.py
// ported to dataB.watchItems over the live routes), placed in the real
// targets.py stage columns by the builder's recorded rule (STAGE_OF).
// Approvals = /api/actions/proposals, Enabled rules = /api/alerts/rules,
// Evidence items = /api/evidence. "Send to" lists the real outputs:
// /api/export (GeoJSON, CSV), /api/report/pptx and the alert-rule channels.
import { useState } from "react";
import { apiFetch } from "../../../transport/http.js";
import { Chip, Ico, type FoundryNav } from "./pg.js";
import { DkPage, cnt } from "./dk.js";
import {
  unavailable,
  useJson,
  type FC,
  type SarFC,
  type SancP,
} from "./data.js";
import {
  KIND_GROUP,
  SAR_AOIS,
  STAGE_OF,
  mgrs,
  watchItems,
  type Rule,
  type WItem,
  type WatchSrc,
} from "./dataB.js";

export const COLS: [string, string][] = [
  ["CONFIRM", "#c8a46a"],
  ["ATTACH INTEL", "#e8cd6a"],
  ["APPROVALS", "#c490e0"],
  ["ASSESS", "#e0605a"],
  ["COMPLETE", "#a8aeb6"],
];
const RULE_KIND: Record<WItem["kind"], string> = {
  sar: "dark_vessel",
  jam: "jamming",
  quake: "quake",
  choke: "loiter",
  ofac: "ais_gap",
  nga: "incident",
};
const OUTCOMES = [
  "Confirmed",
  "Likely",
  "Reclassified",
  "Not observed",
  "Mismatch",
  "Undetermined",
];
const SEND = [
  "GeoJSON - Current picture",
  "CSV - Current picture",
  "PPTX - Case report",
  "Alert rule - In-app",
  "Alert rule - Discord",
  "Alert rule - Webhook",
];
const cardId = (it: WItem): string => "#" + it.id;

/** The items of one stage column grouped by kind, the biggest group first. */
export function stageGroups(
  items: WItem[],
  stage: number,
): [string, WItem[]][] {
  const by = new Map<string, WItem[]>();
  for (const it of items)
    if (STAGE_OF[it.kind] === stage)
      by.set(KIND_GROUP[it.kind], [...(by.get(KIND_GROUP[it.kind]) ?? []), it]);
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
}

async function download(
  path: string,
  init: RequestInit | undefined,
  name: string,
): Promise<string> {
  try {
    const r = await apiFetch(path, init);
    if (!r.ok) return `${name} failed (HTTP ${r.status})`;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return `${name} downloaded`;
  } catch {
    return `${name} failed (network error)`;
  }
}

export function useWatch(): { items: WItem[]; loading: boolean } {
  type SarR = SarFC & { summary: { date: string; label: string } };
  const sar = [
    useJson<SarR>(`/api/intel/dark-vessels/sar?aoi=${SAR_AOIS[0]}`),
    useJson<SarR>(`/api/intel/dark-vessels/sar?aoi=${SAR_AOIS[1]}`),
    useJson<SarR>(`/api/intel/dark-vessels/sar?aoi=${SAR_AOIS[2]}`),
    useJson<SarR>(`/api/intel/dark-vessels/sar?aoi=${SAR_AOIS[3]}`),
  ];
  const choke = useJson<WatchSrc["choke"]>("/api/maritime/chokepoints");
  const jam = useJson<WatchSrc["jam"]>("/api/jamming/nacp");
  const quake = useJson<WatchSrc["quake"]>(
    "/api/seismic/emsc?minmag=2.5&hours=24",
  );
  const warn = useJson<WatchSrc["warn"]>("/api/maritime/warnings");
  const sanc = useJson<FC<SancP>>("/api/sanctions/vessels");
  const [now] = useState(() => Date.now() / 1000);
  const loading = [...sar, choke, jam, quake, warn, sanc].some(
    (r) => r === null,
  );
  const items = watchItems({
    sar: sar
      .map((r) => r?.data)
      .filter((x): x is NonNullable<typeof x> => !!x) as WatchSrc["sar"],
    choke: choke?.data ?? null,
    jam: jam?.data ?? null,
    quake: quake?.data ?? null,
    warn: warn?.data ?? null,
    sanc: sanc?.data ?? null,
    now,
  });
  return { items, loading };
}

function Marker({ it }: { it: WItem }): JSX.Element {
  return (
    <span
      className={`bd-mark ${it.shape}`}
      style={{ borderColor: it.color }}
      aria-hidden
    >
      <Ico n={it.icon} size={14} />
    </span>
  );
}

function RuleDialog({
  it,
  channel,
  onClose,
}: {
  it: WItem;
  channel: string;
  onClose: () => void;
}): JSX.Element {
  const rows: [string, string][] = [
    ["Channel", channel],
    ["Rule kind", RULE_KIND[it.kind]],
    ["Item number", it.id],
    ["MGRS", mgrs(it.ll[1], it.ll[0])],
    ["Latitude", it.ll[1].toFixed(5)],
    ["Longitude", it.ll[0].toFixed(5)],
  ];
  return (
    <div
      className="dk-over"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dk-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={`Alert rule: ${channel}`}
      >
        <h3>
          Alert rule: {channel}
          <span className="pg-fill" />
          <button
            type="button"
            className="pg-btn sq flat"
            aria-label="Close the form"
            onClick={onClose}
          >
            <Ico n="cross" />
          </button>
        </h3>
        <dl className="pg-kv dk-pad">
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="pg-mut pg-sm dk-pad" style={{ margin: 0 }}>
          Preview only: nothing is created from this form.
        </p>
      </div>
    </div>
  );
}

type Tab = "Overview" | "Assessment";
type St =
  | { v: "board" }
  | { v: "target"; it: WItem; tab: Tab; send: boolean }
  | { v: "rule"; it: WItem; channel: string };

export function BoardView({
  nav,
}: {
  nav: (v: FoundryNav) => void;
}): JSX.Element {
  const { items, loading } = useWatch();
  const rules = useJson<Rule[]>("/api/alerts/rules");
  const prop = useJson<unknown[]>("/api/actions/proposals");
  const evid =
    useJson<{ props?: { title?: string; source_context?: string } }[]>(
      "/api/evidence",
    );
  const board = useJson<unknown[]>("/api/targets/board");
  const [st, setSt] = useState<St>({ v: "board" });
  const [outcome, setOutcome] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const n = (
    r: { ok: boolean; data: unknown[] | null } | null,
  ): number | null => (r?.ok && r.data ? r.data.length : null);
  const nProp = n(prop);
  const boardWhy = board?.ok
    ? "Moves run on the target board"
    : unavailable("Target board", board);
  const sel = st.v === "target" ? st.it : null;
  const open = (it: WItem): void =>
    setSt({ v: "target", it, tab: "Overview", send: false });
  const evFor = (it: WItem): number =>
    (evid?.data ?? []).filter((e) =>
      JSON.stringify(e).includes(it.ref || it.id),
    ).length;

  const send = (it: WItem, i: number): void => {
    const bbox = "bbox=32,10,62,31";
    if (i === 0)
      void download(
        `/api/export?fmt=geojson&kinds=vessel&${bbox}`,
        undefined,
        "velocity-export.geojson",
      ).then(setMsg);
    else if (i === 1)
      void download(
        `/api/export?fmt=csv&kinds=vessel&${bbox}`,
        undefined,
        "velocity-export.csv",
      ).then(setMsg);
    else if (i === 2)
      void download(
        "/api/report/pptx",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: `${cardId(it)} ${it.title}`,
            alerts: items.slice(0, 12).map((x) => `${cardId(x)} ${x.title}`),
            sources: [it.link],
          }),
        },
        "case-report.pptx",
      ).then(setMsg);
    else
      setSt({
        v: "rule",
        it,
        channel: ["inapp", "discord", "webhook"][i - 3]!,
      });
  };

  return (
    <DkPage here="board" nav={nav} cls="bd">
      <div className="pg-bar">
        {(
          [
            ["comment", "Enabled rules", n(rules)],
            ["person", "Proposals", nProp],
            ["shield", "Evidence items", n(evid)],
          ] as const
        ).map(([ic, lab, v]) => (
          <Chip key={lab}>
            <Ico n={ic} size={14} />
            {lab} {cnt(v)}
          </Chip>
        ))}
        <span className="pg-fill" />
        <button
          type="button"
          className="pg-btn"
          aria-label="Open the map"
          onClick={() => nav("map")}
        >
          <Ico n="globe" /> Map
        </button>
      </div>
      <div className="bd-body">
        <div className="bd-cols">
          {COLS.map(([name, col], ci) => {
            const grs = ci < 2 ? stageGroups(items, ci) : [];
            const total =
              ci < 2
                ? grs.reduce((a, [, v]) => a + v.length, 0)
                : ci === 2
                  ? nProp
                  : null;
            return (
              <section key={name} className="bd-col" aria-label={name}>
                <h3>
                  <span
                    className="bd-dia"
                    style={{ background: col }}
                    aria-hidden
                  />
                  {name}
                  <span className="pg-fill" />
                  <span
                    className="pg-chip"
                    title={
                      total === null && ci > 2
                        ? "Needs the target board, which needs a sign-in"
                        : undefined
                    }
                  >
                    {cnt(total)}
                  </span>
                </h3>
                <div className="bd-list">
                  {grs.map(([gn, its]) => (
                    <div key={gn}>
                      <div className="bd-grp">
                        <span>{gn}</span>
                        <span>{its.length}</span>
                      </div>
                      {its.slice(0, 40).map((it) => (
                        <button
                          key={it.id}
                          type="button"
                          className="bd-card"
                          aria-label={`Open ${cardId(it)}`}
                          aria-pressed={sel?.id === it.id}
                          onClick={() => open(it)}
                        >
                          <Marker it={it} />
                          <span className="bd-title">
                            <span className="pg-mut">{cardId(it)} /</span>{" "}
                            {it.title}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {ci < 2 && !grs.length && (
                    <p className="pg-note">
                      {loading
                        ? "Loading watch items"
                        : "No watch item in the region from the live routes"}
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
        {st.v === "target" && (
          <aside className="bd-panel" aria-label="Target">
            <div className="bd-phead">
              <Marker it={st.it} />
              <div className="pg-fill">
                <b>
                  <span className="pg-mut">{cardId(st.it)} /</span>{" "}
                  {st.it.title}
                </b>
                <div className="pg-sm pg-mut">
                  {st.it.link.replace("·", "-")}
                </div>
              </div>
              <div className="bd-pop">
                <button
                  type="button"
                  className="pg-btn sq"
                  aria-label="Send to"
                  aria-expanded={st.send}
                  onClick={() => {
                    setMsg(null);
                    setSt({ ...st, send: !st.send });
                  }}
                >
                  <Ico n="share" />
                </button>
                {st.send && (
                  <>
                    <button
                      type="button"
                      className="dk-away"
                      aria-label="Close the menu"
                      onClick={() => setSt({ ...st, send: false })}
                    />
                    <div className="bd-menu" role="menu" aria-label="Send to">
                      <div className="pg-sm pg-mut">
                        Export or alert rule (GeoJSON, CSV or alert channel)
                      </div>
                      {SEND.map((t, i) => (
                        <button
                          key={t}
                          type="button"
                          role="menuitem"
                          className="bd-mi"
                          onClick={() => send(st.it, i)}
                        >
                          {t}
                        </button>
                      ))}
                      {msg && (
                        <div className="pg-sm" role="status">
                          {msg}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
              <button
                type="button"
                className="pg-btn sq"
                aria-label="Close the target"
                onClick={() => setSt({ v: "board" })}
              >
                <Ico n="cross" />
              </button>
            </div>
            <div className="bd-tabs" role="tablist">
              {[
                "Overview",
                "Details",
                "Location",
                "Intelligence",
                "Evidence",
                "Approvals",
                "Assessment",
              ].map((lab) => {
                const live = lab === "Overview" || lab === "Assessment";
                return (
                  <button
                    key={lab}
                    type="button"
                    role="tab"
                    aria-selected={lab === st.tab}
                    disabled={!live}
                    title={
                      live
                        ? undefined
                        : "This tab reads the target board, which needs a sign-in"
                    }
                    onClick={
                      live ? () => setSt({ ...st, tab: lab as Tab }) : undefined
                    }
                  >
                    {lab}
                  </button>
                );
              })}
            </div>
            <div className="bd-pbody">
              {st.tab === "Overview" ? (
                <>
                  <dl className="pg-kv">
                    <dt>Priority</dt>
                    <dd>—</dd>
                    <dt>Location</dt>
                    <dd>{mgrs(st.it.ll[1], st.it.ll[0])}</dd>
                    <dt>Linked entity</dt>
                    <dd>—</dd>
                    <dt>Assigned to</dt>
                    <dd>Unassigned</dd>
                    <dt>Details</dt>
                    <dd>
                      {st.it.kind === "sar"
                        ? "SAR candidate"
                        : st.it.title.split(",")[0]}
                    </dd>
                    <dt>Evidence</dt>
                    <dd>
                      {evid?.ok
                        ? evFor(st.it)
                          ? `${evFor(st.it)} attached`
                          : "None attached"
                        : unavailable("Evidence", evid)}
                    </dd>
                  </dl>
                  <button
                    type="button"
                    className="pg-btn pri"
                    disabled
                    title={boardWhy}
                  >
                    Move to{" "}
                    {COLS[STAGE_OF[st.it.kind] + 1]![0].charAt(0) +
                      COLS[STAGE_OF[st.it.kind] + 1]![0].slice(1).toLowerCase()}
                  </button>
                </>
              ) : (
                <>
                  <b>Conduct review</b>
                  <span className="pg-mut pg-sm">
                    Document the review result
                  </span>
                  <label className="pg-sm pg-mut" htmlFor="bd-outcome">
                    Review outcome
                  </label>
                  <select
                    id="bd-outcome"
                    className="pg-in"
                    aria-label="Review outcome"
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value)}
                  >
                    <option value="">Select an outcome</option>
                    {OUTCOMES.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="pg-btn pri"
                    disabled
                    title="No review store exists on this box; nothing is submitted"
                  >
                    Submit review
                  </button>
                </>
              )}
            </div>
          </aside>
        )}
      </div>
      {st.v === "rule" && (
        <RuleDialog
          it={st.it}
          channel={st.channel}
          onClose={() =>
            setSt({ v: "target", it: st.it, tab: "Assessment", send: false })
          }
        />
      )}
    </DkPage>
  );
}
