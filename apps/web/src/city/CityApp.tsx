// CITY 3D surface (docs/dashboard-workflows-plan.md §4) — keyless
// gaussian-splat 3D scene viewer. Reuses the Spark/THREE viewer already built
// for the Reconstruction Studio (studio/SplatView.tsx, extracted from
// StudioPage.tsx so both apps share one implementation) — this file only adds
// scene *sources* + a left rail + an info chip around that viewer. Sources are
// all keyless: finished recon job results (GET /api/recon/jobs), a local file
// (input + object URL), a pasted URL, or a deep link into the existing
// satellite-AOI training flow in Reconstruction Studio (no training happens
// here — CLAUDE.md "find the reuse first").
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { Btn, Widget, Badge } from '../shell/instruments.js';
import { SplatView, type CamPose } from '../studio/SplatView.js';

interface ReconJob {
  id: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  pct: number;
  error: string | null;
  n_gaussians: number;
  log_tail: string[];
}

type SceneSource = 'recon' | 'file' | 'url';

interface Scene {
  url: string;
  cam: CamPose | null;
  label: string;
  source: SceneSource;
  // Known splat count, when we have one from the server (recon jobs report
  // n_gaussians from the .ply header) — never fabricated for file/URL scenes.
  splatCount: number | null;
}

export function CityApp(): JSX.Element {
  const [jobs, setJobs] = useState<ReconJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [lat, setLat] = useState(25.08);
  const [lon, setLon] = useState(55.14);
  const [radiusKm, setRadiusKm] = useState(2);
  // Mesh-reported splat count for file/URL scenes (best-effort, from Spark).
  const [meshCount, setMeshCount] = useState<number | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // Monotonic counter so a slow openJob can't clobber a scene set by a later
  // click (last-click-wins, not last-response-wins).
  const openSeqRef = useRef(0);

  const fetchJobs = useCallback(async () => {
    setJobsLoading(true);
    setJobsError(null);
    try {
      const res = await apiFetch('/api/recon/jobs');
      if (!res.ok) throw new Error(`jobs list failed: ${res.status}`);
      const body = (await res.json()) as { jobs?: ReconJob[] };
      setJobs(body.jobs ?? []);
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : String(e));
    } finally {
      setJobsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchJobs();
  }, [fetchJobs]);

  // Release any object URL we minted for a local file when it's replaced or
  // the app unmounts.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const setSceneRevokingPrior = useCallback((next: Scene) => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setMeshCount(null);
    setScene(next);
  }, []);

  // Same probe StudioPage.loadJob uses: prefer the compact full-SH .spz, fall
  // back to .ply (a 1-byte Range GET returns 206 if the file exists).
  const openJob = useCallback(async (job: ReconJob) => {
    const seq = ++openSeqRef.current;
    let url = `/api/recon/jobs/${job.id}/result.ply`;
    try {
      const probe = await apiFetch(`/api/recon/jobs/${job.id}/result.spz`, {
        headers: { Range: 'bytes=0-0' },
      });
      if (probe.ok) url = `/api/recon/jobs/${job.id}/result.spz`;
    } catch {
      /* no .spz -> .ply */
    }
    let cam: CamPose | null = null;
    try {
      const r = await apiFetch(`/api/recon/jobs/${job.id}/camera.json`);
      if (r.ok) cam = (await r.json()) as CamPose;
    } catch {
      /* viewer falls back to its default camera */
    }
    if (seq !== openSeqRef.current) return; // superseded by a later click
    setSceneRevokingPrior({
      url,
      cam,
      label: `recon job ${job.id}`,
      source: 'recon',
      splatCount: job.n_gaussians || null,
    });
  }, [setSceneRevokingPrior]);

  const openFile = useCallback((file: File) => {
    openSeqRef.current++; // supersede any in-flight openJob
    // Revoke the prior blob before minting a new one — file→file swaps don't
    // go through setSceneRevokingPrior, so without this the old blob leaks.
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setMeshCount(null);
    setScene({ url, cam: null, label: file.name, source: 'file', splatCount: null });
  }, []);

  const openUrl = useCallback(() => {
    const u = urlInput.trim();
    if (!u) return;
    openSeqRef.current++; // supersede any in-flight openJob
    setSceneRevokingPrior({ url: u, cam: null, label: u, source: 'url', splatCount: null });
  }, [urlInput, setSceneRevokingPrior]);

  // Deep-link into the existing satellite-AOI training flow — Studio owns the
  // actual reconstruction; City 3D never reimplements it (docs/dashboard-
  // workflows-plan.md §4 + CLAUDE.md "find the reuse first").
  const buildFromAoi = useCallback(() => {
    const qs = new URLSearchParams({ lat: String(lat), lon: String(lon), radius: String(radiusKm) });
    window.open(`/studio?${qs.toString()}`, '_blank', 'noopener');
  }, [lat, lon, radiusKm]);

  const doneJobs = jobs.filter((j) => j.status === 'done');
  const shownCount = scene?.splatCount ?? meshCount;

  return (
    <div className="h-full flex text-txt-1 bg-bg-0">
      <nav className="w-[230px] shrink-0 border-r border-line-2 bg-bg-1 flex flex-col overflow-y-auto">
        <div className="flex items-center gap-2 px-3 h-11 border-b border-line-2 shrink-0">
          <span aria-hidden className="w-2.5 h-2.5 bg-accent rotate-45 shrink-0" />
          <span className="mono font-semibold tracking-[1.5px] text-[12px] text-txt-0">CITY 3D</span>
        </div>
        <div className="flex-1 p-2.5 flex flex-col gap-3">
          <Widget
            title="RECON JOBS"
            count={doneJobs.length}
            action={
              <Btn size="sm" onClick={() => void fetchJobs()} disabled={jobsLoading} title="Refresh">
                {jobsLoading ? '…' : '↻'}
              </Btn>
            }
          >
            {jobsError && <div className="mono text-[10px] text-alert">{jobsError}</div>}
            {!jobsError && !jobsLoading && doneJobs.length === 0 && (
              <div className="mono text-[10px] text-txt-3">
                No finished recon jobs yet — build one in Reconstruction Studio.
              </div>
            )}
            <div className="flex flex-col gap-1">
              {doneJobs.map((j) => {
                const active = scene?.source === 'recon' && scene.label === `recon job ${j.id}`;
                return (
                  <button
                    key={j.id}
                    type="button"
                    data-testid={`city-job-${j.id}`}
                    onClick={() => void openJob(j)}
                    className={[
                      'text-left px-2 py-1.5 rounded-sm border flex items-center justify-between gap-2 transition-colors',
                      active
                        ? 'border-accent-line bg-accent-dim text-txt-0'
                        : 'border-line-2 bg-bg-2 text-txt-2 hover:text-txt-0 hover:border-accent-line',
                    ].join(' ')}
                  >
                    <span className="mono text-[10px] truncate">{j.id}</span>
                    <span className="mono text-[9px] text-txt-3 tabular-nums shrink-0">
                      {j.n_gaussians ? `${j.n_gaussians.toLocaleString()} pts` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </Widget>

          <Widget title="OPEN FILE">
            <label className="block border border-dashed border-line-2 rounded-md p-3 text-center cursor-pointer hover:border-accent-line">
              <input
                type="file"
                accept=".ply,.splat,.spz,.ksplat"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) openFile(f);
                  e.target.value = '';
                }}
              />
              <div className="mono text-[10px] text-txt-2">Click to choose a local splat file</div>
              <div className="mono text-[9px] text-txt-3 mt-1">.ply · .splat · .spz · .ksplat</div>
            </label>
          </Widget>

          <Widget title="LOAD FROM URL">
            <div className="flex flex-col gap-1.5">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://…/scene.spz"
                className="w-full bg-bg-2 border border-line-2 rounded-sm px-1.5 py-1 mono text-[10px] text-txt-1"
              />
              <Btn size="sm" onClick={openUrl} disabled={!urlInput.trim()}>
                LOAD
              </Btn>
            </div>
          </Widget>

          <Widget title="BUILD FROM SATELLITE AOI">
            <div className="grid grid-cols-2 gap-2 mono text-[10px]">
              <label className="flex flex-col gap-1">
                <span className="text-txt-3">Latitude</span>
                <input
                  type="number"
                  value={lat}
                  step={0.001}
                  onChange={(e) => setLat(Number(e.target.value))}
                  className="w-full bg-bg-2 border border-line-2 rounded-sm px-1 py-1 text-txt-1"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-txt-3">Longitude</span>
                <input
                  type="number"
                  value={lon}
                  step={0.001}
                  onChange={(e) => setLon(Number(e.target.value))}
                  className="w-full bg-bg-2 border border-line-2 rounded-sm px-1 py-1 text-txt-1"
                />
              </label>
              <label className="flex flex-col gap-1 col-span-2">
                <span className="text-txt-3">Radius (km)</span>
                <input
                  type="number"
                  value={radiusKm}
                  min={0.1}
                  step={0.5}
                  onChange={(e) => setRadiusKm(Number(e.target.value))}
                  className="w-full bg-bg-2 border border-line-2 rounded-sm px-1 py-1 text-txt-1"
                />
              </label>
            </div>
            <div className="mono text-[9px] text-txt-3 mt-2 leading-tight">
              Opens Reconstruction Studio in a new tab, prefilled — the actual training
              runs there, not here.
            </div>
            <Btn tone="accent" size="sm" className="mt-2 w-full" onClick={buildFromAoi}>
              OPEN STUDIO →
            </Btn>
          </Widget>
        </div>
        <div className="px-3 py-2 border-t border-line-2 text-[9px] uppercase tracking-[0.4px] text-txt-4 shrink-0">
          keyless · local
        </div>
      </nav>

      <div className="flex-1 min-w-0 relative bg-black/40">
        {scene ? (
          <>
            <SplatView url={scene.url} cam={scene.cam} onStats={(s) => setMeshCount(s.numSplats)} />
            <div className="absolute top-2 right-2 flex flex-col items-end gap-1 pointer-events-none">
              <Badge tone="accent">{scene.source}</Badge>
              <div
                className="mono text-[9px] text-txt-2 bg-bg-1/80 border border-line-2 rounded-sm px-2 py-1 max-w-[260px] truncate"
                title={scene.label}
              >
                {scene.label}
              </div>
              {shownCount != null && (
                <div className="mono text-[9px] text-txt-3 bg-bg-1/80 border border-line-2 rounded-sm px-2 py-1">
                  {shownCount.toLocaleString()} splats
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-center max-w-[420px] px-6">
              <span aria-hidden className="w-2.5 h-2.5 bg-accent rotate-45" />
              <span className="mono font-semibold tracking-[1.5px] text-[12px] text-txt-0">CITY 3D</span>
              <p className="text-[11px] text-txt-3 leading-relaxed">
                No scene loaded. Pick a finished recon job, open a local .ply / .splat / .spz
                / .ksplat file, paste a splat URL, or build one from a satellite AOI in
                Reconstruction Studio — every source here is keyless.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
