// Selection inference (Gotham-style "AI brief on click"): a separate, faster
// model pick from the main routing model, with an optional hot-load pin so
// the EntityPanel's brief stays fast. Persists via the extended
// POST /api/ai/local contract ({selection_enabled, selection_model}) and
// mirrors the result into the settings store so EntityPanel doesn't have to
// poll the backend on every selection.
import { useState } from 'react';
import { apiFetch } from '../../transport/http.js';
import { Badge, Toggle } from '../../shell/instruments.js';
import { useSettings } from '../../state/settings.js';
import type { CatalogEntry, InstalledModel } from './types.js';

export function SelectionInferenceBlock({
  installed,
  catalog,
  selectionEnabled,
  selectionModel,
  onChanged,
}: {
  installed: InstalledModel[];
  catalog: CatalogEntry[];
  selectionEnabled: boolean;
  selectionModel: string | null;
  onChanged: () => void;
}): JSX.Element {
  const setSetting = useSettings((s) => s.set);
  const aiPosition = useSettings((s) => s.selectionAiPosition);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const recommendedRepo = catalog.find((c) => c.tier === '8b')?.repo_id ?? null;

  const persist = async (nextEnabled: boolean, nextModel: string | null): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch('/api/ai/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selection_enabled: nextEnabled, selection_model: nextModel }),
      });
      if (!r.ok) {
        setErr(`save failed (${r.status})`);
        return;
      }
      setSetting('selectionAiEnabled', nextEnabled);
      setSetting('selectionAiModel', nextModel);
      onChanged();
    } catch {
      setErr('network error');
    } finally {
      setBusy(false);
    }
  };

  const selected = installed.find((m) => m.key === selectionModel) ?? null;

  const toggleHotLoad = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await apiFetch('/api/ai/models/hot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: selected.key, hot: !selected.hot }),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-sm border border-line px-2.5 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="mono text-[11px] font-medium text-txt-1">Selection AI brief</span>
        <Toggle
          on={selectionEnabled}
          onChange={(v) => void persist(v, selectionModel)}
          label="Enable selection AI brief"
        />
      </div>
      <p className="mono text-[10px] text-txt-3 leading-snug">
        When ON, clicking an aircraft/vessel/place shows a short AI assessment in the entity
        panel, using a faster model separate from the main routing model.
      </p>

      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3">Panel position</span>
        <div className="flex rounded-sm border border-line overflow-hidden">
          {(['top', 'bottom'] as const).map((pos) => (
            <button
              key={pos}
              type="button"
              onClick={() => setSetting('selectionAiPosition', pos)}
              aria-pressed={aiPosition === pos}
              className={`mono text-[10px] px-2 py-0.5 capitalize ${
                aiPosition === pos ? 'bg-accent-dim text-accent' : 'text-txt-2 hover:text-txt-1'
              }`}
            >
              {pos}
            </button>
          ))}
        </div>
      </div>

      {selectionEnabled && (
        <>
          <div>
            <label className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 block mb-1">
              Model
            </label>
            <select
              value={selectionModel ?? ''}
              disabled={busy || installed.length === 0}
              onChange={(e) => void persist(selectionEnabled, e.target.value || null)}
              aria-label="Selection-inference model"
              className="w-full mono text-[10px] bg-bg-2 border border-line rounded-sm px-1.5 py-1 text-txt-1 outline-none focus:border-accent-line"
            >
              <option value="">none selected</option>
              {installed.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.repo_id} · {m.quant}
                  {m.repo_id === recommendedRepo ? ' (recommended)' : ''}
                </option>
              ))}
            </select>
            {installed.length === 0 && (
              <p className="mono text-[10px] text-txt-3 mt-1">install a model above first</p>
            )}
          </div>

          {selected && (
            <label className="flex items-center gap-1.5 mono text-[10px] text-txt-2">
              <Toggle on={selected.hot} onChange={() => void toggleHotLoad()} label="Hot-load selection model" />
              hot-load (keep resident for fast briefs)
            </label>
          )}

          {recommendedRepo && (
            <p className="mono text-[10px] text-txt-3">
              recommended fast pick: <Badge tone="accent">{recommendedRepo}</Badge>
            </p>
          )}
        </>
      )}
      {err && <p className="mono text-[10px] text-alert">{err}</p>}
    </div>
  );
}
