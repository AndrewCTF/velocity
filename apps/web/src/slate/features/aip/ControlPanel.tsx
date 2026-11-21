// Control Panel as a native layout over the AI settings routes: /api/ai/models
// (engines and catalog), /api/ai/local (the Ollama models), /api/ai/hardware
// (the model the hardware probe recommends), /api/ai/guardrails (governance,
// tools, the one principal), /api/ai/calls (calls per model) and
// /api/status/sources (the usage chart: upstream requests per host, since no
// spend exists locally).
import { useState } from "react";
import { Chip, Ico, PageNav, type FoundryNav } from "./pg.js";
import { useJson, unavailable, type Res } from "./data.js";
import { axis, busiest, catName, nodash, type Call, type CatEntry, type GuardB, type Hardware, type Models, type Src } from "./dataB.js";

export type CpTab = "Overview" | "Access permissions" | "Plugins and tools" | "Users" | "Usage and cost";
const TABS: CpTab[] = ["Overview", "Access permissions", "Plugins and tools", "Users", "Usage and cost"];
interface Row {
  name: string;
  by: string;
  tile: string;
  installed: boolean;
  embed: boolean;
  cat: CatEntry | null;
}
const comma = (n: number): string => n.toLocaleString("en-US");
const okFail = (src: Src[]): [number, number] => [src.reduce((a, x) => a + x.ok, 0), src.reduce((a, x) => a + x.fail, 0)];

function UsageChart({ src }: { src: Src[] }): JSX.Element {
  const hs = busiest(src);
  if (!hs.length) return <p className="pg-note">No upstream request recorded since boot</p>;
  const { step, top } = axis(Math.max(...hs.map((h) => h.ok + h.fail)));
  const [x0, x1, y0, y1] = [56, 620, 12, 180];
  const bw = (x1 - x0) / hs.length;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return (
    <svg className="cp-chart" viewBox="0 0 640 212" role="img" aria-label="Upstream requests since boot per host">
      {ticks.map((v) => {
        const y = y1 - ((y1 - y0) * v) / top;
        return (
          <g key={v}>
            <line x1={x0} x2={x1} y1={y} y2={y} stroke="#e4e8ea" />
            <text x={x0 - 6} y={y} textAnchor="end" dominantBaseline="central">
              {v >= 1000 ? `${+(v / 1000).toPrecision(6)}k` : String(v)}
            </text>
          </g>
        );
      })}
      {hs.map((h, i) => {
        const hok = ((y1 - y0) * h.ok) / top;
        const hf = ((y1 - y0) * h.fail) / top;
        const bx = x0 + i * bw;
        return (
          <g key={h.host}>
            <title>{`${nodash(h.host)}: ${h.ok} succeeded, ${h.fail} failed`}</title>
            <rect x={bx + 1} y={y1 - hok} width={bw - 2} height={hok} fill="#1c78a4" />
            <rect x={bx + 1} y={y1 - hok - hf} width={bw - 2} height={hf} fill="#c26a14" />
          </g>
        );
      })}
      <line x1={x0} x2={x1} y1={y1} y2={y1} stroke="#566067" />
      <text x={x0 + bw / 2} y={y1 + 16} textAnchor="start">
        {nodash(hs[0]!.host)}
      </text>
      {hs.length > 1 ? (
        <text x={x1} y={y1 + 16} textAnchor="end">
          {nodash(hs[hs.length - 1]!.host)}
        </text>
      ) : null}
    </svg>
  );
}

function UsageCard({ src }: { src: Src[] }): JSX.Element {
  const [ok, fail] = okFail(src);
  return (
    <section className="pg-card">
      <h3>Upstream requests since boot, 16 busiest hosts</h3>
      <div className="pg-pad cp-grid" style={{ gridTemplateColumns: "minmax(0,3fr) minmax(160px,1fr)" }}>
        <UsageChart src={src} />
        <div className="pg-col" style={{ gap: 8 }}>
          <div className="pg-stat">
            <span className="pg-mut">Succeeded</span>
            <b>{comma(ok)}</b>
          </div>
          <div className="pg-stat">
            <span className="pg-mut">Failed</span>
            <b>{comma(fail)}</b>
          </div>
          <span className="pg-row pg-sm">
            <i className="lg-sw" style={{ background: "#1c78a4" }} />
            Succeeded
          </span>
          <span className="pg-row pg-sm">
            <i className="lg-sw" style={{ background: "#c26a14" }} />
            Failed
          </span>
        </div>
      </div>
    </section>
  );
}

function AccessSummary({ g }: { g: GuardB | null }): JSX.Element {
  return (
    <section className="pg-card">
      <h3>Access summary</h3>
      <dl className="pg-kv pg-pad">
        <dt>Read tools</dt>
        <dd>{g?.tools.length ?? 0}</dd>
        <dt>Action tools</dt>
        <dd>{g?.action_tools.length ?? 0}</dd>
        <dt>Control tools</dt>
        <dd>{g?.control_tools.length ?? 0}</dd>
        {g?.citations_required ? (
          <>
            <dt>Citations</dt>
            <dd>Required</dd>
          </>
        ) : null}
      </dl>
      {g?.action_tools.length ? (
        <table className="pg-tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Data access</th>
            </tr>
          </thead>
          <tbody>
            {g.action_tools.slice(0, 3).map((nm) => (
              <tr key={nm}>
                <td>{nm}</td>
                <td>{g.action_approval ? "Approval" : "Direct"}</td>
                <td>
                  <Ico n="tick" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="pg-mut pg-sm pg-pad" style={{ margin: 0 }}>
        <Ico n="info-sign" size={12} /> Information displayed is dependent on your access level.
      </p>
    </section>
  );
}

function Overview({ r, g, src, calls, hub }: { r: Row; g: GuardB | null; src: Src[]; calls: Res<Call[]> | null; hub: () => void }): JSX.Element {
  const creator = r.cat ? `${r.cat.repo_id.split("/")[0]} (GGUF)` : "Ollama";
  const comps = g?.compartments ?? [];
  const now = Date.now();
  const mine = (calls?.data ?? []).filter((c) => c.model_id.toLowerCase().includes(r.name.toLowerCase().split(":")[0]!));
  const inDays = (d: number): string => (calls?.ok ? String(mine.filter((c) => now - Date.parse(c.ts) <= d * 86400e3).length) : "n/a");
  return (
    <div className="pg-col">
      <div className="cp-grid">
        <section className="pg-card pg-pad">
          <dl className="pg-kv">
            <dt>Name</dt>
            <dd>
              <b>{r.name}</b>
            </dd>
            <dt>Created by</dt>
            <dd>{creator}</dd>
            <dt>Groups</dt>
            <dd>{`local${comps.length ? `, ${comps.join(", ")}` : " (no further groups)"}`}</dd>
            <dt>Markings</dt>
            <dd>
              <Chip>
                <Ico n="shield" size={12} />
                Marking UNCLAS
              </Chip>
            </dd>
            <dt>ID</dt>
            <dd>{r.cat ? (r.cat.repo_id.split("/")[1] ?? "") : r.name}</dd>
            <dt>API</dt>
            <dd>/api/ai/models</dd>
            <dt>Quant</dt>
            <dd>{r.cat?.recommended_quant ?? "n/a"}</dd>
          </dl>
        </section>
        <section className="pg-card pg-pad pg-col" style={{ gap: 8 }}>
          <div className="pg-row">
            <span className="pg-fill pg-mut">View model</span>
            <button type="button" className="pg-btn" title="Open in the model manager (AI hub)" onClick={hub}>
              Open in Model manager
              <Ico n="arrow-top-right" />
            </button>
          </div>
          <dl className="pg-kv">
            <dt>Status</dt>
            <dd>
              <Chip tone={r.installed ? "ok" : undefined}>{r.installed ? "Installed" : "Not installed"}</Chip>
            </dd>
            <dt>Calls (7 day)</dt>
            <dd>{inDays(7)}</dd>
            <dt>Calls (30 day)</dt>
            <dd>{inDays(30)}</dd>
            <dt>Tools</dt>
            <dd>{g ? String(g.tools.length) : "n/a"}</dd>
          </dl>
        </section>
      </div>
      <UsageCard src={src} />
      <AccessSummary g={g} />
    </div>
  );
}

function Usage({ src, g }: { src: Src[]; g: GuardB | null }): JSX.Element {
  const th = g?.action_auto_threshold;
  const rows: [string, string, string, string][] = [
    [
      "Auto-approval threshold for actions",
      "Proposed actions scoring at or above this run without an operator.",
      th === undefined ? "n/a" : th > 1 ? `${th} is above any possible score, so none run unattended.` : `Actions scoring ${th} or more run unattended.`,
      th === undefined ? "n/a" : String(th),
    ],
    [
      "Operator approval for actions",
      "Whether a proposed action waits for an operator decision.",
      `${g?.action_tools.length ?? 0} action tools, ${g?.operator_only_actions.length ?? 0} operator-only.`,
      g ? (g.action_approval ? "Required" : "Off") : "n/a",
    ],
  ];
  return (
    <div className="pg-col">
      <UsageCard src={src} />
      <section className="pg-card">
        <h3>
          <Ico n="lock" />
          Set action limits
        </h3>
        <p className="pg-mut pg-pad" style={{ margin: 0 }}>Define when the assistant may act without an operator</p>
        <dl className="pg-kv pg-pad" style={{ gap: 16 }}>
          {rows.map(([lab, h1, h2, val]) => (
            <div key={lab} style={{ display: "contents" }}>
              <dt style={{ color: "var(--ink)" }}>
                <b>{lab}</b>
                <span className="pg-mut" style={{ display: "block" }}>{h1}</span>
                <span className="pg-mut" style={{ display: "block" }}>{h2}</span>
              </dt>
              <dd>
                <b>{val}</b>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function Access({ g }: { g: GuardB | null }): JSX.Element {
  return (
    <div className="pg-col">
      <section className="pg-card">
        <h3>Principals</h3>
        <p className="pg-pad" style={{ margin: 0 }}>
          <Ico n="person" /> local (operator)
        </p>
      </section>
      <section className="pg-card">
        <h3>Markings</h3>
        <p className="pg-mut pg-pad" style={{ margin: 0 }}>Manage which markings the language model will have access to</p>
        <p className="pg-pad" style={{ margin: 0, paddingTop: 0 }}>
          <Chip>
            <Ico n="shield" size={12} />
            UNCLAS
          </Chip>
        </p>
      </section>
      <section className="pg-card">
        <h3>Advanced settings</h3>
        <p className="pg-mut pg-pad" style={{ margin: 0 }}>Further limit language model access. Mode in force: Allowlist.</p>
        <ul className="pg-pad" style={{ margin: 0, paddingTop: 0, listStyle: "none", display: "grid", gap: 8 }}>
          {g?.action_tools[0] ? <li>{`${g.action_tools[0]} (action tool)`}</li> : null}
          {g?.operator_only_actions[0] ? <li>{`${g.operator_only_actions[0]} (operator only)`}</li> : null}
          {!g?.action_tools[0] && !g?.operator_only_actions[0] ? <li className="pg-mut">No allowlisted resource</li> : null}
        </ul>
      </section>
      <AccessSummary g={g} />
    </div>
  );
}

function Plugins({ m, g, ollamaUp, hub }: { m: Models | null; g: GuardB | null; ollamaUp: boolean | null; hub: () => void }): JSX.Element {
  const e = m?.engines;
  const chipOf = (inst: boolean, run: boolean): ["ok" | "warn" | "bad", string] => (run ? ["ok", "Running"] : inst ? ["warn", "Installed, idle"] : ["bad", "Not installed"]);
  const rows: [string, string, ["ok" | "warn" | "bad", string]][] = e
    ? [
        ["llama.cpp", e.llamacpp.version ? e.llamacpp.version.split("(")[0]!.replace("version:", "Build").trim() : e.llamacpp.installed ? "Installed" : "Not installed", chipOf(e.llamacpp.installed, e.llamacpp.running)],
        ["vLLM", e.vllm.version ?? (e.vllm.installed ? "Installed" : "Not installed"), chipOf(e.vllm.installed, e.vllm.running)],
        ["Ollama", ollamaUp ? "Serving embeddings" : "Not answering", chipOf(e.ollama.installed, e.ollama.running)],
      ]
    : [];
  return (
    <div className="pg-col">
      <section className="pg-card">
        <h3>
          Engines
          <span className="pg-fill" />
          <button type="button" className="pg-btn" title="Add an engine in the model manager (AI hub)" onClick={hub}>
            <Ico n="add" />
            Add
          </button>
        </h3>
        <p className="pg-mut pg-pad" style={{ margin: 0 }}>Manage inference engines this language model can run on</p>
        {e ? null : <p className="pg-note">{unavailable("Engines", null)}</p>}
        {rows.map(([nm, sub, [tone, lab]]) => (
          <div key={nm} className="cp-row">
            <div className="cp-tile" style={{ background: "#ece6f8" }}>
              <Ico n={nm === "Ollama" ? "database" : "desktop"} size={20} />
            </div>
            <div className="pg-fill">
              <b>{nm}</b>
              <div className="pg-mut pg-sm">{sub}</div>
            </div>
            <Chip tone={tone}>{lab}</Chip>
            <button type="button" className="pg-btn" title={`${nm} status in the AI hub`} aria-label={`${nm} status in the AI hub`} onClick={hub}>
              View status
              <Ico n="arrow-top-right" />
            </button>
            <button type="button" className="pg-btn" title={`Manage ${nm} in the AI hub`} aria-label={`Manage ${nm} in the AI hub`} onClick={hub}>
              Manage
            </button>
          </div>
        ))}
      </section>
      <section className="pg-card">
        <h3>Tools</h3>
        <p className="pg-mut pg-pad" style={{ margin: 0 }}>Configure the tools that this model can interact with in Velocity.</p>
        <dl className="pg-kv pg-pad">
          <dt>Actions</dt>
          <dd>
            <Chip tone="warn">{g?.action_approval ? "Approval required" : "No approval"}</Chip>
          </dd>
          <dt>{`Read tools (${g?.tools.length ?? 0})`}</dt>
          <dd>
            <Chip tone="bad">{g?.citations_required ? "Citations required" : "No citations"}</Chip>
          </dd>
        </dl>
      </section>
    </div>
  );
}

function Users({ g }: { g: GuardB | null }): JSX.Element {
  return (
    <section className="pg-card">
      <h3>User access</h3>
      <p className="pg-mut pg-pad" style={{ margin: 0 }}>Manage which principals will have access to this language model</p>
      <p className="pg-pad" style={{ margin: 0, paddingTop: 0 }}>
        <Ico n="person" /> local{" "}
        <span className="pg-mut">{`(clearance ${g?.clearance ?? "n/a"}, compartments: ${g?.compartments.length ? g.compartments.join(", ") : "none"})`}</span>
      </p>
    </section>
  );
}

export function ControlPanel({ onConsole, onHub, nav }: { onConsole: () => void; onHub: () => void; nav?: (v: FoundryNav) => void }): JSX.Element {
  const models = useJson<Models>("/api/ai/models");
  const local = useJson<{ models: string[]; ollama_up: boolean }>("/api/ai/local");
  const hw = useJson<Hardware>("/api/ai/hardware");
  const guard = useJson<GuardB>("/api/ai/guardrails");
  const src = useJson<{ sources: Src[] }>("/api/status/sources");
  const calls = useJson<Call[]>("/api/ai/calls?limit=500");
  const [open, setOpen] = useState<number | null>(null);
  const [tab, setTab] = useState<CpTab>("Overview");
  const [q, setQ] = useState("");
  const cat = models?.data?.catalog ?? [];
  const rec = cat.find((c) => c.repo_id === hw?.data?.recommendation.repo_id) ?? null;
  const speed = cat.find((c) => c.tier === "30b") ?? null;
  const installed = new Set((models?.data?.installed ?? []).map((x) => JSON.stringify(x)));
  const rows: Row[] = [];
  const om = local?.data?.models[0];
  if (om) rows.push({ name: om, by: "Ollama, size not reported by /api/ai/local", tile: "#d4f0d2", installed: true, embed: om.includes("embed"), cat: null });
  for (const [c, tile] of [[rec, "#dcd8ee"], [speed, "#def0f8"]] as const)
    if (c && !rows.some((r) => r.cat === c))
      rows.push({ name: catName(c), by: `Catalog entry, ${c.license}, ${c.quants[0]?.size_gb ?? "n/a"} GB (${c.recommended_quant})`, tile, installed: [...installed].some((x) => x.includes(c.repo_id)), embed: false, cat: c });
  const err = !models?.ok || !local?.ok ? unavailable("Model list", !models?.ok ? models : local) : null;
  const g = guard?.data ?? null;
  const row = open === null ? null : (rows[open] ?? null);
  const sources = src?.data?.sources ?? [];
  const go = nav ?? ((v: FoundryNav): void => (v === "terminal" ? onConsole() : undefined));
  const shown = rows.map((r, i) => [r, i] as const).filter(([r]) => r.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="aip-pg">
      <PageNav here="control" nav={go} />
      {!row ? (
        <>
          <div className="pg-bar">
            <b style={{ fontSize: 16 }}>Language models</b>
            <span className="pg-mut">Manage language models used in Velocity.</span>
            <span className="pg-fill" />
            <input className="pg-in" placeholder="Filter models" aria-label="Filter models" value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="button" className="pg-btn" title="Add a model in the model manager (AI hub)" onClick={onHub}>
              Add new model
              <Ico n="arrow-top-right" />
            </button>
          </div>
          <div className="pg-body">
            <div className="pg-scroll">
              <section className="pg-card">
                {!rows.length && err ? <p className="pg-note">{err}</p> : null}
                {shown.map(([r, i]) => (
                  <div key={r.name} className="cp-row">
                    <div className="cp-tile" style={{ background: r.tile }}>
                      <Ico n="citation" size={20} />
                    </div>
                    <div className="pg-fill">
                      <b>{r.name}</b>
                      <div className="pg-mut pg-sm">{r.by}</div>
                    </div>
                    <Chip tone="ok">Self-hosted</Chip>
                    <Chip tone={r.embed ? "info" : r.installed ? "info" : undefined}>{r.embed ? "Embeddings only" : r.installed ? "Installed" : "Not installed"}</Chip>
                    <button type="button" className="pg-btn" title={`Manage ${r.name}`} aria-label={`Manage ${r.name}`} onClick={() => { setOpen(i); setTab("Overview"); }}>
                      Manage
                    </button>
                  </div>
                ))}
                {rows.length && !shown.length ? <p className="pg-note">No model matches this filter</p> : null}
              </section>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="pg-bar">
            <button type="button" className="pg-btn sq" aria-label="Back to language models" title="Back to language models" onClick={() => setOpen(null)}>
              <Ico n="arrow-left" />
            </button>
            <div className="cp-tile" style={{ background: row.tile, width: 32, height: 32 }}>
              <Ico n="citation" size={18} />
            </div>
            <span>
              <span className="pg-mut">Language models</span> › <b>{row.name}</b>
            </span>
            <span className="pg-mut pg-sm">Manage language model access and usage</span>
          </div>
          <div className="pg-nav" role="tablist" aria-label="Model sections">
            {TABS.map((t) => (
              <button key={t} type="button" role="tab" className="pg-tab" aria-selected={t === tab} aria-current={t === tab ? "page" : undefined} onClick={t === tab ? undefined : () => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="pg-body">
            <div className="pg-scroll">
              {!src?.ok && (tab === "Overview" || tab === "Usage and cost") ? <p className="pg-err" style={{ padding: "0 0 16px" }}>{unavailable("Upstream sources", src)}</p> : null}
              {tab === "Overview" ? <Overview r={row} g={g} src={sources} calls={calls} hub={onHub} /> : null}
              {tab === "Usage and cost" ? <Usage src={sources} g={g} /> : null}
              {tab === "Access permissions" ? <Access g={g} /> : null}
              {tab === "Plugins and tools" ? <Plugins m={models?.data ?? null} g={g} ollamaUp={local?.data?.ollama_up ?? null} hub={onHub} /> : null}
              {tab === "Users" ? <Users g={g} /> : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
