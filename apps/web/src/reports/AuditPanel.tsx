import { useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { Badge, Btn, Widget } from '../shell/instruments.js';
import { label as classificationLabel } from '../security/classification.js';

// Audit read-back (design §6.1 "Audit becomes UI") — the UI for the backend's
// immutable action log (GET /api/audit, apps/api/app/routes/audit.py): the
// latest governed actions this deployment recorded itself performing, unioned
// over the two local stores (action_log.db + audit_log.db) and the Supabase
// table when configured, plus the tamper check on the local hash chain
// (GET /api/audit/verify). The table polls on a 30 s grid so the operator
// watches the trail stay current without hammering the store; Copy JSON hands
// the current rows to the operator's pipeline.

interface AuditRow {
  ts?: string;
  user_id?: string;
  actor_email?: string;
  action?: string;
  target_id?: string;
  classification?: number;
  store?: string;
  [key: string]: unknown;
}

interface ChainCheck {
  ok: boolean;
  rows: number;
  first_bad_id: string | number | null;
}

type VerifyState =
  | { status: 'pending' }
  | { status: 'ok'; rows: number }
  | { status: 'broken'; firstBadId: string | number | null }
  | { status: 'failed'; httpCode: number | null };

const LIMITS = [50, 200, 500] as const;
const POLL_MS = 30_000;

// ts is stored as ISO-8601 UTC; render it back as UTC wall time so the table
// column reads "time (UTC)" truthfully even on a non-UTC machine.
function utcTime(ts: unknown): string {
  if (typeof ts !== 'string' || !ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function actorOf(row: AuditRow): string {
  const actor = row.user_id ?? row.actor_email;
  return typeof actor === 'string' && actor ? actor : '—';
}

export function AuditPanel(): JSX.Element {
  const [limit, setLimit] = useState<number>(LIMITS[0]);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [verify, setVerify] = useState<VerifyState>({ status: 'pending' });
  // Build identity next to the chain: app version, git sha and every local
  // store's schema version (GET /api/status/version), so an audit reader knows
  // which build wrote the rows in front of them.
  const [version, setVersion] = useState<string>('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await apiFetch('/api/status/version');
        if (!r.ok) return;
        const v = (await r.json()) as { version?: string; git_sha?: string; stores?: Record<string, number> };
        const stores = Object.entries(v.stores ?? {})
          .map(([k, n]) => `${k} v${n}`)
          .join(' · ');
        if (alive) setVersion(`build ${v.version ?? 'dev'} · ${v.git_sha ?? 'unknown'}${stores ? ' · ' + stores : ''}`);
      } catch {
        /* the chip simply stays empty */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await apiFetch(`/api/audit?limit=${limit}`, { cache: 'no-store' });
        if (!alive) return;
        if (r.ok) {
          const data = (await r.json()) as unknown;
          if (alive) setRows(Array.isArray(data) ? (data as AuditRow[]) : []);
        }
        if (alive) setLoaded(true);
      } catch {
        // Transient error: keep the last table, mark the load as settled so
        // the empty state does not masquerade as "still loading".
        if (alive) setLoaded(true);
      }
    };
    void load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [limit]);

  useEffect(() => {
    let alive = true;
    const check = async (): Promise<void> => {
      try {
        const r = await apiFetch('/api/audit/verify');
        if (!alive) return;
        if (!r.ok) {
          setVerify({ status: 'failed', httpCode: r.status });
          return;
        }
        const data = (await r.json()) as ChainCheck;
        if (!alive) return;
        setVerify(
          data.ok
            ? { status: 'ok', rows: data.rows }
            : { status: 'broken', firstBadId: data.first_bad_id },
        );
      } catch {
        if (alive) setVerify({ status: 'failed', httpCode: null });
      }
    };
    void check();
    return () => {
      alive = false;
    };
  }, []);

  const copyJson = async (): Promise<void> => {
    const text = JSON.stringify(rows, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Non-secure contexts (an http:// operator box) have no async
        // clipboard; the legacy execCommand path still works there.
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
    } catch {
      /* clipboard denied or missing: the button stays quiet rather than toasting */
    }
  };

  const hasClassification = rows.some((r) => typeof r.classification === 'number');
  const colSpan = 4 + (hasClassification ? 1 : 0);

  const chip =
    verify.status === 'ok' ? (
      <Badge tone="ok">chain verified · {verify.rows} rows</Badge>
    ) : verify.status === 'broken' ? (
      <Badge tone="alert">chain broken · row {verify.firstBadId ?? 'unknown'} no longer matches</Badge>
    ) : verify.status === 'failed' && verify.httpCode !== null ? (
      <Badge tone="alert">chain check failed (HTTP {verify.httpCode})</Badge>
    ) : verify.status === 'failed' ? (
      <Badge tone="alert">chain check unavailable (network)</Badge>
    ) : (
      <Badge tone="neutral">checking chain…</Badge>
    );

  return (
    <div className="p-3 flex flex-col gap-3 text-txt-1">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {chip}
          {version ? <span className="mono text-[11px] text-txt-3">{version}</span> : null}
        </div>
        <div className="flex items-center gap-1.5">
          <select
            aria-label="row limit"
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="mono text-[11px] rounded-sm border border-line-2 bg-bg-2 text-txt-1 px-1.5 py-0.5"
          >
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <Btn size="sm" onClick={() => void copyJson()}>
            Copy JSON
          </Btn>
        </div>
      </div>

      <Widget title="Audit log" count={rows.length} elevation="inset">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line-2">
                <th className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 font-medium py-1 pr-2">
                  Time (UTC)
                </th>
                <th className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 font-medium py-1 pr-2">
                  Actor
                </th>
                <th className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 font-medium py-1 pr-2">
                  Action
                </th>
                <th className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 font-medium py-1 pr-2">
                  Target
                </th>
                {hasClassification && (
                  <th className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 font-medium py-1">
                    Classification
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-line-2/60">
                  <td className="mono text-[11px] text-txt-1 py-1 pr-2 whitespace-nowrap">{utcTime(row.ts)}</td>
                  <td className="mono text-[11px] text-txt-2 py-1 pr-2 max-w-[120px] truncate" title={actorOf(row)}>
                    {actorOf(row)}
                  </td>
                  <td className="mono text-[11px] text-txt-1 py-1 pr-2">{row.action ?? '—'}</td>
                  <td className="mono text-[11px] text-txt-1 py-1 pr-2 max-w-[120px] truncate">
                    {row.target_id ?? '—'}
                  </td>
                  {hasClassification && (
                    <td className="mono text-[11px] text-txt-2 py-1">
                      {typeof row.classification === 'number' ? classificationLabel(row.classification) : '—'}
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="mono text-[11px] text-txt-3 py-2">
                    {loaded ? 'no rows yet' : 'loading…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Widget>
    </div>
  );
}
