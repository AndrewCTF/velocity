// BYOK key manager. Lists the provider catalog from GET /api/keys, lets the
// user set (PUT) or remove (DELETE) a key. Plaintext is write-only — the server
// only ever returns a masked last-4 `hint`.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';

interface Provider {
  id: string;
  label: string;
  help: string;
  wired: boolean;
}
interface StoredKey {
  provider: string;
  hint: string;
  updated_at?: string | null;
}

export function KeysPanel(): JSX.Element {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [keys, setKeys] = useState<Record<string, StoredKey>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch('/api/keys');
      if (r.status === 401) {
        setError('Sign in to manage keys.');
        setProviders([]);
        return;
      }
      if (!r.ok) {
        setError(
          r.status === 502
            ? 'Key store not ready (run the user_keys migration).'
            : `Could not load keys (${r.status}).`,
        );
        return;
      }
      const data = (await r.json()) as { providers: Provider[]; keys: StoredKey[] };
      setProviders(data.providers);
      setKeys(Object.fromEntries(data.keys.map((k) => [k.provider, k])));
    } catch {
      setError('Gateway unreachable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="micro text-txt-3">loading keys…</p>;
  if (error) return <p className="micro text-alert-fg">{error}</p>;

  return (
    <div className="flex flex-col gap-2.5">
      {providers.map((p) => (
        <KeyRow key={p.id} provider={p} stored={keys[p.id] ?? null} onChanged={load} />
      ))}
    </div>
  );
}

function KeyRow({
  provider,
  stored,
  onChanged,
}: {
  provider: Provider;
  stored: StoredKey | null;
  onChanged: () => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    if (!value.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch(`/api/keys/${provider.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: value.trim() }),
      });
      if (!r.ok) {
        setErr(`save failed (${r.status})`);
        return;
      }
      setValue('');
      onChanged();
    } catch {
      setErr('save failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch(`/api/keys/${provider.id}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) {
        setErr(`remove failed (${r.status})`);
        return;
      }
      onChanged();
    } catch {
      setErr('remove failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-sm border border-line bg-bg-2/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[11px] text-txt-1">{provider.label}</span>
        <span
          className={`mono text-[10px] uppercase tracking-[0.6px] px-1.5 py-0.5 rounded-sm border ${
            provider.wired
              ? 'text-ok border-ok-line'
              : 'text-txt-3 border-line'
          }`}
          title={provider.wired ? 'Used by a live layer' : 'Stored securely; wiring pending'}
        >
          {provider.wired ? 'active' : 'stored'}
        </span>
      </div>
      <p className="mono text-[10px] text-txt-3 mt-0.5 leading-snug">{provider.help}</p>

      {stored ? (
        <div className="flex items-center justify-between gap-2 mt-1.5">
          <span className="mono text-[10px] text-txt-2">•••• {stored.hint}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-alert-line hover:text-alert-fg disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 mt-1.5">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
            placeholder="paste key…"
            autoComplete="off"
            className="flex-1 mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
          />
          <button
            type="button"
            disabled={busy || !value.trim()}
            onClick={() => void save()}
            className="mono text-[10px] px-2 py-1 border border-accent-line rounded-sm text-accent hover:bg-accent/10 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}
      {err && <p className="mono text-[10px] text-alert-fg mt-1">{err}</p>}
    </div>
  );
}
