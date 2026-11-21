import { useEffect, useState } from "react";
import * as Cesium from "cesium";
import { BpIcon } from "../../../shell/BpIcon.js";
import { useMapTools } from "../../../globe/mapTools.js";
import "./mainToolbar.css";

// MainToolbar: D66 "Main map toolbar, icon plus word (Draw pressed, Search
// Around and Delete disabled)". Seven items in the copy's order with the
// copy's separators at 89.5 / 228.5 / 590.5. Reachable from the Maven header
// Tools pill (`mv-chrome` Draw pill) and always visible on the map.

// D66 disables are copy-specific: Search Around and Delete render disabled.
// In the app Search Around is the `search-around` menu item and Delete is
// the map draw tool's clear; both stay disabled here until their hosts are
// wired (same disabled contract as the copy, honestly unwired).
const ITEMS = [
  { id: "select", label: "Select", icon: "record", sepAfter: false, disabled: false },
  { id: "search-around", label: "Search Around", icon: "search-around", sepAfter: true, disabled: true },
  { id: "draw", label: "Draw", icon: "draw", sepAfter: false, disabled: false },
  { id: "capture", label: "Capture", icon: "camera", sepAfter: false, disabled: false },
  { id: "measure", label: "Measure", icon: "arrows-horizontal", sepAfter: false, disabled: false },
  { id: "annotate", label: "Annotate", icon: "annotation", sepAfter: true, disabled: false },
  { id: "delete", label: "Delete", icon: "cross-circle", sepAfter: false, disabled: true },
] as const;

type ItemId = (typeof ITEMS)[number]["id"];

export function MainToolbar({
  viewer,
  active,
  onActivate,
}: {
  viewer: Cesium.Viewer | null;
  active?: ItemId | null;
  onActivate?: (id: ItemId) => void;
}): React.JSX.Element {
  const [current, setCurrent] = useState<ItemId>(active ?? "draw");

  useEffect(() => {
    if (active) setCurrent(active);
  }, [active]);

  const activate = (id: ItemId): void => {
    const item = ITEMS.find((i) => i.id === id);
    if (!item || item.disabled) return;
    setCurrent(id);
    onActivate?.(id);
    // Draw/Measure/Annotate are the mapTools tools (GlobeToolbar drives the
    // same store); Select/Capture just change the active highlight here.
    if (id === "draw") useMapTools.getState().setTool("area");
    else if (id === "measure") useMapTools.getState().setTool("measure");
    else if (id === "annotate") useMapTools.getState().setTool("annotate");
    else useMapTools.getState().setTool("pan");
    void viewer;
  };

  return (
    <div
      className="mv-main-toolbar"
      role="toolbar"
      aria-label="Main map toolbar"
      data-testid="d66-toolbar"
    >
      {ITEMS.map((it) => (
        <span key={it.id} className={`mvmt-item${it.disabled ? " is-disabled" : ""}`}>
          <button
            type="button"
            className={`mvmt-btn${current === it.id ? " is-active" : ""}`}
            aria-pressed={current === it.id}
            aria-disabled={it.disabled}
            disabled={it.disabled}
            title={it.disabled ? `${it.label} unavailable` : it.label}
            onClick={() => activate(it.id)}
          >
            <BpIcon name={it.icon} size={16} />
            <span className="mvmt-label">{it.label}</span>
          </button>
          {it.sepAfter && <span className="mvmt-sep" aria-hidden="true" />}
        </span>
      ))}
    </div>
  );
}
