import { useEffect, useState } from 'react';
import { useFoundry, type Binding, type SyncResult } from '../state/foundry.js';
import { Badge, Btn, Toggle } from '../shell/instruments.js';
import { EmptyState, Field, Select, ViewHeader, controlCls } from './ui.js';

// Ontology — bindings map a dataset into the local ontology (dataset → object
// kind, key column, column→property map). Sync mints/updates objects through
// the registry with source='foundry:<dataset_id>', landing BYO data in the same
// graph as the live world. Entity resolution (the `resolve` toggle) matches an
// incoming key against existing objects of the kind so the same real-world
// entity from two datasets updates one object instead of minting a duplicate.

function PropMapEditor({
  map,
  onChange,
}: {
  map: Record<string, string>;
  onChange: (m: Record<string, string>) => void;
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
          <input value={col} onChange={(e) => setRow(i, e.target.value, prop)} placeholder="column" className={controlCls} />
          <span aria-hidden className="text-txt-3">→</span>
          <input value={prop} onChange={(e) => setRow(i, col, e.target.value)} placeholder="property" className={controlCls} />
          <button type="button" onClick={() => removeRow(i)} className="text-txt-3 hover:text-alert text-[12px] px-1" aria-label="Remove row">
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange({ ...map, '': '' })} className="mono text-[10px] text-accent hover:underline">
        + property
      </button>
    </div>
  );
}

function BindingEditor({ onDone }: { onDone: () => void }): JSX.Element {
  const datasets = useFoundry((s) => s.datasets);
  const createBinding = useFoundry((s) => s.createBinding);
  const [datasetId, setDatasetId] = useState('');
  const [objectKind, setObjectKind] = useState('');
  const [keyColumn, setKeyColumn] = useState('');
  const [propMap, setPropMap] = useState<Record<string, string>>({});
  const [resolve, setResolve] = useState(false);

  const save = async (): Promise<void> => {
    await createBinding({ dataset_id: datasetId, object_kind: objectKind, key_column: keyColumn, prop_map: propMap, resolve });
    onDone();
  };

  return (
    <div className="rounded-md border border-line-2 bg-bg-1 p-4 space-y-3">
      <div className="text-[11px] font-semibold tracking-[0.09em] uppercase text-txt-2">New binding</div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Dataset">
          <Select value={datasetId} onChange={setDatasetId} placeholder="Dataset…" options={datasets.map((d) => ({ value: d.id, label: d.name }))} />
        </Field>
        <Field label="Object kind">
          <input value={objectKind} onChange={(e) => setObjectKind(e.target.value)} placeholder="e.g. vessel" className={controlCls} />
        </Field>
        <Field label="Key column">
          <input value={keyColumn} onChange={(e) => setKeyColumn(e.target.value)} placeholder="e.g. mmsi" className={controlCls} />
        </Field>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-[0.4px] text-txt-3 mb-1.5">Property map — column → ontology property</div>
        <PropMapEditor map={propMap} onChange={setPropMap} />
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <Toggle on={resolve} onChange={setResolve} label="entity resolution" />
        <span className="text-[11px] text-txt-1">Entity resolution</span>
        <span className="text-[10px] text-txt-4">— match an existing object by key instead of minting a duplicate</span>
      </label>
      <div className="flex items-center gap-2 pt-1">
        <Btn tone="accent" disabled={!datasetId || !objectKind || !keyColumn} onClick={() => void save()}>
          Create binding
        </Btn>
        <Btn onClick={onDone}>Cancel</Btn>
      </div>
    </div>
  );
}

function BindingCard({ binding }: { binding: Binding }): JSX.Element {
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
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await syncBinding(binding.id);
              setResult(r);
              setBusy(false);
            }}
          >
            {busy ? 'Syncing…' : 'Sync'}
          </Btn>
          <button
            type="button"
            onClick={() => window.confirm('Delete this binding?') && void deleteBinding(binding.id)}
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
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    void loadBindings();
    void loadDatasets();
  }, [loadBindings, loadDatasets]);

  return (
    <div className="p-5 space-y-5">
      <ViewHeader
        title="Ontology bindings"
        subtitle="Map datasets into the ontology graph; sync mints or updates objects."
        actions={
          <Btn tone="accent" onClick={() => setEditorOpen(true)}>
            + New binding
          </Btn>
        }
      />
      {error && <p className="text-[11px] text-alert">{error}</p>}
      {editorOpen && <BindingEditor onDone={() => setEditorOpen(false)} />}
      <div className="space-y-2.5">
        {bindings.map((b) => (
          <BindingCard key={b.id} binding={b} />
        ))}
        {bindings.length === 0 && !editorOpen && (
          <EmptyState
            icon="◈"
            title="No bindings yet"
            hint="Bind a dataset to an object kind to land its rows in the ontology graph — the same graph as the live feeds."
            action={
              <Btn tone="accent" onClick={() => setEditorOpen(true)}>
                + New binding
              </Btn>
            }
          />
        )}
      </div>
    </div>
  );
}
