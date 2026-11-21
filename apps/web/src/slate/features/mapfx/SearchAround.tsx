import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { apiFetch } from "../../../transport/http.js";
import { useInvestigation } from "../../../graph/investigationStore.js";
import { BpIcon } from "../../../shell/BpIcon.js";
import "./searchAround.css";

// SearchAround: D86 "Search Around dropdown with link types and counts
// (OpenFlights routes, runways, frequencies)". Counts are live: routes from
// /api/aviation/routes filtered to the selected airport's IATA, runways and
// frequencies from /api/entity/airport:{IATA}. Entries open the graph
// (investigationStore.searchAround) like the Links row in MavenMap.

interface AirportEntity {
  iata?: string;
  icao?: string;
  lat?: number;
  lon?: number;
  runways?: unknown[];
  frequencies?: unknown[];
}

interface RouteRow {
  airline: string;
  src: string;
  dst: string;
}

interface PlaceAirport {
  id: string;
  geometry?: { coordinates?: [number, number] };
  properties?: { iata?: string; name?: string; icao?: string };
}

// D88: nearby airports carrying IATA codes (link-merged "via" type).
const VIA_RADIUS_KM = 150;
const R_KM = 6371.0088;

export function nearbyIataAirports(
  lat: number,
  lon: number,
  feats: PlaceAirport[],
): PlaceAirport[] {
  const out: Array<[number, PlaceAirport]> = [];
  for (const f of feats) {
    const iata = (f.properties?.iata ?? "").trim();
    if (!iata) continue;
    const c = f.geometry?.coordinates;
    if (!c) continue;
    const p1 = (lat * Math.PI) / 180;
    const p2 = (c[1] * Math.PI) / 180;
    const dp = ((c[1] - lat) * Math.PI) / 180;
    const dl = ((c[0] - lon) * Math.PI) / 180;
    const h =
      Math.sin(dp / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const km = 2 * R_KM * Math.asin(Math.sqrt(h));
    if (km <= VIA_RADIUS_KM) out.push([km, f]);
  }
  return out.sort((a, b) => a[0] - b[0]).map(([, f]) => f);
}

export function SearchAround({
  entityId,
  viewer: _viewer,
}: {
  entityId: string;
  viewer?: Cesium.Viewer | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [routes, setRoutes] = useState<RouteRow[] | null>(null);
  const [airport, setAirport] = useState<AirportEntity | null>(null);
  const [viaAirports, setViaAirports] = useState<PlaceAirport[] | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const iata = entityId.startsWith("airport:")
    ? entityId.slice("airport:".length)
    : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open || !iata) return;
    let cancelled = false;
    apiFetch(`/api/aviation/routes`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { routes?: RouteRow[] } | null) => {
        if (cancelled || !j?.routes) return;
        setRoutes(j.routes.filter((x) => x.src === iata || x.dst === iata));
      })
      .catch(() => undefined);
    apiFetch(`/api/entity/airport:${iata}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: AirportEntity | null) => {
        if (cancelled || !j) return;
        setAirport(j);
        // D88: via airports need the selected airport's lat/lon first.
        if (j.lat == null || j.lon == null) {
          setViaAirports([]);
          return;
        }
        apiFetch(
          `/api/places/airports?bbox=-180,-85,180,85&limit=20000`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((p: { features?: PlaceAirport[] } | null) => {
            if (cancelled || !p?.features) return;
            setViaAirports(
              nearbyIataAirports(j.lat!, j.lon!, p.features).filter(
                (f) => (f.properties?.iata ?? "").trim() !== iata,
              ),
            );
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, iata]);

  const routeCount = routes?.length ?? 0;
  const runwayCount = airport?.runways?.length ?? 0;
  const freqCount = Array.isArray(airport?.frequencies)
    ? airport.frequencies.length
    : 0;

  return (
    <span className="mv-search-around" ref={ref}>
      <button
        type="button"
        className="mv-sa-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Search around"
        data-testid="d86-search-around"
        onClick={() => setOpen((v) => !v)}
      >
        <BpIcon name="search-around" size={16} />
        <span>Search Around</span>
        <BpIcon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open && (
        <div className="sl-pop mv-sa-menu" role="menu" aria-label="Search around link types">
          {iata === null && (
            <div className="mv-sa-empty">Select an airport to search around</div>
          )}
          {iata !== null && (
            <>
              <button
                type="button"
                role="menuitem"
                className="mv-sa-item"
                disabled={routes === null}
                title={routes === null ? "Loading routes" : `${routeCount.toLocaleString()} OpenFlights routes`}
                onClick={() => {
                  setOpen(false);
                  useInvestigation.getState().searchAround(entityId);
                }}
              >
                <BpIcon name="route" size={14} />
                <span className="mv-sa-name">Routes</span>
                <span className="mv-sa-count">
                  {routes === null ? "…" : routeCount.toLocaleString()}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mv-sa-item"
                disabled={airport === null}
                title={airport === null ? "Loading airport" : `${runwayCount} runways`}
                onClick={() => {
                  setOpen(false);
                  useInvestigation.getState().searchAround(entityId);
                }}
              >
                <BpIcon name="airplane" size={14} />
                <span className="mv-sa-name">Runways</span>
                <span className="mv-sa-count">
                  {airport === null ? "…" : runwayCount.toLocaleString()}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mv-sa-item"
                disabled={airport === null}
                title={airport === null ? "Loading airport" : `${freqCount} frequencies`}
                onClick={() => {
                  setOpen(false);
                  useInvestigation.getState().searchAround(entityId);
                }}
              >
                <BpIcon name="radio" size={14} />
                <span className="mv-sa-name">Frequencies</span>
                <span className="mv-sa-count">
                  {airport === null ? "…" : freqCount.toLocaleString()}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mv-sa-item"
                disabled={viaAirports === null}
                title={
                  viaAirports === null
                    ? "Loading nearby airports"
                    : `${viaAirports.length} airports with IATA codes within 150 km`
                }
                onClick={() => {
                  setOpen(false);
                  useInvestigation.getState().searchAround(entityId);
                }}
              >
                <BpIcon name="airplane" size={14} />
                <span className="mv-sa-name">Nearby airports (via links)</span>
                <span className="mv-sa-count">
                  {viaAirports === null ? "…" : viaAirports.length.toLocaleString()}
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}
