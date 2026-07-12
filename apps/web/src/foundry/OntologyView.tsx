import { Boxes } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useFoundry, type Binding, type SyncResult } from '../state/foundry.js';
import { Badge, Btn, Toggle } from '../shell/instruments.js';
import { Modal, useConfirm } from '../shell/Modal.js';
import { useFoundryPoll } from './useFoundryPoll.js';
import { EmptyState, Field, Select, ViewHeader, controlCls } from './ui.js';

// Ontology — bindings map a dataset into the local ontology (dataset → object
// kind, key column, column→property map). Now: object-kind picker from the
// backend's known kinds (no more free text that only 422s server-side), a
// key-column picker from the chosen dataset's schema, a Sync-all that
// aggregates results, a 2-column card grid, and a guided empty state.

function PropMapEditor({
  map,
  onChange,
  columns,
}: {
  map: Record<string, string>;
  onChange: (m: Record<string, string>) => void;
  columns: string[];
}): JSX.Element {
  const rows = Object.entries(map);
  const setRow = (i: number, col: string, prop: string): void => {
    const next = [...rows];
    next[i] = [col, prop];
    onChange(Object.fromEntries(next));
  };
  const removeRow = (i: number): void => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)));
  return (
    <div className="space-y-1.5">
      {rows.map(([col, prop], i) => (
        <div key={i} className="flex items-center gap-2">
          <input list="propmap-cols" value={col} onChange={(e) => setRow(i, e.target.value, prop)} placeholder="column" className={controlCls} />
          <datalist id="propmap-cols">{columns.map((c) => <option key={c} value={c} />)}</datalist>
          <span aria-hidden className="text-txt-3">→</span>
          <input value={prop} onChange={(e) => setRow(i, col, e.target.value)} placeholder="property" className={controlCls} />
          <button type="button" onClick={() => removeRow(i)} className="text-txt-3 hover:text-alert text-[12px] px-1" aria-label="Remove row">✕</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange({ ...map, '': '' })} className="mono text-[10px] text-accent hover:underline">+ property</button>
    </div>
  );
}

function BindingEditor({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const datasets = useFoundry((s) => s.datasets);
  const kinds = useFoundry((s) => s.kinds);
  const createBinding = useFoundry((s) => s.createBinding);
  const [datasetId, setDatasetId] = useState('');
  const [objectKind, setObjectKind] = useState('');
  const [keyColumn, setKeyColumn] = useState('');
  const [propMap, setPropMap] = useState<Record<string, string>>({});
  const [resolve, setResolve] = useState(false);

  const selectedDs = datasets.find((d) => d.id === datasetId);
  const schemaCols = selectedDs?.schema.map((c) => c.name) ?? [];

  const save = async (): Promise<void> => {
    const cleanMap: Record<string, string> = {};
    for (const [c, p] of Object.entries(propMap)) if (c && p) cleanMap[c] = p;
    await createBinding({ dataset_id: datasetId, object_kind: objectKind, key_column: keyColumn, prop_map: cleanMap, resolve });
    setDatasetId('');
    setObjectKind('');
    setKeyColumn('');
    setPropMap({});
    setResolve(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New binding"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn tone="accent" disabled={!datasetId || !objectKind || !keyColumn} onClick={() => void save()}>Create binding</Btn>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Dataset">
            <Select value={datasetId} onChange={setDatasetId} placeholder="Dataset…" options={datasets.map((d) => ({ value: d.id, label: d.name }))} />
          </Field>
          <Field label="Object kind">
            <Select value={objectKind} onChange={setObjectKind} placeholder="kind…" options={kinds.map((k) => ({ value: k, label: k }))} />
          </Field>
          <Field label="Key column">
            <Select value={keyColumn} onChange={setKeyColumn} placeholder="column…" options={schemaCols.map((c) => ({ value: c, label: c }))} />
          </Field>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3 mb-1.5">Property map — column → ontology property</div>
          <PropMapEditor map={propMap} onChange={setPropMap} columns={schemaCols} />
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <Toggle on={resolve} onChange={setResolve} label="entity resolution" />
          <span className="text-[11px] text-txt-1">Entity resolution</span>
          <span className="text-[10px] text-txt-4">— match an existing object by key instead of minting a duplicate</span>
        </label>
      </div>
    </Modal>
  );
}

function BindingCard({ binding, confirm }: { binding: Binding; confirm: (o: { title: string; body?: string; tone?: 'danger' | 'neutral'; confirmLabel?: string }) => Promise<boolean> }): JSX.Element {
  const datasets = useFoundry((s) => s.datasets);
  const updateBinding = useFoundry((s) => s.updateBinding);
  const deleteBinding = useFoundry((s) => s.deleteBinding);
  const syncBinding = useFoundry((s) => s.syncBinding);
  const [result, setResult] = useState<SyncResult | null>(binding.last_result);
  const [busy, setBusy] = useState(false);

  const datasetName = datasets.find((d) => d.id === binding.dataset_id)?.name ?? binding.dataset_id;

  return (
    <div className="rounded-md border border-line-2 bg-bg-1 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[12px] text-txt-0 truncate">{datasetName}</span>
          <span aria-hidden className="text-txt-3">→</span>
          <Badge tone="mag">{binding.object_kind}</Badge>
          {binding.resolve && <Badge tone="accent">resolve</Badge>}
          {!binding.enabled && <Badge tone="neutral">disabled</Badge>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Toggle on={binding.enabled} onChange={(next) => void updateBinding(binding.id, { enabled: next })} label="enabled" />
          <Btn
            size="sm"
            tone="accent"
            disabled={busy || !binding.enabled}
            onClick={async () => {
              setBusy(true);
              setResult(await syncBinding(binding.id));
              setBusy(false);
            }}
          >
            {busy ? 'Syncing…' : 'Sync'}
          </Btn>
          <button
            type="button"
            onClick={() => void confirm({ title: 'Delete this binding?', tone: 'danger', confirmLabel: 'Delete' }).then((ok) => ok && deleteBinding(binding.id))}
            className="text-txt-3 hover:text-alert text-[12px]"
            aria-label="Delete binding"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="mono text-[10px] text-txt-3">
        key <span className="text-txt-1">{binding.key_column}</span> · props{' '}
        {Object.entries(binding.prop_map).map(([c, p]) => `${c}→${p}`).join('  ') || '—'}
      </div>
      {result && (
        <div className="mono text-[10px] flex items-center gap-2" data-testid="sync-result">
          <Badge tone="ok">minted {result.minted}</Badge>
          <Badge tone="accent">updated {result.updated}</Badge>
          {result.skipped > 0 && <span className="text-txt-3">skipped {result.skipped}</span>}
          {result.errors.length > 0 && <Badge tone="alert">{result.errors.length} error{result.errors.length === 1 ? '' : 's'}</Badge>}
        </div>
      )}
    </div>
  );
}

export function OntologyView(): JSX.Element {
  const bindings = useFoundry((s) => s.bindings);
  const error = useFoundry((s) => s.error);
  const loadBindings = useFoundry((s) => s.loadBindings);
  const loadDatasets = useFoundry((s) => s.loadDatasets);
  const loadKinds = useFoundry((s) => s.loadKinds);
  const syncBinding = useFoundry((s) => s.syncBinding);
  const { confirm, confirmElement } = useConfirm();
  const [editorOpen, setEditorOpen] = useState(false);
  const [syncAll, setSyncAll] = useState<{ done: number; total: number; agg: SyncResult } | null>(null);

  useFoundryPoll(async () => {
    await Promise.all([loadBindings(), loadDatasets(), loadKinds()]);
  });

  const enabledBindings = useMemo(() => bindings.filter((b) => b.enabled), [bindings]);

  const runSyncAll = async (): Promise<void> => {
    const agg: SyncResult = { minted: 0, updated: 0, skipped: 0, errors: [] };
    let done = 0;
    setSyncAll({ done: 0, total: enabledBindings.length, agg });
    for (const b of enabledBindings) {
      const r = await syncBinding(b.id);
      if (r) {
        agg.minted += r.minted;
        agg.updated += r.updated;
        agg.skipped += r.skipped;
        agg.errors.push(...r.errors);
      }
      done++;
      setSyncAll({ done, total: enabledBindings.length, agg: { ...agg } });
    }
  };

  return (
    <div className="p-5 space-y-5">
      <ViewHeader
        title="Ontology bindings"
        subtitle="Map datasets into the ontology graph; sync mints or updates objects."
        actions={
          <>
            <Btn onClick={() => void runSyncAll()} disabled={syncAll != null || enabledBindings.length === 0}>
              {syncAll ? `Syncing ${syncAll.done}/${syncAll.total}` : `Sync all (${enabledBindings.length})`}
            </Btn>
            <Btn tone="accent" onClick={() => setEditorOpen(true)}>+ New binding</Btn>
          </>
        }
      />
      {error && <p className="text-[11px] text-alert">{error}</p>}

      {syncAll && syncAll.done >= syncAll.total && (
        <div className="rounded-md border border-line-2 bg-bg-1 px-3 py-2 mono text-[11px] flex items-center gap-2" data-testid="sync-all-result">
          <span className="text-txt-3 uppercase tracking-[0.4px] text-[10px]">Sync all</span>
          <Badge tone="ok">minted {syncAll.agg.minted}</Badge>
          <Badge tone="accent">updated {syncAll.agg.updated}</Badge>
          {syncAll.agg.skipped > 0 && <span className="text-txt-3">skipped {syncAll.agg.skipped}</span>}
          {syncAll.agg.errors.length > 0 && <Badge tone="alert">{syncAll.agg.errors.length} error(s)</Badge>}
          <button type="button" onClick={() => setSyncAll(null)} className="ml-auto text-txt-3 hover:text-txt-0" aria-label="Dismiss" title="Dismiss">✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
        {bindings.map((b) => (
          <BindingCard key={b.id} binding={b} confirm={confirm} />
        ))}
        {bindings.length === 0 && (
          <div className="lg:col-span-2">
            <EmptyState
              icon={Boxes}
              title="No bindings yet"
              hint="The loop: upload a dataset → author a transform → bind the output here → sync to land its rows in the ontology graph (the same graph as the live feeds)."
              action={<Btn tone="accent" onClick={() => setEditorOpen(true)}>+ New binding</Btn>}
            />
          </div>
        )}
      </div>

      <BindingEditor open={editorOpen} onClose={() => setEditorOpen(false)} />
      {confirmElement}
    </div>
  );
}
