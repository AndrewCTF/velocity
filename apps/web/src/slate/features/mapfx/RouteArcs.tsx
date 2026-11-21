import { useEffect } from "react";
import * as Cesium from "cesium";
import { apiFetch } from "../../../transport/http.js";
import { destinationPoint } from "../../../globe/projection.js";

// RouteArcs: D87 "Search Around result: great-circle route arcs and a LINKS
// layer (187 real OpenFlights destinations from DXB)". Fetches the live
// /api/aviation/routes destinations for the selected airport's IATA,
// geocodes each via /api/aviation/airports/openflights?limit=... IATA lookup
// (the collection is large; filter by IATA), then drapes great-circle arcs
// from the origin to each destination as polylines in one entity collection
// labelled LINKS. Annotations are: arcs are real OpenFlights pairs; the
// great-circle sampling is the same destinationPoint helper the projection
// overlay uses (continuous bearing steps, not sampled gateway coordinates).

const R_KM = 6371.0088;

export function arcPoints(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
  n = 24,
): Array<[number, number]> {
  // Great-circle interpolation: step the bearing from A to B by distance.
  const dist = 2 * R_KM * Math.asin(
    Math.sqrt(
      Math.sin(((bLat - aLat) * Math.PI) / 360) ** 2 +
        Math.cos((aLat * Math.PI) / 180) *
          Math.cos((bLat * Math.PI) / 180) *
          Math.sin(((bLon - aLon) * Math.PI) / 360) ** 2,
    ),
  );
  const th = Math.atan2(
    Math.sin(((bLon - aLon) * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180),
    Math.cos((aLat * Math.PI) / 180) * Math.sin((bLat * Math.PI) / 180) -
      Math.sin((aLat * Math.PI) / 180) *
        Math.cos((bLat * Math.PI) / 180) *
        Math.cos(((bLon - aLon) * Math.PI) / 180),
  );
  const bearingDeg = (th * 180) / Math.PI;
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const p = destinationPoint(aLat, aLon, bearingDeg, (dist / n) * i);
    out.push([p.lon, p.lat]);
  }
  return out;
}

interface OpenFlightsFeature {
  id: string;
  geometry: { coordinates: [number, number] };
  properties: { iata?: string; icao?: string; name?: string };
}

export function RouteArcs({
  airportId,
  viewer,
}: {
  airportId: string;
  viewer: Cesium.Viewer | null;
}): React.JSX.Element | null {
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    if (!airportId.startsWith("airport:")) return;
    const iata = airportId.slice("airport:".length);
    let cancelled = false;
    let ds: Cesium.CustomDataSource | null = null;

    const load = async (): Promise<void> => {
      // Origin position from the airport entity.
      const entRes = await apiFetch(`/api/entity/airport:${iata}`).catch(() => null);
      if (cancelled || !entRes?.ok) return;
      const ent = (await entRes.json()) as { lat?: number; lon?: number; icao?: string };
      if (cancelled || typeof ent.lat !== "number" || typeof ent.lon !== "number") return;
      const origin = { lat: ent.lat, lon: ent.lon };

      // Destinations: live OpenFlights routes from this IATA.
      const routesRes = await apiFetch(`/api/aviation/routes`).catch(() => null);
      if (cancelled || !routesRes?.ok) return;
      const routesJson = (await routesRes.json()) as {
        routes?: Array<{ airline: string; src: string; dst: string }>;
      };
      const dstCodes = new Set(
        (routesJson.routes ?? [])
          .filter((r) => r.src === iata)
          .map((r) => r.dst),
      );
      if (cancelled || dstCodes.size === 0) return;

      // Geocode destinations via the OpenFlights airport collection
      // (IATA on each feature's properties).
      const airportsRes = await apiFetch(
        `/api/aviation/airports/openflights?limit=20000`,
      ).catch(() => null);
      if (cancelled || !airportsRes?.ok) return;
      const airportsJson = (await airportsRes.json()) as {
        features?: OpenFlightsFeature[];
      };
      const geomByIata = new Map<string, { lat: number; lon: number; name: string | undefined }>();
      for (const f of airportsJson.features ?? []) {
        const c = f.properties?.iata;
        if (c && dstCodes.has(c)) {
          geomByIata.set(c, {
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
            name: f.properties.name,
          });
        }
      }
      if (cancelled || geomByIata.size === 0) return;

      // One LINKS data source for all arcs, labelled as the copy does.
      ds = new Cesium.CustomDataSource("LINKS");
      void viewer.dataSources.add(ds);
      for (const [code, g] of geomByIata) {
        if (cancelled) break;
        const pts = arcPoints(origin.lat, origin.lon, g.lat, g.lon);
        const positions = pts.map(([lon, lat]) =>
          Cesium.Cartesian3.fromDegrees(lon, lat, 25000),
        );
        ds.entities.add({
          name: `${iata} → ${code}`,
          polyline: {
            positions,
            width: 2,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.12,
              color: Cesium.Color.fromCssColorString("#2ea3ff"),
            }),
          },
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (ds) {
        try {
          void viewer.dataSources.remove(ds, true);
        } catch {
          // Viewer destroyed; nothing to remove.
        }
      }
    };
  }, [airportId, viewer]);

  return null;
}
