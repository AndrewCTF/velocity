import { Fragment, useEffect } from "react";
import { useContextMenu } from "./contextMenuStore.js";
import { pointActions } from "./mapActions.js";
import { BpIcon } from "../shell/BpIcon.js";
import "./contextMenu.css";

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
      if (e.key === "Escape") close();
    };
    const onClick = (): void => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [open, close]);

  if (!open) return null;

  const items = pointActions(lat, lon);

  // Clamp so the menu never overflows the viewport.
  const W = 257;
  const H = items.length * 36 + items.filter((i) => i.sep).length + 22;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.max(8, Math.min(y, window.innerHeight - H - 8));

  return (
    <div
      role="menu"
      aria-label={`Map point ${lat.toFixed(4)}, ${lon.toFixed(4)}`}
      onClick={(e) => e.stopPropagation()}
      className="gx-cmenu"
      style={{ left, top }}
    >
      {items.map((it) => (
        <Fragment key={it.label}>
          {it.sep ? <div className="gx-sep" role="separator" /> : null}
          <button
            type="button"
            role="menuitem"
            className="gx-it"
            onClick={() => {
              void it.run();
              close();
            }}
          >
            {it.icon ? <BpIcon name={it.icon} size={18} /> : null}
            {it.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
