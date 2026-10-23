// Models app: a full-surface registry of local language models. Composes the
// Settings local-AI pieces (apps/web/src/settings/localAi/*) rather than
// re-implementing them; this file only adds the list/detail layout.
// Data: GET /api/ai/models, GET /api/ai/hardware, GET /api/ai/local.
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../transport/http.js";
import { ModelsTable } from "../settings/localAi/ModelsTable.js";
import { CatalogBrowser } from "../settings/localAi/CatalogBrowser.js";
import { PresetsRow } from "../settings/localAi/PresetsRow.js";
import { EnginePicker } from "../settings/localAi/EnginePicker.js";
import {
  humanBytes,
  type HardwareResponse,
  type LocalAiConfig,
  type ModelsResponse,
} from "../settings/localAi/types.js";

type Tab = "detail" | "catalog" | "presets";

export function ModelsApp(): JSX.Element {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [hardware, setHardware] = useState<HardwareResponse | null>(null);
  const [local, setLocal] = useState<LocalAiConfig | null>(null);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("detail");

  const loadModels = useCallback(async () => {
    try {
      const r = await apiFetch("/api/ai/models");
      if (!r.ok) {
        setModelsErr(`Model registry unavailable (HTTP ${r.status}).`);
        return;
      }
      setModels((await r.json()) as ModelsResponse);
      setModelsErr(null);
    } catch {
      setModelsErr("Model registry unavailable (backend unreachable).");
    }
  }, []);

  const loadLocal = useCallback(async () => {
    try {
      const r = await apiFetch("/api/ai/local");
      if (r.ok) setLocal((await r.json()) as LocalAiConfig);
    } catch {
      /* engine picker falls back to "auto" */
    }
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await apiFetch("/api/ai/hardware");
        if (live && r.ok) setHardware((await r.json()) as HardwareResponse);
      } catch {
        /* presets tab says the probe is unavailable */
      }
    })();
    void loadModels();
    void loadLocal();
    return () => {
      live = false;
    };
  }, [loadModels, loadLocal]);

  const download = async (repoId: string, quant: string): Promise<void> => {
    await apiFetch("/api/ai/models/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_id: repoId, quant }),
    }).catch(() => undefined);
    void loadModels();
  };

  if (!models) {
    return (
      <div className="h-full bg-bg-1 font-sans">
        <div className="k-empty">{modelsErr ?? "loading model registry…"}</div>
      </div>
    );
  }

  const installed = models.installed;
  const sel = installed.find((m) => m.key === selKey) ?? installed[0] ?? null;

  return (
    <div className="flex h-full min-h-0 bg-bg-1 font-sans text-txt-0">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-line">
        <div className="k-title">Language models</div>
        <div className="k-band">
          Installed <span className="k-n">{installed.length}</span>
        </div>
        {installed.length === 0 && (
          <div className="k-empty">
            No models installed yet. Open the catalog to download one.
          </div>
        )}
        {installed.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => {
              setSelKey(m.key);
              setTab("detail");
            }}
            className={`k-card block w-auto text-left ${sel?.key === m.key ? "sel" : ""}`}
          >
            <div className="k-card-hd">{m.repo_id}</div>
            <div className="k-card-by">
              <span className="mono">{m.quant}</span> · {humanBytes(m.size_bytes)}
            </div>
          </button>
        ))}
        <div className="k-band">Engine</div>
        <div className="px-4 py-2">
          <EnginePicker
            engine={local?.engine ?? "auto"}
            engines={models.engines}
            onChanged={() => void loadLocal()}
          />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="k-ptabs" role="tablist">
          {(
            [
              ["detail", "Overview"],
              ["catalog", "Catalog"],
              ["presets", "Presets"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className="k-ptab"
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "detail" &&
            (sel ? (
              <>
                <div className="k-title">{sel.repo_id}</div>
                <div className="k-kv">
                  <span className="k">Repository</span>
                  <span className="v mono">{sel.repo_id}</span>
                  <span className="k">Quant</span>
                  <span className="v mono">{sel.quant}</span>
                  <span className="k">Size</span>
                  <span className="v">{humanBytes(sel.size_bytes)}</span>
                  <span className="k">File</span>
                  <span className="v mono">{sel.filename}</span>
                  <span className="k">Tier</span>
                  <span className="v">{sel.tier ?? "—"}</span>
                  <span className="k">Engine</span>
                  <span className="v">{local?.engine ?? "—"}</span>
                  <span className="k">Active main</span>
                  <span className="v">
                    {models.active.main === sel.key ? "yes" : "no"}
                  </span>
                  <span className="k">Active selection</span>
                  <span className="v">
                    {models.active.selection === sel.key ? "yes" : "no"}
                  </span>
                  <span className="k">Hot</span>
                  <span className="v">{sel.hot ? "yes" : "no"}</span>
                </div>
                <div className="k-band">Manage</div>
                <div className="px-4 py-2">
                  <ModelsTable
                    installed={[sel]}
                    active={models.active}
                    onChanged={() => void loadModels()}
                  />
                </div>
              </>
            ) : (
              <div className="k-empty">
                No installed model to show. The catalog lists{" "}
                {models.catalog.length} downloadable models.
              </div>
            ))}
          {tab === "catalog" && (
            <div className="px-4 py-3">
              <CatalogBrowser
                catalog={models.catalog}
                installed={installed}
                onDownloaded={() => void loadModels()}
              />
            </div>
          )}
          {tab === "presets" &&
            (hardware ? (
              <div className="px-4 py-3">
                <PresetsRow
                  hardware={hardware}
                  installed={installed}
                  onDownload={(r, q) => void download(r, q)}
                />
              </div>
            ) : (
              <div className="k-empty">
                Presets need the hardware probe, which did not answer.
              </div>
            ))}
        </div>
      </main>
    </div>
  );
}
