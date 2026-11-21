import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { apiFetch } from "../../../transport/http.js";
import { searchObjects, type ObjectResult } from "../../../transport/search.js";
import { useSelection } from "../../../state/stores.js";
import { BpIcon } from "../../../shell/BpIcon.js";
import { FacetChecklist, useFacetChecked } from "./FacetChecklist.js";
import "./searchDialog.css";

// SearchDialog: D80 "Object search dialog: type facet with counts, mixed
// live results (ADS-B aircraft and AIS vessels) with inline key-values".
// The type facet already lives in ExplorerApp; this dialog is the Maven-map
// reachable host that reuses the same live source (/api/search/objects =>
// /api/adsb/global + /api/maritime/vessels union server-side) and adds the
// Fat facet checklist (D81) + inline key-values per row. Clicking a row
// selects it and flies the viewer to it, exactly like ExplorerApp.

interface AisVessel {
  id: string;
  name?: string;
  shipType?: string;
  flag?: string;
  sog?: number;
  cog?: number | null;
  heading?: number | null;
  lat: number;
  lon: number;
}

export function SearchDialog({
  viewer,
  onClose,
  bbox,
}: {
  viewer: Cesium.Viewer | null;
  onClose: () => void;
  bbox?: [number, number, number, number] | null;
}): React.JSX.Element {
  const [q, setQ] = useState("");
  const [type, setType] = useState<string>("all");
  const [results, setResults] = useState<ObjectResult[]>([]);
  const [byType, setByType] = useState<Record<string, number>>({});
  const [count, setCount] = useState(0);
  const [aisById, setAisById] = useState<Map<string, AisVessel>>(new Map());
  // D83: the vessel feed's real cap is 50,000 (the backend truncates at
  // limit=50000 and reports truncated:true). "Add all" would need to page
  // past that cap, so it stays disabled with this tooltip naming the cap.
  const vesselCap = 50000;
  const [checked, toggle] = useFacetChecked();
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    const id = window.setTimeout(() => {
      searchObjects(
        { type, q, limit: 500, ...(bbox ? { bbox } : {}) },
        ac.signal,
      )
        .then((d) => {
          setResults(d.results);
          setByType(d.by_type);
          setCount(d.count);
        })
        .catch(() => undefined);
      // AIS field-level detail for vessel rows (name/shipType/flag/SOG/COG)
      // from the live vessel feed — the "inline key-values".
      apiFetch(`/api/maritime/vessels?bbox=-180,-85,180,85&limit=200`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { vessels?: AisVessel[] } | null) => {
          if (ac.signal.aborted || !j?.vessels) return;
          setAisById(new Map(j.vessels.map((v) => [v.id, v])));
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      window.clearTimeout(id);
      ac.abort();
    };
  }, [q, type, bbox]);

  const chips: Array<[string, number]> = [
    ["all", count],
    ...Object.entries(byType).sort((a, b) => b[1] - a[1]),
  ];

  const filtered = results.filter((r) => {
    if (checked.size === 0) return true;
    // Facet filter lives on the vessel flag derivation used by the checklist.
    const v = aisById.get(r.id);
    const flag = (v?.flag ?? "") || "other";
    return checked.has(flag);
  });

  const onRow = (r: ObjectResult): void => {
    useSelection.getState().select(r.id);
    if (viewer && !viewer.isDestroyed()) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 120_000),
        duration: 0.8,
      });
    }
  };

  return (
    <div className="mv-search-dialog" role="dialog" aria-label="Object search" data-testid="d80-search-dialog">
      <div className="mv-sd-head">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search objects…"
          aria-label="Search objects"
          className="mv-sd-input"
        />
        <button
          type="button"
          className="mv-sd-close"
          aria-label="Close search"
          onClick={onClose}
        >
          <BpIcon name="cross" size={14} />
        </button>
      </div>
      <div className="mv-sd-chips" role="group" aria-label="Type facet">
        {bbox && (
          <span className="mv-sd-shape-chip" data-testid="d84-drawn-shape">
            Filtered to drawn shape
          </span>
        )}
        {chips.map(([k, n]) => (
          <button
            key={k}
            type="button"
            className={`mv-sd-chip${type === k ? " is-on" : ""}`}
            aria-pressed={type === k}
            onClick={() => setType(k)}
          >
            {k} <b>{n.toLocaleString()}</b>
          </button>
        ))}
      </div>
      <FacetChecklist results={results} checked={checked} onToggle={toggle} query={q} />
      <div className="mv-sd-results">
        {filtered.map((r) => {
          const v = r.kind === "vessel" ? aisById.get(r.id) : undefined;
          return (
            <button
              key={r.id}
              type="button"
              className="mv-sd-row"
              onClick={() => onRow(r)}
            >
              <span className="mv-sd-label">{r.label}</span>
              <span className="mv-sd-kind">{r.kind}</span>
              {v ? (
                <span className="mv-sd-kv">
                  <span>{v.shipType ?? "—"}</span>
                  <span>{v.flag ?? "—"}</span>
                  <span>{v.sog != null ? `${v.sog.toFixed(1)} kn` : "—"}</span>
                </span>
              ) : (
                <span className="mv-sd-kv">
                  <span>{r.source}</span>
                  <span>
                    {r.lat.toFixed(2)}, {r.lon.toFixed(2)}
                  </span>
                </span>
              )}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="mv-sd-empty">No objects match. Clear the facet or widen the search.</div>
        )}
      </div>
      <div className="mv-sd-foot">
        <span>
          {filtered.length.toLocaleString()} shown · {count.toLocaleString()} match
        </span>
        <button
          type="button"
          className="mv-sd-add-all"
          disabled={true}
          title={`Add all is capped at ${vesselCap.toLocaleString()} vessels — the vessel feed's real limit (limit=50000, truncated)`}
          data-testid="d83-add-all"
        >
          Add all ({count.toLocaleString()})
        </button>
      </div>
    </div>
  );
}
