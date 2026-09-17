import { Antenna } from 'lucide-react';
import { useCallback, useState } from 'react';

import { apiFetch } from '../transport/http.js';
import { Badge, Btn, Toggle } from '../shell/instruments.js';
import { Modal, useConfirm } from '../shell/Modal.js';
import { useFoundry } from '../state/foundry.js';
import { useFoundryPoll } from './useFoundryPoll.js';
import { EmptyState, Field, Select, Th, ViewHeader, controlCls, rowCls, stamp, tableHeadCls } from './ui.js';
import { Icon } from '../normal/Icon.js';

// Connections — sources the OPERATOR configured, as opposed to the ~100 feeds
// this repo wrote code for. An MQTT topic, a Kafka topic or a query against
// their own SQL database lands in a Foundry dataset, and the binding editor
// next door carries it on into the ontology.
//
// Kafka and SQL need an optional client, so the backend reports which kinds it
// can actually run and this view greys out the rest rather than letting someone
// configure a connection that will only fail at run time.
//
// ponytail: local fetch + useFoundryPoll rather than another slice of the
// foundry store. Nothing else on the page reads connections.

interface Connection {
  id: string;
  name: string;
  kind: 'mqtt' | 'kafka' | 'sql';
  dataset_id: string;
  config: Record<string, unknown>;
  enabled: boolean;
  running: boolean;
  last_ok: string | null;
  last_error: string | null;
  rows_total: number;
}

type Availability = Record<string, { available: boolean; detail: string }>;

interface ConnectorEntry {
  kind: string;
  title: string;
  needs: string;
  available: boolean;
  docs: string;
}

// GET /api/foundry/connectors — every way a dataset can be filled, not just
// the three you can configure a running connection for (upload + the push
// endpoint below are their own routes, and `sql-table` is a config shape of
// the `sql` kind, not a fourth thing to pick in the editor).
function ConnectorCatalog({ rows }: { rows: ConnectorEntry[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-md border border-line-2 bg-bg-1 overflow-hidden">
      <table className="w-full border-collapse">
        <thead>
          <tr className={tableHeadCls()}>
            <Th>Source</Th>
            <Th>Needs</Th>
            <Th align="center">Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.kind} className={rowCls}>
              <td className="px-2.5 py-1.5 max-w-0">
                <div className="text-[11px] text-txt-1">{r.title}</div>
                <div className="text-[10px] text-txt-3">{r.docs}</div>
              </td>
              <td className="px-2.5 py-1.5 mono text-[10px] text-txt-3 whitespace-nowrap">{r.needs}</td>
              <td className="px-2.5 py-1.5 text-center">
                {r.available ? <Badge tone="ok">available</Badge> : <Badge tone="neutral">unavailable</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const KIND_HINT: Record<Connection['kind'], string> = {
  mqtt: 'Subscribe to a topic on your broker',
  kafka: 'Consume a topic from your cluster',
  sql: 'Poll a read-only query, or cursor pull one named table',
};

// The two sql sub-modes the backend accepts under one kind (foundry/connections.py):
// `query` re-reads the whole answer every cycle; `table` pulls only the rows whose
// cursor column is past the last persisted value.
type SqlMode = 'query' | 'table';

// Mirrors the backend's boundary check (`valid_identifier`) so a value that can
// never be a bare identifier is caught here instead of after a round trip.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifierError(field: string, value: string): string | null {
  if (IDENT_RE.test(value)) return null;
  return `${field} must be a bare SQL identifier (letters/digits/underscore, not starting with a digit)`;
}

// Two states, both visible, the active one carrying the accent. Not a <label>
// wrapper: a label around buttons hijacks the click for its first labelable
// descendant.
function SqlModeToggle({ mode, onChange }: { mode: SqlMode; onChange: (m: SqlMode) => void }): JSX.Element {
  return (
    <div role="group" aria-label="query · table" className="flex items-center gap-1.5">
      {(['query', 'table'] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          onClick={() => onChange(m)}
          className={[
            'mono text-[11px] px-2 py-1 rounded-sm border transition-colors',
            mode === m
              ? 'border-accent-line bg-accent-dim text-accent-fg'
              : 'border-line-2 text-txt-2 hover:border-accent-line hover:text-txt-0',
          ].join(' ')}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function ConnectionEditor({
  open,
  onClose,
  availability,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  availability: Availability;
  onSaved: () => void;
}): JSX.Element | null {
  const datasets = useFoundry((s) => s.datasets);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Connection['kind']>('mqtt');
  const [datasetId, setDatasetId] = useState('');
  const [url, setUrl] = useState('');
  const [topic, setTopic] = useState('');
  const [servers, setServers] = useState('');
  const [dsnEnv, setDsnEnv] = useState('');
  const [query, setQuery] = useState('');
  const [sqlMode, setSqlMode] = useState<SqlMode>('query');
  const [table, setTable] = useState('');
  const [cursorColumn, setCursorColumn] = useState('');
  const [batch, setBatch] = useState('5000');
  const [intervalS, setIntervalS] = useState('300');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const config = (): Record<string, unknown> => {
    if (kind === 'mqtt') return { url, topic };
    if (kind === 'kafka') return { bootstrap_servers: servers, topic };
    if (sqlMode === 'table') {
      return {
        dsn_env: dsnEnv,
        table,
        cursor_column: cursorColumn,
        batch: Number(batch) || 5000,
        interval_s: Number(intervalS) || 300,
      };
    }
    return { dsn_env: dsnEnv, query, interval_s: Number(intervalS) || 300 };
  };

  const save = async (): Promise<void> => {
    const badIdentifier =
      kind === 'sql' && sqlMode === 'table'
        ? identifierError('table', table) ?? identifierError('cursor_column', cursorColumn)
        : null;
    if (badIdentifier) {
      setError(badIdentifier);
      return;
    }
    setSaving(true);
    setError(null);
    const r = await apiFetch('/api/foundry/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, kind, dataset_id: datasetId, config: config() }),
    }).catch(() => null);
    setSaving(false);
    if (!r || !r.ok) {
      const detail = r ? ((await r.json().catch(() => null))?.detail ?? null) : null;
      setError(typeof detail === 'string' ? detail : `Could not save the connection (HTTP ${r?.status ?? 0})`);
      return;
    }
    setName('');
    setUrl('');
    setTopic('');
    setServers('');
    setDsnEnv('');
    setQuery('');
    setTable('');
    setCursorColumn('');
    onSaved();
    onClose();
  };

  const sqlReady = sqlMode === 'table' ? !!(dsnEnv && table && cursorColumn) : !!(dsnEnv && query);
  const ready =
    name.trim() !== '' &&
    datasetId !== '' &&
    (kind === 'mqtt' ? !!(url && topic) : kind === 'kafka' ? !!(servers && topic) : sqlReady);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New connection"
      footer={
        <>
          <Btn size="sm" onClick={onClose}>
            Cancel
          </Btn>
          <Btn size="sm" tone="accent" disabled={!ready || saving} onClick={() => void save()}>
            {saving ? 'saving…' : 'Create'}
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <p className="rounded-sm border border-alert-line bg-alert-dim px-2.5 py-1.5 text-[11px] text-alert">
            {error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="warehouse_orders" className={controlCls} />
          </Field>
          <Field label="Kind" hint={KIND_HINT[kind]}>
            <Select
              value={kind}
              onChange={(v) => setKind(v as Connection['kind'])}
              options={(['mqtt', 'kafka', 'sql'] as const).map((k) => ({
                value: k,
                // A kind whose client is not installed still lists, saying why.
                // Hiding it would read as "this platform cannot do Kafka".
                label: availability[k]?.available === false ? `${k} · ${availability[k]?.detail}` : k,
              }))}
            />
          </Field>
        </div>
        <Field label="Target dataset" hint="rows are appended as a new version">
          <Select
            value={datasetId}
            onChange={setDatasetId}
            placeholder="select a dataset…"
            options={datasets.map((d) => ({ value: d.id, label: d.name }))}
          />
        </Field>

        {kind === 'mqtt' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Broker URL" hint="mqtt:// mqtts:// ws:// or wss://">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="mqtt://broker.example:1883" className={controlCls} />
            </Field>
            <Field label="Topic" hint="wildcards + and # are allowed">
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="sensors/#" className={controlCls} />
            </Field>
          </div>
        )}
        {kind === 'kafka' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bootstrap servers">
              <input value={servers} onChange={(e) => setServers(e.target.value)} placeholder="broker1:9092,broker2:9092" className={controlCls} />
            </Field>
            <Field label="Topic">
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="orders" className={controlCls} />
            </Field>
          </div>
        )}
        {kind === 'sql' && (
          <>
            <Field
              label="DSN environment variable"
              hint="the NAME of a variable in the backend's environment, never the connection string itself"
            >
              <input value={dsnEnv} onChange={(e) => setDsnEnv(e.target.value.toUpperCase())} placeholder="OSINT_SQL_DSN_WAREHOUSE" className={controlCls} />
            </Field>
            <div className="space-y-1">
              <span className="block text-[10px] uppercase tracking-[0.4px] text-txt-3">Mode</span>
              <SqlModeToggle mode={sqlMode} onChange={setSqlMode} />
            </div>
            {sqlMode === 'query' ? (
              <Field label="Query" hint="read only; the whole answer becomes one new version">
                <textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  rows={3}
                  placeholder="SELECT id, name, lat, lon FROM sites"
                  className={`${controlCls} font-mono`}
                />
              </Field>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <Field label="Table" hint="one named table">
                  <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="flight_logs" className={controlCls} />
                </Field>
                <Field label="Cursor column" hint="monotonic, e.g. an id or a timestamp">
                  <input value={cursorColumn} onChange={(e) => setCursorColumn(e.target.value)} placeholder="id" className={controlCls} />
                </Field>
                <Field label="Batch" hint="rows per cycle">
                  <input value={batch} onChange={(e) => setBatch(e.target.value)} type="number" className={controlCls} />
                </Field>
              </div>
            )}
            <Field label="Interval (seconds)" hint="minimum 30">
              <input value={intervalS} onChange={(e) => setIntervalS(e.target.value)} inputMode="numeric" className={controlCls} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function summarise(c: Connection): string {
  const cfg = c.config;
  if (c.kind === 'mqtt') return `${String(cfg['url'] ?? '')} · ${String(cfg['topic'] ?? '')}`;
  if (c.kind === 'kafka') return `${String(cfg['bootstrap_servers'] ?? '')} · ${String(cfg['topic'] ?? '')}`;
  if (cfg['table']) {
    // The cursor value is written by the runner every cycle, so a connection
    // that has not pulled yet reports no value — the lone dash, not a zero.
    const cursor = cfg['cursor_value'];
    const reported = cursor === undefined || cursor === null || cursor === '' ? '—' : String(cursor);
    return `table · ${String(cfg['table'])} · cursor ${String(cfg['cursor_column'] ?? '')} = ${reported}`;
  }
  return `$${String(cfg['dsn_env'] ?? '')} · every ${String(cfg['interval_s'] ?? 300)}s`;
}

function ConnectionCard({
  conn,
  onChanged,
  confirm,
}: {
  conn: Connection;
  onChanged: () => void;
  confirm: (o: { title: string; body?: string; tone?: 'danger' | 'neutral'; confirmLabel?: string }) => Promise<boolean>;
}): JSX.Element {
  const datasets = useFoundry((s) => s.datasets);
  const datasetName = datasets.find((d) => d.id === conn.dataset_id)?.name ?? conn.dataset_id;

  const setEnabled = async (enabled: boolean): Promise<void> => {
    await apiFetch(`/api/foundry/connections/${conn.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset_id: conn.dataset_id, config: conn.config, enabled }),
    }).catch(() => undefined);
    onChanged();
  };

  const remove = async (): Promise<void> => {
    if (!(await confirm({ title: `Delete the connection ${conn.name}?`, tone: 'danger', confirmLabel: 'Delete' }))) return;
    await apiFetch(`/api/foundry/connections/${conn.id}`, { method: 'DELETE' }).catch(() => undefined);
    onChanged();
  };

  return (
    <div className="rounded-md border border-line-2 bg-bg-1 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[12px] text-txt-0 truncate">{conn.name}</span>
          <Badge tone="mag">{conn.kind}</Badge>
          <span aria-hidden className="text-txt-3">→</span>
          <span className="text-[11px] text-txt-2 truncate">{datasetName}</span>
          {conn.running ? <Badge tone="ok">running</Badge> : conn.enabled ? <Badge tone="warn">starting</Badge> : <Badge tone="neutral">disabled</Badge>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Toggle on={conn.enabled} onChange={(next) => void setEnabled(next)} label="enabled" />
          <button type="button" onClick={() => void remove()} className="text-txt-3 hover:text-alert text-[12px]" aria-label="Delete connection">
            <Icon name="x" className="w-3 h-3" />
          </button>
        </div>
      </div>
      <div className="mono text-[10px] text-txt-3 truncate">{summarise(conn)}</div>
      <div className="mono text-[10px] flex items-center gap-2 flex-wrap">
        <Badge tone="accent">{conn.rows_total} rows</Badge>
        <span className="text-txt-3">last ok {conn.last_ok ? stamp(conn.last_ok) : '—'}</span>
        {conn.last_error && <Badge tone="alert">{conn.last_error}</Badge>}
      </div>
    </div>
  );
}

// ── push endpoints ────────────────────────────────────────────────────────────
// The other direction: instead of the platform dialling out, a sender pushes in.
// Arming a dataset mints a token, and the token is displayed exactly once
// because only its hash is stored. This is the operator's only address for
// POST /api/ingest/{dataset_id}, which by design no browser code ever calls.

function PushEndpoints(): JSX.Element {
  const datasets = useFoundry((s) => s.datasets);
  const [minted, setMinted] = useState<{ dataset: string; token: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, confirmElement } = useConfirm();

  const arm = async (id: string, name: string): Promise<void> => {
    setBusy(id);
    const r = await apiFetch(`/api/foundry/datasets/${id}/ingest-token`, { method: 'POST' }).catch(() => null);
    setBusy(null);
    if (!r || !r.ok) return;
    const body = (await r.json()) as { token: string; url: string };
    setMinted({ dataset: name, token: body.token, url: body.url });
  };

  const close = async (id: string, name: string): Promise<void> => {
    if (!(await confirm({ title: `Close the push endpoint for ${name}?`, body: 'Any sender using the current token stops working.', tone: 'danger', confirmLabel: 'Close' }))) return;
    await apiFetch(`/api/foundry/datasets/${id}/ingest-token`, { method: 'DELETE' }).catch(() => undefined);
  };

  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-txt-1">Push endpoints</h3>
      <p className="text-[11px] text-txt-3">
        Give a sender a URL instead of configuring a source here. Anything that can make an HTTP POST reaches
        it: a shell script, a CI step, a bridge from a queue this build has no client for.
      </p>
      <div className="rounded-md border border-line-2 bg-bg-1 divide-y divide-line">
        {datasets.length === 0 && <p className="px-3 py-2 text-[11px] text-txt-3">No datasets yet.</p>}
        {datasets.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-[11px] text-txt-1 truncate">{d.name}</span>
            <span className="flex items-center gap-2 shrink-0">
              <Btn size="sm" disabled={busy === d.id} onClick={() => void arm(d.id, d.name)}>
                {busy === d.id ? 'arming…' : 'Arm / rotate'}
              </Btn>
              <Btn size="sm" onClick={() => void close(d.id, d.name)}>
                Close
              </Btn>
            </span>
          </div>
        ))}
      </div>

      <Modal
        open={minted !== null}
        onClose={() => setMinted(null)}
        title={`Push endpoint for ${minted?.dataset ?? ''}`}
        footer={
          <Btn size="sm" tone="accent" onClick={() => setMinted(null)}>
            Done
          </Btn>
        }
      >
        <div className="space-y-2">
          <p className="text-[11px] text-txt-2">
            Copy this now. Only a hash of the token is stored, so it cannot be shown again. Arming the dataset
            a second time replaces it.
          </p>
          <pre className="mono text-[10px] whitespace-pre-wrap break-all rounded-sm border border-line-2 bg-bg-2 px-2.5 py-2 text-txt-1">
{`curl -X POST ${minted?.url ?? ''} \\
  -H 'X-Ingest-Token: ${minted?.token ?? ''}' \\
  -H 'content-type: application/json' \\
  -d '{"your": "row"}'`}
          </pre>
        </div>
      </Modal>
      {confirmElement}
    </section>
  );
}

export function ConnectionsView(): JSX.Element {
  const loadDatasets = useFoundry((s) => s.loadDatasets);
  const [rows, setRows] = useState<Connection[]>([]);
  const [availability, setAvailability] = useState<Availability>({});
  const [connectors, setConnectors] = useState<ConnectorEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [editorOpen, setEditorOpen] = useState(false);
  const { confirm, confirmElement } = useConfirm();

  const load = useCallback(async (): Promise<void> => {
    const r = await apiFetch('/api/foundry/connections').catch(() => null);
    if (!r || !r.ok) {
      setStatus('error');
      return;
    }
    const body = (await r.json()) as { connections: Connection[]; availability: Availability };
    setRows(body.connections ?? []);
    setAvailability(body.availability ?? {});
    setStatus('ready');
  }, []);

  const loadConnectors = useCallback(async (): Promise<void> => {
    const r = await apiFetch('/api/foundry/connectors').catch(() => null);
    if (r && r.ok) setConnectors(((await r.json()) as ConnectorEntry[]) ?? []);
  }, []);

  useFoundryPoll(async () => {
    await Promise.all([load(), loadDatasets(), loadConnectors()]);
  });

  const unavailable = Object.entries(availability).filter(([, v]) => !v.available);

  return (
    <div className="p-4 space-y-3">
      <ViewHeader
        title="Connections"
        subtitle="Your own broker, cluster or database. Rows land in a dataset, and a binding carries them into the ontology."
        actions={
          <Btn size="sm" tone="accent" onClick={() => setEditorOpen(true)}>
            New connection
          </Btn>
        }
        meta={
          unavailable.length > 0 ? (
            <span className="mono text-[10px] text-txt-3">
              {unavailable.map(([k, v]) => `${k} ${v.detail}`).join(' · ')}
            </span>
          ) : undefined
        }
      />

      <ConnectorCatalog rows={connectors} />

      {status === 'error' && (
        <p className="rounded-sm border border-alert-line bg-alert-dim px-2.5 py-1.5 text-[11px] text-alert">
          Connections unavailable. The backend did not answer.
        </p>
      )}

      {status === 'ready' && rows.length === 0 && (
        <EmptyState
          icon={Antenna}
          title="No connections yet"
          hint="An MQTT or Kafka topic streams in continuously; a SQL query is polled on an interval. Each one appends to a dataset you choose."
          action={
            <Btn size="sm" tone="accent" onClick={() => setEditorOpen(true)}>
              New connection
            </Btn>
          }
        />
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {rows.map((c) => (
          <ConnectionCard key={c.id} conn={c} onChanged={() => void load()} confirm={confirm} />
        ))}
      </div>

      <PushEndpoints />

      <ConnectionEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        availability={availability}
        onSaved={() => void load()}
      />
      {confirmElement}
    </div>
  );
}
