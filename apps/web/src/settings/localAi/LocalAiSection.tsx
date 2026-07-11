// Local-LLM engine + model manager (design: local-llm-design.md, 2026-07-11).
// Orchestrates GET /api/ai/hardware + GET /api/ai/models and composes the
// engine picker, installed-models table, catalog browser (+ custom repo),
// presets row and selection-inference block. Rendered inside SettingsModal
// underneath the existing "Run AI locally (GPU)" toggle (LocalAiToggle),
// which keeps owning the separate narrative/agent/sim routing switch.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../transport/http.js';
import { SectionLabel } from '../../shell/instruments.js';
import { EnginePicker } from './EnginePicker.js';
import { ModelsTable } from './ModelsTable.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { PresetsRow } from './PresetsRow.js';
import { SelectionInferenceBlock } from './SelectionInferenceBlock.js';
import type { EngineId, HardwareResponse, LocalAiConfig, ModelsResponse } from './types.js';

export function LocalAiSection(): JSX.Element {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [hardware, setHardware] = useState<HardwareResponse | null>(null);
  const [local, setLocal] = useState<LocalAiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    try {
      const r = await apiFetch('/api/ai/models');
      if (r.ok) setModels((await r.json()) as ModelsResponse);
    } catch {
      /* non-fatal — the section degrades to "unavailable" below */
    }
  }, []);

  const loadLocal = useCallback(async () => {
    try {
      const r = await apiFetch('/api/ai/local');
      if (r.ok) setLocal((await r.json()) as LocalAiConfig);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await apiFetch('/api/ai/hardware');
        if (live && r.ok) setHardware((await r.json()) as HardwareResponse);
      } catch {
        if (live) setError('hardware probe unavailable');
      }
    })();
    void loadModels();
    void loadLocal();
    return () => {
      live = false;
    };
  }, [loadModels, loadLocal]);

  if (!models) {
    return <p className="mono text-[10px] text-txt-3">{error ?? 'loading engine + model catalog…'}</p>;
  }

  const download = async (repoId: string, quant: string): Promise<void> => {
    await apiFetch('/api/ai/models/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo_id: repoId, quant }),
    }).catch(() => undefined);
    // Downloads run async server-side; the catalog card polls its own job —
    // this just makes sure a preset "download & use" click is reflected once
    // the browser's own job list re-renders on the next models refresh.
    void loadModels();
  };

  return (
    <div className="space-y-3">
      <div>
        <SectionLabel title="Engine" className="mb-1.5" />
        <EnginePicker
          engine={local?.engine ?? 'auto'}
          engines={models.engines}
          onChanged={() => void loadLocal()}
        />
      </div>

      {hardware && (
        <div>
          <SectionLabel title="Presets" className="mb-1.5" />
          <PresetsRow hardware={hardware} installed={models.installed} onDownload={(r, q) => void download(r, q)} />
        </div>
      )}

      <div>
        <SectionLabel title="Installed models" count={models.installed.length} className="mb-1.5" />
        <ModelsTable installed={models.installed} active={models.active} onChanged={() => void loadModels()} />
      </div>

      <div>
        <SectionLabel title="Catalog" className="mb-1.5" />
        <CatalogBrowser
          catalog={models.catalog}
          installed={models.installed}
          onDownloaded={() => void loadModels()}
        />
      </div>

      <div>
        <SectionLabel title="Selection inference" className="mb-1.5" />
        {local && (
          <SelectionInferenceBlock
            installed={models.installed}
            catalog={models.catalog}
            selectionEnabled={local.selection_enabled}
            selectionModel={local.selection_model}
            onChanged={() => {
              void loadModels();
              void loadLocal();
            }}
          />
        )}
      </div>
    </div>
  );
}

// Re-exported so the first-run wizard (AiSetupWizard) can decide whether to
// show at all without re-implementing the "no models yet" probe.
export async function fetchModelsOnce(): Promise<ModelsResponse | null> {
  try {
    const r = await apiFetch('/api/ai/models');
    if (!r.ok) return null;
    return (await r.json()) as ModelsResponse;
  } catch {
    return null;
  }
}

export type { EngineId };
