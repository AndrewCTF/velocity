import { useEffect, useReducer, useState } from 'react';
import type * as Cesium from 'cesium';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { Icon } from '../normal/Icon.js';
import {
  MAP_LAYER_FOLDERS,
  rowEnabled,
  toggleRow,
  folderCounts,
  toggleFolder,
  type CatalogFolder,
} from '../normal/layerCatalog.js';

// Curated layer catalog (design §6.2 salvage) — the 34-source registry grouped
// into a small set of plain-English capability FOLDERS/ROWS, the default Layers
// flyout. A clean Tailwind rebuild of the old .nrm-coupled NormalLayerRail using
// the same pure `layerCatalog.ts` data. "All sources" (raw registry LayerRail) is
// a separate rail entry for the advanced view.
//
// Colour lives ONLY on the folder headers, as a deep hand-tuned background per
// domain (not a bright hue mixed toward black, which muddied warm colours into
// olive). Each tone is dark enough for crisp white text and saturated enough to
// tell apart; a brighter same-hue edge sharpens it. Cool hues read as benign
// domains, warm hues as hazard/conflict, so colour also hints at content. Rows
// stay monochrome — one app accent for on-state — so the panel reads clean.
const FOLDER_TONE: Record<string, { bg: string; edge: string }> = {
  air: { bg: '#15323f', edge: '#38bdf8' }, // cyan-blue
  maritime: { bg: '#123a32', edge: '#2dd4bf' }, // teal
  space: { bg: '#241f47', edge: '#a78bfa' }, // indigo
  ground: { bg: '#3d191b', edge: '#ff6b5c' }, // deep hazard red
  signals: { bg: '#3a1d1a', edge: '#f2765b' }, // rust (alert)
  infra: { bg: '#183320', edge: '#4ade80' }, // forest
  reference: { bg: '#232a33', edge: '#94a3b8' }, // slate
};
const FALLBACK_TONE = { bg: '#232a33', edge: 'var(--accent)' };

// ponytail: registry.subscribe → forceUpdate on toggle; no local mirror of state.
export function LayerCatalog({ registry }: { registry: LayerRegistry; viewer?: Cesium.Viewer | null }): JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => registry.subscribe(force), [registry]);

  return (
    <div className="p-2 flex flex-col gap-2">
      {MAP_LAYER_FOLDERS.map((folder) => (
        <Folder key={folder.id} folder={folder} registry={registry} />
      ))}
    </div>
  );
}

function Folder({ folder, registry }: { folder: CatalogFolder; registry: LayerRegistry }): JSX.Element {
  const [open, setOpen] = useState(folder.defaultOpen ?? false);
  const { on, total } = folderCounts(registry, folder);
  const tone = FOLDER_TONE[folder.id] ?? FALLBACK_TONE;
  return (
    <div className="rounded-sm border border-line/60 overflow-hidden">
      {/* Big title: deep coloured background, white words, brighter same-hue edge. */}
      <div
        className="flex items-center gap-1.5 px-2 h-9 border-l-[3px] text-white"
        style={{ borderLeftColor: tone.edge, background: tone.bg }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-white"
          aria-expanded={open}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} className="w-3 h-3 shrink-0 text-white/60" />
          <Icon name={folder.icon} className="w-4 h-4 shrink-0 text-white" />
          <span className="font-label font-bold uppercase tracking-[0.8px] text-[13px] truncate text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.55)]">
            {folder.label}
          </span>
        </button>
        <span className={`mono text-[10px] tabular-nums ${on > 0 ? 'text-white' : 'text-white/55'}`}>
          {on}/{total}
        </span>
        <button
          type="button"
          onClick={() => toggleFolder(registry, folder)}
          title={on > 0 ? 'Turn all off' : 'Turn all on'}
          className={`w-5 h-5 flex items-center justify-center rounded-sm border transition-colors ${
            on > 0 ? 'border-white/50 text-white bg-white/15' : 'border-white/25 text-white/60 hover:text-white'
          }`}
        >
          <Icon name="crosshair" className="w-3 h-3" />
        </button>
      </div>
      {open && (
        <div className="bg-bg-0/40">
          {folder.rows.map((row) => {
            const en = rowEnabled(registry, row);
            // Small titles: monochrome. A single accent marks "on"; off is grey.
            return (
              <button
                key={row.label}
                type="button"
                onClick={() => toggleRow(registry, row)}
                className={`flex items-center gap-2 w-full px-2.5 py-2 text-left border-t border-line/50 border-l-2 transition-colors ${
                  en ? 'border-l-accent bg-accent-dim/30 hover:bg-accent-dim/50' : 'border-l-transparent hover:bg-bg-2'
                }`}
                aria-pressed={en}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${en ? 'bg-accent' : 'bg-txt-4'}`} />
                <Icon name={row.icon} className={`w-4 h-4 shrink-0 ${en ? 'text-txt-1' : 'text-txt-3'}`} />
                <span className={`text-[12px] flex-1 truncate ${en ? 'text-txt-0 font-medium' : 'text-txt-1'}`}>
                  {row.label}
                </span>
                {en ? (
                  <span className="mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-[1px] rounded-sm border border-accent-line bg-accent-dim text-accent shrink-0">
                    on
                  </span>
                ) : (
                  <span className="mono text-[10px] uppercase tracking-[0.4px] text-txt-4 shrink-0">off</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
