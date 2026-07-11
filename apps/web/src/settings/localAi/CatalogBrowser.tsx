// Curated model catalog, one card per size tier (8B..700B). Each card shows
// the license, a quant dropdown preselected to the backend's recommended
// quant with a per-quant fits-now indicator, and a download button that
// kicks off POST /api/ai/models/download then polls the returned job_id.
// A custom-repo field below lets an operator pull any other unsloth/* GGUF
// repo — client-side regex-gated (defence in depth; the server enforces the
// same org restriction and is the actual security boundary, 422 surfaced here).
import { useState } from 'react';
import { apiFetch } from '../../transport/http.js';
import { Badge, Btn } from '../../shell/instruments.js';
import { DownloadProgress } from './DownloadProgress.js';
import { UNSLOTH_REPO_RE, type CatalogEntry, type DownloadJob, type InstalledModel } from './types.js';

interface ActiveJob {
  repoId: string;
  quant: string;
  jobId: string;
}

export function CatalogBrowser({
  catalog,
  installed,
  onDownloaded,
}: {
  catalog: CatalogEntry[];
  installed: InstalledModel[];
  onDownloaded: () => void;
}): JSX.Element {
  const [jobs, setJobs] = useState<Record<string, ActiveJob>>({});

  const startDownload = async (repoId: string, quant: string): Promise<void> => {
    const rowKey = repoId;
    try {
      const r = await apiFetch('/api/ai/models/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo_id: repoId, quant }),
      });
      if (r.status !== 202) {
        const detail = await readError(r);
        setJobs((j) => ({ ...j, [rowKey]: { repoId, quant, jobId: `error:${detail}` } }));
        return;
      }
      const body = (await r.json()) as { job_id: string };
      setJobs((j) => ({ ...j, [rowKey]: { repoId, quant, jobId: body.job_id } }));
    } catch {
      setJobs((j) => ({ ...j, [rowKey]: { repoId, quant, jobId: 'error:network error' } }));
    }
  };

  const clearJob = (job: DownloadJob): void => {
    if (job.status === 'done') onDownloaded();
  };

  return (
    <div className="space-y-2">
      {catalog.map((entry) => (
        <CatalogCard
          key={entry.repo_id}
          entry={entry}
          alreadyInstalledQuants={
            new Set(installed.filter((m) => m.repo_id === entry.repo_id).map((m) => m.quant))
          }
          job={jobs[entry.repo_id] ?? null}
          onDownload={(quant) => void startDownload(entry.repo_id, quant)}
          onJobDone={(job) => clearJob(job)}
        />
      ))}
      <CustomRepoField onDownload={startDownload} />
    </div>
  );
}

function CatalogCard({
  entry,
  alreadyInstalledQuants,
  job,
  onDownload,
  onJobDone,
}: {
  entry: CatalogEntry;
  alreadyInstalledQuants: Set<string>;
  job: ActiveJob | null;
  onDownload: (quant: string) => void;
  onJobDone: (job: DownloadJob) => void;
}): JSX.Element {
  const [quant, setQuant] = useState(entry.recommended_quant);
  const q = entry.quants.find((x) => x.q === quant) ?? entry.quants[0];
  const isErrorJob = job?.jobId.startsWith('error:');
  const installed = alreadyInstalledQuants.has(quant);

  return (
    <div className="rounded-sm border border-line bg-bg-2/50 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="mono text-[11px] text-txt-1 font-medium">{entry.label}</span>
            <Badge tone="neutral">{entry.tier}</Badge>
          </div>
          <div className="mono text-[10px] text-txt-3 mt-0.5 truncate" title={entry.repo_id}>
            {entry.repo_id}
          </div>
          <div className="mono text-[10px] text-txt-3 mt-0.5">
            {entry.params}
            {entry.active_params ? ` (${entry.active_params} active)` : ''} · {entry.ctx} ctx
          </div>
        </div>
        <Badge tone="neutral">{entry.license}</Badge>
      </div>

      <div className="flex items-center gap-1.5 mt-2">
        <select
          value={quant}
          onChange={(e) => setQuant(e.target.value)}
          aria-label={`Quant for ${entry.label}`}
          className="mono text-[10px] bg-bg-2 border border-line rounded-sm px-1.5 py-1 text-txt-1 outline-none focus:border-accent-line"
        >
          {entry.quants.map((qq) => (
            <option key={qq.q} value={qq.q}>
              {qq.q} · {qq.size_gb.toFixed(1)} GB{qq.fits_now ? '' : ' (won’t fit)'}
            </option>
          ))}
        </select>
        {q && (
          <span
            className={`mono text-[10px] ${q.fits_now ? 'text-ok' : 'text-alert'}`}
            title={q.fits_now ? 'fits current hardware' : 'exceeds available VRAM/RAM/disk'}
          >
            {q.fits_now ? '✓ fits' : '✗ won’t fit'}
          </span>
        )}
        <div className="flex-1" />
        {installed ? (
          <Badge tone="ok">installed</Badge>
        ) : (
          <Btn
            size="sm"
            tone="accent"
            disabled={!q?.fits_now || (job != null && !isErrorJob)}
            onClick={() => onDownload(quant)}
          >
            ⭳ Download
          </Btn>
        )}
      </div>

      {entry.runner_up && (
        <p className="mono text-[10px] text-txt-3 mt-1.5">
          runner-up: {entry.runner_up.label} ({entry.runner_up.repo_id})
        </p>
      )}

      {job && !isErrorJob && (
        <div className="mt-2">
          <DownloadProgress jobId={job.jobId} onDone={onJobDone} />
        </div>
      )}
      {job && isErrorJob && (
        <p className="mono text-[10px] text-alert mt-1.5">{job.jobId.slice('error:'.length)}</p>
      )}
    </div>
  );
}

function CustomRepoField({
  onDownload,
}: {
  onDownload: (repoId: string, quant: string) => void;
}): JSX.Element {
  const [repoId, setRepoId] = useState('');
  const [quant, setQuant] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);

  const valid = UNSLOTH_REPO_RE.test(repoId.trim()) && quant.trim().length > 0;

  const submit = async (): Promise<void> => {
    setServerError(null);
    if (!valid) return;
    const trimmedRepo = repoId.trim();
    const trimmedQuant = quant.trim();
    try {
      const r = await apiFetch('/api/ai/models/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo_id: trimmedRepo, quant: trimmedQuant }),
      });
      if (r.status === 422) {
        setServerError(await readError(r));
        return;
      }
      if (r.status !== 202) {
        setServerError(`request failed (${r.status})`);
        return;
      }
      onDownload(trimmedRepo, trimmedQuant);
      setRepoId('');
      setQuant('');
    } catch {
      setServerError('network error');
    }
  };

  return (
    <div className="rounded-sm border border-line-2 border-dashed bg-bg-2/30 p-2.5">
      <p className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1.5">Custom unsloth repo</p>
      <div className="flex items-center gap-1.5">
        <input
          value={repoId}
          onChange={(e) => setRepoId(e.target.value)}
          placeholder="unsloth/Some-Model-GGUF"
          spellCheck={false}
          autoComplete="off"
          className="flex-[2] mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 outline-none focus:border-accent-line"
        />
        <input
          value={quant}
          onChange={(e) => setQuant(e.target.value)}
          placeholder="quant (e.g. UD-Q4_K_XL)"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 outline-none focus:border-accent-line"
        />
        <Btn size="sm" tone="accent" disabled={!valid} onClick={() => void submit()}>
          Fetch
        </Btn>
      </div>
      {repoId.trim() && !UNSLOTH_REPO_RE.test(repoId.trim()) && (
        <p className="mono text-[10px] text-warn mt-1">must match unsloth/&lt;name&gt; (org-restricted)</p>
      )}
      {serverError && <p className="mono text-[10px] text-alert mt-1">{serverError}</p>}
    </div>
  );
}

async function readError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { detail?: unknown };
    const d = j.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d) && d.length > 0) {
      const first = d[0] as { msg?: string };
      if (first?.msg) return first.msg;
    }
  } catch {
    /* non-JSON body */
  }
  if (r.status === 507) return 'not enough free disk space';
  return `failed (${r.status})`;
}
