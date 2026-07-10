// Upload modal — the single entry for both new-dataset and new-version uploads.
// Replaces the old window.prompt(name) + bare UploadZone flow. Surfaces the
// upload's `types` (column type pinning) and `cascade` (rebuild downstream
// transforms) params the backend already accepted but the UI never sent.
import { useRef, useState } from 'react';
import { useFoundry, type Build, type Dataset } from '../state/foundry.js';
import { Badge, Btn } from '../shell/instruments.js';
import { Modal } from '../shell/Modal.js';
import { Field, Select, controlCls } from './ui.js';

const TYPE_OPTS = ['auto', 'str', 'int', 'float', 'bool'].map((v) => ({ value: v, label: v }));

// Read the first 64KB of a file as text. FileReader is the one read API that's
// reliably implemented across browsers AND jsdom (File.text / Blob.slice().text
// are uneven in jsdom), so the upload modal stays testable without a backend.
function readHead(file: File): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = (): void => resolve(String(r.result ?? '').slice(0, 65536));
    r.onerror = (): void => resolve('');
    r.readAsText(file.slice(0, 65536));
  });
}

// Parse column names from a file's first chunk, client-side (never uploaded):
// CSV → first line split on comma; JSON/NDJSON → keys of the first object.
async function parseColumns(file: File): Promise<string[]> {
  const head = await readHead(file);
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
    if (!firstLine) return [];
    return firstLine.split(',').map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  // JSON or NDJSON: take the first {...} object and read its keys.
  const objMatch = head.match(/\{[^]*?\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]) as Record<string, unknown>;
      return Object.keys(obj);
    } catch {
      /* fall through */
    }
  }
  return [];
}

export function UploadModal({
  open,
  onClose,
  existing,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  // When set: new-version mode for this dataset. When null: new-dataset mode.
  existing?: Dataset | null;
  onDone?: (d: Dataset & { cascade_build?: Build }) => void;
}): JSX.Element | null {
  const uploadDataset = useFoundry((s) => s.uploadDataset);
  const uploadVersion = useFoundry((s) => s.uploadVersion);
  const error = useFoundry((s) => s.error);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'snapshot' | 'append'>('snapshot');
  const [columns, setColumns] = useState<string[]>([]);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Dataset & { cascade_build?: Build } | null>(null);

  const versionMode = !!existing;

  const reset = (): void => {
    setFile(null);
    setName('');
    setDescription('');
    setColumns([]);
    setPins({});
    setCascade(false);
    setBusy(false);
    setResult(null);
  };
  const close = (): void => {
    reset();
    onClose();
  };

  const onFile = async (f: File): Promise<void> => {
    setFile(f);
    setResult(null);
    if (!versionMode && !name) setName(f.name.replace(/\.[^.]+$/, ''));
    const cols = await parseColumns(f);
    setColumns(cols);
    setPins(Object.fromEntries(cols.map((c) => [c, 'auto'])));
  };

  const submit = async (): Promise<void> => {
    if (!file) return;
    if (!versionMode && !name.trim()) return;
    setBusy(true);
    const types: Record<string, string> = {};
    for (const [c, t] of Object.entries(pins)) if (t && t !== 'auto') types[c] = t;
    const d = versionMode
      ? await uploadVersion(existing!.id, file, mode, { types, cascade })
      : await uploadDataset(file, name.trim(), description || undefined, { types });
    setBusy(false);
    if (d) {
      setResult(d);
      onDone?.(d);
    }
  };

  const pinnedCount = Object.values(pins).filter((t) => t && t !== 'auto').length;

  return (
    <Modal
      open={open}
      onClose={close}
      title={versionMode ? `Upload version — ${existing?.name}` : 'Upload dataset'}
      width={560}
      footer={
        result ? (
          <Btn tone="accent" onClick={close}>
            Done
          </Btn>
        ) : (
          <>
            <Btn onClick={close}>Cancel</Btn>
            <Btn tone="accent" disabled={busy || !file || (!versionMode && !name.trim())} onClick={() => void submit()}>
              {busy ? 'Uploading…' : versionMode ? 'Upload version' : 'Create dataset'}
            </Btn>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] mono">
            <Badge tone="ok">uploaded</Badge>
            <span className="text-txt-1">
              {result.name} · v{result.latest_version} · {result.row_count.toLocaleString()} rows
            </span>
          </div>
          {result.cascade_build && (
            <div className="rounded-sm border border-line-2 bg-bg-2 px-2.5 py-2 text-[11px] mono space-y-1" data-testid="cascade-summary">
              <div className="text-txt-3 uppercase tracking-[0.4px] text-[10px]">Cascade build</div>
              <div className="flex items-center gap-2">
                <Badge tone={result.cascade_build.status === 'succeeded' ? 'ok' : result.cascade_build.status === 'failed' ? 'alert' : 'accent'}>
                  {result.cascade_build.status}
                </Badge>
                <span className="text-txt-2">{result.cascade_build.rows_out?.toLocaleString() ?? '—'} rows out</span>
              </div>
              {result.cascade_build.error && <div className="text-alert text-[10px]">{result.cascade_build.error}</div>}
            </div>
          )}
          <p className="text-[10px] text-txt-4">
            Ontology auto-sync ran on enabled bindings — see the banner in Datasets.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* dropzone — operable by keyboard (Enter/Space triggers the file input) */}
          <div
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            role="button"
            tabIndex={0}
            className="rounded-md border border-dashed border-line-2 bg-bg-1 hover:border-accent-line px-4 py-5 text-center cursor-pointer transition-colors focus:outline-none focus:border-accent-line"
          >
            <div className="text-[11px] text-txt-1">{file ? file.name : 'Drop CSV / JSON / NDJSON, or click to browse'}</div>
            <div className="text-[10px] text-txt-3 mt-1">25 MB cap · header row for CSV</div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.json,.ndjson,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = '';
              }}
            />
          </div>

          {!versionMode && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Dataset name">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my_dataset" className={controlCls} />
              </Field>
              <Field label="Description (optional)">
                <input value={description} onChange={(e) => setDescription(e.target.value)} className={controlCls} />
              </Field>
            </div>
          )}

          {versionMode && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mode">
                <Select
                  value={mode}
                  onChange={(v) => setMode(v as 'snapshot' | 'append')}
                  options={[
                    { value: 'snapshot', label: 'snapshot (replace)' },
                    { value: 'append', label: 'append (concat)' },
                  ]}
                />
              </Field>
              <Field label="Cascade" hint="Rebuild stale downstream transforms">
                <label className="flex items-center gap-2 h-[26px] mono text-[11px] text-txt-1">
                  <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} className="accent-accent" />
                  rebuild downstream
                </label>
              </Field>
            </div>
          )}

          {columns.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.4px] text-txt-3">Column types</span>
                <span className="mono text-[10px] text-txt-4">{pinnedCount} pinned · rest auto-inferred</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 max-h-[180px] overflow-y-auto pr-1">
                {columns.map((c) => (
                  <div key={c} className="flex items-center gap-1.5">
                    <span className="mono text-[10px] text-txt-2 truncate flex-1" title={c}>{c}</span>
                    <Select value={pins[c] ?? 'auto'} onChange={(v) => setPins((p) => ({ ...p, [c]: v }))} options={TYPE_OPTS} className="w-[88px]" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-[11px] text-alert">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
