// Foundry resource workspace as a native layout: the transform catalogue, one
// transform's page (summary, builds, checks, versions) and the build comparison.
// A real transform stands in for the modeling objective (Velocity has none); the
// comparison states that no labelled evaluation set exists and reads every
// metric n/a except Row Count, the build's real rows_out.
import { useState } from "react";
import { apiFetch } from "../../../transport/http.js";
import { useAppView } from "../../../state/appView.js";
import { Chip, Ico, PageNav, type FoundryNav } from "./pg.js";
import {
  tsFmt,
  unavailable,
  useJson,
  type Binding,
  type Build,
  type Check,
  type Dataset,
  type Transform,
} from "./data.js";

interface Ctx {
  tf: Transform;
  tin: Dataset | undefined;
  tout: Dataset | undefined;
  tfBuilds: Build[];
  builds: Build[];
  checks: Check[] | null;
  ds: Map<string, Dataset>;
  boundKinds: string[];
}

const nm = (d: Dataset | undefined, id: string): string => d?.name ?? id;
const stTone = (s: string): "ok" | "bad" | undefined =>
  s === "succeeded" ? "ok" : s === "failed" ? "bad" : undefined;
const stLabel = (s: string): string => (s === "succeeded" ? "Succeeded" : s);

function BuildStatus({ b }: { b: Build }): JSX.Element {
  return (
    <Chip tone={stTone(b.status)}>
      <Ico
        n={
          b.status === "succeeded"
            ? "tick-circle"
            : b.status === "failed"
              ? "error"
              : "time"
        }
        size={12}
      />
      {stLabel(b.status)}
    </Chip>
  );
}

function RightPanel({
  c,
  onLineage,
}: {
  c: Ctx;
  onLineage: (id?: string) => void;
}): JSX.Element {
  const inId = c.tf.inputs[0] ?? "";
  const dsl: [string, Dataset | undefined][] = [
    [inId, c.tin],
    [c.tf.output_dataset_id, c.tout],
  ];
  return (
    <aside className="pg-card" aria-label="Transform details">
      <h3>Transform details</h3>
      <div className="pg-pad pg-col" style={{ gap: 16 }}>
        <div>
          <b>Transform API</b>
          <p
            className="pg-mut pg-sm"
            style={{ margin: "8px 0 4px" }}
          >{`Inputs (showing 1 of ${c.tf.inputs.length})`}</p>
          <div className="pg-card pg-pad">
            <div className="pg-sm pg-mut">{`${nm(c.tin, inId)} · dataset`}</div>
            <div>{`${c.tin?.row_count ?? "n/a"} rows`}</div>
          </div>
          <p className="pg-mut pg-sm" style={{ margin: "8px 0 4px" }}>
            Outputs (showing 1 of 1)
          </p>
          <div className="pg-card pg-pad">
            <div className="pg-sm pg-mut">{`${nm(c.tout, c.tf.output_dataset_id)} · dataset`}</div>
            <div>{`${c.tout?.row_count ?? "n/a"} rows`}</div>
          </div>
        </div>
        <div>
          <b>Input datasets</b>
          <div
            className="pg-col"
            style={{ gap: 4, marginTop: 8, alignItems: "flex-start" }}
          >
            {dsl.map(([id, d]) => (
              <button
                key={id}
                type="button"
                className="pg-link"
                title={`Preview ${nm(d, id)} in the lineage`}
                onClick={() => onLineage(id)}
              >
                {nm(d, id)}
                <span
                  className="pg-mut pg-sm"
                  style={{ display: "block", textDecoration: "none" }}
                >{`foundry://${id}`}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <b>Lineage</b>
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="pg-link"
              title="Open the master lineage"
              onClick={() => onLineage()}
            >
              Master Lineage + builds
            </button>
            <div className="pg-mut pg-sm">/Velocity Foundry/lineage</div>
          </div>
        </div>
        <div>
          <b>Linked ontology kinds</b>
          <div style={{ marginTop: 8 }}>
            {c.boundKinds.length ? (
              c.boundKinds[0]
            ) : (
              <span className="pg-mut">none bound</span>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function TransformPage({
  c,
  busy,
  runMsg,
  onRun,
  onAll,
  onBack,
  onLineage,
}: {
  c: Ctx;
  busy: boolean;
  runMsg: string;
  onRun: () => void;
  onAll: () => void;
  onBack: () => void;
  onLineage: (id?: string) => void;
}): JSX.Element {
  const steps = c.tf.steps
    .map((st) => `${st.type}(${st.expr || st.column || ""})`)
    .join(", ");
  const rows = c.tfBuilds.slice(0, 5);
  const ck = c.checks;
  const c0 = ck?.[0];
  const outName = nm(c.tout, c.tf.output_dataset_id);
  const ver = c.tout ? `v${c.tout.latest_version}` : "n/a";
  return (
    <div className="pg-split">
      <div className="pg-col">
        <div className="pg-row">
          <button
            type="button"
            className="pg-btn flat"
            title="Back to the transform catalogue"
            onClick={onBack}
          >
            <Ico n="arrow-left" />
            Transforms
          </button>
        </div>
        <h1>{c.tf.name}</h1>
        <section className="pg-card">
          <h3>Summary</h3>
          <div className="pg-pad">
            <p
              style={{ margin: 0 }}
            >{`Reads ${nm(c.tin, c.tf.inputs[0] ?? "")} and writes ${outName} in ${c.tf.steps.length} steps.`}</p>
            <p
              className="pg-mut"
              style={{ margin: "8px 0 0" }}
            >{`Steps: ${steps}`}</p>
          </div>
        </section>
        <section className="pg-card">
          <h3>
            <Ico n="git-merge" />
            {`Builds (${c.tfBuilds.length})`}
            <span className="pg-fill" />
            {runMsg ? (
              <span className="pg-mut pg-sm" style={{ fontWeight: 400 }}>
                {runMsg}
              </span>
            ) : null}
            <button
              type="button"
              className="pg-btn"
              disabled={busy}
              title={busy ? "Building" : "Run build"}
              onClick={onRun}
            >
              <Ico n="add" />
              Run build
            </button>
          </h3>
          <table className="pg-tbl">
            <thead>
              <tr>
                <th>Build</th>
                <th>Date started</th>
                <th>Scope</th>
                <th>Checks</th>
                <th>Status</th>
                <th className="num">Rows out</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td>{b.id}</td>
                  <td>{tsFmt(b.started_at)}</td>
                  <td className="pg-mut">
                    {b.scope +
                      (b.transform_id === null ? " (all transforms)" : "")}
                  </td>
                  <td className="pg-mut">No checks yet</td>
                  <td>
                    <BuildStatus b={b} />
                  </td>
                  <td className="num">{b.rows_out}</td>
                </tr>
              ))}
              {rows.length ? null : (
                <tr>
                  <td colSpan={6} className="pg-mut">
                    No build of this transform yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="pg-pad">
            <button
              type="button"
              className="pg-link"
              title="View all builds"
              onClick={onAll}
            >
              View all builds
            </button>
          </div>
        </section>
        <section className="pg-card">
          <h3>
            <Ico n="timeline-bar-chart" />
            Checks
          </h3>
          <ul
            className="pg-pad"
            style={{ margin: 0, listStyle: "none", display: "grid", gap: 8 }}
          >
            <li className="pg-mut">
              Datasets are checked using the following:
            </li>
            {ck === null ? (
              <>
                <li>{unavailable("Checks", null)}</li>
                <li>0 dataset (n/a)</li>
              </>
            ) : (
              <>
                <li>
                  <b>{ck.length}</b>{" "}
                  {c0
                    ? `check (${c0.name}: ${c0.type} on ${c0.params.column}, max age ${c0.params.max_age_s} s)`
                    : "checks (none)"}
                </li>
                <li>
                  <b>{c0 ? 1 : 0}</b>{" "}
                  {c0
                    ? `dataset (${nm(c.ds.get(c0.dataset_id), c0.dataset_id)})`
                    : "dataset (n/a)"}
                </li>
              </>
            )}
            <li>
              <b>0</b> evaluation libraries (no labelled evaluation set on this
              box)
            </li>
          </ul>
        </section>
        <section className="pg-card">
          <h3>
            <Ico n="tag" />
            Versions
          </h3>
          <dl className="pg-kv pg-pad">
            <dt>Latest version</dt>
            <dd>{`${outName} ${ver}`}</dd>
            <dt>Previous version</dt>
            <dd className="pg-mut">n/a</dd>
            <dt>Last built</dt>
            <dd>
              {c.tfBuilds[0]
                ? `Built ${tsFmt(c.tfBuilds[0].started_at, false)}`
                : "Never built"}
            </dd>
          </dl>
        </section>
      </div>
      <RightPanel c={c} onLineage={onLineage} />
    </div>
  );
}

type StKey = "never" | "failed" | "succeeded";
const ST_ROWS: [StKey, string, string][] = [
  ["never", "Never built", "Transforms with no build yet"],
  ["failed", "Failed", "Transforms whose last build failed"],
  ["succeeded", "Succeeded", "Transforms whose last build succeeded"],
];

function Catalogue({
  tfs,
  c,
  onOpen,
  setApp,
}: {
  tfs: Transform[];
  c: {
    ds: Map<string, Dataset>;
    builds: Build[];
    bindings: number;
    tfName: string;
  };
  onOpen: (id: string) => void;
  setApp: (a: "models" | "foundry" | "workflows") => void;
}): JSX.Element {
  const [q, setQ] = useState("");
  const [stF, setStF] = useState<StKey[]>([]);
  const tf = tfs.find((t) => t.name === c.tfName);
  const nTfB = tf ? c.builds.filter((b) => b.transform_id === tf.id).length : 0;
  const nPipe = c.builds.filter((b) => b.scope === "pipeline").length;
  const last = (t: Transform): Build | undefined =>
    c.builds.find((b) => b.transform_id === t.id);
  const keyOf = (t: Transform): StKey | null => {
    const b = last(t);
    return !b
      ? "never"
      : b.status === "failed"
        ? "failed"
        : b.status === "succeeded"
          ? "succeeded"
          : null;
  };
  const shown = tfs.filter(
    (t) =>
      t.name.toLowerCase().includes(q.trim().toLowerCase()) &&
      (!stF.length || stF.includes(keyOf(t) as StKey)),
  );
  return (
    <div className="pg-col">
      <div>
        <h1>Manage Transforms, Models, and Flows</h1>
        <p className="pg-mut" style={{ margin: "4px 0 0" }}>
          Explore and manage the lifecycle of transforms, builds and local
          language models per task.
        </p>
      </div>
      <div className="pg-row">
        <button
          type="button"
          className="pg-btn ok"
          title="New transform"
          onClick={() => setApp("foundry")}
        >
          <Ico n="add" />
          New transform
        </button>
        <button
          type="button"
          className="pg-btn"
          title="Define Transforms"
          onClick={() => setApp("foundry")}
        >
          <Ico n="edit" />
          Define Transforms
        </button>
        <button
          type="button"
          className="pg-btn"
          title="Manage Installed Models"
          onClick={() => setApp("models")}
        >
          <Ico n="upload" />
          Manage Installed Models
        </button>
        <button
          type="button"
          className="pg-btn"
          title="Deploy To Workflows And Monitors"
          onClick={() => setApp("workflows")}
        >
          <Ico n="desktop" />
          Deploy To Workflows And Monitors
        </button>
      </div>
      <div className="pg-split left">
        <aside
          className="pg-card pg-pad pg-col"
          style={{ gap: 16 }}
          aria-label="Filters"
        >
          <label className="pg-col" style={{ gap: 4 }}>
            <b className="pg-sm pg-mut">TRANSFORMS</b>
            <input
              className="pg-in"
              placeholder="Search by transform name"
              aria-label="Search by transform name"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <div>
            <b className="pg-sm pg-mut">SCOPES</b>
            <dl className="pg-kv" style={{ marginTop: 4 }}>
              <dt>{`Builds of ${c.tfName}`}</dt>
              <dd>{nTfB}</dd>
              <dt>Pipeline builds</dt>
              <dd>{nPipe}</dd>
              <dt>Ontology bindings</dt>
              <dd>{c.bindings}</dd>
            </dl>
          </div>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend
              className="pg-sm pg-mut"
              style={{ fontWeight: 600, padding: 0 }}
            >
              STATUS
            </legend>
            {ST_ROWS.map(([k, lab, desc]) => (
              <label
                key={k}
                className="pg-col"
                style={{ gap: 0, marginTop: 8 }}
              >
                <span className="pg-row">
                  <input
                    type="checkbox"
                    checked={stF.includes(k)}
                    onChange={() =>
                      setStF((f) =>
                        f.includes(k) ? f.filter((x) => x !== k) : [...f, k],
                      )
                    }
                  />
                  {lab}
                </span>
                <span className="pg-sm pg-mut" style={{ marginLeft: 24 }}>
                  {desc}
                </span>
              </label>
            ))}
          </fieldset>
        </aside>
        <section className="pg-card" aria-label="Transforms">
          <h3>
            Transforms <Chip>{shown.length}</Chip>
          </h3>
          <table className="pg-tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Inputs</th>
                <th>Outputs</th>
                <th>Steps</th>
                <th>Last built</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const b = last(t);
                return (
                  <tr key={t.id}>
                    <td>
                      <button
                        type="button"
                        className="rowbtn"
                        title={`Open ${t.name}`}
                        aria-label={`Open ${t.name}`}
                        onClick={() => onOpen(t.id)}
                      >
                        {t.name}
                      </button>
                      <div className="pg-sm pg-mut">{`Velocity Foundry · transform · ${t.id}`}</div>
                    </td>
                    {[t.inputs[0] ?? "", t.output_dataset_id].map((did, i) => {
                      const d = c.ds.get(did);
                      return (
                        <td key={i}>
                          <div>{nm(d, did)}</div>
                          <div className="pg-sm pg-mut">{`${d?.schema.length ?? "n/a"} properties`}</div>
                        </td>
                      );
                    })}
                    <td>
                      <div>{t.steps.map((st) => st.type).join(", ")}</div>
                      <div className="pg-sm pg-mut">{`${t.steps.length} steps`}</div>
                    </td>
                    <td>
                      {b ? (
                        `Built ${tsFmt(b.started_at)}`
                      ) : (
                        <span className="pg-mut">Never built</span>
                      )}
                    </td>
                    <td>{b ? <BuildStatus b={b} /> : null}</td>
                  </tr>
                );
              })}
              {shown.length ? null : (
                <tr>
                  <td colSpan={6} className="pg-mut">
                    No transform matches these filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

const PAIR = ["#264eb2", "#1f7a31"];
const HEADS = [
  "Precision",
  "Recall",
  "F1 Score",
  "Prior",
  "Accuracy",
  "Row Count",
  "Matthews Correlation Coefficient",
  "ROC AUC Score",
  "Root Mean Squared Error",
];
const CHARTS = [
  "ROC Curve",
  "TPR Curve",
  "FPR Curve",
  "Lift Curve",
  "Score Distribution",
  "Residuals",
];

function Compare({
  c,
  sel,
  busy,
  onBack,
  onHome,
  onToggle,
  onClear,
  onRun,
}: {
  c: Ctx;
  sel: Build[];
  busy: boolean;
  onBack: () => void;
  onHome: () => void;
  onToggle: (b: Build) => void;
  onClear: () => void;
  onRun: () => void;
}): JSX.Element {
  const [picker, setPicker] = useState(false);
  const ok = c.builds.filter((b) => b.status === "succeeded").length;
  const fail = c.builds.filter((b) => b.status === "failed").length;
  const outName = nm(c.tout, c.tf.output_dataset_id);
  const list = [
    ...c.tfBuilds.slice(0, 4),
    ...c.builds
      .filter((x) => x.transform_id !== c.tf.id && !c.tfBuilds.includes(x))
      .slice(0, 2),
  ];
  const info: [string, (b: Build) => string][] = [
    ["Started", (b) => tsFmt(b.started_at)],
    ["Rows out", (b) => String(b.rows_out)],
    ["Scope", (b) => b.scope],
  ];
  return (
    <div className="pg-col">
      <div className="pg-row">
        <button
          type="button"
          className="pg-btn sq"
          aria-label={`Back to ${c.tf.name}`}
          title={`Back to ${c.tf.name}`}
          onClick={onBack}
        >
          <Ico n="arrow-left" />
        </button>
        <button
          type="button"
          className="pg-btn"
          title="Home: manage transforms"
          onClick={onHome}
        >
          <Ico n="home" />
          Home
        </button>
        <b>Build comparison</b>
        <span className="pg-fill" />
        <Chip>
          <Ico n="refresh" size={12} />
          {`${c.builds.length - ok - fail} pending`}
        </Chip>
        <Chip tone="ok">
          <Ico n="tick" size={12} />
          {`${ok} succeeded`}
        </Chip>
        <Chip tone="bad">
          <Ico n="cross" size={12} />
          {`${fail} failed`}
        </Chip>
        <button
          type="button"
          className="pg-btn"
          disabled={busy}
          title={busy ? "Building" : "Build all"}
          onClick={onRun}
        >
          <Ico n="build" />
          Build all
        </button>
      </div>
      <div className="pg-split left">
        <aside
          className="pg-card pg-pad pg-col"
          style={{ gap: 16 }}
          aria-label="Builds to compare"
        >
          <div>
            <b className="pg-sm pg-mut">Viewing metrics on</b>
            <div>{outName}</div>
            <div className="pg-sm pg-mut">
              Using latest values for each build
            </div>
          </div>
          <div>
            <div className="pg-row">
              <b>Select builds</b>
              <span className="pg-fill" />
              <button
                type="button"
                className="pg-link"
                title="Clear all"
                onClick={onClear}
              >
                Clear all
              </button>
            </div>
            <p className="pg-sm pg-mut" style={{ margin: "4px 0 8px" }}>
              Add specific builds to the comparison dashboard.
            </p>
            <div className="pg-col" style={{ gap: 4 }}>
              {sel.map((b, i) => (
                <span
                  key={b.id}
                  className="pg-row"
                  style={{
                    background: PAIR[i],
                    color: "#fff",
                    borderRadius: 3,
                    padding: "4px 8px",
                  }}
                >
                  <Ico n="git-merge" size={12} />
                  <span className="pg-fill">{b.id}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${b.id}`}
                    title={`Remove ${b.id}`}
                    onClick={() => onToggle(b)}
                    style={{
                      background: "none",
                      border: 0,
                      color: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    <Ico n="cross" size={12} />
                  </button>
                </span>
              ))}
            </div>
            <button
              type="button"
              className="pg-btn"
              style={{ marginTop: 8 }}
              aria-expanded={picker}
              title="Select builds"
              onClick={() => setPicker(!picker)}
            >
              Select builds…
            </button>
            {picker ? (
              <ul
                className="pg-card"
                style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}
              >
                {list.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      className="pg-btn flat"
                      style={{
                        width: "100%",
                        height: "auto",
                        padding: "8px",
                        justifyContent: "flex-start",
                        whiteSpace: "normal",
                        textAlign: "left",
                      }}
                      title={`Compare ${b.id}`}
                      onClick={() => onToggle(b)}
                    >
                      <span style={{ width: 16 }}>
                        {sel.includes(b) ? <Ico n="tick" size={12} /> : null}
                      </span>
                      <span>
                        {b.id}
                        <span
                          className="pg-sm pg-mut"
                          style={{ display: "block" }}
                        >{`Started ${tsFmt(b.started_at)}`}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {list.length ? null : (
                  <li className="pg-note">No builds yet</li>
                )}
              </ul>
            ) : null}
          </div>
        </aside>
        <div className="pg-col">
          <section className="pg-card">
            <h3>Overall</h3>
            <table className="pg-tbl">
              <thead>
                <tr>
                  <th />
                  {sel.map((b, i) => (
                    <th
                      key={b.id}
                      style={{ background: PAIR[i], color: "#fff" }}
                    >
                      {b.id}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {info.map(([lab, f]) => (
                  <tr key={lab}>
                    <td className="pg-mut">{lab}</td>
                    {sel.map((b) => (
                      <td key={b.id}>{f(b)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="pg-note" style={{ margin: 0 }}>
              No evaluation metrics: no labelled evaluation set on this box
            </p>
          </section>
          <section className="pg-card" style={{ overflow: "auto" }}>
            <h3>Metrics</h3>
            <table className="pg-tbl">
              <thead>
                <tr>
                  <th>Build</th>
                  {HEADS.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sel.map((b, i) => (
                  <tr key={b.id}>
                    <td style={{ background: PAIR[i], color: "#fff" }}>
                      {b.id}
                    </td>
                    {HEADS.map((h) => (
                      <td key={h}>
                        {h === "Row Count" ? String(b.rows_out) : "n/a"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="cp-grid">
            {CHARTS.map((ch) => (
              <section key={ch} className="pg-card">
                <h3>{ch}</h3>
                <p className="pg-note" style={{ margin: 0 }}>
                  n/a: no evaluation set
                </p>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

type Page = "catalogue" | "page" | "eval";

export function TransformsView({
  nav,
  onLineage,
}: {
  nav: (v: FoundryNav) => void;
  onLineage: (id?: string) => void;
}): JSX.Element {
  const setAppView = useAppView((s) => s.setApp);
  const [nonce, setNonce] = useState(0);
  const tfR = useJson<Transform[]>("/api/foundry/transforms");
  const dsR = useJson<Dataset[]>("/api/foundry/datasets");
  const bR = useJson<Build[]>("/api/foundry/builds", nonce);
  const ckR = useJson<Check[]>("/api/foundry/checks");
  const bnd = useJson<Binding[]>("/api/foundry/bindings");
  const [page, setPage] = useState<Page>("catalogue");
  const [tfId, setTfId] = useState<string | null>(null);
  const [pairIds, setPairIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [runMsg, setRunMsg] = useState("");

  const tfs = tfR?.data ?? [];
  const ds = new Map((dsR?.data ?? []).map((d) => [d.id, d]));
  const builds = bR?.data ?? [];
  const tf =
    tfs.find((t) => t.id === tfId) ??
    tfs.find((t) => t.name === "fast_vessels_tf") ??
    tfs[0];
  const shell = (body: JSX.Element): JSX.Element => (
    <div className="aip-pg">
      <PageNav here="transforms" nav={nav} />
      <div className="pg-body">
        <div className="pg-scroll">{body}</div>
      </div>
    </div>
  );
  if (!tfR?.ok || !tf)
    return shell(
      <div className="pg-note">
        {tfR?.ok ? "No transform on this box" : unavailable("Transforms", tfR)}
      </div>,
    );
  const tfBuilds = builds.filter(
    (b) =>
      b.transform_id === tf.id ||
      (b.log ?? []).some((l) => l.includes(tf.name + ":")),
  );
  const ctx: Ctx = {
    tf,
    tin: ds.get(tf.inputs[0] ?? ""),
    tout: ds.get(tf.output_dataset_id),
    tfBuilds,
    builds,
    checks: ckR?.ok ? (ckR.data ?? []) : null,
    ds,
    boundKinds: (bnd?.data ?? [])
      .filter(
        (b) =>
          b.dataset_id === tf.inputs[0] ||
          b.dataset_id === tf.output_dataset_id,
      )
      .map((b) => b.object_kind),
  };
  const run = async (path: string): Promise<void> => {
    setBusy(true);
    setRunMsg("building…");
    try {
      const r = await apiFetch(path, { method: "POST" });
      setRunMsg(r.ok ? "" : `Build failed to start (HTTP ${r.status})`);
    } catch {
      setRunMsg("Build failed to start (network error)");
    }
    setBusy(false);
    setNonce((n) => n + 1);
  };
  const sel = (
    pairIds
      ? pairIds
          .map((id) => builds.find((b) => b.id === id))
          .filter((b): b is Build => Boolean(b))
      : tfBuilds.slice(0, 2)
  ).slice(0, 2);
  const toggle = (b: Build): void => {
    const cur = sel.map((x) => x.id);
    setPairIds(
      cur.includes(b.id)
        ? cur.filter((x) => x !== b.id)
        : [...cur, b.id].slice(-2),
    );
  };
  if (page === "catalogue")
    return shell(
      <Catalogue
        tfs={tfs}
        c={{ ds, builds, bindings: bnd?.data?.length ?? 0, tfName: tf.name }}
        onOpen={(id) => {
          setTfId(id);
          setPage("page");
        }}
        setApp={setAppView}
      />,
    );
  if (page === "page")
    return shell(
      <TransformPage
        c={ctx}
        busy={busy}
        runMsg={runMsg}
        onRun={() => void run(`/api/foundry/transforms/${tf.id}/build`)}
        onAll={() => setPage("eval")}
        onBack={() => setPage("catalogue")}
        onLineage={onLineage}
      />,
    );
  return shell(
    <Compare
      c={ctx}
      sel={sel}
      busy={busy}
      onBack={() => setPage("page")}
      onHome={() => setPage("catalogue")}
      onToggle={toggle}
      onClear={() => setPairIds([])}
      onRun={() => void run("/api/foundry/pipeline/build")}
    />,
  );
}
