import { useState } from "react";
import { createPortal } from "react-dom";
import { BpIcon } from "../../../shell/BpIcon.js";
import "./moveToLayer.css";

// MoveToLayer: D78 "Move to layer submenu (selected aircraft moved between
// the real Airliners and Other aircraft layers)". Submenu with the two real
// category splits (A3-A5 airliners vs the rest) and counts from the live
// registry; the count chip is the real layer size.

export interface MoveToLayerTarget {
  id: string;
  label: string;
  count: number;
}

export function MoveToLayer({
  targets,
  onMove,
}: {
  targets: readonly MoveToLayerTarget[];
  onMove: (id: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  return (
    <span className="mv-move-to-layer">
      <button
        type="button"
        className="mv-mtl-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // This button lives in a portal inside the parent Row <button>: a
          // click bubbles through the React tree to the row and collapses the
          // layer menu before the submenu can open, so it must not propagate.
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAnchor({ left: r.right + 4, top: r.top - 30 });
          setOpen((v) => !v);
        }}
      >
        <BpIcon name="contrast" size={14} />
        Move to layer
        <BpIcon name="caret-right" size={11} />
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            role="menu"
            aria-label="Move to layer"
            className="sl-pop mv-mtl-menu"
            style={{ position: "fixed", left: anchor.left, top: anchor.top }}
            onClick={(e) => e.stopPropagation()}
          >
            {targets.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onMove(t.id);
                }}
              >
                <BpIcon name="airplane" size={14} />
                <span className="lbl">{t.label}</span>
                <span className="mv-mtl-count">{t.count}</span>
              </button>
            ))}
            <button type="button" role="menuitem" disabled title="Move-selected-to-new-layer is copy-only">
              <BpIcon name="send-to-map" size={14} />
              <span className="lbl">Move selected Aircraft to new layer</span>
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}
