// In-console settings overlay. Primary job: the BYOK key panel ("config panel
// for keys, there now"). Also surfaces the current plan and links out to the
// full account dashboard (limits / renew / alerts) on the marketing site.
import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { apiFetch } from '../transport/http.js';
import { KeysPanel } from './KeysPanel.js';
import { useDashboardMode, type DashboardMode } from '../state/dashboardMode.js';
import { useSettings } from '../state/settings.js';
import {
  MAP_QUALITIES,
  QUALITY_LABELS,
  presetKnobs,
  type MapQuality,
} from '../globe/qualityPresets.js';
import { resetOnboarding } from '../onboarding/Onboarding.js';
import { LocalAiSection } from './localAi/LocalAiSection.js';

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
      className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[8vh]"
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
                <span className="mono text-[10px] text-txt-3 uppercase tracking-[0.6px]">
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

          <div className="mono text-[10px] uppercase tracking-[0.7px] text-txt-3 mb-2">
            Dashboard
          </div>
          <DashboardToggle />

          <div className="mono text-[10px] uppercase tracking-[0.7px] text-txt-3 mb-2 mt-4">
            Aircraft motion
          </div>
          <DeadReckonToggle />

          <div className="mono text-[10px] uppercase tracking-[0.7px] text-txt-3 mb-2 mt-4">
            Display
          </div>
          <MapQualityPreset />
          <div className="mt-2">
            <RenderQualitySlider />
          </div>
          <div className="mt-2">
            <GovernorToggle />
          </div>

          <div className="mono text-[10px] uppercase tracking-[0.7px] text-txt-3 mb-2 mt-4">
            Local AI inference
          </div>
          <LocalAiToggle />
          <div className="mt-2.5">
            <LocalAiSection />
          </div>

          <div className="mono text-[10px] uppercase tracking-[0.7px] text-txt-3 mb-2 mt-4">
            API keys · bring your own
          </div>
          <KeysPanel />

          <button
            type="button"
            onClick={() => {
              resetOnboarding();
              window.location.reload();
            }}
            className="flex w-full items-center justify-center gap-1.5 mt-3.5 mono text-[10px] px-2 py-1.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
          >
            <RotateCcw size={12} strokeWidth={1.75} aria-hidden /> Replay welcome tour
          </button>

          <a
            href={ACCOUNT_URL}
            className="block text-center mt-2 mono text-[10px] px-2 py-1.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
          >
            Open full dashboard — limits, billing & alerts →
          </a>
        </div>
      </div>
    </div>
  );
}

// Switch between the new approachable "Normal" dashboard (default) and the dense
// "Professional" COP. Persisted via the dashboardMode store; the "/" route
// re-renders into the chosen shell. The map/globe is identical between them.
function DashboardToggle(): JSX.Element {
  const mode = useDashboardMode((s) => s.mode);
  const setMode = useDashboardMode((s) => s.setMode);
  const opts: { id: DashboardMode; label: string; hint: string }[] = [
    { id: 'professional', label: 'Professional', hint: 'Dense, full-tool COP (default)' },
    { id: 'normal', label: 'Normal', hint: 'Clean, guided layout' },
  ];
  return (
    <div className="flex gap-1.5" role="radiogroup" aria-label="Dashboard layout">
      {opts.map((o) => {
        const on = mode === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setMode(o.id)}
            className={`flex-1 text-left rounded-sm border px-2.5 py-2 transition-colors ${
              on
                ? 'border-accent-line bg-accent-dim text-txt-0'
                : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1'
            }`}
          >
            <div className="mono text-[11px] font-medium">{o.label}</div>
            <div className="mono text-[10px] text-txt-3 mt-0.5">{o.hint}</div>
          </button>
        );
      })}
    </div>
  );
}

// FlightRadar24-style dead-reckoning toggle. OFF by default — the map shows real
// ADS-B fixes only. When ON, aircraft glide forward along their last reported
// track/speed BETWEEN fixes; those positions are ESTIMATED (a map badge says
// so). Operator-sanctioned opt-in (2026-06-28) over the real-fix-only guardrail.
function DeadReckonToggle(): JSX.Element {
  const on = useSettings((s) => s.aircraftDeadReckon);
  const set = useSettings((s) => s.set);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => set('aircraftDeadReckon', !on)}
      className={`w-full text-left rounded-sm border px-2.5 py-2 transition-colors ${
        on
          ? 'border-accent-line bg-accent-dim text-txt-0'
          : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="mono text-[11px] font-medium">Keep planes moving between updates</span>
        <span
          className={`mono text-[10px] px-1.5 py-0.5 rounded-sm border ${
            on ? 'border-accent-line text-accent' : 'border-line text-txt-3'
          }`}
        >
          {on ? 'ON' : 'OFF'}
        </span>
      </div>
      <div className="mono text-[10px] text-txt-3 mt-1 leading-snug">
        FlightRadar24-style: glide aircraft along their last heading &amp; speed between
        ADS-B fixes. Positions shown are <span className="text-accent">estimated</span>, not
        observed. Off by default.
      </div>
    </button>
  );
}

// Render-on-demand governor (design §5.1). OFF by default. When ON, the globe
// stops re-rendering every frame in the genuinely-idle case (world view, teleport
// aircraft, frozen vessels, nothing selected/simulating/orbiting) to cut GPU burn,
// while still rendering every frame whenever anything actually animates.
function GovernorToggle(): JSX.Element {
  const on = useSettings((s) => s.continuousRenderGovernor);
  const set = useSettings((s) => s.set);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => set('continuousRenderGovernor', !on)}
      className={`w-full text-left rounded-sm border px-2.5 py-2 transition-colors ${
        on
          ? 'border-accent-line bg-accent-dim text-txt-0'
          : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="mono text-[11px] font-medium">Idle render governor</span>
        <span
          className={`mono text-[10px] px-1.5 py-0.5 rounded-sm border ${
            on ? 'border-accent-line text-accent' : 'border-line text-txt-3'
          }`}
        >
          {on ? 'ON' : 'OFF'}
        </span>
      </div>
      <div className="mono text-[10px] text-txt-3 mt-1 leading-snug">
        Stop re-rendering the globe every frame when nothing is moving (world view,
        teleport aircraft). Cuts idle GPU burn; motion stays smooth. Off by default —
        confirm glide/pulse look right on your hardware before relying on it.
      </div>
    </button>
  );
}

// Local-inference toggle (Part 4). Routes the app's text-LLM tier (narrative,
// agent, sim reasoning) to the on-GPU Ollama model AHEAD of the cloud backends,
// so heavy use doesn't hit cloud rate limits. The backend owns the flag
// (POST /api/ai/local); this reads /api/ai/local for the current state + the
// hardware gate — the switch is disabled when Ollama is down or no tool-capable
// model is installed ("requires some level of hardware").
interface LocalAiState {
  enabled: boolean;
  ollama_up: boolean;
  tool_capable: boolean;
  models: string[];
  model_fast: string;
  model_reason: string;
}

function LocalAiToggle(): JSX.Element {
  const [st, setSt] = useState<LocalAiState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await apiFetch('/api/ai/local');
        if (live && r.ok) setSt((await r.json()) as LocalAiState);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const gated = !st || !st.ollama_up || !st.tool_capable;
  const on = !!st?.enabled;

  const toggle = async (): Promise<void> => {
    if (gated || busy) return;
    setBusy(true);
    try {
      const r = await apiFetch('/api/ai/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !on }),
      });
      if (r.ok) setSt((await r.json()) as LocalAiState);
    } catch {
      /* non-fatal */
    } finally {
      setBusy(false);
    }
  };

  const reason = !st
    ? 'checking local engine…'
    : !st.ollama_up
      ? 'Ollama not running on this machine'
      : !st.tool_capable
        ? 'no tool-capable model installed'
        : on
          ? `local — ${st.model_reason}`
          : 'using cloud';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={gated || busy}
      onClick={() => void toggle()}
      className={`w-full text-left rounded-sm border px-2.5 py-2 transition-colors ${
        on
          ? 'border-accent-line bg-accent-dim text-txt-0'
          : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1'
      } ${gated ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <div className="flex items-center justify-between">
        <span className="mono text-[11px] font-medium">Run AI locally (GPU)</span>
        <span
          className={`mono text-[10px] px-1.5 py-0.5 rounded-sm border ${
            on ? 'border-accent-line text-accent' : 'border-line text-txt-3'
          }`}
        >
          {on ? 'ON' : 'OFF'}
        </span>
      </div>
      <div className="mono text-[10px] text-txt-3 mt-1 leading-snug">
        Route narrative, agent &amp; sim reasoning to a local Ollama model instead of the
        cloud — no API rate limits. Needs a capable GPU + Ollama running.{' '}
        <span className="text-accent">{reason}</span>.
      </div>
    </button>
  );
}

// Map quality preset — the one control most users want for "make the 3D map
// smoother". Bundles resolution + terrain detail + vessel/satellite/layer caps
// (globe/qualityPresets.ts). Picking a preset also writes renderPixelCap to the
// preset's resolution so the fine-tune slider below stays in sync; the slider
// then lets a power user nudge resolution over the preset if they want.
function MapQualityPreset(): JSX.Element {
  const q = useSettings((s) => s.mapQuality);
  const set = useSettings((s) => s.set);
  const choose = (next: MapQuality): void => {
    set('mapQuality', next);
    set('renderPixelCap', presetKnobs(next).pixelCap);
  };
  return (
    <div className="w-full rounded-sm border border-line px-2.5 py-2">
      <div className="mono text-[11px] font-medium text-txt-1 mb-2">Map quality</div>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Map quality preset">
        {MAP_QUALITIES.map((id) => {
          const on = q === id;
          const meta = QUALITY_LABELS[id];
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(id)}
              className={`flex-1 text-left rounded-sm border px-2 py-1.5 transition-colors ${
                on
                  ? 'border-accent-line bg-accent-dim text-txt-0'
                  : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1'
              }`}
            >
              <div className="mono text-[11px] font-medium">{meta.label}</div>
              <div className="mono text-[9px] text-txt-3 mt-0.5 leading-tight">{meta.hint}</div>
            </button>
          );
        })}
      </div>
      <div className="mono text-[10px] text-txt-3 mt-1.5 leading-snug">
        Lower quality renders fewer pixels, coarser terrain and fewer vessels/satellites for a
        higher frame rate. On a weak GPU choose Performance. Aircraft coverage is unaffected.
      </div>
    </div>
  );
}

// Globe render resolution ↔ FPS. The 3D scene renders its drawing buffer at
// css_pixels × min(devicePixelRatio, cap). 2.0 = native sharp on a 2× / Retina /
// 200%-scaled display; lower trades sharpness for frame rate (fewer pixels to
// fill). Applied live (GlobeCanvas subscribes to the setting).
function RenderQualitySlider(): JSX.Element {
  const cap = useSettings((s) => s.renderPixelCap);
  const set = useSettings((s) => s.set);
  const label = cap >= 1.95 ? 'Sharp (native)' : cap <= 1.05 ? 'Fastest' : 'Balanced';
  return (
    <div className="w-full rounded-sm border border-line px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="mono text-[11px] font-medium text-txt-1">Globe render quality</span>
        <span className="mono text-[10px] px-1.5 py-0.5 rounded-sm border border-accent-line text-accent">
          {label} · {cap.toFixed(2)}×
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={3}
        step={0.25}
        value={cap}
        aria-label="Globe render quality (resolution vs FPS)"
        onChange={(e) => set('renderPixelCap', Number(e.target.value))}
        className="w-full mt-2 accent-accent"
      />
      <div className="mono text-[10px] text-txt-3 mt-1 leading-snug">
        Higher = sharper (renders at native device pixels); lower = higher FPS (fewer
        pixels). Resolution and frame rate trade off directly. Default 2.0×.
      </div>
    </div>
  );
}
