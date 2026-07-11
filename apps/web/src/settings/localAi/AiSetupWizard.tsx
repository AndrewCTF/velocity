// First-run local-AI setup wizard. Shows once — gated by aiSetupSeen's
// localStorage flag and the "no models installed yet + llama.cpp not running"
// probe (see AppRouter's AiSetupGate) — then walks detect → preset pick →
// confirm → download → done. Style mirrors Onboarding.tsx (fixed overlay,
// bg-bg-1 card, mono type); the body reuses the same instrument primitives
// as SettingsModal/LocalAiSection so it doesn't invent new form idioms.
import { useEffect, useState } from 'react';
import { apiFetch } from '../../transport/http.js';
import { Btn, StatusDot } from '../../shell/instruments.js';
import { DownloadProgress } from './DownloadProgress.js';
import { markAiSetupSeen } from './aiSetupSeen.js';
import { humanBytes, type DownloadJob, type HardwareResponse, type PresetId } from './types.js';

type Step = 'detect' | 'preset' | 'confirm' | 'download' | 'done';

export function AiSetupWizard({ onClose }: { onClose: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>('detect');
  const [hardware, setHardware] = useState<HardwareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<PresetId | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await apiFetch('/api/ai/hardware');
        if (!live) return;
        if (!r.ok) {
          setError(`hardware probe failed (${r.status})`);
          return;
        }
        const body = (await r.json()) as HardwareResponse;
        setHardware(body);
        setChosen(body.recommendation.preset);
        setStep('preset');
      } catch {
        if (live) setError('hardware probe unreachable');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const finish = (skip: boolean): void => {
    markAiSetupSeen();
    if (skip) onClose();
    else setStep('done');
  };

  const startDownload = async (): Promise<void> => {
    if (!hardware || !chosen) return;
    const preset = hardware.presets[chosen];
    setJobError(null);
    try {
      const r = await apiFetch('/api/ai/models/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo_id: preset.repo_id, quant: preset.quant }),
      });
      if (r.status !== 202) {
        setJobError(`download failed (${r.status})`);
        return;
      }
      const body = (await r.json()) as { job_id: string };
      setJobId(body.job_id);
      setStep('download');
    } catch {
      setJobError('network error');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[2400] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Local AI setup"
    >
      <div className="w-[440px] max-w-[92vw] rounded-md border border-line bg-bg-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="mono text-[12px] tracking-[0.12em] uppercase text-accent">Local AI setup</span>
          <button
            type="button"
            onClick={() => finish(true)}
            className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
          >
            Skip
          </button>
        </div>

        <div className="px-4 py-3.5 min-h-[180px]">
          {error && (
            <p className="mono text-[11px] text-alert">
              {error} — you can still set this up later from ⚙ Settings → Local AI.
            </p>
          )}

          {!error && step === 'detect' && (
            <p className="mono text-[11px] text-txt-2">Detecting GPU, RAM and free disk…</p>
          )}

          {!error && step === 'preset' && hardware && (
            <div className="space-y-2">
              <p className="mono text-[11px] text-txt-2">
                {hardware.gpu ? `${hardware.gpu.name} · ${(hardware.gpu.vram_mb / 1024).toFixed(0)} GB VRAM` : 'no GPU detected'}
                {' · '}
                {(hardware.ram_mb / 1024).toFixed(0)} GB RAM · {(hardware.disk_free_mb / 1024).toFixed(0)} GB free disk
              </p>
              <div className="space-y-1.5">
                {(Object.keys(hardware.presets) as PresetId[]).map((id) => {
                  const p = hardware.presets[id];
                  const refused = !p.fits && Boolean(p.refused_reason);
                  const recommended = hardware.recommendation.preset === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      disabled={refused}
                      onClick={() => setChosen(id)}
                      className={`w-full text-left rounded-sm border px-2.5 py-2 transition-colors disabled:opacity-50 ${
                        chosen === id ? 'border-accent-line bg-accent-dim text-txt-0' : 'border-line text-txt-2 hover:border-accent-line'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="mono text-[11px] font-medium capitalize">
                          {id}
                          {recommended ? ' (recommended)' : ''}
                        </span>
                        <StatusDot tone={p.fits ? 'green' : 'red'} />
                      </div>
                      <div className="mono text-[10px] text-txt-3 mt-0.5 truncate">{p.repo_id}</div>
                      <div className="mono text-[10px] text-txt-3">
                        {p.quant} · ~{p.est_size_gb.toFixed(0)} GB
                      </div>
                      <p className="mono text-[10px] text-txt-3 mt-0.5 leading-snug">
                        {recommended ? hardware.recommendation.reason : p.reason}
                      </p>
                      {refused && <p className="mono text-[10px] text-alert mt-0.5">{p.refused_reason}</p>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {!error && step === 'confirm' && hardware && chosen && (
            <ConfirmStep preset={hardware.presets[chosen]} diskFreeMb={hardware.disk_free_mb} error={jobError} />
          )}

          {!error && step === 'download' && jobId && (
            <div className="space-y-2">
              <p className="mono text-[11px] text-txt-2">Downloading…</p>
              <DownloadProgress
                jobId={jobId}
                onDone={(job: DownloadJob) => {
                  if (job.status === 'done') setStep('done');
                  else setJobError(job.error ?? 'download failed');
                }}
              />
            </div>
          )}

          {!error && step === 'done' && (
            <p className="mono text-[11px] text-txt-1">
              Model installed. It's now the active main model — you can pin it hot, set up
              selection-brief inference, or add more models any time from ⚙ Settings → Local AI.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-1.5 border-t border-line px-4 py-2.5">
          {step === 'preset' && (
            <Btn tone="accent" disabled={!chosen} onClick={() => setStep('confirm')}>
              Next →
            </Btn>
          )}
          {step === 'confirm' && (
            <>
              <Btn onClick={() => setStep('preset')}>Back</Btn>
              <Btn tone="accent" onClick={() => void startDownload()}>
                ⭳ Download
              </Btn>
            </>
          )}
          {step === 'done' && (
            <Btn tone="accent" onClick={() => finish(false)}>
              Done
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfirmStep({
  preset,
  diskFreeMb,
  error,
}: {
  preset: HardwareResponse['presets'][PresetId];
  diskFreeMb: number;
  error: string | null;
}): JSX.Element {
  const estBytes = preset.est_size_gb * 1024 * 1024 * 1024;
  const freeBytes = diskFreeMb * 1024 * 1024;
  const tight = estBytes > freeBytes * 0.8;
  return (
    <div className="space-y-1.5">
      <p className="mono text-[11px] text-txt-2">Confirm download:</p>
      <div className="rounded-sm border border-line bg-bg-2/50 p-2.5">
        <div className="mono text-[11px] text-txt-1">{preset.repo_id}</div>
        <div className="mono text-[10px] text-txt-3 mt-0.5">{preset.quant}</div>
        <div className="mono text-[10px] text-txt-3 mt-1">
          ~{preset.est_size_gb.toFixed(1)} GB to download · {humanBytes(diskFreeMb * 1024 * 1024)} free
        </div>
      </div>
      {tight && (
        <p className="mono text-[10px] text-warn">
          This uses most of your free disk space — consider a smaller quant if the download fails.
        </p>
      )}
      {error && <p className="mono text-[10px] text-alert">{error}</p>}
    </div>
  );
}
