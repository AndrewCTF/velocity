// In-console settings overlay. Primary job: the BYOK key panel ("config panel
// for keys, there now"). Also surfaces the current plan and links out to the
// full account dashboard (limits / renew / alerts) on the marketing site.
import { useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { KeysPanel } from './KeysPanel.js';

interface Me {
  email?: string;
  tier?: string;
  status?: string;
}

// The console runs under /app on the gateway; the account dashboard is /account.
const ACCOUNT_URL = '/account';

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await apiFetch('/api/me');
        if (live && r.ok) setMe(await r.json());
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[8vh]"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-[92vw] max-h-[80vh] overflow-y-auto rounded-md border border-line bg-bg-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="mono text-[12px] tracking-[0.12em] uppercase text-txt-1">
            Settings
          </span>
          <button
            type="button"
            onClick={onClose}
            className="mono text-[11px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
          >
            esc
          </button>
        </div>

        <div className="px-4 py-3.5">
          {me && (
            <div className="flex items-center justify-between mb-3 pb-3 border-b border-line">
              <div className="flex flex-col">
                <span className="mono text-[11px] text-txt-1">{me.email ?? 'signed in'}</span>
                <span className="mono text-[9px] text-txt-3 uppercase tracking-[0.6px]">
                  {me.tier ?? 'none'} · {me.status ?? '—'}
                </span>
              </div>
              <a
                href={ACCOUNT_URL}
                className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
              >
                Manage plan →
              </a>
            </div>
          )}

          <div className="mono text-[9px] uppercase tracking-[0.7px] text-txt-3 mb-2">
            API keys · bring your own
          </div>
          <KeysPanel />

          <a
            href={ACCOUNT_URL}
            className="block text-center mt-3.5 mono text-[10px] px-2 py-1.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
          >
            Open full dashboard — limits, billing & alerts →
          </a>
        </div>
      </div>
    </div>
  );
}
