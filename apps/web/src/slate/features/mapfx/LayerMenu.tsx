import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type * as Cesium from "cesium";
import { BpIcon } from "../../../shell/BpIcon.js";
import { useLayerCounts, rowCount } from "../../../layer-rail/useLayerCounts.js";
import { MoveToLayer } from "./MoveToLayer.js";
import type { CatalogRow } from "../../../normal/layerCatalog.js";
import "./layerMenu.css";

// LayerMenu: D71/D76 layer row hover actions + layer menu.
// The copy's row carries: count + "objects", ••• menu, eye toggle, chevron
// drill-in. The ••• opens the 8-item layer menu (centre, select, add objects,
// show only, lock, rename, description, delete). Velocity's real actions are
// show/hide, opacity and refresh (LayerRail); lock/rename/description/show-only
// are copied as grammar and disabled with reasons (D76 note).

const ITEMS = [
  { id: "centre", label: "Center map on layer", icon: "locate", disabled: false },
  { id: "select", label: "Select objects in layer", icon: "select", disabled: false },
  { id: "add", label: "Add objects to layer", icon: "new-object", disabled: true, why: "Add-objects has no Velocity host" },
  { id: "show-only", label: "Show this layer only", icon: "eye-open", disabled: true, why: "Show-only is not wired (copy-only)" },
  { id: "lock", label: "Lock layer", icon: "lock", disabled: true, why: "Layer lock is not wired (copy-only)" },
  { id: "rename", label: "Rename", icon: "edit", disabled: false },
  { id: "description", label: "Add description", icon: "paragraph", disabled: true, why: "Descriptions are not wired (copy-only)" },
  { id: "delete", label: "Delete Layer", icon: "cross-circle", disabled: false },
] as const;

export function LayerMenu({
  row,
  count: _count,
  viewer,
  onToggleHide,
  onDrillIn,
  onCentre,
  onSelect,
  onRename,
  onDelete,
}: {
  row: CatalogRow;
  count: number;
  viewer?: Cesium.Viewer | null;
  onToggleHide: () => void;
  onDrillIn: () => void;
  onCentre: () => void;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const counts = useLayerCounts(viewer);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const run = (id: string): void => {
    setOpen(false);
    if (id === "centre") onCentre();
    else if (id === "select") onSelect();
    else if (id === "rename") onRename();
    else if (id === "delete") onDelete();
  };

  // Row chip: the copy's title + count above the actions. The Row already
  // carries the title and count in its .tx, so only the actions are rendered
  // here; the menu portal is the D71/D76 menu itself.
  return (
    <span className="mv-layer-row" style={{ gap: 0 }}>
      <span className="mv-layer-actions">
        <button
          type="button"
          className="mv-layer-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Menu for ${row.label}`}
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setAnchor({ left: r.right - 158, top: r.bottom + 4 });
            setOpen((v) => !v);
          }}
        >
          <BpIcon name="more" size={14} />
        </button>
        <button
          type="button"
          className="mv-layer-btn"
          aria-label={`Hide ${row.label}`}
          title={`Hide ${row.label}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleHide();
          }}
        >
          <BpIcon name="eye-open" size={16} />
        </button>
        <button
          type="button"
          className="mv-layer-btn"
          aria-label={`Drill into ${row.label}`}
          title={`Drill into ${row.label}`}
          onClick={(e) => {
            e.stopPropagation();
            onDrillIn();
          }}
        >
          <BpIcon name="chevron-right" size={14} />
        </button>
      </span>
      {open &&
        anchor &&
        createPortal(
          <div
            role="menu"
            aria-label={`Layer menu for ${row.label}`}
            className="sl-pop mv-layer-menu"
            style={{ position: "fixed", left: anchor.left, top: anchor.top }}
            onClick={(e) => e.stopPropagation()}
          >
            {ITEMS.map((it) => (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                {...("why" in it && it.why ? { title: it.why } : {})}
                className={it.id === "delete" ? "is-danger" : undefined}
                onClick={() => run(it.id)}
              >
                <BpIcon name={it.icon} size={14} />
                <span className="lbl">{it.label}</span>
              </button>
            ))}
            <MoveToLayer
              targets={[
                { id: "airliners", label: "Airliners", count: rowCount(counts, ["airliners"]) },
                { id: "other-aircraft", label: "Other aircraft", count: rowCount(counts, ["other-aircraft"]) },
              ]}
              onMove={() => setOpen(false)}
            />
          </div>,
          document.body,
        )}
    </span>
  );
}
