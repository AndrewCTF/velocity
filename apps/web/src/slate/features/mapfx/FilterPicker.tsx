import { useEffect, useState } from "react";
import { apiFetch } from "../../../transport/http.js";
import { BpIcon } from "../../../shell/BpIcon.js";
import { useFilters } from "../../../state/stores.js";
import "./filterPicker.css";

// FilterPicker: D82 "Add-filter property picker with type glyphs (properties
// of the real airport object)". The glyphs are the property's value KIND
// (text, number, boolean, runway, frequency) — the same derivation dashboards
// use to render a typed value. The properties are the fields the live
// /api/entity/airport:{IATA} payload actually carries (runways, frequencies,
// elevation, municipality, …). Adding a filter writes a useFilters clause so
// the globe's filter store stays in sync with what the user picked.

interface AirportEntity {
  iata?: string;
  icao?: string;
  name?: string;
  lat?: number;
  lon?: number;
  elevation_ft?: number;
  municipality?: string;
  iso?: string;
  atype?: string;
  scheduled_service?: boolean;
  military?: boolean;
  runway_count?: number;
  max_runway_length_ft?: number;
  runways?: Array<Record<string, unknown>>;
  frequencies?: Array<Record<string, unknown>>;
}

type Glyph = "text" | "number" | "bool" | "runway" | "frequency";

interface PropertyRow {
  key: string;
  glyph: Glyph;
  value: string;
}

const GLYPH_ICON: Record<Glyph, string> = {
  text: "paragraph",
  number: "align-justify",
  bool: "check",
  runway: "airplane",
  frequency: "radio",
};

function glyphFor(key: string, value: unknown): Glyph {
  if (key === "runways") return "runway";
  if (key === "frequencies") return "frequency";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  return "text";
}

function rowsFor(ent: AirportEntity): PropertyRow[] {
  const rows: PropertyRow[] = [];
  for (const [k, v] of Object.entries(ent)) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "registry" || k === "candidate_mounts" || k === "candidate_mounts_best_effort") continue;
    const glyph = glyphFor(k, v);
    let value: string;
    if (Array.isArray(v)) {
      value = `${v.length} items`;
    } else if (typeof v === "object") {
      value = JSON.stringify(v).slice(0, 40);
    } else {
      value = String(v);
    }
    rows.push({ key: k, glyph, value });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return rows;
}

export function FilterPicker({
  airportId,
  onClose,
}: {
  airportId: string;
  onClose: () => void;
}): React.JSX.Element {
  const [ent, setEnt] = useState<AirportEntity | null>(null);
  const toggleClause = useFilters((s) => s.toggleClause);

  useEffect(() => {
    if (!airportId.startsWith("airport:")) return;
    const iata = airportId.slice("airport:".length);
    let cancelled = false;
    apiFetch(`/api/entity/airport:${iata}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: AirportEntity | null) => {
        if (!cancelled && j) setEnt(j);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [airportId]);

  const rows = ent ? rowsFor(ent) : [];

  return (
    <div className="mv-filter-picker" role="dialog" aria-label="Add filter" data-testid="d82-filter-picker">
      <div className="mv-fp-head">
        <span className="mv-fp-title">Add filter</span>
        <span className="mv-fp-sub">
          {ent ? `${ent.name ?? airportId} properties` : "Loading airport…"}
        </span>
        <button
          type="button"
          className="mv-fp-close"
          aria-label="Close filter picker"
          onClick={onClose}
        >
          <BpIcon name="cross" size={14} />
        </button>
      </div>
      <div className="mv-fp-list">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            className="mv-fp-row"
            aria-label={`Add filter ${r.key}`}
            onClick={() => {
              toggleClause("flag", r.key, "only");
              onClose();
            }}
          >
            <span className="mv-fp-icon" aria-hidden="true"><BpIcon name={GLYPH_ICON[r.glyph]} size={14} /></span>
            <span className="mv-fp-key">{r.key}</span>
            <span className="mv-fp-val">{r.value}</span>
            <span className="mv-fp-glyph" aria-hidden="true">{r.glyph}</span>
          </button>
        ))}
        {ent === null && (
          <div className="mv-fp-empty">Loading properties…</div>
        )}
      </div>
    </div>
  );
}
