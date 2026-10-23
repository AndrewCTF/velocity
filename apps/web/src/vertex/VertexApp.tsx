// Vertex app: a system graph of this platform's own data flow, drawn left to
// right as catalog sources, live feeds and globe layers. Every node and count is
// real: GET /api/sources/catalog, GET /api/status and the layer registry. An
// edge is drawn only where a feed's snapshot is the endpoint a layer polls
// (FEED_LINKS below); the catalog column has no such relation and stays
// unconnected. The docked Series panel reads GET /api/history/timeseries.
// Layout is hand-rolled SVG, like graph/InvestigationCanvas.tsx.
import { useMemo, useState } from "react";
import type { LayerDescriptor } from "@osint/shared";
import { defaultLayers } from "../registry/defaults.js";
import {
  fmtTime,
  seriesProblem,
  useJson,
  type PlatformStatus,
  type SeriesResponse,
  type SourceCatalog,
  type StatusFeed,
} from "./useJson.js";

type SeriesKind = "aircraft" | "vessel" | "total";

/** Which layer endpoint each /api/status feed backs, and which archived count it is. */
const FEED_LINKS: { match: RegExp; endpoint: string; kind: SeriesKind | null }[] =
  [
    { match: /^ADS-B aircraft/, endpoint: "/api/adsb/global", kind: "aircraft" },
    { match: /^AIS vessels .*keyless/, endpoint: "/api/maritime/snapshot", kind: "vessel" },
    { match: /AISStream/, endpoint: "/ws/ais", kind: null },
    { match: /^GPS\/GNSS jamming/, endpoint: "/api/jamming/nacp", kind: null },
    { match: /^USGS earthquakes/, endpoint: "/api/eq", kind: null },
    { match: /^Sentinel-1 SAR/, endpoint: "/api/intel/dark-vessels/sar", kind: null },
    { match: /^NASA FIRMS/, endpoint: "/api/firms", kind: null },
  ];

function servesEndpoint(layer: LayerDescriptor, base: string): boolean {
  const e = layer.endpoint;
  return e === base || e.startsWith(`${base}?`) || e.startsWith(`${base}/`);
}

type GNode =
  | { id: string; col: 0; label: string; category: string; n: number }
  | { id: string; col: 1; label: string; feed: StatusFeed; kind: SeriesKind | null }
  | { id: string; col: 2; label: string; layer: LayerDescriptor };
interface GEdge {
  from: string;
  to: string;
  count: number | undefined;
}

const COL_X = [16, 372, 728] as const;
const NODE_W = 300;
const NODE_H = 26;
const ROW = 32;
const TOP = 44;
const COL_TITLES = ["Sources (catalog)", "Feeds (live)", "Layers (registry)"];

function chipClass(status: string): string {
  if (status === "green") return "g";
  if (status === "degraded") return "w";
  if (status === "red" || status === "down") return "r";
  return "";
}

function iconFill(n: GNode): string {
  if (n.col === 0) return "var(--txt-3)";
  if (n.col === 2) return "var(--accent)";
  const c = chipClass(n.feed.status);
  return c === "g" ? "var(--ok-fg)" : c === "w" ? "var(--warn-fg)" : c === "r" ? "var(--alert-fg)" : "var(--txt-3)";
}

function clip(s: string, max = 36): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function buildGraph(
  status: PlatformStatus | null,
  catalog: SourceCatalog | null,
  layers: readonly LayerDescriptor[],
): { nodes: GNode[]; edges: GEdge[] } {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  for (const cat of catalog?.categories ?? []) {
    const n = catalog!.sources.filter((s) => s.category === cat).length;
    nodes.push({ id: `src:${cat}`, col: 0, label: cat.replace(/_/g, " "), category: cat, n });
  }
  const linked: LayerDescriptor[] = [];
  (status?.feeds ?? []).forEach((feed, i) => {
    const link = FEED_LINKS.find((l) => l.match.test(feed.name));
    const id = `feed:${i}`;
    nodes.push({ id, col: 1, label: feed.name, feed, kind: link?.kind ?? null });
    if (!link) return;
    for (const layer of layers) {
      if (!servesEndpoint(layer, link.endpoint)) continue;
      edges.push({ from: id, to: `layer:${layer.id}`, count: feed.count });
      if (!linked.includes(layer)) linked.push(layer);
    }
  });
  // Fed layers first, in feed order, so edges stay short; the rest by group.
  const rest = layers
    .filter((l) => !linked.includes(l))
    .sort((a, b) => a.group.localeCompare(b.group));
  for (const layer of [...linked, ...rest])
    nodes.push({ id: `layer:${layer.id}`, col: 2, label: layer.title, layer });
  return { nodes, edges };
}

function edgeWidth(count: number | undefined): number {
  return count && count > 0 ? 1 + Math.log10(count + 1) * 1.2 : 1;
}

function StepChart({ kind }: { kind: SeriesKind }): JSX.Element {
  const s = useJson<SeriesResponse>("/api/history/timeseries?window_sec=3600&bucket_sec=300");
  const problem = seriesProblem(s);
  if (problem) return <div className="k-empty">{problem}</div>;
  if (!s.data) return <div className="k-empty">loading…</div>;
  const b = s.data.buckets;
  const vals = b.map((x) => x[kind]);
  const max = Math.max(...vals, 1);
  const W = 900;
  const H = 80;
  const step = W / b.length;
  const y = (v: number): number => H - 4 - (v / max) * (H - 8);
  let d = `M0 ${y(vals[0]!)}`;
  vals.forEach((v, i) => {
    d += ` V${y(v)} H${(i + 1) * step}`;
  });
  return (
    <div className="px-4 pb-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-20 w-full" preserveAspectRatio="none" aria-label={`${kind} per ${s.data.bucket_sec / 60} min bucket`}>
        <path d={d} style={{ fill: "none", stroke: "var(--accent-fg)", strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[12px] text-txt-3">
        <span className="mono">{fmtTime(b[0]!.t)}</span>
        <span>
          {kind} · min <span className="mono">{Math.min(...vals)}</span> · max{" "}
          <span className="mono">{Math.max(...vals)}</span> · {b.length} buckets
        </span>
        <span className="mono">{fmtTime(b[b.length - 1]!.t)}</span>
      </div>
    </div>
  );
}

function Kv({ rows }: { rows: [string, string | number | undefined][] }): JSX.Element {
  return (
    <div className="k-kv">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <span className="k">{k}</span>
          <span className="v">{v === undefined || v === "" ? "—" : String(v)}</span>
        </div>
      ))}
    </div>
  );
}

export function VertexApp(): JSX.Element {
  const status = useJson<PlatformStatus>("/api/status");
  const catalog = useJson<SourceCatalog>("/api/sources/catalog");
  const [selId, setSelId] = useState<string | null>(null);
  const [tab, setTab] = useState<"info" | "search" | "selection">("info");
  const [q, setQ] = useState("");

  const { nodes, edges } = useMemo(
    () => buildGraph(status.data, catalog.data, defaultLayers),
    [status.data, catalog.data],
  );
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    const row = [0, 0, 0];
    for (const n of nodes) m.set(n.id, { x: COL_X[n.col], y: TOP + row[n.col]!++ * ROW });
    return m;
  }, [nodes]);
  const height = TOP + Math.max(1, ...[0, 1, 2].map((c) => nodes.filter((n) => n.col === c).length)) * ROW + 12;
  const sel = nodes.find((n) => n.id === selId) ?? null;
  const select = (id: string): void => {
    setSelId(id);
    setTab("selection");
  };

  const seriesKind: SeriesKind | null = !sel
    ? "total"
    : sel.col === 1
      ? sel.kind
      : sel.col === 2
        ? ((nodes.find(
            (n) => n.col === 1 && edges.some((e) => e.from === n.id && e.to === sel.id),
          ) as Extract<GNode, { col: 1 }> | undefined)?.kind ?? null)
        : null;

  const fedBy = (layerId: string): string =>
    edges
      .filter((e) => e.to === layerId)
      .map((e) => nodes.find((n) => n.id === e.from)?.label ?? e.from)
      .join(", ");

  const hits = q.trim()
    ? nodes.filter((n) => n.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 60)
    : [];

  const colError = (c: 0 | 1): string | null =>
    c === 0
      ? catalog.err
        ? `Source catalog unavailable (${catalog.err}).`
        : catalog.data && catalog.data.categories.length === 0
          ? "The catalog lists no sources (HTTP 200)."
          : null
      : status.err
        ? `Platform status unavailable (${status.err}).`
        : status.data && (status.data.feeds ?? []).length === 0
          ? "Status reported no feeds (HTTP 200)."
          : null;

  const tabBtn = (t: typeof tab, label: string): JSX.Element => (
    <button
      key={t}
      type="button"
      role="tab"
      aria-selected={tab === t}
      onClick={() => setTab(t)}
      className={`px-1 py-3 text-[13px] [writing-mode:vertical-rl] ${tab === t ? "border-l-2 border-accent text-accent" : "text-txt-2 hover:text-txt-0"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-1 font-sans text-txt-0">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-9 shrink-0 flex-col items-center border-r border-line" role="tablist" aria-orientation="vertical">
          {tabBtn("info", "Info")}
          {tabBtn("search", "Search")}
          {tabBtn("selection", "Selection")}
        </nav>
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-line">
          {tab === "info" && (
            <>
              <div className="k-title">System graph</div>
              <Kv
                rows={[
                  ["Aircraft", status.data?.aircraft_count],
                  ["Vessels", status.data?.vessel_count],
                  ["Parked vessels", status.data?.parked_count],
                  ["Catalog sources", catalog.data?.total],
                  ["Feeds", status.data?.feeds?.length],
                  ["Layers", defaultLayers.length],
                  ["Edges drawn", edges.length],
                ]}
              />
              <div className="k-empty">
                An edge means the layer polls the endpoint that feed fills. Catalog sources are
                reference endpoints with no live feed behind them, so they carry no edge.
              </div>
            </>
          )}
          {tab === "search" && (
            <>
              <div className="px-4 py-3">
                <input
                  aria-label="Search nodes"
                  className="w-full border border-line bg-bg-2 px-2 py-1 text-[14px] text-txt-0"
                  placeholder="Search nodes"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              {q.trim() && hits.length === 0 && <div className="k-empty">No node matches.</div>}
              {hits.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className="block w-full truncate px-4 py-1 text-left text-[14px] hover:bg-bg-3"
                  onClick={() => select(n.id)}
                >
                  {n.label} <span className="text-txt-3">· {COL_TITLES[n.col]}</span>
                </button>
              ))}
            </>
          )}
          {tab === "selection" &&
            (!sel ? (
              <div className="k-empty">Click a node to inspect it.</div>
            ) : (
              <>
                <div className="k-title">{sel.label}</div>
                {sel.col === 0 && (
                  <>
                    <Kv rows={[["Category", sel.category], ["Sources", sel.n]]} />
                    <div className="k-band">
                      Sources <span className="k-n">{sel.n}</span>
                    </div>
                    {catalog.data!.sources
                      .filter((s) => s.category === sel.category)
                      .map((s) => (
                        <div key={s.id ?? s.name} className="flex justify-between gap-2 px-4 py-1 text-[14px]">
                          <span className="truncate">{s.name}</span>
                          <span className="k-chip">{s.auth ?? "—"}</span>
                        </div>
                      ))}
                  </>
                )}
                {sel.col === 1 && (
                  <>
                    <div className="px-4">
                      <span className={`k-chip ${chipClass(sel.feed.status)}`}>{sel.feed.status}</span>
                    </div>
                    <Kv
                      rows={[
                        ["Count", sel.feed.count ?? "not reported"],
                        ["Age", sel.feed.age_s != null ? `${sel.feed.age_s} s` : undefined],
                        ["Layers fed", edges.filter((e) => e.from === sel.id).length],
                        ["Detail", sel.feed.detail],
                      ]}
                    />
                  </>
                )}
                {sel.col === 2 && (
                  <Kv
                    rows={[
                      ["Id", sel.layer.id],
                      ["Group", sel.layer.group],
                      ["Emits", sel.layer.emits?.join(", ")],
                      ["Endpoint", sel.layer.endpoint],
                      ["Fed by", fedBy(sel.id) || "no status feed"],
                    ]}
                  />
                )}
              </>
            ))}
        </aside>
        <main className="min-w-0 flex-1 overflow-auto">
          <svg width={COL_X[2] + NODE_W + 16} height={height} role="img" aria-label="Platform data-flow graph">
            {COL_TITLES.map((t, c) => (
              <text key={t} x={COL_X[c]} y={24} style={{ fill: "var(--txt-2)", fontSize: 13, fontWeight: 700 }}>
                {t}
              </text>
            ))}
            {([0, 1] as const).map((c) => {
              const msg = colError(c);
              return msg ? (
                <text key={c} x={COL_X[c]} y={TOP + 16} style={{ fill: "var(--txt-3)", fontSize: 13 }}>
                  {msg}
                </text>
              ) : null;
            })}
            {edges.map((e) => {
              const a = pos.get(e.from)!;
              const b = pos.get(e.to)!;
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const y2 = b.y + NODE_H / 2;
              const mx = (x1 + b.x) / 2;
              const hot = selId === e.from || selId === e.to;
              return (
                <path
                  key={`${e.from}>${e.to}`}
                  data-edge={`${e.from}>${e.to}`}
                  d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${b.x} ${y2}`}
                  style={{ fill: "none", stroke: hot ? "var(--accent)" : "var(--line-2)", strokeWidth: edgeWidth(e.count) }}
                >
                  <title>{e.count != null ? `${e.count} records` : "count not reported"}</title>
                </path>
              );
            })}
            {nodes.map((n) => {
              const p = pos.get(n.id)!;
              const on = n.id === selId;
              return (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-label={n.label}
                  aria-pressed={on}
                  className="cursor-pointer"
                  onClick={() => select(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") select(n.id);
                  }}
                >
                  <rect x={p.x} y={p.y + 4} width={18} height={18} style={{ fill: iconFill(n) }} />
                  <rect
                    x={p.x + 24}
                    y={p.y}
                    width={NODE_W - 24}
                    height={NODE_H}
                    style={{ fill: "var(--bg-2)", stroke: on ? "var(--accent)" : "var(--line-2)", strokeWidth: on ? 2 : 1 }}
                  />
                  <text x={p.x + 32} y={p.y + 17} style={{ fill: "var(--txt-0)", fontSize: 13 }}>
                    {clip(n.label)}
                    {n.col === 0 ? ` (${n.n})` : n.col === 1 && n.feed.count != null ? ` · ${n.feed.count}` : ""}
                  </text>
                </g>
              );
            })}
          </svg>
        </main>
      </div>
      <section className="shrink-0 border-t border-line" aria-label="Series">
        <div className="k-band">
          Series <span className="k-n">{seriesKind ?? "none"}</span>
        </div>
        {seriesKind ? (
          <StepChart kind={seriesKind} />
        ) : (
          <div className="k-empty">
            The archive records aircraft and vessel snapshot counts; {sel?.label} has no recorded series.
          </div>
        )}
      </section>
    </div>
  );
}
