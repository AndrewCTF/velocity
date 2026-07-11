// Installed-models table: quant, size, active main/selection badges, a hot
// pin toggle (POST /api/ai/models/hot) and a delete button with a confirm
// step (DELETE /api/ai/models/{key}). `key` is the server-issued opaque id —
// never a filesystem path — so deletion is always by key.
import { useState } from 'react';
import { apiFetch } from '../../transport/http.js';
import { Badge, Toggle } from '../../shell/instruments.js';
import { humanBytes, type InstalledModel } from './types.js';

export function ModelsTable({
  installed,
  active,
  onChanged,
}: {
  installed: InstalledModel[];
  active: { main: string | null; selection: string | null };
  onChanged: () => void;
}): JSX.Element {
  if (installed.length === 0) {
    return <p className="mono text-[10px] text-txt-3">No models installed yet — pick one from the catalog below.</p>;
  }
  return (
    <div className="space-y-1.5">
      {installed.map((m) => (
        <ModelRow key={m.key} model={m} active={active} onChanged={onChanged} />
      ))}
    </div>
  );
}

function ModelRow({
  model,
  active,
  onChanged,
}: {
  model: InstalledModel;
  active: { main: string | null; selection: string | null };
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleHot = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch('/api/ai/models/hot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: model.key, hot: !model.hot }),
      });
      if (!r.ok) {
        setErr(`hot-pin failed (${r.status})`);
        return;
      }
      onChanged();
    } catch {
      setErr('network error');
    } finally {
      setBusy(false);
    }
  };

  const del = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch(`/api/ai/models/${encodeURIComponent(model.key)}`, { method: 'DELETE' });
      if (!r.ok) {
        setErr(`delete failed (${r.status})`);
        setConfirming(false);
        return;
      }
      onChanged();
    } catch {
      setErr('network error');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const isMain = active.main === model.key;
  const isSelection = active.selection === model.key;

  return (
    <div className="rounded-sm border border-line bg-bg-2/50 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mono text-[10.5px] text-txt-1 truncate" title={model.repo_id}>
            {model.repo_id}
          </div>
          <div className="mono text-[10px] text-txt-3 mt-0.5">
            {model.quant} · {humanBytes(model.size_bytes)}
            {model.tier ? ` · ${model.tier}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isMain && <Badge tone="accent">main</Badge>}
          {isSelection && <Badge tone="ok">selection</Badge>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mt-1.5">
        <label className="flex items-center gap-1.5 mono text-[10px] text-txt-2">
          <Toggle on={model.hot} onChange={() => void toggleHot()} label={`Hot-pin ${model.repo_id}`} />
          hot pin
        </label>
        {confirming ? (
          <div className="flex items-center gap-1.5">
            <span className="mono text-[10px] text-warn">delete {model.quant}?</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void del()}
              className="mono text-[10px] px-1.5 py-0.5 border border-rose-700/60 rounded-sm text-rose-400 hover:bg-rose-950/40 disabled:opacity-50"
            >
              confirm
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm text-txt-2"
            >
              cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(true)}
            className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-rose-500 hover:text-rose-400 disabled:opacity-50"
          >
            delete
          </button>
        )}
      </div>
      {err && <p className="mono text-[10px] text-alert mt-1">{err}</p>}
    </div>
  );
}
