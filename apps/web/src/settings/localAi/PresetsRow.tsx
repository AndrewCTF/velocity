// Speed / medium / quality preset cards, fed by GET /api/ai/hardware. The
// backend's auto-detected recommendation is highlighted with its reason;
// the quality card disables itself with `refused_reason` when the hardware
// floor isn't met (e.g. not enough VRAM for a 700B-tier quant).
import { useState } from 'react';
import { apiFetch } from '../../transport/http.js';
import { Badge, Btn } from '../../shell/instruments.js';
import type { HardwareResponse, InstalledModel, PresetId } from './types.js';

const PRESET_LABEL: Record<PresetId, string> = {
  speed: 'Speed',
  medium: 'Medium',
  quality: 'Quality',
};

export function PresetsRow({
  hardware,
  installed,
  onDownload,
}: {
  hardware: HardwareResponse;
  installed: InstalledModel[];
  onDownload: (repoId: string, quant: string) => void;
}): JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {(Object.keys(hardware.presets) as PresetId[]).map((id) => (
        <PresetCard
          key={id}
          id={id}
          preset={hardware.presets[id]}
          recommended={hardware.recommendation.preset === id}
          recommendationReason={hardware.recommendation.reason}
          installed={installed}
          onDownload={onDownload}
        />
      ))}
    </div>
  );
}

function PresetCard({
  id,
  preset,
  recommended,
  recommendationReason,
  installed,
  onDownload,
}: {
  id: PresetId;
  preset: HardwareResponse['presets'][PresetId];
  recommended: boolean;
  recommendationReason: string;
  installed: InstalledModel[];
  onDownload: (repoId: string, quant: string) => void;
}): JSX.Element {
  const refused = !preset.fits && Boolean(preset.refused_reason);
  const already = installed.some((m) => m.repo_id === preset.repo_id && m.quant === preset.quant);
  const [settingActive, setSettingActive] = useState(false);

  const setActive = async (): Promise<void> => {
    setSettingActive(true);
    try {
      const key = installed.find((m) => m.repo_id === preset.repo_id && m.quant === preset.quant)?.key;
      if (!key) return;
      await apiFetch('/api/ai/models/active', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'main', key }),
      });
    } finally {
      setSettingActive(false);
    }
  };

  return (
    <div
      className={`rounded-sm border p-2.5 flex flex-col gap-1.5 ${
        recommended ? 'border-accent-line bg-accent-dim' : 'border-line bg-bg-2/50'
      } ${refused ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center justify-between gap-1.5">
        <span className="mono text-[11px] font-medium text-txt-1">{PRESET_LABEL[id]}</span>
        {recommended && <Badge tone="accent">recommended</Badge>}
      </div>
      <div className="mono text-[10px] text-txt-3">{preset.tier} tier</div>
      <div className="mono text-[10px] text-txt-2 truncate" title={preset.repo_id}>
        {preset.repo_id}
      </div>
      <div className="mono text-[10px] text-txt-3">
        {preset.quant} · ~{preset.est_size_gb.toFixed(0)} GB
      </div>
      <p className="mono text-[10px] text-txt-3 leading-snug">
        {recommended ? recommendationReason : preset.reason}
      </p>
      {refused && <p className="mono text-[10px] text-alert leading-snug">{preset.refused_reason}</p>}
      <div className="mt-auto pt-1">
        {refused ? (
          <Btn size="sm" disabled className="w-full">
            unavailable
          </Btn>
        ) : already ? (
          <Btn size="sm" tone="accent" disabled={settingActive} onClick={() => void setActive()} className="w-full">
            {settingActive ? '…' : 'Set as main'}
          </Btn>
        ) : (
          <Btn size="sm" tone="accent" onClick={() => onDownload(preset.repo_id, preset.quant)} className="w-full">
            ⭳ Download &amp; use
          </Btn>
        )}
      </div>
    </div>
  );
}
