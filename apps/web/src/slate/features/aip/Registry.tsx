// Registry Watch Manager as a native layout over the real sanctions registry
// (/api/sanctions/vessels). Priority = number of sanction programs (1 Low,
// 2 Medium, 3+ High); status from parked/sog. The drawer's actions and the
// modal's Confirm are the real governed actions (POST /api/actions/{name}).
import { useState, type ReactNode } from "react";
import { apiFetch } from "../../../transport/http.js";
import { Chip, Ico, PageNav, type FoundryNav } from "./pg.js";
import type { Rule } from "./dataB.js";
import {
  comma,
  counter,
  dmy,
  inWatchRegion,
  prio,
  sancRows,
  tsFmt,
  unavailable,
  useJson,
  type FC,
  type Guardrails,
  type Prio,
  type Sanc,
  type SancP,
  type VStatus,
} from "./data.js";

const P_TONE: Record<Prio, "ok" | "warn" | "bad"> = {
  Low: "ok",
  Medium: "warn",
  High: "bad",
};
const S_TONE: Record<VStatus, "ok" | "info" | "warn"> = {
  Parked: "ok",
  Underway: "info",
  Slow: "warn",
  Stationary: "warn",
};
const flagOf = (s: Sanc): string => s.vessel_flag || s.flag || "n/a";

type Phase = {
  name: string;
  state: "busy" | "ok" | "error";
  msg: string;
} | null;

async function act(
  name: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; msg: string }> {
  try {
    const r = await apiFetch(`/api/actions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (r.ok) return { ok: true, msg: "" };
    const j = (await r.json().catch(() => ({}))) as { detail?: unknown };
    const d = typeof j.detail === "string" ? `: ${j.detail.slice(0, 60)}` : "";
    return { ok: false, msg: `HTTP ${r.status}${d}` };
  } catch {
    return { ok: false, msg: "network error" };
  }
}

function Overlay({
  mid,
  label,
  onClose,
  children,
}: {
  mid?: boolean;
  label: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`rg-over ${mid ? "mid" : ""}`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`rg-panel ${mid ? "dlg" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}

function CountList({
  title,
  rows,
}: {
  title: string;
  rows: [string, number][];
}): JSX.Element {
  return (
    <div>
      <b className="pg-sm pg-mut">{title}</b>
      <dl className="pg-kv" style={{ marginTop: 4 }}>
        {rows.map(([k, n]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: "var(--ink)" }}>{k}</dt>
            <dd style={{ textAlign: "right" }}>{comma(n)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function FilterPanel({
  rows,
  filtered,
  onStatus,
}: {
  rows: Sanc[];
  filtered: VStatus | null;
  onStatus: (s: VStatus) => void;
}): JSX.Element {
  const base = filtered ? rows.filter((r) => r.status === filtered) : rows;
  const cst = counter(rows.map((r) => r.status));
  const mx = Math.max(1, ...cst.map(([, n]) => n));
  return (
    <aside
      className="pg-card pg-pad pg-col"
      style={{ gap: 16 }}
      aria-label="Filter vessels"
    >
      <b>
        <Ico n="filter" /> Filter Vessels
      </b>
      <CountList
        title="PRIORITY"
        rows={(["HIGH", "MEDIUM", "LOW"] as const).map(
          (k): [string, number] => [
            k,
            base.filter((r) => prio(r.np).toUpperCase() === k).length,
          ],
        )}
      />
      <div>
        <b className="pg-sm pg-mut">CURRENT STATUS</b>
        <div className="pg-sm pg-mut">{`Keeping ${cst.length} values`}</div>
        {cst.map(([k, n]) => (
          <button
            key={k}
            type="button"
            className="rg-flt"
            aria-pressed={filtered === k}
            title={
              filtered === k ? `Clear the ${k} filter` : `Filter status ${k}`
            }
            aria-label={
              filtered === k ? `Clear the ${k} filter` : `Filter status ${k}`
            }
            onClick={() => onStatus(k)}
          >
            <span className="pg-fill">{k}</span>
            <span>{comma(n)}</span>
            <span className="rg-bar">
              <i style={{ width: `${(100 * n) / mx}%` }} />
            </span>
          </button>
        ))}
      </div>
      <CountList
        title="SHIP TYPE"
        rows={counter(base.map((r) => r.cls)).slice(0, 5)}
      />
      <CountList title="FLAG" rows={counter(base.map(flagOf)).slice(0, 5)} />
    </aside>
  );
}

function Drawer({
  v,
  all,
  phase,
  tools,
  onClose,
  onAct,
  onAck,
}: {
  v: Sanc;
  all: Sanc[];
  phase: Phase;
  tools: string[];
  onClose: () => void;
  onAct: (n: string) => void;
  onAck: () => void;
}): JSX.Element {
  const nm = `${v.name}_${v.mmsi}`;
  const others = all.filter((r) => r.mmsi !== v.mmsi);
  const btns: [string, string, string, string][] = [
    ["refresh", "Update", "flag_entity", "#a8570a"],
    ["upload", "Escalate", "promote_incident", "#b63242"],
    ["comment", "Comment", "", "#3268c2"],
  ];
  return (
    <Overlay label="Vessel Object View" onClose={onClose}>
      <div className="pg-bar">
        <Ico n="box" size={20} />
        <b style={{ fontSize: 16 }}>Vessel Object View</b>
        <span className="pg-fill" />
        {phase ? (
          <span
            className="pg-sm"
            style={{
              color: phase.state === "error" ? "#8a1f27" : "var(--mut)",
            }}
          >
            {phase.state === "busy"
              ? `${phase.name}: running`
              : phase.state === "ok"
                ? `${phase.name}: done`
                : `${phase.name} failed (${phase.msg})`}
          </span>
        ) : null}
        <button
          type="button"
          className="pg-btn sq"
          aria-label="Close the vessel view"
          title="Close the vessel view"
          onClick={onClose}
        >
          <Ico n="cross" />
        </button>
      </div>
      <div className="pg-pad pg-col">
        <div className="pg-row">
          {btns.map(([ic, lab, tool, c]) => {
            const live =
              tool && tools.includes(tool) && phase?.state !== "busy";
            return (
              <button
                key={lab}
                type="button"
                className="pg-btn"
                style={
                  live
                    ? { background: c, borderColor: c, color: "#fff" }
                    : undefined
                }
                disabled={!live}
                title={
                  live
                    ? `${lab}: ${tool}`
                    : tool
                      ? "Action not available"
                      : "No comment action on this box"
                }
                aria-label={tool ? `${lab}: ${tool}` : lab}
                onClick={live ? () => onAct(tool) : undefined}
              >
                <Ico n={ic} />
                {lab}
              </button>
            );
          })}
        </div>
        <div
          className="pg-card pg-pad pg-row"
          style={{ background: "#f8eaea" }}
        >
          <Ico n="envelope" size={20} />
          <span className="pg-fill">
            New Registry Match{" "}
            <b>{all.filter((r) => r.mmsi === v.mmsi).length}</b>
          </span>
          <button
            type="button"
            className="pg-btn"
            title="Acknowledge: add to watch"
            aria-label="Acknowledge: add to watch"
            onClick={onAck}
          >
            <Ico n="tick-circle" />
            Acknowledge Registry Match
          </button>
        </div>
        <section className="pg-card pg-pad">
          <b>{nm}</b>
          <div className="pg-mut">[Velocity] Vessel</div>
          <dl className="pg-kv" style={{ marginTop: 16 }}>
            <dt>Vessel Name</dt>
            <dd>{v.name}</dd>
            <dt>Registry Match</dt>
            <dd>{`${v.sanction_list ?? "n/a"}: ${(v.sanction_programs ?? []).join(", ")} (matched on ${v.sanction_matched_on ?? "n/a"}, ${v.sanction_confidence ?? "n/a"})`}</dd>
            <dt>Programs</dt>
            <dd>{`${prio(v.np)} (${v.np})`}</dd>
            <dt>Speed over Ground</dt>
            <dd>{`${v.sogN.toFixed(1)} kn`}</dd>
            <dt>Ship Type</dt>
            <dd>{`${v.cls} (AIS ${v.shipType ?? "n/a"})`}</dd>
            <dt>Last Fix At (UTC)</dt>
            <dd>{dmy(new Date(v.t * 1000))}</dd>
            <dt>Last Updated By (feed)</dt>
            <dd>{v.source || "n/a"}</dd>
          </dl>
        </section>
        <section className="pg-card">
          <h3>
            <Ico n="inbox" />
            More Registry Matches
            <span className="pg-fill" />
            <span
              className="pg-mut pg-sm"
              style={{ fontWeight: 400 }}
            >{`${others.length} results`}</span>
          </h3>
          <table className="pg-tbl">
            <thead>
              <tr>
                <th>Title</th>
                <th>Programs</th>
                <th>Last fix</th>
                <th>Vessel name</th>
              </tr>
            </thead>
            <tbody>
              {others.slice(0, 5).map((r) => (
                <tr key={r.mmsi}>
                  <td>{`${r.name}_${r.mmsi}`.slice(0, 24)}</td>
                  <td>{r.np}</td>
                  <td>{tsFmt(new Date(r.t * 1000).toISOString())}</td>
                  <td>{r.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </Overlay>
  );
}

function PhaseLine({
  phase,
  ok,
  fail,
}: {
  phase: Phase;
  ok: string;
  fail: string;
}): JSX.Element | null {
  if (!phase) return null;
  return (
    <span
      className="pg-sm"
      style={{ color: phase.state === "error" ? "#8a1f27" : "var(--mut)" }}
    >
      {phase.state === "busy"
        ? "adding…"
        : phase.state === "ok"
          ? ok
          : `${fail} (${phase.msg})`}
    </span>
  );
}

export function RegistryView({
  nav,
}: {
  nav: (v: FoundryNav) => void;
}): JSX.Element {
  const res = useJson<FC<SancP>>("/api/sanctions/vessels");
  const guard = useJson<Guardrails>("/api/ai/guardrails");
  const [filtered, setFiltered] = useState<VStatus | null>(null);
  const [open, setOpen] = useState<Sanc | null>(null);
  const [picked, setPicked] = useState<Sanc | null>(null);
  const [confirm, setConfirm] = useState<Sanc | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [bulk, setBulk] = useState<Sanc[] | null>(null);
  const [saved, setSaved] = useState(0);
  const [rulesView, setRulesView] = useState<"none" | "view" | "saved">("none");
  const rules = useJson<Rule[]>("/api/alerts/rules", saved);
  const tools = guard?.data?.action_tools ?? [];
  const all = sancRows(res?.data ?? null);
  const order = [...all].sort(
    (a, b) => b.np - a.np || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const rows = order.filter((r) => !filtered || r.status === filtered);

  const run = async (name: string, v: Sanc): Promise<void> => {
    setPhase({ name, state: "busy", msg: "" });
    const target_id = `vessel:${v.mmsi}`;
    const params: Record<string, unknown> =
      name === "add_watch"
        ? { target_id, label: v.name, lat: v.xy[1], lon: v.xy[0] }
        : name === "promote_incident"
          ? {
              target_id,
              title: `Registry match: ${v.name}`,
              note: `${v.sanction_list}: ${(v.sanction_programs ?? []).join(", ")}`,
            }
          : {
              target_id,
              note: `Registry match reviewed: ${v.sanction_list}`,
              severity: Math.min(5, 2 + v.np),
            };
    // as EntityPanel's ActionsCard does: mint the vessel with its registry
    // props first and await it, so the action's upsert keeps them
    const trigger = { flag_entity: "flag", add_watch: "watch" }[name];
    if (trigger)
      await apiFetch("/api/ontology/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: target_id,
          props: {
            name: v.name,
            mmsi: v.mmsi,
            sog: v.sog,
            shipType: v.shipType,
            sanction_list: v.sanction_list,
            sanction_programs: v.sanction_programs,
          },
          trigger,
        }),
      }).catch(() => undefined);
    const r = await act(name, params);
    setPhase({ name, state: r.ok ? "ok" : "error", msg: r.msg });
    if (r.ok && name === "add_watch") {
      setConfirm(null);
      setOpen(null);
      setSaved((n) => n + 1);
      setRulesView("saved");
    }
  };
  const runBulk = async (sel: Sanc[]): Promise<void> => {
    for (const [i, v] of sel.entries()) {
      setPhase({
        name: "add_watch",
        state: "busy",
        msg: `${i + 1} of ${sel.length}`,
      });
      const target_id = `vessel:${v.mmsi}`;
      const r = await act("add_watch", {
        target_id,
        label: v.name,
        lat: v.xy[1],
        lon: v.xy[0],
      });
      if (!r.ok)
        return setPhase({ name: "add_watch", state: "error", msg: r.msg });
    }
    setBulk(null);
    setPhase(null);
    setSaved((n) => n + 1);
    setRulesView("saved");
  };

  const watchN =
    rulesView !== "none" && rules?.data
      ? rules.data.length
      : all.filter((s) => inWatchRegion(s.xy)).length;
  const watchLabel =
    rulesView !== "none" && rules?.data
      ? "WATCH RULES ACTIVE"
      : "REGISTRY WATCH ITEMS PENDING REVIEW";
  const park = all.length
    ? (100 * all.filter((s) => s.parked).length) / all.length
    : 0;
  const onBand = picked
    ? () => {
        setPhase(null);
        setConfirm(picked);
      }
    : filtered
      ? () => {
          setPhase(null);
          setBulk(rows);
        }
      : undefined;
  const bad = !res?.ok;

  return (
    <div className="aip-pg">
      <PageNav here="registry" nav={nav} />
      <div className="pg-bar">
        <b style={{ fontSize: 16 }}>Registry Watch Manager</b>
        <span className="pg-fill" />
        <button
          type="button"
          className="pg-btn"
          title="View chokepoint counts in the AIP terminal"
          onClick={() => nav("terminal")}
        >
          <Ico n="timeline-bar-chart" />
          View Chokepoint Counts
        </button>
        <button
          type="button"
          className="pg-btn"
          title="View the ontology lineage"
          onClick={() => nav("lineage")}
        >
          <Ico n="data-lineage" />
          View Ontology
        </button>
      </div>
      <div className="pg-body">
        <div className="pg-scroll pg-col">
          <div className="pg-row">
            <span className="pg-mut">
              Viewing Registry Matches for{" "}
              <b style={{ color: "var(--ink)" }}>All areas</b>
            </span>
            <span className="pg-fill" />
            <button
              type="button"
              className="rg-kpi"
              title="View the active watch rules"
              aria-label="View the active watch rules"
              onClick={() => setRulesView("view")}
              style={{
                background: rulesView !== "none" ? "#dcefe1" : "#fbe4de",
              }}
            >
              <b>{watchN}</b>
              <span className="pg-sm">{watchLabel}</span>
            </button>
            <div className="rg-kpi" style={{ background: "#dbeefa" }}>
              <b>{park.toFixed(2)}%</b>
              <span className="pg-sm">OF REGISTRY MATCHES PARKED</span>
            </div>
            <button
              type="button"
              className="pg-btn ok"
              disabled={!onBand}
              title={
                onBand
                  ? "Confirm the selected vessels: add to watch"
                  : "Select a vessel, or filter a status, first"
              }
              onClick={onBand}
            >
              <Ico n="take-action" />
              Confirm Selected Vessels
            </button>
          </div>
          <div className="pg-split left">
            <FilterPanel
              rows={bad ? [] : all}
              filtered={filtered}
              onStatus={(k) => setFiltered((f) => (f === k ? null : k))}
            />
            <section className="pg-card" aria-label="Registry matches">
              <table className="pg-tbl">
                <thead>
                  <tr>
                    <th>Vessel Type</th>
                    <th className="num">Speed (kn)</th>
                    <th>Vessel Name</th>
                    <th>Programs</th>
                    <th>Current Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bad ? (
                    <tr>
                      <td colSpan={5} className="pg-err">
                        {unavailable("Sanctions registry", res)}
                      </td>
                    </tr>
                  ) : null}
                  {bad
                    ? null
                    : rows.map((r) => {
                        const pr = prio(r.np);
                        return (
                          <tr
                            key={r.mmsi}
                            style={
                              picked?.mmsi === r.mmsi
                                ? { background: "#e8f0fb" }
                                : undefined
                            }
                          >
                            <td>
                              <Chip tone="info">{r.cls}</Chip>
                            </td>
                            <td className="num">{r.sogN.toFixed(1)}</td>
                            <td>
                              <button
                                type="button"
                                className="rowbtn"
                                title={`Open ${r.name}`}
                                aria-label={`Open ${r.name}`}
                                onClick={() => {
                                  setPhase(null);
                                  setOpen(r);
                                  setPicked(r);
                                }}
                              >
                                {r.name.slice(0, 24)}
                              </button>
                            </td>
                            <td>
                              <Chip tone={P_TONE[pr]}>{`${pr} (${r.np})`}</Chip>
                            </td>
                            <td>
                              <Chip tone={S_TONE[r.status]}>{r.status}</Chip>
                            </td>
                          </tr>
                        );
                      })}
                  {!bad && !rows.length ? (
                    <tr>
                      <td colSpan={5} className="pg-mut">
                        No registry match in this view
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </section>
          </div>
        </div>
        {bulk ? (
          <Overlay
            mid
            label="Create watch rules"
            onClose={() => {
              setBulk(null);
              setPhase(null);
            }}
          >
            <div className="pg-bar">
              <b>Create watch rules</b>
            </div>
            <div className="pg-pad pg-col">
              <div className="pg-row">
                <div className="rg-kpi">
                  <b>{bulk.length}</b>
                  <span className="pg-sm">Registry matches</span>
                </div>
                <div className="rg-kpi">
                  <b>
                    {
                      new Set(bulk.flatMap((v) => v.sanction_programs ?? []))
                        .size
                    }
                  </b>
                  <span className="pg-sm">Sanction programs</span>
                </div>
              </div>
              <Chip tone="ok">
                Selected vessels are on the active registry list
              </Chip>
              <div className="pg-row">
                <button
                  type="button"
                  className="pg-btn ok"
                  disabled={
                    !(tools.includes("add_watch") && phase?.state !== "busy")
                  }
                  title={
                    tools.includes("add_watch")
                      ? `add_watch for ${bulk.length} vessels`
                      : "add_watch is not in this box's action tools"
                  }
                  onClick={() => void runBulk(bulk)}
                >
                  <Ico n="take-action" />
                  Create Watch Rules for Selected
                </button>
                <button
                  type="button"
                  className="pg-btn"
                  title="Cancel"
                  onClick={() => {
                    setBulk(null);
                    setPhase(null);
                  }}
                >
                  Cancel
                </button>
                {phase ? (
                  <span
                    className="pg-sm"
                    style={{
                      color: phase.state === "error" ? "#8a1f27" : "var(--mut)",
                    }}
                  >
                    {phase.state === "busy"
                      ? `add_watch: ${phase.msg}`
                      : phase.state === "ok"
                        ? "Watch rules added"
                        : `add_watch failed (${phase.msg})`}
                  </span>
                ) : null}
              </div>
            </div>
          </Overlay>
        ) : rulesView !== "none" && rules?.data && !confirm && !open ? (
          <Overlay
            label="Active watch rules"
            onClose={() => setRulesView("none")}
          >
            {rulesView === "saved" ? (
              <div className="rg-toast pg-row">
                <Ico n="tick" />
                <span className="pg-fill">Watch rule saved!</span>
                <button
                  type="button"
                  className="pg-btn sq"
                  style={{
                    background: "transparent",
                    borderColor: "#fff",
                    color: "#fff",
                  }}
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={() => setRulesView("none")}
                >
                  <Ico n="cross" />
                </button>
              </div>
            ) : null}
            <div className="pg-bar">
              <Ico n="envelope" size={20} />
              <b style={{ fontSize: 16 }}>
                Active Watch Rules <Chip>{rules.data.length}</Chip>
              </b>
              <span className="pg-fill" />
              <button
                type="button"
                className="pg-btn sq"
                aria-label="Close"
                title="Close"
                onClick={() => setRulesView("none")}
              >
                <Ico n="cross" />
              </button>
            </div>
            <div className="pg-pad">
              <table className="pg-tbl pg-card">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Kinds</th>
                    <th className="num">Radius (nm)</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.data.map((r) => (
                    <tr key={r.id}>
                      <td>{r.label}</td>
                      <td>{r.kinds.join(", ") || "n/a"}</td>
                      <td className="num">{r.radius_nm}</td>
                    </tr>
                  ))}
                  {rules.data.length ? null : (
                    <tr>
                      <td colSpan={3} className="pg-mut">
                        No watch rule yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Overlay>
        ) : confirm ? (
          <Overlay
            mid
            label="Confirm Add to Watch"
            onClose={() => {
              setConfirm(null);
              setPhase(null);
            }}
          >
            <div className="pg-bar">
              <b style={{ fontSize: 16 }}>Confirm Add to Watch</b>
            </div>
            <dl className="pg-kv pg-pad">
              <dt>[VELOCITY] VESSEL</dt>
              <dd>{`${confirm.name}_${confirm.mmsi}`}</dd>
              <dt>ACTION</dt>
              <dd>add_watch</dd>
            </dl>
            <div
              className="pg-bar"
              style={{ borderTop: "1px solid var(--line)", borderBottom: 0 }}
            >
              <PhaseLine
                phase={phase}
                ok="Watch added"
                fail="add_watch failed"
              />
              <span className="pg-fill" />
              <button
                type="button"
                className="pg-btn"
                title="Cancel"
                onClick={() => {
                  setConfirm(null);
                  setPhase(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pg-btn ok"
                disabled={
                  !(tools.includes("add_watch") && phase?.state !== "busy")
                }
                title={
                  tools.includes("add_watch")
                    ? "Confirm: add to watch"
                    : "add_watch is not in this box's action tools"
                }
                onClick={() => void run("add_watch", confirm)}
              >
                Confirm
              </button>
            </div>
          </Overlay>
        ) : open ? (
          <Drawer
            v={open}
            all={all}
            phase={phase}
            tools={tools}
            onClose={() => {
              setOpen(null);
              setPhase(null);
            }}
            onAct={(name) => void run(name, open)}
            onAck={() => {
              setPhase(null);
              setConfirm(open);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
