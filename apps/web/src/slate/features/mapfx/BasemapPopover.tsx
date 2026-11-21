import { useEffect, useRef, useState } from "react";
import { BASEMAP_OPTIONS } from "../../../globe/basemaps.js";
import { useImagery } from "../../../state/stores.js";
import { BpIcon } from "../../../shell/BpIcon.js";
import "./basemapPopover.css";

// BasemapPopover: D72 "Basemap picker popover (Map | Satellite, thumbnails,
// description, checkmark on the active basemap)". Options are the real
// BASEMAP_OPTIONS registry; "Map" is the Esri dark canvas (the app's actual
// default map basemap), "Satellite" the Esri imagery. The active one carries
// the checkmark; the description is the option's attribution title.

const THUMBS: Record<string, string> = {
  "2d-dark": "Map",
  "3d-sat": "Satellite",
  "esri-imagery": "Satellite",
  "esri-topo": "Map",
  "esri-dark": "Map",
  "opentopo": "Map",
  "usgs-imagery": "Satellite",
  "eox-s2": "Satellite",
  "apple-sat": "Satellite",
  "google-3d": "Satellite",
};

export function BasemapPopover(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const mode = useImagery((s) => s.mode);
  const setMode = useImagery((s) => s.setMode);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const active = BASEMAP_OPTIONS.find((b) => b.value === mode);
  const usable = BASEMAP_OPTIONS.filter((b) => {
    const why = b.unavailable?.();
    return why === null || why === undefined;
  });

  return (
    <span className="mv-basemap-pop" ref={ref}>
      <button
        type="button"
        className="mv-bp-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Change basemap"
        data-testid="d72-basemap"
        onClick={() => setOpen((v) => !v)}
      >
        <BpIcon name="layers" size={16} />
        <span>{active?.label ?? mode}</span>
        <BpIcon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open && (
        <div className="sl-pop mv-bp-menu" role="dialog" aria-label="Basemap picker">
          <div className="mv-bp-tabs" role="tablist" aria-label="Basemap kind">
            <span className="mv-bp-tab" role="tab" aria-selected="true">Map</span>
            <span className="mv-bp-tab" role="tab" aria-selected="false">Satellite</span>
          </div>
          <div className="mv-bp-list">
            {usable.map((b) => {
              const isActive = b.value === mode;
              return (
                <button
                  key={b.value}
                  type="button"
                  className={`mv-bp-row${isActive ? " is-active" : ""}`}
                  aria-pressed={isActive}
                  title={b.title}
                  onClick={() => {
                    setMode(b.value);
                    setOpen(false);
                  }}
                >
                  <span className="mv-bp-thumb" aria-hidden="true">
                    {THUMBS[b.value] ?? "Map"}
                  </span>
                  <span className="mv-bp-main">
                    <span className="mv-bp-name">{b.label}</span>
                    <span className="mv-bp-desc">{b.title}</span>
                  </span>
                  {isActive && (
                    <BpIcon name="checkmark" size={14} className="mv-bp-check" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}
