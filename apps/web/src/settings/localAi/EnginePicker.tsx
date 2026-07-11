// Engine picker — auto / llama.cpp / vLLM / Ollama, each with a live status
// dot (green = running, amber = installed but not running, gray = not
// installed). POSTs the choice to /api/ai/engine; the backend owns actual
// engine resolution (auto → llamacpp if ready else ollama).
import { useState } from 'react';
import { apiFetch } from '../../transport/http.js';
import { StatusDot } from '../../shell/instruments.js';
import type { EngineId, ModelsResponse } from './types.js';

const ENGINES: { id: EngineId; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'llamacpp', label: 'llama.cpp' },
  { id: 'vllm', label: 'vLLM' },
  { id: 'ollama', label: 'Ollama' },
];

function statusTone(engines: ModelsResponse['engines'], id: EngineId): string {
  if (id === 'auto') return 'ok';
  const s = engines[id];
  if (!s) return 'neutral';
  if (s.running) return 'green';
  if (s.installed) return 'amber';
  return 'red';
}

function statusTitle(engines: ModelsResponse['engines'], id: EngineId): string {
  if (id === 'auto') return 'resolves to llama.cpp when ready, else Ollama';
  const s = engines[id];
  if (!s) return 'unknown';
  if (s.running) return `running${s.version ? ` (${s.version})` : ''}`;
  if (s.installed) return `installed, not running${s.version ? ` (${s.version})` : ''}`;
  return 'not installed';
}

export function EnginePicker({
  engine,
  engines,
  onChanged,
}: {
  engine: EngineId;
  engines: ModelsResponse['engines'];
  onChanged: (engine: EngineId) => void;
}): JSX.Element {
  const [busy, setBusy] = useState<EngineId | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const select = async (id: EngineId): Promise<void> => {
    if (id === engine || busy) return;
    setBusy(id);
    setErr(null);
    try {
      const r = await apiFetch('/api/ai/engine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: id }),
      });
      if (!r.ok) {
        setErr(`switch failed (${r.status})`);
        return;
      }
      const body = (await r.json()) as { ok: boolean; engine: EngineId };
      onChanged(body.engine);
    } catch {
      setErr('network error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Local AI engine">
        {ENGINES.map((e) => {
          const on = engine === e.id;
          return (
            <button
              key={e.id}
              type="button"
              role="radio"
              aria-checked={on}
              title={statusTitle(engines, e.id)}
              disabled={busy !== null}
              onClick={() => void select(e.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 mono text-[10.5px] px-2 py-1.5 rounded-sm border transition-colors disabled:opacity-50 ${
                on
                  ? 'border-accent-line bg-accent-dim text-txt-0'
                  : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1'
              }`}
            >
              <StatusDot tone={statusTone(engines, e.id)} />
              {busy === e.id ? '…' : e.label}
            </button>
          );
        })}
      </div>
      {err && <p className="mono text-[10px] text-alert mt-1">{err}</p>}
    </div>
  );
}
