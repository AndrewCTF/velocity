import { useEffect } from 'react';
import { useContextMenu } from './contextMenuStore.js';
import { useChip } from '../imagery/chipStore.js';
import { useWatchboxes } from '../watchbox/watchboxStore.js';
import { useAnnotations } from '../annotations/annotationStore.js';
import { useSituations } from '../situations/situationStore.js';
import { useSelection } from '../state/stores.js';
import { useImageryDiff } from '../imagery/imageryDiffStore.js';
import { useGround } from '../ground/groundStore.js';
import { useGeoScope } from '../state/geoScope.js';

// Unified map right-click menu. Pure wiring — every action dispatches to an
// existing store/feature at the clicked ground point. Opened by GlobeCanvas on a
// right-click over empty ground (an entity right-click still opens search-around).

interface Item {
  label: string;
  run: () => void | Promise<void>;
}

export function ContextMenu(): JSX.Element | null {
  const { open, x, y, lat, lon, close } = useContextMenu();

  // Close on any outside click / Escape / scroll.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    const onClick = (): void => close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [open, close]);

  if (!open) return null;

  const items: Item[] = [
    {
      label: 'Collect imagery here',
      run: () =>
        useChip.getState().setFocus({ entityId: `aoi:${lat.toFixed(3)},${lon.toFixed(3)}`, lat, lon, radiusKm: 4 }),
    },
    {
      label: 'Ground recon here',
      // Opens the Ground tab: street photos + weather + area chip, and (desktop)
      // CUDA detection + traffic sim. openAt bumps openSeq so App brings the tab
      // forward; the panel fetches /api/ground/nearby for a 2 km radius.
      run: () => useGround.getState().openAt({ lat, lon, radiusKm: 2 }),
    },
    {
      label: 'Imagery diff here',
      run: () => useImageryDiff.getState().openAt({ lat, lon }),
    },
    {
      label: 'Search objects nearby (50 km)',
      // Geo search-around (§6.4): scope the Explorer app's live object query to a
      // radius around this point. App switches to Explorer on the scope change.
      run: () =>
        useGeoScope.getState().setScope({ lat, lon, radiusKm: 50, label: `${lat.toFixed(2)}, ${lon.toFixed(2)}` }),
    },
    {
      label: 'Geosearch',
      // Omnibar listens for Cmd/Ctrl+K itself — toggle it open.
      run: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })),
    },
    {
      label: 'Create watchbox',
      run: () =>
        useWatchboxes.getState().add({ label: `Watchbox ${lat.toFixed(1)},${lon.toFixed(1)}`, center: { lat, lon }, radiusKm: 25, rule: 'enter' }),
    },
    {
      label: 'Add annotation',
      run: () => useAnnotations.getState().add({ kind: 'point', threat: 'unknown', label: 'Marker', coords: [[lon, lat]] }),
    },
    {
      label: 'Copy coordinates',
      run: () => navigator.clipboard?.writeText(`${lat.toFixed(5)},${lon.toFixed(5)}`),
    },
    {
      label: 'Create situation here',
      run: async () => {
        const id = await useSituations.getState().create({ name: `Situation ${lat.toFixed(1)},${lon.toFixed(1)}`, centroid: { lat, lon } });
        useSelection.getState().select(id);
      },
    },
  ];

  // Clamp so the menu never overflows the viewport.
  const W = 220;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - items.length * 28 - 40);

  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[1000] rounded-sm border border-line-2 bg-bg-1/95 backdrop-blur shadow-xl py-1"
      style={{ left, top, width: W }}
    >
      <div className="px-3 py-1 mono text-[10px] tracking-[0.6px] uppercase text-txt-3 border-b border-line">
        {lat.toFixed(4)}, {lon.toFixed(4)}
      </div>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          onClick={() => {
            void it.run();
            close();
          }}
          className="block w-full text-left px-3 py-1.5 text-[11px] text-txt-1 hover:bg-bg-2 hover:text-txt-0 transition-colors"
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
