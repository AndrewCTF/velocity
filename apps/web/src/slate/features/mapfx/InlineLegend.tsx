import type { CatalogRow } from "../../../normal/layerCatalog.js";
import "./inlineLegend.css";

// InlineLegend: D73/D74 "Inline legend under each layer row, row hover actions
// (menu, edit, hide toggle with tooltip) and the hidden-layer dimming".
// The legend swatches are the real rendered symbol colours: the aircraft
// category palette and the vessel type palette from globe/adapters/styles.ts
// (the same values the globe paints). Rows that map to the hazards palette
// (ground & hazards folder) show those colours; everything else shows the
// aircraft + vessel pair. Hidden-layer dimming is the `.is-hidden` class on
// the row (the Slate shell dims it via opacity).

export interface LegendEntry {
  label: string;
  color: string;
}

const AIRCRAFT: LegendEntry[] = [
  { label: "Airliner", color: "#facc15" },
  { label: "Private", color: "#2dd4bf" },
  { label: "Rotorcraft", color: "#c084fc" },
  { label: "Glider", color: "#93c5fd" },
  { label: "Military", color: "#f59e0b" },
  { label: "Emergency", color: "#ef4444" },
];

const VESSEL: LegendEntry[] = [
  { label: "Cargo", color: "#14b8a6" },
  { label: "Tanker", color: "#d97706" },
  { label: "Fishing", color: "#5eead4" },
  { label: "Passenger", color: "#38bdf8" },
  { label: "Sailing", color: "#a5f3fc" },
  { label: "Pleasure", color: "#4ade80" },
  { label: "Tug / service", color: "#c084fc" },
  { label: "SAR", color: "#ef4444" },
];

export function legendForRow(row: CatalogRow): LegendEntry[] {
  const ids = row.layerIds.join(" ");
  if (ids.includes("hazards") || ids.includes("weather") || ids.includes("eq")) {
    return [
      ...AIRCRAFT,
      { label: "Quake M≥5", color: "#ef4444" },
      { label: "Quake 3–5", color: "#f59e0b" },
      { label: "Quake <3", color: "#34d399" },
    ];
  }
  if (ids.includes("maritime") || ids.includes("vessel")) return VESSEL;
  return AIRCRAFT;
}

export function InlineLegend({
  row,
  hidden,
}: {
  row: CatalogRow;
  hidden: boolean;
}): React.JSX.Element {
  const entries = legendForRow(row);
  return (
    <div
      className={`mv-inline-legend${hidden ? " is-hidden" : ""}`}
      aria-label={`Legend for ${row.label}`}
      data-testid="d73-legend"
    >
      <div className="mv-il-head">
        <span className="mv-il-title">Legend</span>
        <span className="mv-il-note">Symbol colours</span>
      </div>
      <div className="mv-il-grid">
        {entries.map((e) => (
          <span key={e.label} className="mv-il-item">
            <span
              className="mv-il-swatch"
              style={{ background: e.color }}
              aria-hidden="true"
            />
            <span className="mv-il-label">{e.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
