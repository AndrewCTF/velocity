import { useEffect, useMemo, useState } from 'react';
import {
  useFoundry,
  type Check,
  type CheckResult,
  type CheckSeverity,
  type CheckType,
  type ColumnLineage,
  type ColumnStat,
  type Dataset,
  type DatasetDocs,
  type DatasetVersion,
  type DeadLetterEntry,
  type RowsPage,
} from '../state/foundry.js';
import { Badge, Btn, Toggle } from '../shell/instruments.js';
import { useConfirm } from '../shell/Modal.js';
import { Modal } from '../shell/Modal.js';
import { useFoundryNav, type DetailTab } from './nav.js';
import { useFoundryPoll } from './useFoundryPoll.js';
import { UploadModal } from './UploadModal.js';
import {
  EmptyState,
  Field,
  FilterChips,
  Select,
  Tabs,
  Th,
  TypeChip,
  cellMono,
  controlCls,
  rowCls,
  stamp,
  tableHeadCls,
} from './ui.js';

// Datasets — a master/detail workspace: a filterable list (left) and a tabbed
// detail (right) with Schema, Preview, Stats, Versions, Lineage, Dead-letter,
// Checks, and the auto-generated Data Docs. Selection + active tab persist to
// the URL (foundry/nav.ts). Uploads go through the UploadModal (type pinning +
// cascade); deletes/rollback through a styled confirm — no window.prompt.

const PAGE_SIZE = 50;
const CHECK_TYPES: CheckType[] = ['row_count_min', 'row_count_max', 'not_null', 'unique', 'column_exists', 'freshness', 'schema_contract'];

function paramsSummary(check: Check): string {
  if (check.type === 'row_count_min' || check.type === 'row_count_max') return String(check.params.min ?? check.params.max ?? '');
  if (check.type === 'freshness') return `${check.params.column} < ${check.params.max_age_s}s`;
  if (check.type === 'schema_contract') return ((check.params.columns as string[] | undefined) ?? []).join(', ');
  return String(check.params.column ?? '');
}

function AutoSyncBanner(): JSX.Element | null {
  const lastAutoSync = useFoundry((s) => s.lastAutoSync);
  if (!lastAutoSync || lastAutoSync.length === 0) return null;
  return (
    <div className="rounded-md border border-line-2 bg-bg-1 px-3 py-2 space-y-1" data-testid="auto-sync-banner">
      <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3">Ontology auto-sync</div>
      {lastAutoSync.map((a) => (
        <div key={a.binding_id} className="flex items-center gap-2 text-[11px] mono">
          {a.status === 'ok' && a.result ? (
            <>
              <Badge tone="ok">minted {a.result.minted}</Badge>
              <Badge tone="accent">updated {a.result.updated}</Badge>
              {a.result.skipped > 0 && <span className="text-txt-3">skipped {a.result.skipped}</span>}
              {a.result.errors.length > 0 && <Badge tone="alert">{a.result.errors.length} error(s)</Badge>}
            </>
          ) : (
            <span className="text-warn">binding {a.binding_id}: {a.error ?? 'failed'}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function ChecksSection({ datasetId }: { datasetId: string }): JSX.Element {
  const checks = useFoundry((s) => s.checks);
  const loadChecks = useFoundry((s) => s.loadChecks);
  const createCheck = useFoundry((s) => s.createCheck);
  const updateCheck = useFoundry((s) => s.updateCheck);
  const deleteCheck = useFoundry((s) => s.deleteCheck);
  const getCheckResults = useFoundry((s) => s.getCheckResults);

  const [results, setResults] = useState<CheckResult[]>([]);
  const [type, setType] = useState<CheckType>('row_count_min');
  const [name, setName] = useState('');
  const [paramValue, setParamValue] = useState('');
  const [paramValue2, setParamValue2] = useState('');
  const [severity, setSeverity] = useState<CheckSeverity>('warn');

  useEffect(() => {
    void loadChecks(datasetId).then(() => void getCheckResults(datasetId).then(setResults));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  const resultFor = (checkId: string): CheckResult | undefined => results.find((r) => r.check_id === checkId);
  const isCount = type === 'row_count_min' || type === 'row_count_max';

  const buildParams = (): Record<string, unknown> | null => {
    if (type === 'row_count_min') return { min: Number(paramValue) };
    if (type === 'row_count_max') return { max: Number(paramValue) };
    if (type === 'freshness') return paramValue && paramValue2 ? { column: paramValue, max_age_s: Number(paramValue2) } : null;
    if (type === 'schema_contract') {
      const cols = paramValue.split(',').map((s) => s.trim()).filter(Boolean);
      return cols.length ? { columns: cols } : null;
    }
    return paramValue ? { column: paramValue } : null;
  };

  const add = async (): Promise<void> => {
    if (!name) return;
    const params = buildParams();
    if (!params) return;
    await createCheck({ dataset_id: datasetId, name, type, params, severity, enabled: true });
    setName('');
    setParamValue('');
    setParamValue2('');
    void getCheckResults(datasetId).then(setResults);
  };

  const failing = checks.filter((c) => c.enabled && resultFor(c.id)?.passed === false).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">Data health</span>
        {failing > 0 ? <Badge tone="alert">{failing} failing</Badge> : checks.length > 0 ? <Badge tone="ok">all passing</Badge> : null}
      </div>
      <div className="flex items-end gap-2 flex-wrap rounded-md border border-line-2 bg-bg-1 p-3">
        <div className="w-32"><Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="min rows" className={controlCls} /></Field></div>
        <div className="w-40"><Field label="Type"><Select value={type} onChange={(v) => { setType(v as CheckType); setParamValue(''); setParamValue2(''); }} options={CHECK_TYPES.map((t) => ({ value: t, label: t }))} /></Field></div>
        {type === 'freshness' ? (
          <>
            <div className="w-28"><Field label="timestamp col"><input value={paramValue} onChange={(e) => setParamValue(e.target.value)} className={controlCls} /></Field></div>
            <div className="w-24"><Field label="max age (s)"><input value={paramValue2} onChange={(e) => setParamValue2(e.target.value)} type="number" className={controlCls} /></Field></div>
          </>
        ) : type === 'schema_contract' ? (
          <div className="w-52"><Field label="required columns"><input value={paramValue} onChange={(e) => setParamValue(e.target.value)} placeholder="id, name, ts" className={controlCls} /></Field></div>
        ) : (
          <div className="w-28"><Field label={isCount ? 'value' : 'column'}><input value={paramValue} onChange={(e) => setParamValue(e.target.value)} type={isCount ? 'number' : 'text'} className={controlCls} /></Field></div>
        )}
        <div className="w-24"><Field label="Severity"><Select value={severity} onChange={(v) => setSeverity(v as CheckSeverity)} options={[{ value: 'warn', label: 'warn' }, { value: 'fail', label: 'fail' }]} /></Field></div>
        <Btn tone="accent" disabled={!name || !paramValue} onClick={() => void add()}>+ Check</Btn>
      </div>
      <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className={tableHeadCls()}>
              <Th>Name</Th><Th>Type</Th><Th>Params</Th><Th>Severity</Th><Th align="center">Enabled</Th><Th>Result</Th><Th />
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const res = resultFor(c.id);
              return (
                <tr key={c.id} className={rowCls}>
                  <td className={`${cellMono} text-txt-0`}>{c.name}</td>
                  <td className={`${cellMono} text-txt-2`}>{c.type}</td>
                  <td className={`${cellMono} text-txt-3 text-[10px]`}>{paramsSummary(c)}</td>
                  <td className="px-2.5 py-1.5"><Badge tone={c.severity === 'fail' ? 'alert' : 'warn'}>{c.severity}</Badge></td>
                  <td className="px-2.5 py-1.5 text-center"><Toggle on={c.enabled} onChange={(next) => void updateCheck(c.id, { enabled: next }).then(() => void getCheckResults(datasetId).then(setResults))} label="enabled" /></td>
                  <td className="px-2.5 py-1.5">{res ? <Badge tone={res.passed ? 'ok' : c.severity === 'fail' ? 'alert' : 'warn'}>{res.passed ? 'pass' : 'fail'}</Badge> : <span className="text-[10px] text-txt-3">—</span>}</td>
                  <td className="px-2.5 py-1.5 text-right"><button type="button" onClick={() => void deleteCheck(c.id)} className="text-txt-3 hover:text-alert text-[12px]" aria-label="Delete check">✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {checks.length === 0 && <div className="px-2.5 py-3 text-center mono text-[11px] text-txt-3">No checks yet — add one to gate every version write.</div>}
      </div>
    </div>
  );
}

// Data Docs — the auto-generated single-pane dataset overview the backend
// already produced (GET /docs) but no view rendered. Producer/upstream/
// downstream chips deep-link into Pipeline / Datasets.
function DocsTab({ dataset, docs }: { dataset: Dataset; docs: DatasetDocs | null }): JSX.Element {
  const navigate = useFoundryNav((s) => s.navigate);
  const select = useFoundryNav((s) => s.select);
  if (!docs) return <div className="p-4 mono text-[11px] text-txt-3">Loading data docs…</div>;
  const lin = docs.lineage;
  return (
    <div className="space-y-3" data-testid="docs-tab">
      <div className="rounded-md border border-line-2 bg-bg-1 p-3">
        <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3 mb-1">Description</div>
        <div className="text-[11px] text-txt-1">{docs.dataset.description || <span className="text-txt-4">— no description —</span>}</div>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <Badge tone={docs.dataset.kind === 'raw' ? 'accent' : 'mag'}>{docs.dataset.kind}</Badge>
          <span className="mono text-[10px] text-txt-2">v{docs.dataset.latest_version}</span>
          <span className="mono text-[10px] text-txt-2 tabular-nums">{docs.dataset.row_count.toLocaleString()} rows</span>
          {docs.dead_letter_present && <Badge tone="warn">dead-letter present</Badge>}
          {lin.stale === true && <Badge tone="warn">stale</Badge>}
        </div>
      </div>

      <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
        <table className="w-full border-collapse">
          <thead><tr className={tableHeadCls()}><Th>Column</Th><Th>Type</Th></tr></thead>
          <tbody>
            {docs.schema.map((c) => (
              <tr key={c.name} className={rowCls}>
                <td className={`${cellMono} text-txt-0`}>{c.name}</td>
                <td className="px-2.5 py-1.5"><TypeChip type={c.type} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-md border border-line-2 bg-bg-1 p-3 space-y-2">
        <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3">Lineage</div>
        <div className="text-[11px] text-txt-1">
          {lin.produced_by ? (
            <>Produced by{' '}
              <button className="mono text-accent hover:underline" onClick={() => navigate('pipeline', lin.produced_by!)}>{lin.produced_by}</button>
            </>
          ) : 'Raw dataset — each column is its own source.'}
        </div>
        {lin.upstream_datasets.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-txt-3 uppercase tracking-[0.4px]">upstream</span>
            {lin.upstream_datasets.map((id) => (
              <button key={id} className="mono text-[10px] text-accent hover:underline" onClick={() => select(id)}>{id}</button>
            ))}
          </div>
        )}
        {lin.downstream.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px] text-txt-3 uppercase tracking-[0.4px]">downstream</span>
            {lin.downstream.map((d, i) => (
              <div key={i} className="flex items-center gap-1.5 mono text-[10px]">
                <button className="text-mag hover:underline" onClick={() => navigate('pipeline', d.transform)}>{d.transform}</button>
                <span className="text-txt-4">→</span>
                <button className="text-accent hover:underline" onClick={() => select(d.output_dataset_id)}>{d.output_dataset_id}</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {docs.checks.length > 0 && (
        <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
          <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-[0.4px] text-txt-3 border-b border-line">Latest check results</div>
          <table className="w-full border-collapse">
            <tbody>
              {docs.checks.map((c) => {
                const res = docs.check_results.find((r) => r.check_id === c.id);
                return (
                  <tr key={c.id} className={rowCls}>
                    <td className={`${cellMono} text-txt-0`}>{c.name}</td>
                    <td className="px-2.5 py-1.5"><Badge tone={res ? (res.passed ? 'ok' : c.severity === 'fail' ? 'alert' : 'warn') : 'neutral'}>{res ? (res.passed ? 'pass' : 'fail') : '—'}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mono text-[10px] text-txt-4">Generated from dataset {dataset.id} · {docs.versions.length} versions on record.</div>
    </div>
  );
}

function DatasetDetail({ dataset }: { dataset: Dataset }): JSX.Element {
  const getRows = useFoundry((s) => s.getDatasetRows);
  const getStats = useFoundry((s) => s.getDatasetStats);
  const getVersions = useFoundry((s) => s.getDatasetVersions);
  const getDeadLetter = useFoundry((s) => s.getDeadLetter);
  const getColumnLineage = useFoundry((s) => s.getColumnLineage);
  const getDatasetDocs = useFoundry((s) => s.getDatasetDocs);
  const rollbackDataset = useFoundry((s) => s.rollbackDataset);
  const deleteDataset = useFoundry((s) => s.deleteDataset);
  const error = useFoundry((s) => s.error);
  const { confirm, confirmElement } = useConfirm();
  const select = useFoundryNav((s) => s.select);
  const detailTab = useFoundryNav((s) => s.detailTab);
  const setDetailTab = useFoundryNav((s) => s.setDetailTab);
  const navigate = useFoundryNav((s) => s.navigate);

  const tab: DetailTab = detailTab ?? 'schema';
  const [rows, setRows] = useState<RowsPage | null>(null);
  const [stats, setStats] = useState<ColumnStat[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [deadLetter, setDeadLetter] = useState<DeadLetterEntry[]>([]);
  const [lineage, setLineage] = useState<ColumnLineage | null>(null);
  const [docs, setDocs] = useState<DatasetDocs | null>(null);
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [uploadOpen, setUploadOpen] = useState(false);

  useEffect(() => { setOffset(0); setVersion(undefined); }, [dataset.id]);
  useEffect(() => {
    void getRows(dataset.id, version, PAGE_SIZE, offset).then(setRows);
    void getStats(dataset.id, version).then(setStats);
    void getVersions(dataset.id).then(setVersions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id, version, offset]);
  useEffect(() => {
    if (tab === 'deadletter') void getDeadLetter(dataset.id).then(setDeadLetter);
    if (tab === 'lineage') void getColumnLineage(dataset.id).then(setLineage);
    if (tab === 'docs') void getDatasetDocs(dataset.id).then(setDocs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dataset.id]);

  const refresh = (): void => { void getVersions(dataset.id).then(setVersions); };

  const tabs: Array<{ id: DetailTab; label: string; count?: number | undefined }> = [
    { id: 'schema', label: 'Schema', count: dataset.schema.length },
    { id: 'preview', label: 'Preview' },
    { id: 'stats', label: 'Stats' },
    { id: 'versions', label: 'Versions', count: versions.length || undefined },
    { id: 'lineage', label: 'Lineage' },
    { id: 'deadletter', label: 'Dead-letter' },
    { id: 'checks', label: 'Checks' },
    { id: 'docs', label: 'Docs' },
  ];

  const onDelete = async (): Promise<void> => {
    if (await confirm({ title: `Delete dataset "${dataset.name}"?`, body: 'All versions and rows are removed permanently.', tone: 'danger', confirmLabel: 'Delete' })) {
      const ok = await deleteDataset(dataset.id);
      if (ok) select(null);
    }
  };
  const onRollback = async (v: number): Promise<void> => {
    if (await confirm({ title: `Roll back "${dataset.name}" to v${v}?`, body: 'Creates a new latest version from v' + v + ' — does not delete history.', confirmLabel: 'Roll back' })) {
      const d = await rollbackDataset(dataset.id, v);
      if (d) refresh();
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2.5 border-b border-line-2 bg-bg-1 flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <Badge tone={dataset.kind === 'raw' ? 'accent' : 'mag'}>{dataset.kind}</Badge>
          <h2 className="text-[13px] font-semibold text-txt-0 truncate">{dataset.name}</h2>
          <span className="mono text-[10px] text-txt-3">v{dataset.latest_version}</span>
          <span className="mono text-[10px] text-txt-2 tabular-nums">{dataset.row_count.toLocaleString()} rows</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Btn size="sm" tone="accent" onClick={() => setUploadOpen(true)}>⇪ Upload version</Btn>
          <Btn size="sm" onClick={() => navigate('pipeline')}>Lineage ›</Btn>
          <Btn size="sm" onClick={() => void onDelete()}>Delete</Btn>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {dataset.description && <p className="text-[11px] text-txt-2">{dataset.description}</p>}
        {error && <p className="text-[11px] text-alert">{error}</p>}
        <AutoSyncBanner />
        <Tabs tabs={tabs} active={tab} onChange={setDetailTab} />

        {tab === 'schema' && (
          <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
            <table className="w-full border-collapse">
              <thead><tr className={tableHeadCls()}><Th>Column</Th><Th>Type</Th></tr></thead>
              <tbody>
                {dataset.schema.map((c) => (
                  <tr key={c.name} className={rowCls}>
                    <td className={`${cellMono} text-txt-0`}>{c.name}</td>
                    <td className="px-2.5 py-1.5"><TypeChip type={c.type} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dataset.schema.length === 0 && <div className="px-2.5 py-3 text-center mono text-[11px] text-txt-3">No columns — upload data to infer a schema.</div>}
          </div>
        )}

        {tab === 'preview' && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-end gap-2 mono text-[10px] text-txt-3">
              <Btn size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹ prev</Btn>
              <span className="tabular-nums">{offset + 1}–{offset + (rows?.rows.length ?? 0)} of {(rows?.total ?? 0).toLocaleString()}</span>
              <Btn size="sm" disabled={!rows || offset + PAGE_SIZE >= rows.total} onClick={() => setOffset(offset + PAGE_SIZE)}>next ›</Btn>
            </div>
            <div className="overflow-auto rounded-md border border-line-2 bg-bg-1 max-h-[60vh]">
              <table className="w-full border-collapse">
                <thead><tr className={tableHeadCls()}>{(rows?.schema ?? []).map((f) => <Th key={f.name}>{f.name}</Th>)}</tr></thead>
                <tbody>
                  {(rows?.rows ?? []).map((row, i) => (
                    <tr key={i} className="border-t border-line">
                      {(rows?.schema ?? []).map((f) => <td key={f.name} className="px-2.5 py-1 mono text-[11px] text-txt-1 whitespace-nowrap">{String((row as Record<string, unknown>)[f.name] ?? '')}</td>)}
                    </tr>
                  ))}
                  {(rows?.rows.length ?? 0) === 0 && <tr><td className="px-2.5 py-3 text-center mono text-[11px] text-txt-3">No rows.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'stats' && (
          <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
            <table className="w-full border-collapse">
              <thead><tr className={tableHeadCls()}><Th>Column</Th><Th>Type</Th><Th align="right">Nulls</Th><Th align="right">Distinct</Th><Th align="right">Min</Th><Th align="right">Max</Th></tr></thead>
              <tbody>
                {stats.map((c) => (
                  <tr key={c.name} className={rowCls}>
                    <td className={`${cellMono} text-txt-0`}>{c.name}</td>
                    <td className="px-2.5 py-1.5"><TypeChip type={c.type} /></td>
                    <td className={`${cellMono} text-right ${c.nulls > 0 ? 'text-warn' : 'text-txt-2'}`}>{c.nulls}</td>
                    <td className={`${cellMono} text-right text-txt-2`}>{c.distinct}</td>
                    <td className={`${cellMono} text-right text-txt-3 text-[10px]`}>{String(c.min ?? '—')}</td>
                    <td className={`${cellMono} text-right text-txt-3 text-[10px]`}>{String(c.max ?? '—')}</td>
                  </tr>
                ))}
                {stats.length === 0 && <tr><td colSpan={6} className="px-2.5 py-3 text-center mono text-[11px] text-txt-3">No columns.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'versions' && (
          <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
            <table className="w-full border-collapse">
              <thead><tr className={tableHeadCls()}><Th>Version</Th><Th>Source</Th><Th align="right">Rows</Th><Th>Created</Th><Th /></tr></thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version} className={`${rowCls} ${version === v.version ? 'bg-accent-dim' : ''}`}>
                    <td className={`${cellMono} text-txt-0 cursor-pointer`} onClick={() => { setVersion(v.version); setOffset(0); setDetailTab('preview'); }}>
                      v{v.version}{v.version === dataset.latest_version && <span className="ml-1 text-txt-3 text-[10px]">latest</span>}
                    </td>
                    <td className={`${cellMono} text-txt-2`}>{v.source}</td>
                    <td className={`${cellMono} text-right`}>{v.row_count.toLocaleString()}</td>
                    <td className={`${cellMono} text-txt-3 text-[10px]`}>{stamp(v.created_at)}</td>
                    <td className="px-2.5 py-1.5 text-right">
                      {v.version !== dataset.latest_version && <Btn size="sm" onClick={() => void onRollback(v.version)}>Roll back</Btn>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'lineage' && (
          <div className="rounded-md border border-line-2 bg-bg-1 p-3 space-y-2">
            <div className="text-[11px] text-txt-2">
              {lineage?.produced_by ? <>Produced by <span className="mono text-accent">{lineage.produced_by}</span>{lineage.primary_input && <> from <span className="mono text-txt-1">{lineage.primary_input}</span></>}</> : 'Raw dataset — each column is its own source.'}
            </div>
            <table className="w-full border-collapse">
              <thead><tr className={tableHeadCls()}><Th>Output column</Th><Th>Derives from</Th></tr></thead>
              <tbody>
                {Object.entries(lineage?.columns ?? {}).map(([col, srcs]) => (
                  <tr key={col} className={rowCls}>
                    <td className={`${cellMono} text-txt-0`}>{col}</td>
                    <td className="px-2.5 py-1.5">{srcs.length ? srcs.map((s) => <span key={s} className="mono text-[10px] mr-1.5 text-txt-2">{s}</span>) : <span className="text-txt-4 text-[10px]">—</span>}</td>
                  </tr>
                ))}
                {!lineage && <tr><td colSpan={2} className="px-2.5 py-3 text-center mono text-[11px] text-txt-3">Loading…</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'deadletter' && (
          <div className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
            {deadLetter.length === 0 ? (
              <div className="p-4"><EmptyState icon="✓" title="No quarantined rows" hint="Rows that raise during a filter/derive in the last build land here instead of failing the whole build." /></div>
            ) : (
              <table className="w-full border-collapse">
                <thead><tr className={tableHeadCls()}><Th>Step</Th><Th>Error</Th><Th>Row</Th></tr></thead>
                <tbody>
                  {deadLetter.map((e, i) => (
                    <tr key={i} className={rowCls}>
                      <td className="px-2.5 py-1.5"><Badge tone="warn">{e.step_type}</Badge></td>
                      <td className={`${cellMono} text-[#ffb3ae] text-[10px]`}>{e.error}</td>
                      <td className={`${cellMono} text-txt-3 text-[10px] truncate max-w-[280px]`}>{JSON.stringify(e.row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'checks' && <ChecksSection datasetId={dataset.id} />}
        {tab === 'docs' && <DocsTab dataset={dataset} docs={docs} />}
      </div>
      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} existing={dataset} onDone={() => { setUploadOpen(false); refresh(); }} />
      {confirmElement}
    </div>
  );
}

type KindFilter = 'all' | 'raw' | 'derived';
type SortKey = 'updated' | 'name' | 'rows';

export function DatasetsView(): JSX.Element {
  const datasets = useFoundry((s) => s.datasets);
  const error = useFoundry((s) => s.error);
  const loadDatasets = useFoundry((s) => s.loadDatasets);
  const createDataset = useFoundry((s) => s.createDataset);
  const clearAutoSync = useFoundry((s) => s.clearAutoSync);
  const selectedId = useFoundryNav((s) => s.selectedId);
  const select = useFoundryNav((s) => s.select);

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [sort, setSort] = useState<SortKey>('updated');
  const [newOpen, setNewOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  useFoundryPoll(() => loadDatasets());

  const filtered = useMemo(() => {
    let list = datasets;
    if (kind !== 'all') list = list.filter((d) => d.kind === kind);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'rows') return b.row_count - a.row_count;
      return b.updated_at.localeCompare(a.updated_at);
    });
    return sorted;
  }, [datasets, kind, query, sort]);

  const selected = datasets.find((d) => d.id === selectedId) ?? null;

  const onCreate = async (): Promise<void> => {
    if (!newName.trim()) return;
    const d = await createDataset(newName.trim(), newDesc || undefined);
    if (d) {
      setNewOpen(false);
      setNewName('');
      setNewDesc('');
      clearAutoSync();
      select(d.id);
    }
  };

  return (
    <div className="h-full flex">
      {/* master list */}
      <div className="w-[320px] shrink-0 border-r border-line-2 bg-bg-1 flex flex-col">
        <div className="p-2.5 space-y-2 border-b border-line-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search datasets…" className={controlCls} />
          <div className="flex items-center gap-2">
            <FilterChips<KindFilter>
              value={kind}
              onChange={setKind}
              options={[
                { key: 'all', label: 'all', count: datasets.length },
                { key: 'raw', label: 'raw', count: datasets.filter((d) => d.kind === 'raw').length },
                { key: 'derived', label: 'derived', count: datasets.filter((d) => d.kind === 'derived').length },
              ]}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.4px] text-txt-3">sort</span>
            <Select value={sort} onChange={(v) => setSort(v as SortKey)} className="flex-1" options={[{ value: 'updated', label: 'updated' }, { value: 'name', label: 'name' }, { value: 'rows', label: 'rows' }]} />
          </div>
          <div className="flex items-center gap-1.5">
            <Btn size="sm" tone="accent" className="flex-1" onClick={() => setNewOpen(true)}>+ New dataset</Btn>
            <Btn size="sm" className="flex-1" onClick={() => setUploadOpen(true)}>⇪ Upload</Btn>
          </div>
          {error && <p className="text-[10px] text-alert">{error}</p>}
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map((d) => {
            const on = d.id === selectedId;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => { clearAutoSync(); select(d.id); }}
                className={`w-full text-left px-3 py-2 border-l-2 border-b border-line transition-colors ${on ? 'border-accent bg-accent-dim' : 'border-transparent hover:bg-bg-2'}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-txt-0 truncate flex-1">{d.name}</span>
                  <Badge tone={d.kind === 'raw' ? 'accent' : 'mag'}>{d.kind}</Badge>
                </div>
                <div className="flex items-center gap-2 mt-0.5 mono text-[10px] text-txt-3">
                  <span className="tabular-nums">{d.row_count.toLocaleString()} rows</span>
                  <span>· v{d.latest_version}</span>
                  <span className="ml-auto">{stamp(d.updated_at)}</span>
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="p-4"><EmptyState icon="▤" title="No datasets" hint="Upload a CSV, JSON, or NDJSON file to create your first dataset." /></div>
          )}
        </div>
      </div>

      {/* detail pane */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <DatasetDetail dataset={selected} />
        ) : (
          <div className="h-full flex items-center justify-center p-8">
            <EmptyState icon="▤" title="Select a dataset" hint="Pick one from the list, or upload a file to create a new dataset." />
          </div>
        )}
      </div>

      {/* new-dataset modal */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New dataset"
        footer={
          <>
            <Btn onClick={() => setNewOpen(false)}>Cancel</Btn>
            <Btn tone="accent" disabled={!newName.trim()} onClick={() => void onCreate()}>Create</Btn>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name"><input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my_dataset" className={controlCls} /></Field>
          <Field label="Description (optional)"><input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} className={controlCls} /></Field>
          <p className="text-[10px] text-txt-4">Creates an empty dataset — upload a file next to add its first version.</p>
        </div>
      </Modal>

      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} onDone={() => setUploadOpen(false)} />
    </div>
  );
}
