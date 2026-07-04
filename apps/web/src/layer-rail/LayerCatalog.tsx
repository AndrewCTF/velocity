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
// ponytail: registry.subscribe → forceUpdate on toggle; no local mirror of state.
export function LayerCatalog({ registry }: { registry: LayerRegistry; viewer?: Cesium.Viewer | null }): JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => registry.subscribe(force), [registry]);

  return (
    <div className="p-2 flex flex-col gap-1">
      {MAP_LAYER_FOLDERS.map((folder) => (
        <Folder key={folder.id} folder={folder} registry={registry} />
      ))}
    </div>
  );
}

function Folder({ folder, registry }: { folder: CatalogFolder; registry: LayerRegistry }): JSX.Element {
  const [open, setOpen] = useState(folder.defaultOpen ?? false);
  const { on, total } = folderCounts(registry, folder);
  return (
    <div className="rounded-sm border border-line/60 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 h-8 bg-bg-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-txt-1 hover:text-txt-0"
          aria-expanded={open}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} className="w-3 h-3 shrink-0 text-txt-3" />
          <Icon name={folder.icon} className="w-3.5 h-3.5 shrink-0 text-txt-2" />
          <span className="font-label uppercase tracking-[0.6px] text-[11px] truncate">{folder.label}</span>
        </button>
        <span className={`mono text-[10px] tabular-nums ${on > 0 ? 'text-accent' : 'text-txt-3'}`}>
          {on}/{total}
        </span>
        <button
          type="button"
          onClick={() => toggleFolder(registry, folder)}
          title={on > 0 ? 'Turn all off' : 'Turn all on'}
          className={`w-5 h-5 flex items-center justify-center rounded-sm border ${
            on > 0 ? 'border-accent-line text-accent bg-accent-dim' : 'border-line text-txt-3 hover:text-txt-1'
          }`}
        >
          <Icon name="crosshair" className="w-3 h-3" />
        </button>
      </div>
      {open && (
        <div className="bg-bg-0/40">
          {folder.rows.map((row) => {
            const en = rowEnabled(registry, row);
            return (
              <button
                key={row.label}
                type="button"
                onClick={() => toggleRow(registry, row)}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left hover:bg-bg-2 border-t border-line/40"
                aria-pressed={en}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${en ? 'bg-accent' : 'bg-txt-4'}`}
                  style={en ? { boxShadow: '0 0 6px var(--accent)' } : undefined}
                />
                <Icon name={row.icon} className={`w-3.5 h-3.5 shrink-0 ${en ? 'text-txt-1' : 'text-txt-3'}`} />
                <span className={`text-[11px] flex-1 truncate ${en ? 'text-txt-0' : 'text-txt-2'}`}>{row.label}</span>
                <span className={`mono text-[10px] uppercase tracking-[0.4px] ${en ? 'text-accent' : 'text-txt-4'}`}>
                  {en ? 'on' : 'off'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
