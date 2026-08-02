import { useEffect, useReducer, useState } from 'react';
import type * as Cesium from 'cesium';
import type { LayerRegistry } from '../../registry/LayerRegistry.js';
import { Icon } from '../../normal/Icon.js';
import { LayerRail } from '../../layer-rail/LayerRail.js';
import { useLayerCounts, rowCount } from '../../layer-rail/useLayerCounts.js';
import {
  MAP_LAYER_FOLDERS,
  rowEnabled,
  toggleRow,
  folderCounts,
  toggleFolder,
} from '../../normal/layerCatalog.js';

// The Layers panel, built from docs/mockups/console-2026-08 and fed by the real
// registry. It is NOT the old LayerCatalog restyled.
//
// The difference matters and it is the whole point of the rebuild. The old
// panel painted a deep hand-tuned background per domain (cyan for air, teal for
// maritime, red for hazards) and stated each layer's state as the word `ON` or
// `OFF`. So the loudest thing in the panel was the folder chrome, and the
// quietest thing was the data: a 12,000-contact layer and a 3-contact layer
// both said `ON`.
//
// The mockup inverts that. The group header is a plain uppercase label with a
// hairline and a `3 of 6` count, carrying no colour of its own, and every row
// carries its live count and a bar. Colour is spent on the DATA, not on the
// furniture around it.
//
// The bar is scaled against the largest row in its own group. Scaling across
// groups would render every hazard row as an empty track next to aircraft, and
// the comparison an operator actually makes is within a domain.

export function LayersPanel({
  registry,
  viewer,
}: {
  registry: LayerRegistry;
  viewer?: Cesium.Viewer | null;
}): JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => registry.subscribe(force), [registry]);
  const counts = useLayerCounts(viewer);
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const toggleOpen = (id: string): void =>
    setOpenIds((o) => ({ ...o, [id]: !(o[id] ?? MAP_LAYER_FOLDERS.find((f) => f.id === id)?.defaultOpen ?? false) }));
  // The curated / all switch `panels.ts` promised.
  //
  // REHOMED records `allsources` as "redundant with Layers, which gains a
  // curated/all toggle". The toggle was never built, so `byHome` dropped the
  // old All-sources rail on the floor and the raw registry — every layer the
  // curated folders do not name — became unreachable in the console. A recorded
  // replacement that does not exist is worse than an unrecorded deletion,
  // because the contract test passes either way.
  const [all, setAll] = useState(false);

  return (
    <div className="pb-2">
      <div
        className="flex items-center gap-[4px] border-b border-line px-[14px] py-[6px]"
        role="group"
        aria-label="Layer source"
      >
        {([
          ['Curated', false],
          ['All sources', true],
        ] as const).map(([label, v]) => (
          <button
            key={label}
            type="button"
            onClick={() => setAll(v)}
            aria-pressed={all === v}
            className={`mono h-[20px] rounded-sm px-[7px] text-[12px] ${
              all === v
                ? 'bg-accent-dim text-accent-fg shadow-[inset_0_0_0_1px_var(--accent-line)]'
                : 'text-txt-2 hover:bg-[var(--hover)]'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <span className="mono text-[12px] tabular-nums text-txt-3">{registry.list().length}</span>
      </div>

      {all && <LayerRail registry={registry} viewer={viewer ?? null} />}
      {!all && (
    <>
      {MAP_LAYER_FOLDERS.map((folder) => {
        const { on, total } = folderCounts(registry, folder);
        const open = openIds[folder.id] ?? folder.defaultOpen ?? on > 0;
        const peak = Math.max(1, ...folder.rows.map((r) => rowCount(counts, r.layerIds)));
        return (
          <section key={folder.id} aria-label={folder.label}>
            <div className="mt-3 flex h-[26px] items-center gap-[6px] border-t border-line px-[14px] pt-[6px] first:mt-0 first:border-t-0 first:pt-0">
              <button
                type="button"
                onClick={() => toggleOpen(folder.id)}
                aria-expanded={open}
                className="flex min-w-0 flex-1 items-center gap-[6px] text-left"
              >
                <Icon
                  name={open ? 'chevron-down' : 'chevron-right'}
                  className="h-3 w-3 shrink-0 text-txt-3"
                />
                <Icon name={folder.icon} className="h-3 w-3 shrink-0 text-txt-3" />
                <span className="truncate text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
                  {folder.label}
                </span>
              </button>
              <span className="mono text-[12px] tabular-nums text-txt-3">
                {on} of {total}
              </span>
              <button
                type="button"
                onClick={() => toggleFolder(registry, folder)}
                aria-label={on > 0 ? `Turn all ${folder.label} off` : `Turn all ${folder.label} on`}
                className="flex h-5 w-5 items-center justify-center rounded-sm text-txt-3 hover:bg-bg-2 hover:text-txt-0"
              >
                <Icon name="crosshair" className="h-3 w-3" />
              </button>
            </div>

            {open && folder.rows.map((row) => {
              const en = rowEnabled(registry, row);
              const n = rowCount(counts, row.layerIds);
              const frac = peak > 0 ? n / peak : 0;
              return (
                <button
                  key={row.label}
                  type="button"
                  onClick={() => toggleRow(registry, row)}
                  aria-pressed={en}
                  className="flex h-[var(--g-row-2)] w-full items-center gap-2 px-[14px] text-left hover:bg-[var(--hover)]"
                >
                  <Icon
                    name={row.icon}
                    className={`h-3 w-3 shrink-0 ${en ? 'text-accent-fg' : 'text-txt-3'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[12px] ${en ? 'text-txt-0' : 'text-txt-1'}`}
                    >
                      {row.label}
                    </span>
                  </span>
                  {/* A count and a bar, never the word "on". The bar carries the
                      magnitude the word threw away. A layer that reports nothing
                      shows the lone em dash, which is the never-guess rule. */}
                  <span
                    className={`mono w-[46px] shrink-0 text-right text-[12px] tabular-nums ${
                      en ? 'text-txt-1' : 'text-txt-3'
                    }`}
                  >
                    {en ? (n > 0 ? n.toLocaleString() : '—') : ''}
                  </span>
                  <span
                    className="relative h-[10px] w-[44px] shrink-0 overflow-hidden rounded-[1px] bg-bg-0"
                    aria-hidden="true"
                  >
                    <i
                      className={`absolute inset-y-0 left-0 block ${en ? 'bg-accent' : 'bg-bg-4'}`}
                      style={{ width: `${Math.max(en && n > 0 ? 3 : 0, Math.min(100, frac * 100))}%` }}
                    />
                  </span>
                  {/* An eye, not a sliding pill. The pill was 26px of iOS in a
                      Blueprint console, and it stated a second time what the
                      accent icon and the accent bar already state. Its width is
                      what forced `Chokepoint conge…`, `Disaster alerts (G…` and
                      `Humanitarian disa…` in a 336px panel. */}
                  <Icon
                    name={en ? 'eye' : 'eye-off'}
                    className={`h-3 w-3 shrink-0 ${en ? 'text-accent-fg' : 'text-txt-4'}`}
                  />
                </button>
              );
            })}
          </section>
        );
      })}
        </>
      )}
    </div>
  );
}
