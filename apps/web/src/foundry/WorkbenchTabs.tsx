import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  useFoundry,
  type Dataset,
  type GeoFeature,
  type GeoResult,
  type Monitor,
  type MonitorAction,
  type MonitorEvent,
  type MonitorInput,
  type MonitorSeverity,
  type MonitorTrigger,
  type SqlResult,
} from '../state/foundry.js';
import { Badge, type BadgeTone, Btn, Toggle } from '../shell/instruments.js';
import { useConfirm } from '../shell/Modal.js';
import {
  EmptyState,
  Field,
  Select,
  Th,
  cellMono,
  controlCls,
  rowCls,
  slugIdent,
  stamp,
  tableHeadCls,
} from './ui.js';

// Three "workbench" dataset-detail tabs added alongside the original
// Schema/Preview/Stats/…: a dependency-free geo plot, a read-only SQL
// console, and rule monitors — each a thin view over the corresponding
// GET/POST /api/foundry/{geo,sql,monitors} routes (state/foundry.ts).

// ── Map tab ──────────────────────────────────────────────────────────────────
// No mapping library — this is a generic lat/lon scatter of arbitrary BYO
// data (not a georeferenced basemap view like maplibre/MapLibreCanvas, which
// needs a bundled regional PMTiles archive + glyphs unrelated to this data).
// Plain SVG, auto-fit to the feature bounds with a padding margin, drawn over
// a 30°-spaced graticule so the plot still reads as "a map" at a glance.
const VB_W = 960;
const VB_H = 480;

interface HoverState {
  feature: GeoFeature;
  clientX: number;
  clientY: number;
}

export function MapTab({ dataset }: { dataset: Dataset }): JSX.Element {
  const loadGeo = useFoundry((s) => s.loadGeo);
  const [geo, setGeo] = useState<GeoResult | null | undefined>(undefined);
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGeo(undefined);
    setHover(null);
    void loadGeo(dataset.id).then((g) => {
      if (!cancelled) setGeo(g);
    });
    return () => {
      cancelled = true;
    };
  }, [dataset.id, loadGeo]);

  if (geo === undefined) {
    return <div className="p-4 mono text-[11px] text-txt-3">Loading map…</div>;
  }
  if (geo === null || !geo.ok) {
    return (
      <div className="p-4">
        <EmptyState icon="⊙" title="No map to show" hint={geo === null ? 'Failed to load geo data.' : geo.reason} />
      </div>
    );
  }
  const features = geo.features.features;
  if (features.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          icon="⊙"
          title="No plottable rows"
          hint={`Columns ${geo.lat_col}/${geo.lon_col} were detected, but no row had valid coordinates in both.`}
        />
      </div>
    );
  }

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const padLon = Math.max((maxLon - minLon) * 0.08, 0.5);
  const padLat = Math.max((maxLat - minLat) * 0.08, 0.5);
  const x0 = Math.max(minLon - padLon, -180);
  const x1 = Math.min(maxLon + padLon, 180);
  const y0 = Math.max(minLat - padLat, -90);
  const y1 = Math.min(maxLat + padLat, 90);
  const spanLon = x1 - x0 || 1;
  const spanLat = y1 - y0 || 1;

  const sx = (lon: number): number => ((lon - x0) / spanLon) * VB_W;
  const sy = (lat: number): number => ((y1 - lat) / spanLat) * VB_H;

  const gratLons: number[] = [];
  for (let g = Math.ceil(x0 / 30) * 30; g <= x1 + 1e-9; g += 30) gratLons.push(g);
  const gratLats: number[] = [];
  for (let g = Math.ceil(y0 / 30) * 30; g <= y1 + 1e-9; g += 30) gratLats.push(g);

  const tooltipProps = hover
    ? Object.entries(hover.feature.properties).filter(([k]) => k !== '_idx').slice(0, 3)
    : [];

  return (
    <div className="space-y-1.5" data-testid="map-tab">
      <div className="relative rounded-md border border-line-2 bg-bg-1 overflow-hidden">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="w-full h-[60vh] block"
          role="img"
          aria-label={`Map of ${features.length} points`}
        >
          <rect x={0} y={0} width={VB_W} height={VB_H} fill="var(--bg-0)" />
          {gratLons.map((g) => (
            <line key={`glon-${g}`} x1={sx(g)} y1={0} x2={sx(g)} y2={VB_H} stroke="var(--line-2)" strokeWidth={0.5} />
          ))}
          {gratLats.map((g) => (
            <line key={`glat-${g}`} x1={0} y1={sy(g)} x2={VB_W} y2={sy(g)} stroke="var(--line-2)" strokeWidth={0.5} />
          ))}
          {features.map((f) => {
            const [lon, lat] = f.geometry.coordinates;
            return (
              <circle
                key={f.properties._idx}
                data-testid="geo-point"
                cx={sx(lon)}
                cy={sy(lat)}
                r={2.75}
                fill="var(--accent)"
                stroke="var(--bg-0)"
                strokeWidth={0.5}
                className="cursor-pointer"
                onMouseEnter={(e) => setHover({ feature: f, clientX: e.clientX, clientY: e.clientY })}
                onMouseMove={(e) => setHover({ feature: f, clientX: e.clientX, clientY: e.clientY })}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </svg>
        {hover && (
          <div
            className="fixed z-10 pointer-events-none rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[10px] mono text-txt-1 shadow-[var(--sh-2)]"
            style={{ left: hover.clientX + 10, top: hover.clientY + 10 }}
            data-testid="map-tooltip"
          >
            <div className="text-txt-3">row #{hover.feature.properties._idx}</div>
            {tooltipProps.map(([k, v]) => (
              <div key={k}>
                <span className="text-txt-3">{k}:</span> {String(v)}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mono text-[10px] text-txt-3">
        {geo.count.toLocaleString()} points · lat <span className="text-txt-2">{geo.lat_col}</span> · lon{' '}
        <span className="text-txt-2">{geo.lon_col}</span>
        {features.length >= 5000 ? ' · capped at 5,000' : ''}
      </div>
    </div>
  );
}

// ── SQL tab ──────────────────────────────────────────────────────────────────
export function SqlTab({ dataset }: { dataset: Dataset }): JSX.Element {
  const runSql = useFoundry((s) => s.runSql);
  const slug = useMemo(() => slugIdent(dataset.name), [dataset.name]);
  const [query, setQuery] = useState(`SELECT * FROM ${slug} LIMIT 50`);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  // Bumped on every dataset switch so an in-flight run() for the old dataset
  // can't paint its rows (or leave the Run button stuck) under the new one.
  const runSeqRef = useRef(0);

  useEffect(() => {
    runSeqRef.current++;
    setQuery(`SELECT * FROM ${slug} LIMIT 50`);
    setResult(null);
    setElapsedMs(null);
    setRunning(false);
  }, [dataset.id, slug]);

  const run = async (): Promise<void> => {
    if (!query.trim() || running) return;
    const seq = runSeqRef.current;
    setRunning(true);
    const t0 = performance.now();
    const r = await runSql([dataset.id], query, 1000);
    if (seq !== runSeqRef.current) return; // dataset switched mid-run
    setElapsedMs(Math.round(performance.now() - t0));
    setResult(r);
    setRunning(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
    }
  };

  return (
    <div className="space-y-2" data-testid="sql-tab">
      <div className="text-[10px] text-txt-4">
        Available table: <span className="mono text-txt-2">{slug}</span>
      </div>
      <textarea
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        rows={5}
        spellCheck={false}
        placeholder={`SELECT * FROM ${slug} LIMIT 50`}
        className={`${controlCls} font-mono resize-y`}
        data-testid="sql-query-input"
      />
      <div className="flex items-center gap-2">
        <Btn tone="accent" disabled={!query.trim() || running} onClick={() => void run()}>
          {running ? 'Running…' : '▶ Run'}
        </Btn>
        <span className="text-[10px] text-txt-4">Ctrl/Cmd+Enter to run</span>
        {result?.ok && (
          <span className="mono text-[10px] text-txt-3 ml-auto">
            {result.row_count.toLocaleString()} row{result.row_count === 1 ? '' : 's'}
            {elapsedMs != null ? ` · ${elapsedMs}ms` : ''}
          </span>
        )}
      </div>
      {result && !result.ok && (
        <div className="rounded-sm border border-alert bg-alert-bg px-2.5 py-2 text-[11px] text-alert" data-testid="sql-error">
          {result.error}
        </div>
      )}
      {result?.ok && (
        <div className="overflow-auto rounded-md border border-line-2 bg-bg-1 max-h-[50vh]">
          <table className="w-full border-collapse">
            <thead>
              <tr className={tableHeadCls()}>
                {result.columns.map((c) => (
                  <Th key={c}>{c}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className={rowCls}>
                  {result.columns.map((c) => (
                    <td key={c} className={cellMono}>
                      {String((row as Record<string, unknown>)[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={result.columns.length || 1} className="px-2.5 py-3 text-center mono text-[11px] text-txt-3">
                    No rows.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Monitors tab ─────────────────────────────────────────────────────────────
const TRIGGERS: MonitorTrigger[] = ['new_version', 'row_condition', 'check_failed', 'build_failed'];
const ACTIONS: MonitorAction[] = ['alert', 'llm', 'both'];
const SEVERITIES: MonitorSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];
const LLM_TIERS: Array<'fast' | 'reason'> = ['fast', 'reason'];

const SEVERITY_TONE: Record<MonitorSeverity, BadgeTone> = {
  info: 'neutral',
  low: 'neutral',
  medium: 'warn',
  high: 'alert',
  critical: 'alert',
};

const ACTION_TONE: Record<MonitorAction, BadgeTone> = {
  alert: 'neutral',
  llm: 'mag',
  both: 'accent',
};

interface MonitorForm {
  name: string;
  trigger: MonitorTrigger;
  conditionExpr: string;
  action: MonitorAction;
  llmTier: 'fast' | 'reason';
  llmSystem: string;
  llmPrompt: string;
  severity: MonitorSeverity;
  enabled: boolean;
}

function emptyForm(): MonitorForm {
  return {
    name: '',
    trigger: 'new_version',
    conditionExpr: '',
    action: 'alert',
    llmTier: 'fast',
    llmSystem: '',
    llmPrompt: '',
    severity: 'medium',
    enabled: true,
  };
}

function formFromMonitor(m: Monitor): MonitorForm {
  return {
    name: m.name,
    trigger: m.trigger,
    conditionExpr: m.condition_expr,
    action: m.action,
    llmTier: m.llm_tier,
    llmSystem: m.llm_system,
    llmPrompt: m.llm_prompt,
    severity: m.severity,
    enabled: m.enabled,
  };
}

function toBody(datasetId: string, f: MonitorForm): MonitorInput {
  return {
    dataset_id: datasetId,
    name: f.name.trim(),
    trigger: f.trigger,
    condition_expr: f.trigger === 'row_condition' ? f.conditionExpr : '',
    action: f.action,
    llm_tier: f.llmTier,
    llm_system: f.action !== 'alert' ? f.llmSystem : '',
    llm_prompt: f.action !== 'alert' ? f.llmPrompt : '',
    severity: f.severity,
    enabled: f.enabled,
  };
}

export function MonitorsTab({ datasetId }: { datasetId: string }): JSX.Element {
  const monitors = useFoundry((s) => s.monitors);
  const loadMonitors = useFoundry((s) => s.loadMonitors);
  const createMonitor = useFoundry((s) => s.createMonitor);
  const updateMonitor = useFoundry((s) => s.updateMonitor);
  const deleteMonitor = useFoundry((s) => s.deleteMonitor);
  const loadMonitorEvents = useFoundry((s) => s.loadMonitorEvents);
  const { confirm, confirmElement } = useConfirm();

  const [form, setForm] = useState<MonitorForm>(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  // Bumped on dataset switch / each selection so a slow events fetch can't
  // paint an earlier monitor's events under a later selection.
  const selectSeqRef = useRef(0);

  useEffect(() => {
    selectSeqRef.current++;
    void loadMonitors(datasetId);
    setSelectedId(null);
    setEvents([]);
    setEditingId(null);
    setForm(emptyForm());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  const selectMonitor = (id: string): void => {
    const seq = ++selectSeqRef.current;
    setSelectedId(id);
    void loadMonitorEvents(id).then((ev) => {
      if (seq === selectSeqRef.current) setEvents(ev);
    });
  };

  const startEdit = (m: Monitor): void => {
    setEditingId(m.id);
    setForm(formFromMonitor(m));
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setForm(emptyForm());
  };

  const submit = async (): Promise<void> => {
    if (!form.name.trim()) return;
    const body = toBody(datasetId, form);
    const result = editingId ? await updateMonitor(editingId, body) : await createMonitor(body);
    if (result) {
      cancelEdit();
      await loadMonitors(datasetId);
    }
  };

  const toggleEnabled = async (m: Monitor, next: boolean): Promise<void> => {
    await updateMonitor(m.id, toBody(datasetId, { ...formFromMonitor(m), enabled: next }));
  };

  const onDelete = async (m: Monitor): Promise<void> => {
    if (await confirm({ title: `Delete monitor "${m.name}"?`, body: 'Its event history is removed too.', tone: 'danger', confirmLabel: 'Delete' })) {
      const ok = await deleteMonitor(m.id);
      if (ok) {
        if (selectedId === m.id) {
          setSelectedId(null);
          setEvents([]);
        }
        await loadMonitors(datasetId);
      }
    }
  };

  const showCondition = form.trigger === 'row_condition';
  const showLlm = form.action !== 'alert';

  return (
    <div className="space-y-3" data-testid="monitors-tab">
      <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className={tableHeadCls()}>
              <Th>Name</Th>
              <Th>Trigger</Th>
              <Th>Action</Th>
              <Th>Severity</Th>
              <Th align="center">Enabled</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {monitors.map((m) => (
              <tr
                key={m.id}
                className={`${rowCls} cursor-pointer ${selectedId === m.id ? 'bg-accent-dim' : ''}`}
                onClick={() => selectMonitor(m.id)}
              >
                <td className={`${cellMono} text-txt-0`}>{m.name}</td>
                <td className={`${cellMono} text-txt-2`}>{m.trigger}</td>
                <td className="px-2.5 py-1.5"><Badge tone={ACTION_TONE[m.action]}>{m.action}</Badge></td>
                <td className="px-2.5 py-1.5"><Badge tone={SEVERITY_TONE[m.severity]}>{m.severity}</Badge></td>
                <td className="px-2.5 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                  <Toggle on={m.enabled} onChange={(next) => void toggleEnabled(m, next)} label={`${m.name} enabled`} />
                </td>
                <td className="px-2.5 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                  <button type="button" onClick={() => startEdit(m)} className="text-txt-3 hover:text-accent text-[10px] mono mr-2">edit</button>
                  <button type="button" onClick={() => void onDelete(m)} className="text-txt-3 hover:text-alert text-[12px]" aria-label={`Delete monitor ${m.name}`}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {monitors.length === 0 && (
          <div className="p-4">
            <EmptyState icon="◈" title="No monitors" hint="Watch this dataset for new versions, row conditions, or failed checks/builds — fire an alert, an LLM summary, or both." />
          </div>
        )}
      </div>

      <div className="rounded-md border border-line-2 bg-bg-1 p-3 space-y-2.5">
        <div className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">
          {editingId ? 'Edit monitor' : 'New monitor'}
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <div className="w-40"><Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="row spike" className={controlCls} /></Field></div>
          <div className="w-36">
            <Field label="Trigger">
              <Select value={form.trigger} onChange={(v) => setForm({ ...form, trigger: v as MonitorTrigger })} options={TRIGGERS.map((t) => ({ value: t, label: t }))} />
            </Field>
          </div>
          <div className="w-32">
            <Field label="Action">
              <Select value={form.action} onChange={(v) => setForm({ ...form, action: v as MonitorAction })} options={ACTIONS.map((a) => ({ value: a, label: a }))} />
            </Field>
          </div>
          <div className="w-28">
            <Field label="Severity">
              <Select value={form.severity} onChange={(v) => setForm({ ...form, severity: v as MonitorSeverity })} options={SEVERITIES.map((s) => ({ value: s, label: s }))} />
            </Field>
          </div>
          {showLlm && (
            <div className="w-28">
              <Field label="LLM tier">
                <Select value={form.llmTier} onChange={(v) => setForm({ ...form, llmTier: v as 'fast' | 'reason' })} options={LLM_TIERS.map((t) => ({ value: t, label: t }))} />
              </Field>
            </div>
          )}
          <label className="flex items-center gap-1.5 mb-[5px]">
            <Toggle on={form.enabled} onChange={(next) => setForm({ ...form, enabled: next })} label="enabled" />
            <span className="text-[10px] uppercase tracking-[0.4px] text-txt-3">enabled</span>
          </label>
        </div>
        {showCondition && (
          <Field label="Condition expression" hint="Safe DSL over row fields, e.g. speed_kn > 40 and flag == 'red'">
            <textarea value={form.conditionExpr} onChange={(e) => setForm({ ...form, conditionExpr: e.target.value })} rows={2} className={`${controlCls} font-mono resize-y`} />
          </Field>
        )}
        {showLlm && (
          <>
            <Field label="LLM system prompt">
              <textarea value={form.llmSystem} onChange={(e) => setForm({ ...form, llmSystem: e.target.value })} rows={2} placeholder="You are a data monitor assistant." className={`${controlCls} resize-y`} />
            </Field>
            <Field label="LLM prompt template" hint="Template vars: {dataset} {rows} {trigger}">
              <textarea value={form.llmPrompt} onChange={(e) => setForm({ ...form, llmPrompt: e.target.value })} rows={3} placeholder={'Summarize {trigger} on {dataset}: {rows}'} className={`${controlCls} font-mono resize-y`} />
            </Field>
          </>
        )}
        <div className="flex items-center gap-2">
          <Btn tone="accent" disabled={!form.name.trim()} onClick={() => void submit()}>{editingId ? 'Save' : '+ Monitor'}</Btn>
          {editingId && <Btn onClick={cancelEdit}>Cancel</Btn>}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">Events</div>
        {!selectedId ? (
          <div className="p-4 rounded-md border border-line-2 bg-bg-1">
            <EmptyState icon="◷" title="Select a monitor" hint="Click a monitor above to see its firing history." />
          </div>
        ) : events.length === 0 ? (
          <div className="p-4 rounded-md border border-line-2 bg-bg-1">
            <EmptyState icon="◷" title="No events yet" hint="This monitor hasn't fired." />
          </div>
        ) : (
          <div className="rounded-md border border-line-2 bg-bg-1 divide-y divide-line">
            {events.map((ev) => (
              <div key={ev.id} className="px-3 py-2 space-y-1">
                <div className="flex items-center gap-2">
                  <Badge tone={ev.kind === 'llm_error' ? 'alert' : 'ok'}>{ev.kind}</Badge>
                  <span className="mono text-[10px] text-txt-3">{stamp(ev.at)}</span>
                </div>
                <p className="text-[11px] text-txt-1 whitespace-pre-wrap">{ev.summary}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      {confirmElement}
    </div>
  );
}
