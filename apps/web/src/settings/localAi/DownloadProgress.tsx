// Polls GET /api/ai/models/download/{job_id} until the job lands in a
// terminal state (done/error), rendering the MeterBar progress primitive.
// Used by both the catalog browser and the first-run setup wizard.
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../transport/http.js';
import { MeterBar } from '../../shell/instruments.js';
import { humanBytes, type DownloadJob } from './types.js';

const POLL_MS = 1000;

export function DownloadProgress({
  jobId,
  onDone,
}: {
  jobId: string;
  onDone: (job: DownloadJob) => void;
}): JSX.Element {
  const [job, setJob] = useState<DownloadJob | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let live = true;
    doneRef.current = false;
    const poll = async (): Promise<void> => {
      if (!live || doneRef.current) return;
      try {
        const r = await apiFetch(`/api/ai/models/download/${encodeURIComponent(jobId)}`);
        if (!live) return;
        if (!r.ok) return; // transient — keep polling on the same cadence
        const body = (await r.json()) as DownloadJob;
        setJob(body);
        if (body.status === 'done' || body.status === 'error') {
          doneRef.current = true;
          onDone(body);
          return;
        }
      } catch {
        /* transient network hiccup — next tick retries */
      }
      if (live && !doneRef.current) window.setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      live = false;
    };
    // onDone is a fresh closure per render in callers; only jobId identifies the poll loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (!job) {
    return <p className="mono text-[10px] text-txt-3">queued…</p>;
  }
  if (job.status === 'error') {
    return <p className="mono text-[10px] text-alert">download failed{job.error ? `: ${job.error}` : ''}</p>;
  }
  if (job.status === 'done') {
    return <p className="mono text-[10px] text-ok">✓ installed</p>;
  }
  return (
    <div className="space-y-1">
      <MeterBar pct={job.progress_pct} />
      <p className="mono text-[10px] text-txt-3 tabular-nums">
        {job.status} · {humanBytes(job.bytes_done)} / {humanBytes(job.bytes_total)} ·{' '}
        {job.progress_pct.toFixed(0)}%
      </p>
    </div>
  );
}
