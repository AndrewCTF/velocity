// Workshop app: build small pages ("modules") out of widgets that each read
// real data: metric (GET /api/status counts), series (GET
// /api/history/timeseries), table (GET /api/sources/catalog by category) and
// saved maps (GET /api/maps). Saved maps store map state, not page layouts, so
// modules live in localStorage instead.
import { useEffect, useState } from "react";
import { Trace } from "../entity-panel/ArchiveSeriesCard.js";
import {
  fmtTime,
  seriesProblem,
  useJson,
  type PlatformStatus,
  type SeriesResponse,
  type SourceCatalog,
} from "../vertex/useJson.js";

type WidgetType = "metric" | "series" | "table" | "maps";
type MetricKey = "aircraft_count" | "vessel_count" | "parked_count";
type SeriesKey = "aircraft" | "vessel" | "total";
export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  metric: MetricKey;
  series: SeriesKey;
  windowSec: number;
  category: string;
  wide: boolean;
}
export interface WorkshopModule {
  id: string;
  name: string;
  widgets: Widget[];
}
interface SavedMap {
  id: string;
  name: string;
  updated_at: string;
}

const STORE_KEY = "velocity.workshop.modules.v1";
const TYPE_LABEL: Record<WidgetType, string> = {
  metric: "Metric",
  series: "Series",
  table: "Source table",
  maps: "Saved maps",
};
const METRIC_LABEL: Record<MetricKey, string> = {
  aircraft_count: "Aircraft",
  vessel_count: "Vessels",
  parked_count: "Parked vessels",
};
const WINDOWS = [
  { sec: 3600, label: "1h", bucket: 60 },
  { sec: 21600, label: "6h", bucket: 300 },
  { sec: 86400, label: "24h", bucket: 900 },
];

const uid = (p: string): string =>
  `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function newWidget(type: WidgetType): Widget {
  return {
    id: uid("w"),
    type,
    title: TYPE_LABEL[type],
    metric: "aircraft_count",
    series: "total",
    windowSec: 3600,
    category: "",
    wide: type === "series" || type === "table",
  };
}

function newModule(name = "Untitled module"): WorkshopModule {
  return {
    id: uid("m"),
    name,
    widgets: [newWidget("metric"), newWidget("series"), newWidget("maps")],
  };
}

// shortcut: modules are per-browser, move to a backend store when sharing is needed
function loadModules(): WorkshopModule[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as WorkshopModule[];
    }
  } catch {
    /* corrupt or blocked storage: start from one default module */
  }
  return [newModule("Live overview")];
}

function saveModules(ms: WorkshopModule[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(ms));
  } catch {
    /* storage full or blocked: the modules still live for this session */
  }
}

function MetricBody({ w }: { w: Widget }): JSX.Element {
  const { data, err } = useJson<PlatformStatus>("/api/status");
  if (err) return <div className="k-empty">Platform status unavailable ({err}).</div>;
  if (!data) return <div className="k-empty">loading…</div>;
  const v = data[w.metric];
  if (v == null)
    return <div className="k-empty">Status did not report {METRIC_LABEL[w.metric].toLowerCase()} (HTTP 200).</div>;
  return <div className="mono px-3 pb-3 text-[32px] font-semibold text-txt-0">{v}</div>;
}

function SeriesBody({ w }: { w: Widget }): JSX.Element {
  const win = WINDOWS.find((x) => x.sec === w.windowSec) ?? WINDOWS[0]!;
  const s = useJson<SeriesResponse>(
    `/api/history/timeseries?window_sec=${win.sec}&bucket_sec=${win.bucket}`,
  );
  const problem = seriesProblem(s);
  if (problem) return <div className="k-empty">{problem}</div>;
  if (!s.data) return <div className="k-empty">loading…</div>;
  const b = s.data.buckets;
  const values = b.map((x) => x[w.series]);
  return (
    <div className="px-3 pb-2">
      {values.length < 2 ? (
        <div className="k-empty">One bucket recorded, a line needs two.</div>
      ) : (
        <Trace values={values} width={320} height={90} />
      )}
      <div className="mt-1 flex justify-between text-[12px] text-txt-3">
        <span className="mono">{fmtTime(b[0]!.t)}</span>
        <span>
          latest <span className="mono">{values[values.length - 1]}</span>
        </span>
        <span className="mono">{fmtTime(b[b.length - 1]!.t)}</span>
      </div>
    </div>
  );
}

function TableBody({ w }: { w: Widget }): JSX.Element {
  const { data, err } = useJson<SourceCatalog>("/api/sources/catalog");
  if (err) return <div className="k-empty">Source catalog unavailable ({err}).</div>;
  if (!data) return <div className="k-empty">loading…</div>;
  const rows = data.sources.filter((s) => !w.category || s.category === w.category);
  if (rows.length === 0)
    return <div className="k-empty">No catalog sources in this category (HTTP 200, 0 rows).</div>;
  return (
    <table className="w-full text-[13.5px]">
      <thead>
        <tr className="text-left text-txt-3">
          <th className="px-3 py-1 font-normal">Name</th>
          <th className="px-3 py-1 font-normal">Category</th>
          <th className="px-3 py-1 font-normal">Auth</th>
          <th className="px-3 py-1 font-normal">Format</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id ?? s.name} className="border-t border-line">
            <td className="px-3 py-1">{s.name}</td>
            <td className="px-3 py-1 text-txt-2">{s.category}</td>
            <td className="px-3 py-1">{s.auth ?? "—"}</td>
            <td className="px-3 py-1 text-txt-2">{s.format ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MapsBody(): JSX.Element {
  const { data, err } = useJson<SavedMap[]>("/api/maps");
  if (err) return <div className="k-empty">Saved maps unavailable ({err}).</div>;
  if (!data) return <div className="k-empty">loading…</div>;
  if (data.length === 0) return <div className="k-empty">No saved maps yet (HTTP 200, 0 maps).</div>;
  return (
    <div className="k-kv">
      {data.map((m) => (
        <div key={m.id} className="contents">
          <span className="k">{m.name}</span>
          <span className="v mono">{m.updated_at.slice(0, 16).replace("T", " ")}</span>
        </div>
      ))}
    </div>
  );
}

function WidgetConfig({
  w,
  onChange,
}: {
  w: Widget;
  onChange: (w: Widget) => void;
}): JSX.Element {
  const [tab, setTab] = useState<"setup" | "display">("setup");
  const catalog = useJson<SourceCatalog>(w.type === "table" ? "/api/sources/catalog" : null);
  const sel = "w-full border border-line bg-bg-2 px-2 py-1 text-txt-0";
  return (
    <>
      <div className="k-ptabs" role="tablist">
        {(["setup", "display"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className="k-ptab" onClick={() => setTab(t)}>
            {t === "setup" ? "Widget setup" : "Display"}
          </button>
        ))}
      </div>
      {tab === "setup" && (
        <div className="space-y-3 px-4 py-3 text-[14px]">
          <div className="text-txt-3">Type · {TYPE_LABEL[w.type]}</div>
          {w.type === "metric" && (
            <label className="block">
              <span className="text-txt-3">Count</span>
              <select className={sel} value={w.metric} onChange={(e) => onChange({ ...w, metric: e.target.value as MetricKey })}>
                {(Object.keys(METRIC_LABEL) as MetricKey[]).map((k) => (
                  <option key={k} value={k}>{METRIC_LABEL[k]}</option>
                ))}
              </select>
            </label>
          )}
          {w.type === "series" && (
            <>
              <label className="block">
                <span className="text-txt-3">Metric</span>
                <select className={sel} value={w.series} onChange={(e) => onChange({ ...w, series: e.target.value as SeriesKey })}>
                  {(["aircraft", "vessel", "total"] as const).map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-txt-3">Window</span>
                <select className={sel} value={w.windowSec} onChange={(e) => onChange({ ...w, windowSec: Number(e.target.value) })}>
                  {WINDOWS.map((x) => (
                    <option key={x.sec} value={x.sec}>{x.label}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          {w.type === "table" && (
            <label className="block">
              <span className="text-txt-3">Category</span>
              <select className={sel} value={w.category} onChange={(e) => onChange({ ...w, category: e.target.value })}>
                <option value="">All categories</option>
                {(catalog.data?.categories ?? []).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              {catalog.err && <span className="text-txt-3">Categories unavailable ({catalog.err}).</span>}
            </label>
          )}
          {w.type === "maps" && <div className="text-txt-3">Lists GET /api/maps and takes no parameters.</div>}
        </div>
      )}
      {tab === "display" && (
        <div className="space-y-3 px-4 py-3 text-[14px]">
          <label className="block">
            <span className="text-txt-3">Title</span>
            <input className={sel} value={w.title} onChange={(e) => onChange({ ...w, title: e.target.value })} />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={w.wide} onChange={(e) => onChange({ ...w, wide: e.target.checked })} />
            Span two columns
          </label>
        </div>
      )}
    </>
  );
}

export function WorkshopApp(): JSX.Element {
  const [modules, setModules] = useState<WorkshopModule[]>(loadModules);
  const [modId, setModId] = useState<string>(() => modules[0]!.id);
  const [selId, setSelId] = useState<string | null>(null);
  const [editing, setEditing] = useState(true);
  useEffect(() => saveModules(modules), [modules]);

  const mod = modules.find((m) => m.id === modId) ?? modules[0]!;
  const selected = editing ? (mod.widgets.find((w) => w.id === selId) ?? null) : null;
  const patch = (fn: (m: WorkshopModule) => WorkshopModule): void =>
    setModules((ms) => ms.map((m) => (m.id === mod.id ? fn(m) : m)));
  const setWidgets = (fn: (ws: Widget[]) => Widget[]): void =>
    patch((m) => ({ ...m, widgets: fn(m.widgets) }));
  const move = (i: number, d: -1 | 1): void =>
    setWidgets((ws) => {
      const next = [...ws];
      [next[i], next[i + d]] = [next[i + d]!, next[i]!];
      return next;
    });

  const addModule = (): void => {
    const m = newModule();
    setModules((ms) => [...ms, m]);
    setModId(m.id);
    setSelId(null);
    setEditing(true);
  };
  const removeModule = (id: string): void => {
    const rest = modules.filter((m) => m.id !== id);
    const next = rest.length > 0 ? rest : [newModule()];
    setModules(next);
    if (id === mod.id) setModId(next[0]!.id);
  };
  const addWidget = (t: WidgetType): void => {
    const w = newWidget(t);
    setWidgets((ws) => [...ws, w]);
    setSelId(w.id);
  };

  const iconBtn = "px-1 text-txt-3 hover:text-txt-0 disabled:opacity-40";

  return (
    <div className="flex h-full min-h-0 bg-bg-1 font-sans text-txt-0">
      <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-line">
        <div className="k-title">Modules</div>
        <div className="k-band">
          Saved <span className="k-n">{modules.length}</span>
        </div>
        {modules.map((m) => (
          <div key={m.id} className={`flex items-center justify-between px-4 py-1.5 text-[14px] ${m.id === mod.id ? "bg-bg-3" : ""}`}>
            <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => { setModId(m.id); setSelId(null); }}>
              {m.name}
            </button>
            <button type="button" className={iconBtn} aria-label={`Delete ${m.name}`} onClick={() => removeModule(m.id)}>
              ×
            </button>
          </div>
        ))}
        <div className="px-4 py-2">
          <button type="button" className="k-chip" onClick={addModule}>
            New module
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2">
          {editing ? (
            <input
              aria-label="Module name"
              className="min-w-0 flex-1 border border-line bg-bg-2 px-2 py-1 text-[16px] font-bold text-txt-0"
              value={mod.name}
              onChange={(e) => patch((m) => ({ ...m, name: e.target.value }))}
            />
          ) : (
            <div className="k-title min-w-0 flex-1 truncate p-0!">{mod.name}</div>
          )}
          <button type="button" className="k-chip" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
            {editing ? "View" : "Edit"}
          </button>
        </div>
        {editing && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 text-[14px]">
            <span className="text-txt-3">Add widget</span>
            {(Object.keys(TYPE_LABEL) as WidgetType[]).map((t) => (
              <button key={t} type="button" className="k-chip" onClick={() => addWidget(t)}>
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {mod.widgets.length === 0 && (
            <div className="k-empty">This module has no widgets. {editing ? "Add one above." : "Switch to Edit to add one."}</div>
          )}
          <div className="grid grid-cols-2">
            {mod.widgets.map((w, i) => (
              <section
                key={w.id}
                aria-label={w.title}
                className={`k-card ${w.wide ? "col-span-2" : ""} ${selected?.id === w.id ? "sel" : ""}`}
                onClick={() => editing && setSelId(w.id)}
              >
                <div className="k-card-hd">
                  <span className="truncate">{w.title}</span>
                  {editing && (
                    <span className="flex shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className={iconBtn} aria-label={`Move ${w.title} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </button>
                      <button type="button" className={iconBtn} aria-label={`Move ${w.title} down`} disabled={i === mod.widgets.length - 1} onClick={() => move(i, 1)}>
                        ↓
                      </button>
                      <button
                        type="button"
                        className={iconBtn}
                        aria-label={`Remove ${w.title}`}
                        onClick={() => {
                          setWidgets((ws) => ws.filter((x) => x.id !== w.id));
                          if (selId === w.id) setSelId(null);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </div>
                <div className="k-card-by">
                  {w.type === "metric" && `${METRIC_LABEL[w.metric]} · live status`}
                  {w.type === "series" && `${w.series} · last ${WINDOWS.find((x) => x.sec === w.windowSec)?.label ?? `${w.windowSec}s`}`}
                  {w.type === "table" && `catalog · ${w.category || "all categories"}`}
                  {w.type === "maps" && "saved maps"}
                </div>
                {w.type === "metric" && <MetricBody w={w} />}
                {w.type === "series" && <SeriesBody w={w} />}
                {w.type === "table" && <TableBody w={w} />}
                {w.type === "maps" && <MapsBody />}
              </section>
            ))}
          </div>
        </div>
      </main>

      {editing && (
        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line">
          {selected ? (
            <WidgetConfig
              key={selected.id}
              w={selected}
              onChange={(next) => setWidgets((ws) => ws.map((x) => (x.id === next.id ? next : x)))}
            />
          ) : (
            <div className="k-empty">Select a widget to set it up.</div>
          )}
        </aside>
      )}
    </div>
  );
}
