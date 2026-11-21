// Lineage workspace as a native layout over the real Foundry stores
// (/api/foundry/lineage, datasets, bindings, connections, monitors, kinds,
// builds) and the AI guardrails' clearance. The graph is an SVG whose scene
// coordinates come from lineageLayout (the copy's A7-A12 placement); everything
// around it reflows.
import { useRef, useState } from "react";
import { Chip, Ico, PageNav, type FoundryNav } from "./pg.js";
import {
  comma,
  mon,
  unavailable,
  useJson,
  type Binding,
  type Build,
  type Dataset,
  type Guardrails,
  type Lineage as Lin,
  type Rows,
} from "./data.js";

export type { FoundryNav } from "./pg.js";

// fills carry white text unless noted, all >= 4.5:1
const COL = {
  raw: "#886a4e",
  ref: "#8eb8f4",
  der: "#c2377a",
  tf: "#ead074",
  obj: "#2c58b6",
  nodata: "#666c78",
  view: "#3f64b0",
};

/** lineage_layout(): isolated raw datasets top-left in two columns, each raw
 *  dataset that feeds a transform on its own row (input, transform, output),
 *  reference datasets along the bottom. */
export function lineageLayout(lin: Lin): Map<string, [number, number]> {
  const pos = new Map<string, [number, number]>();
  const touches = (id: string): boolean =>
    lin.edges.some((e) => e.src === id || e.dst === id);
  const iso = lin.nodes.filter(
    (n) => n.type === "dataset" && n.kind === "raw" && !touches(n.id),
  );
  iso.forEach((n, i) =>
    pos.set(n.id, [460 + (i % 2) * 190, 300 + Math.floor(i / 2) * 60]),
  );
  const roots = lin.nodes.filter(
    (n) =>
      n.type === "dataset" &&
      n.kind === "raw" &&
      lin.edges.some((e) => e.src === n.id),
  );
  const slots = [330, 450, 590, 760];
  roots.forEach((n, i) => {
    const y = slots[i] ?? 760 + (i - 3) * 150;
    pos.set(n.id, [820, y]);
    const outs = lin.edges.filter((e) => e.src === n.id).map((e) => e.dst);
    outs.forEach((t, j) => {
      const ty = y + (j - (outs.length - 1) / 2) * 56;
      pos.set(t, [1090, ty]);
      for (const e of lin.edges) if (e.src === t) pos.set(e.dst, [1370, ty]);
    });
  });
  lin.nodes
    .filter((n) => n.kind === "reference")
    .forEach((n, i) => pos.set(n.id, [450 + i * 175, 905]));
  return pos;
}

const KIND_ICON: Record<string, string> = {
  vessel: "ship",
  aircraft: "airplane",
  incident: "warning-sign",
  situation: "eye-open",
  evidence: "document",
};
const kindLabel = (k: string): string =>
  `[Velocity] ${k.charAt(0).toUpperCase()}${k.slice(1)}`;

interface Store {
  lin: Lin;
  ds: Map<string, Dataset>;
  bound: Map<string, Binding>;
  kinds: string[];
}

export interface GNode {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bg: string;
  fg: string;
  chev: boolean;
  icon?: string;
  /** a dataset or transform of the lineage (clickable), not an ontology kind */
  real: boolean;
}
export interface GEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  hot: boolean;
  dashed: boolean;
}

/** Pure scene model: nodes, edges and the box that holds them. */
export function graphModel(
  st: Store,
  mode: "color" | "perm",
  sel: string | null,
): { nodes: GNode[]; edges: GEdge[]; box: [number, number, number, number] } {
  const pos = lineageLayout(st.lin);
  const nodes: GNode[] = [];
  const at = new Map<string, GNode>();
  for (const [nid, [x, y]] of pos) {
    const n = st.lin.nodes.find((q) => q.id === nid);
    if (!n) continue;
    let bg: string;
    let fg = "#fff";
    if (n.type === "transform") [bg, fg] = [COL.tf, "#2a2f33"];
    else if (n.kind === "raw") bg = COL.raw;
    else if (n.kind === "reference") [bg, fg] = [COL.ref, "#1d2a3a"];
    else bg = COL.der;
    if (st.bound.has(nid)) [bg, fg] = [COL.der, "#fff"];
    if (mode === "perm")
      [bg, fg] = [
        (st.ds.get(nid)?.row_count ?? 1) === 0 ? COL.nodata : COL.view,
        "#fff",
      ];
    const g: GNode = {
      id: nid,
      label: n.name,
      x,
      y,
      w: Math.trunc(n.name.length * 7 + 34),
      h: 28,
      bg,
      fg,
      chev: n.type === "transform" || n.kind === "derived",
      real: true,
    };
    nodes.push(g);
    at.set(nid, g);
  }
  const edges: GEdge[] = [];
  for (const e of st.lin.edges) {
    const a = at.get(e.src);
    const b = at.get(e.dst);
    if (!a || !b) continue;
    edges.push({
      x1: a.x + a.w / 2,
      y1: a.y,
      x2: b.x - b.w / 2,
      y2: b.y,
      hot: sel !== null && (e.src === sel || e.dst === sel),
      dashed: false,
    });
  }
  const objBg = mode === "perm" ? COL.view : COL.obj;
  const obj = (id: string, kind: string, x: number, y: number): GNode => ({
    id,
    label: kindLabel(kind),
    x,
    y,
    w: Math.max(150, kindLabel(kind).length * 7 + 44),
    h: 30,
    bg: objBg,
    fg: "#fff",
    chev: false,
    icon: KIND_ICON[kind] ?? "cube",
    real: false,
  });
  // bound kinds sit level with their dataset (the copy's [Velocity] Vessel at 1570)
  for (const b of st.bound.values()) {
    const a = at.get(b.dataset_id);
    if (!a) continue;
    const o = obj(`kind:${b.id}`, b.object_kind, 1570, a.y);
    nodes.push(o);
    edges.push({
      x1: a.x + a.w / 2,
      y1: a.y,
      x2: o.x - o.w / 2,
      y2: o.y,
      hot: false,
      dashed: true,
    });
  }
  // ontology kinds with no upstream dataset (the copy's four), when this box has them
  const boundSet = new Set([...st.bound.values()].map((b) => b.object_kind));
  ["aircraft", "incident", "situation", "evidence"]
    .filter((kd) => st.kinds.includes(kd) && !boundSet.has(kd))
    .forEach((kd, i) =>
      nodes.push(
        obj(
          `kind:${kd}`,
          kd,
          1480 + (i % 2) * 190,
          360 + Math.floor(i / 2) * 120,
        ),
      ),
    );
  if (!nodes.length) return { nodes, edges, box: [0, 0, 800, 400] };
  const x0 = Math.min(...nodes.map((n) => n.x - n.w / 2)) - 40;
  const y0 = Math.min(...nodes.map((n) => n.y - n.h / 2)) - 40;
  const x1 = Math.max(...nodes.map((n) => n.x + n.w / 2)) + 40;
  const y1 = Math.max(...nodes.map((n) => n.y + n.h / 2)) + 40;
  return { nodes, edges, box: [x0, y0, x1 - x0, y1 - y0] };
}

const TYPE: Record<string, string> = {
  str: "String",
  float: "Double",
  int: "Integer",
  bool: "Boolean",
};

function Graph({
  model,
  sel,
  z,
  onNode,
  onHover,
  onClear,
}: {
  model: ReturnType<typeof graphModel>;
  sel: string | null;
  z: number;
  onNode: (id: string) => void;
  onHover: (id: string | null) => void;
  onClear: () => void;
}): JSX.Element {
  const [bx, by, bw, bh] = model.box;
  const SPR = `${import.meta.env.BASE_URL}bp-sprite.svg#bp-`;
  return (
    <svg
      className="lg-svg"
      role="group"
      aria-label="Master lineage graph"
      viewBox={`${bx} ${by} ${bw} ${bh}`}
      style={{ width: `${z * 100}%`, height: `${z * 100}%` }}
    >
      <rect
        x={bx}
        y={by}
        width={bw}
        height={bh}
        fill="transparent"
        onClick={onClear}
      />
      {model.edges.map((e, i) => {
        const a = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
        const p = [
          [e.x2, e.y2],
          [e.x2 - 8 * Math.cos(a - 0.4), e.y2 - 8 * Math.sin(a - 0.4)],
          [e.x2 - 8 * Math.cos(a + 0.4), e.y2 - 8 * Math.sin(a + 0.4)],
        ];
        const col = e.hot ? "#c25a14" : "#5f686e";
        return (
          <g key={i} pointerEvents="none">
            <line
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke={col}
              strokeWidth={e.hot ? 2 : 1.4}
              strokeDasharray={e.dashed ? "5 4" : undefined}
            />
            <polygon
              points={p
                .map(([u, v]) => `${u!.toFixed(1)},${v!.toFixed(1)}`)
                .join(" ")}
              fill={col}
            />
          </g>
        );
      })}
      {model.nodes.map((n) => {
        const on = n.id === sel;
        return (
          <g
            key={n.id}
            className={n.real ? "lg-node" : undefined}
            data-nid={n.id}
            role={n.real ? "button" : undefined}
            tabIndex={n.real ? 0 : undefined}
            aria-label={n.real ? `Select ${n.label}` : undefined}
            onClick={n.real ? () => onNode(n.id) : undefined}
            onKeyDown={
              n.real
                ? (ev) =>
                    (ev.key === "Enter" || ev.key === " ") &&
                    (ev.preventDefault(), onNode(n.id))
                : undefined
            }
            onMouseEnter={n.real ? () => onHover(n.id) : undefined}
            onMouseLeave={n.real ? () => onHover(null) : undefined}
          >
            <rect
              className="box"
              x={n.x - n.w / 2}
              y={n.y - n.h / 2}
              width={n.w}
              height={n.h}
              rx={3}
              fill={n.bg}
              stroke={on ? "#e8266f" : "none"}
              strokeWidth={on ? 3 : 0}
            />
            {n.icon ? (
              <use
                href={SPR + n.icon}
                x={n.x - n.w / 2 + 8}
                y={n.y - 7}
                width={14}
                height={14}
                fill="#fff"
              />
            ) : null}
            <text
              x={n.icon ? n.x + 8 : n.x - (n.chev ? 6 : 0)}
              y={n.y}
              textAnchor="middle"
              dominantBaseline="central"
              fill={n.fg}
            >
              {n.label}
            </text>
            {n.chev ? (
              <text
                x={n.x + n.w / 2 - 12}
                y={n.y}
                textAnchor="middle"
                dominantBaseline="central"
                fill={n.fg}
              >
                ›
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function Preview({
  ds,
  rows,
  onClose,
}: {
  ds: Dataset;
  rows: ReturnType<typeof useJson<Rows>>;
  onClose: () => void;
}): JSX.Element {
  const [q, setQ] = useState("");
  const rs = rows?.data?.rows ?? [];
  const schema = (rows?.data?.schema ?? ds.schema).filter((c) =>
    c.name.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <section className="lg-drawer" aria-label="Dataset preview">
      <div className="pg-bar">
        <Ico n="th" />
        <b>Preview</b>
        <span>{ds.name}</span>
        <span className="pg-fill" />
        <span className="pg-mut pg-sm">
          {rows?.ok
            ? `Showing first ${rs.length} of ${comma(ds.row_count)} rows`
            : unavailable("Rows", rows)}
        </span>
        <span className="pg-mut pg-sm">{`${ds.schema.length} columns`}</span>
        <input
          className="pg-in"
          placeholder="Search columns"
          aria-label="Search columns"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          type="button"
          className="pg-btn"
          title="Close the preview"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="scroll">
        {schema.length ? null : (
          <p className="pg-note">
            {ds.schema.length
              ? "No column matches this search"
              : "This dataset has no columns"}
          </p>
        )}
        <table className="pg-tbl">
          <thead>
            <tr>
              <th className="num">#</th>
              {schema.map((c) => (
                <th key={c.name} title={TYPE[c.type] ?? c.type}>
                  {c.name}{" "}
                  <span style={{ fontWeight: 400 }}>
                    {TYPE[c.type] ?? c.type}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rs.map((row, r) => (
              <tr key={r}>
                <td className="num">{r + 1}</td>
                {schema.map((c) => {
                  const v = row[c.name];
                  return (
                    <td
                      key={c.name}
                      className="mono"
                      title={
                        v === null || v === undefined ? undefined : String(v)
                      }
                    >
                      {v === null || v === undefined ? "" : String(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function LineageView({
  nav,
  focus,
}: {
  nav: (v: FoundryNav) => void;
  focus?: string | null;
}): JSX.Element {
  const lin = useJson<Lin>("/api/foundry/lineage");
  const dsR = useJson<Dataset[]>("/api/foundry/datasets");
  const bnd = useJson<Binding[]>("/api/foundry/bindings");
  const conns = useJson<{ connections: { kind?: string; type?: string }[] }>(
    "/api/foundry/connections",
  );
  const mons = useJson<unknown[]>("/api/foundry/monitors");
  const kinds = useJson<{ kinds: string[] }>("/api/foundry/kinds");
  const models = useJson<{ installed: unknown[] }>("/api/ai/models");
  const builds = useJson<Build[]>("/api/foundry/builds");
  const guard = useJson<Guardrails>("/api/ai/guardrails");

  const [sel, setSel] = useState<string | null>(focus ?? null);
  const [drawerOpen, setDrawer] = useState(Boolean(focus));
  const [mode, setMode] = useState<"color" | "perm">("color");
  // open by default only where it does not sit on the graph
  const [legend, setLegend] = useState(() => window.innerWidth >= 1800);
  const [z, setZ] = useState(1);
  const [hover, setHover] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const ds = new Map((dsR?.data ?? []).map((d) => [d.id, d]));
  const selDs = sel ? ds.get(sel) : undefined;
  const showDrawer = drawerOpen && Boolean(selDs);
  const rows = useJson<Rows>(
    showDrawer && sel ? `/api/foundry/datasets/${sel}/rows?limit=16` : null,
  );

  if (!lin?.ok || !lin.data)
    return (
      <div className="aip-pg">
        <PageNav here="lineage" nav={nav} />
        <div className="pg-note">{unavailable("Lineage", lin)}</div>
      </div>
    );
  const st: Store = {
    lin: lin.data,
    ds,
    bound: new Map((bnd?.data ?? []).map((b) => [b.dataset_id, b])),
    kinds: kinds?.data?.kinds ?? [],
  };
  const dsNodes = st.lin.nodes.filter((n) => n.type === "dataset");
  const nRaw = dsNodes.filter((n) => n.kind === "raw").length;
  const nRef = dsNodes.filter((n) => n.kind === "reference").length;
  const nTf = st.lin.nodes.filter((n) => n.type === "transform").length;
  const all = dsR?.data ?? [];
  const nNoData = all.filter((d) => d.row_count === 0).length;
  const bl = builds?.data ?? [];
  const bOk = bl.filter((b) => b.status === "succeeded").length;
  const bFail = bl.filter((b) => b.status === "failed").length;
  const cl = conns?.data?.connections ?? [];
  const ck = (re: RegExp): number =>
    cl.filter((c) => re.test(String(c.kind ?? c.type ?? ""))).length;
  const n = (r: { ok: boolean } | null, v: number): string =>
    r?.ok ? String(v) : "n/a";
  const leg: [string, string][] = [
    ["#ae3462", `Data connections (${n(conns, cl.length)})`],
    ["#886a4e", `Raw datasets (${nRaw})`],
    ["#ead074", `Transforms (${nTf})`],
    ["#88e6ce", `Monitors (${n(mons, mons?.data?.length ?? 0)})`],
    ["#60c662", `Stream sources (${n(conns, ck(/mqtt|kafka|stream/i))})`],
    ["#60c662", `HTTP poll sources (${n(conns, ck(/http|poll/i))})`],
    ["#8eb8f4", `Reference datasets (${nRef})`],
    [COL.der, `Ontology-bound (${st.bound.size})`],
    ["#b84858", "Restricted (n/a)"],
    ["#4c72c2", `Ontology kinds (${n(kinds, st.kinds.length)})`],
    ["#c0c6ca", `Models (${n(models, models?.data?.installed.length ?? 0)})`],
    ["#427c42", `Builds (${n(builds, bl.length)})`],
  ];
  const clearance = guard?.ok ? String(guard.data?.clearance ?? 0) : "n/a";
  const perm = mode === "perm";
  const pick = (id: string): void => {
    setSel(id);
    // colour mode opens the preview; permissions mode only selects
    setDrawer(!perm && ds.has(id));
  };
  const clear = (): void => {
    setSel(null);
    setDrawer(false);
  };
  const model = graphModel(st, mode, sel);
  // No access: lineage datasets the datasets route did not list for this
  // principal; Permissions unknown: every lineage dataset when that route did
  // not answer 200 (nothing can be said about access then)
  const listed = new Set(all.map((d) => d.id));
  const nNoAccess = dsR?.ok
    ? dsNodes.filter((d) => !listed.has(d.id)).length
    : 0;
  const nUnknown = dsR?.ok ? 0 : dsNodes.length;
  const locate = (): void => {
    if (!sel) return setZ(1);
    setZ((v) => Math.max(v, 2));
    requestAnimationFrame(() =>
      scroller.current
        ?.querySelector(`[data-nid="${CSS.escape(sel)}"]`)
        ?.scrollIntoView({ block: "center", inline: "center" }),
    );
  };
  const hv = hover ? ds.get(hover) : undefined;

  return (
    <div className="aip-pg">
      <PageNav here="lineage" nav={nav} />
      <div className="pg-bar">
        <span className="pg-row" role="group" aria-label="Node color">
          <button
            type="button"
            className="pg-btn"
            aria-pressed={!perm}
            title="Node color: custom color"
            onClick={() => setMode("color")}
          >
            <Ico n="tint" />
            Custom color
          </button>
          <button
            type="button"
            className="pg-btn"
            aria-pressed={perm}
            title="Node color: permissions"
            onClick={() => setMode("perm")}
          >
            <Ico n="lock" />
            Permissions
          </button>
        </span>
        <button
          type="button"
          className="pg-btn"
          aria-pressed={perm ? undefined : legend}
          disabled={perm}
          title={
            perm
              ? "The permissions panel replaces the legend"
              : legend
                ? "Hide the legend"
                : "Show the legend"
          }
          onClick={() => setLegend(!legend)}
        >
          <Ico n="eye-open" />
          Legend
        </button>
        <button
          type="button"
          className="pg-btn"
          disabled={!selDs || showDrawer}
          title={
            selDs ? "Preview the selected dataset" : "Select a dataset first"
          }
          onClick={() => setDrawer(true)}
        >
          <Ico n="th" />
          Preview
        </button>
        <button
          type="button"
          className="pg-btn"
          disabled={!sel}
          title={sel ? "Clear the selection" : "Nothing selected"}
          onClick={clear}
        >
          Clear selection
        </button>
        <span className="pg-fill" />
        <Chip>
          <Ico n="refresh" size={12} />
          {`${bl.length - bOk - bFail} pending`}
        </Chip>
        <Chip tone="ok">
          <Ico n="tick" size={12} />
          {`${bOk} succeeded`}
        </Chip>
        <Chip tone="bad">
          <Ico n="cross" size={12} />
          {`${bFail} failed`}
        </Chip>
        <span className="pg-row" role="group" aria-label="Zoom">
          <button
            type="button"
            className="pg-btn sq"
            aria-label="Locate: fit the graph"
            title="Locate: fit the graph"
            onClick={locate}
          >
            <Ico n="locate" />
          </button>
          <button
            type="button"
            className="pg-btn sq"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => setZ((v) => Math.min(4, +(v * 1.4).toFixed(2)))}
          >
            <Ico n="zoom-in" />
          </button>
          <button
            type="button"
            className="pg-btn sq"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => setZ((v) => Math.max(0.5, +(v / 1.4).toFixed(2)))}
          >
            <Ico n="zoom-out" />
          </button>
          <button
            type="button"
            className="pg-btn sq"
            aria-label="Zoom to fit"
            title="Zoom to fit"
            onClick={() => setZ(1)}
          >
            <Ico n="zoom-to-fit" />
          </button>
        </span>
      </div>
      <div className="lg-main">
        <div className="lg-stage">
          <div className="lg-scroll" ref={scroller}>
            <Graph
              model={model}
              sel={sel}
              z={z}
              onNode={pick}
              onHover={setHover}
              onClear={clear}
            />
          </div>
          {perm ? (
            <section className="pg-card lg-side" aria-label="Permissions">
              <div className="lg-leg">
                {(
                  [
                    ["#3f64b0", `View data (${all.length - nNoData})`],
                    ["#e88c9e", `No access (${nNoAccess})`],
                    ["#666c78", `No data (${nNoData})`],
                    ["#ced4d4", `Permissions unknown (${nUnknown})`],
                  ] as const
                ).map(([c, lab]) => (
                  <span key={lab}>
                    <i className="lg-sw" style={{ background: c }} />
                    {lab}
                  </span>
                ))}
              </div>
              <dl className="pg-kv pg-pad" style={{ paddingTop: 0 }}>
                <dt>Permissions type</dt>
                <dd>Data access in datasets</dd>
                <dt>View as</dt>
                <dd>{`Local principal (clearance ${clearance})`}</dd>
              </dl>
              <p
                className="pg-mut pg-sm pg-pad"
                style={{ margin: 0, paddingTop: 0 }}
              >
                You are only able to view a user's access level if you have that
                access level.
              </p>
            </section>
          ) : legend ? (
            <section className="pg-card lg-side" aria-label="Legend">
              <div className="lg-leg">
                {leg.map(([c, lab]) => (
                  <span key={lab}>
                    <i className="lg-sw" style={{ background: c }} />
                    {lab}
                  </span>
                ))}
              </div>
            </section>
          ) : null}
          {hv ? (
            <section className="pg-card lg-hover" aria-label="Dataset summary">
              <div className="pg-pad">
                <b>{hv.name}</b>{" "}
                <span className="pg-mut">{`v${hv.latest_version} (master)`}</span>
                <dl className="pg-kv pg-sm" style={{ marginTop: 8 }}>
                  <dt>Path</dt>
                  <dd>{`foundry://${hv.id}`}</dd>
                  <dt>Kind</dt>
                  <dd>{`${hv.kind} dataset, ${hv.schema.length} columns`}</dd>
                  <dt>Last new data</dt>
                  <dd>
                    {mon(new Date(hv.updated_at.slice(0, 10) + "T00:00:00Z"))}
                  </dd>
                  <dt>Rows</dt>
                  <dd>{`${comma(hv.row_count)} (row count from the store, size n/a)`}</dd>
                </dl>
              </div>
            </section>
          ) : null}
        </div>
        {showDrawer && selDs ? (
          <Preview ds={selDs} rows={rows} onClose={() => setDrawer(false)} />
        ) : null}
        {sel ? <div className="lg-foot">1 node selected</div> : null}
      </div>
    </div>
  );
}
