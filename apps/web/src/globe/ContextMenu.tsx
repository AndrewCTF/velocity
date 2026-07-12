import { useEffect } from 'react';
import { useContextMenu } from './contextMenuStore.js';
import { pointActions } from './mapActions.js';

// Unified map right-click menu. Pure wiring — every action dispatches to an
// existing store/feature at the clicked ground point (shared with the AREA-box
// readout via mapActions.ts so the two never drift). Opened by GlobeCanvas on a
// right-click over empty ground (an entity right-click still opens search-around).

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

  const items = pointActions(lat, lon);

  // Clamp so the menu never overflows the viewport.
  const W = 220;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - items.length * 28 - 40);

  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[var(--z-dropdown)] rounded-sm border border-line-2 bg-bg-1/95 backdrop-blur shadow-xl py-1"
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
