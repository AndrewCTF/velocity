import { useEffect, useRef, useState } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import { usePalette } from "../../../state/palette.js";
import { useMapTools } from "../../../globe/mapTools.js";
import "./addToMapMenu.css";

// AddToMapMenu: D79 "Add to map split menu (Search for objects, intersect a
// shape, Add overlays)". Split button: the main label opens the search dialog
// (the same palette Search for objects opens); the caret opens the split menu.
// "Intersect a shape" arms the area tool (draw rect/polygon → area filter);
// "Add overlays" switches the panel to the Data sources tab (overlays are the
// registry layers there). All three actions run existing app actions.

export function AddToMapMenu({
  onAddOverlays,
}: {
  onAddOverlays?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const search = (): void => {
    setOpen(false);
    usePalette.getState().setOpen(true);
  };
  const intersect = (): void => {
    setOpen(false);
    useMapTools.getState().setTool("area");
  };
  const overlays = (): void => {
    setOpen(false);
    onAddOverlays?.();
  };

  return (
    <span className="mv-add-to-map" ref={ref}>
      <button
        type="button"
        className="mv-atm-main"
        aria-label="Search for objects"
        onClick={search}
      >
        <BpIcon name="search" size={14} />
        <span>Search for objects</span>
      </button>
      <button
        type="button"
        className="mv-atm-caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add to map menu"
        data-testid="d79-add-to-map"
        onClick={() => setOpen((v) => !v)}
      >
        <BpIcon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open && (
        <div className="sl-pop mv-atm-menu" role="menu" aria-label="Add to map">
          <button type="button" role="menuitem" className="mv-atm-item" onClick={search}>
            <BpIcon name="search" size={14} />
            <span>Search for objects</span>
          </button>
          <button type="button" role="menuitem" className="mv-atm-item" onClick={intersect}>
            <BpIcon name="draw" size={14} />
            <span>Intersect a shape</span>
            <span className="mv-atm-hint">Draw on the map</span>
          </button>
          <button type="button" role="menuitem" className="mv-atm-item" onClick={overlays}>
            <BpIcon name="layers" size={14} />
            <span>Add overlays</span>
          </button>
        </div>
      )}
    </span>
  );
}
