// Reconstruction Studio — local 3D Gaussian Splatting on the box's GPU.
// Ingest images or a video → POST /api/recon/jobs → live SSE progress → view the
// finished splat in Spark (THREE.js WebGPU/WebGL2 splat renderer — full spherical
// harmonics, no DC-only/cap compromise). No upload to any cloud.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { Btn, Widget } from '../shell/instruments.js';
import { SplatView, type CamPose } from './SplatView.js';

type Stage = 'queued' | 'frames' | 'sfm' | 'train' | 'export' | 'done' | 'error';
interface Progress {
  id: string;
  status: 'running' | 'done' | 'error';
  stage: Stage;
  pct: number;
  error: string | null;
  n_gaussians: number;
  log_tail: string[];
}

const STAGE_LABEL: Record<Stage, string> = {
  queued: 'Queued',
  frames: 'Extracting frames',
  sfm: 'Structure / feed-forward geometry',
  train: 'Training Gaussian splats (GPU)',
  export: 'Exporting .ply',
  done: 'Done',
  error: 'Error',
};

export function StudioPage(): JSX.Element {
  const [files, setFiles] = useState<File[]>([]);
  const [steps, setSteps] = useState(7000);
  const [sh, setSh] = useState(3);
  const [down, setDown] = useState(1);
  const [matcher, setMatcher] = useState<'sequential' | 'exhaustive'>('sequential');
  // Satellite AOI → 3D (single-image MapAnything). Defaults: Dubai Marina, ~last month.
  const [lat, setLat] = useState(25.08);
  const [lon, setLon] = useState(55.14);
  const [radiusKm, setRadiusKm] = useState(2);
  const [satSource, setSatSource] = useState<'auto' | 'sentinel' | 'maxar' | 'gibs' | 'eusi'>('auto');
  const [satDate, setSatDate] = useState(() => new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
  const [prog, setProg] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [cam, setCam] = useState<CamPose | null>(null);

  // Load a finished job: the .ply + a good initial camera (a real training
  // viewpoint, so the viewer opens framed on the scene — not inside the cloud).
  const loadJob = useCallback(async (id: string) => {
    // Prefer the full-SH .spz (compact, whole splat, no cap); fall back to .ply.
    let url = `/api/recon/jobs/${id}/result.ply`;
    try {
      // 1-byte Range probe (HEAD isn't routed; a Range GET returns 206 if present).
      const probe = await apiFetch(`/api/recon/jobs/${id}/result.spz`, { headers: { Range: 'bytes=0-0' } });
      if (probe.ok) url = `/api/recon/jobs/${id}/result.spz`;
    } catch {
      /* no .spz → .ply */
    }
    setResultUrl(url);
    try {
      const r = await apiFetch(`/api/recon/jobs/${id}/camera.json`);
      if (r.ok) setCam((await r.json()) as CamPose);
    } catch {
      /* viewer falls back to its default camera */
    }
  }, []);

  // Reopen a finished reconstruction directly: /studio?job=<id>, or prefill the
  // satellite-AOI form from the map: /studio?lat=&lon=&radius= (Splat tab).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get('job');
    if (id) {
      void loadJob(id);
      return;
    }
    const qlat = Number(q.get('lat'));
    const qlon = Number(q.get('lon'));
    if (Number.isFinite(qlat) && Number.isFinite(qlon) && q.has('lat') && q.has('lon')) {
      setLat(qlat);
      setLon(qlon);
      const qr = Number(q.get('radius'));
      if (Number.isFinite(qr) && qr > 0) setRadiusKm(qr);
    }
  }, [loadJob]);

  const onPick = useCallback((list: FileList | null) => {
    if (list) setFiles(Array.from(list));
  }, []);

  // Shared job runner: obtain a job_id, then stream progress → load the splat.
  const runJob = useCallback(async (getJobId: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setProg(null);
    setResultUrl(null);
    setCam(null);
    try {
      const job_id = await getJobId();
      await streamEvents(job_id, (p) => {
        setProg(p);
        if (p.status === 'done') void loadJob(job_id);
      });
    } catch (e) {
      setProg({
        id: '', status: 'error', stage: 'error', pct: 0,
        error: e instanceof Error ? e.message : String(e), n_gaussians: 0, log_tail: [],
      });
    } finally {
      setBusy(false);
    }
  }, [busy, loadJob]);

  const start = useCallback(() => {
    if (!files.length) return;
    void runJob(async () => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      fd.append('steps', String(steps));
      fd.append('sh', String(sh));
      fd.append('down', String(down));
      fd.append('matcher', matcher);
      const res = await apiFetch('/api/recon/jobs', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`start failed: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { job_id: string }).job_id;
    });
  }, [files, steps, sh, down, matcher, runJob]);

  // Satellite AOI → single-image MapAnything splat (any imagery source).
  const startAoi = useCallback(() => {
    void runJob(async () => {
      const qs = new URLSearchParams({
        lat: String(lat), lon: String(lon), radius_km: String(radiusKm),
        date: satDate, source: satSource,
      });
      const res = await apiFetch(`/api/imagery/splat?${qs}`, { method: 'POST' });
      if (!res.ok) throw new Error(`AOI splat failed: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { job_id: string }).job_id;
    });
  }, [lat, lon, radiusKm, satDate, satSource, runJob]);

  const stage = prog?.stage ?? 'queued';
  const pct = prog?.pct ?? 0;

  return (
    <div className="absolute inset-0 bg-bg-0 text-txt-1 overflow-auto">
      <div className="max-w-[1400px] mx-auto p-5 grid grid-cols-[360px_1fr] gap-4 h-full">
        {/* ── left: controls ── */}
        <div className="flex flex-col gap-3 min-h-0">
          <div className="mono text-[13px] tracking-[1px] text-txt-1">RECONSTRUCTION STUDIO</div>
          <div className="mono text-[10px] text-txt-3 -mt-2">
            Local Gaussian splatting · runs on this machine's GPU · no upload
          </div>

          <Widget title="INGEST">
            <label
              className="block border border-dashed border-line-2 rounded-md p-4 text-center cursor-pointer hover:border-accent-line"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                onPick(e.dataTransfer.files);
              }}
            >
              <input
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => onPick(e.target.files)}
              />
              <div className="mono text-[11px] text-txt-2">
                {files.length ? `${files.length} file(s) selected` : 'Drop images or a video, or click'}
              </div>
              <div className="mono text-[10px] text-txt-3 mt-1">jpg / png · mp4 / mov (frames @2fps)</div>
            </label>
          </Widget>

          <Widget title="PARAMETERS">
            <div className="grid grid-cols-2 gap-2 text-[10px] mono">
              <Field label="Train steps">
                <NumberInput value={steps} onChange={setSteps} min={200} max={30000} step={500} />
              </Field>
              <Field label="SH degree">
                <NumberInput value={sh} onChange={setSh} min={0} max={3} step={1} />
              </Field>
              <Field label="Downscale">
                <NumberInput value={down} onChange={setDown} min={1} max={8} step={1} />
              </Field>
              <Field label="Matcher">
                <select
                  value={matcher}
                  onChange={(e) => setMatcher(e.target.value as 'sequential' | 'exhaustive')}
                  className="w-full bg-bg-2 border border-line-2 rounded-sm px-1 py-1 text-txt-1"
                >
                  <option value="sequential">sequential (video)</option>
                  <option value="exhaustive">exhaustive (photos)</option>
                </select>
              </Field>
            </div>
          </Widget>

          <Btn tone="accent" onClick={() => start()} disabled={busy || !files.length}>
            {busy ? 'RUNNING…' : 'START RECONSTRUCTION'}
          </Btn>

          <Widget title="SATELLITE → 3D (AOI)">
            <div className="grid grid-cols-2 gap-2 text-[10px] mono">
              <Field label="Latitude">
                <NumberInput value={lat} onChange={setLat} min={-85} max={85} step={0.001} />
              </Field>
              <Field label="Longitude">
                <NumberInput value={lon} onChange={setLon} min={-180} max={180} step={0.001} />
              </Field>
              <Field label="Radius (km)">
                <NumberInput value={radiusKm} onChange={setRadiusKm} min={0.1} max={20} step={0.5} />
              </Field>
              <Field label="Source">
                <select
                  value={satSource}
                  onChange={(e) => setSatSource(e.target.value as typeof satSource)}
                  className="w-full bg-bg-2 border border-line-2 rounded-sm px-1 py-1 text-txt-1"
                >
                  <option value="auto">auto (Maxar→S2→GIBS)</option>
                  <option value="sentinel">Sentinel-2 (10 m)</option>
                  <option value="maxar">Maxar Open Data</option>
                  <option value="gibs">GIBS VIIRS (375 m)</option>
                  <option value="eusi">EUSI VHR multi-view ≤1m (keyless)</option>
                </select>
              </Field>
              <Field label="Date">
                <input
                  type="date"
                  value={satDate}
                  onChange={(e) => setSatDate(e.target.value)}
                  className="w-full bg-bg-2 border border-line-2 rounded-sm px-1 py-1 text-txt-1"
                />
              </Field>
            </div>
            <div className="mono text-[10px] text-txt-3 mt-2 leading-tight">
              Single overhead chip → MapAnything feed-forward. Near-2.5D relief
              (textured surface), strongest at VHR; true building 3D needs multi-view.
            </div>
            <Btn tone="accent" onClick={() => startAoi()} disabled={busy}>
              {busy ? 'RUNNING…' : 'SATELLITE → SPLAT'}
            </Btn>
          </Widget>

          {prog && (
            <Widget title="PROGRESS">
              <div className="flex items-center justify-between mono text-[10px] mb-1">
                <span className={stage === 'error' ? 'text-alert' : 'text-txt-1'}>
                  {STAGE_LABEL[stage]}
                </span>
                <span className="text-txt-2">{pct.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 bg-bg-2 rounded-sm overflow-hidden">
                <div
                  className={`h-full transition-[width] duration-300 ${stage === 'error' ? 'bg-alert' : 'bg-accent'}`}
                  style={{ width: `${stage === 'error' ? 100 : pct}%` }}
                />
              </div>
              {prog.status === 'done' && (
                <div className="mono text-[10px] text-accent mt-2">
                  ✓ {prog.n_gaussians.toLocaleString()} gaussians
                </div>
              )}
              {prog.error && <div className="mono text-[10px] text-alert mt-2 break-words">{prog.error}</div>}
              {prog.log_tail.length > 0 && (
                <pre className="mono text-[10px] text-txt-3 mt-2 max-h-32 overflow-auto whitespace-pre-wrap leading-tight">
                  {prog.log_tail.join('\n')}
                </pre>
              )}
            </Widget>
          )}
        </div>

        {/* ── right: viewer ── */}
        <div className="min-h-0 rounded-md border border-line bg-black/40 relative">
          {resultUrl ? (
            <SplatView url={resultUrl} cam={cam} />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center mono text-[11px] text-txt-3">
              {busy ? 'Reconstructing… the splat appears here when training completes.' : 'No splat yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-txt-3">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  value, onChange, min, max, step,
}: { value: number; onChange: (n: number) => void; min: number; max: number; step: number }): JSX.Element {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
      className="w-full bg-bg-2 border border-line-2 rounded-sm px-1 py-1 text-txt-1"
    />
  );
}

// Read the SSE stream via apiFetch so the API key / bearer is carried (a raw
// EventSource cannot set auth headers). Frames are `data: {json}\n\n`.
async function streamEvents(jobId: string, onEvent: (p: Progress) => void): Promise<void> {
  const res = await apiFetch(`/api/recon/jobs/${jobId}/events`);
  if (!res.ok || !res.body) throw new Error(`events failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as Progress);
      } catch {
        /* partial / non-JSON keepalive */
      }
    }
  }
}
