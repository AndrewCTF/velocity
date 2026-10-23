import { useEffect } from "react";
import * as Cesium from "cesium";
import {
  gstime,
  propagate,
  eciToEcf,
  type EciVec3,
  type Kilometer,
} from "satellite.js";
import { apiFetch } from "../transport/http.js";
import { useDetected } from "../situations/detectedStore.js";
import { useSelection } from "../state/stores.js";
import { useMapTools } from "./mapTools.js";
import { makeSatrec } from "../sim/tasking.js";
import { satelliteStyle } from "./adapters/styles.js";
import { destinationPoint, haversineKm, KN_TO_KMH } from "./projection.js";
import {
  findEntity,
  readPosition,
  readProperties,
} from "../entity-panel/read.js";
import { satellitesOver } from "../slate/features/maven/recommend.js";
import { useMaven } from "./mavenStore.js";

// Globe-scale graphics from the reference feature pages, each drawn from real
// data: the graticule, the next two SAR satellites over the open detection with
// their orbits and 20-degree footprints (G30), great-circle legs from the
// detection to its two nearest maritime chokepoints under real sun shading
// (G51), the drawn area box (G28), and track symbology: a dead-reckoning line
// along the selected vessel's reported course and a real ADS-B history track
// over the detection (G43). Each group is its own data source, rebuilt when its
// store changes; none of them is the live-entity upsert path.

const GLOBE_ONLY = new Cesium.DistanceDisplayCondition(2_500_000, 1e12);
const WHITE = Cesium.Color.WHITE;
const R_EARTH_KM = 6371;
const FOOT_ELEV_DEG = 20;
const DR_HOURS = 2;

const halo = {
  font: '700 13px "Source Sans 3", "Segoe UI", sans-serif',
  fillColor: WHITE,
  outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
  outlineWidth: 3,
  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
};

const pending = new WeakMap<Cesium.DataSource, Promise<unknown>>();
function source(viewer: Cesium.Viewer, name: string): Cesium.CustomDataSource {
  const ds = new Cesium.CustomDataSource(name);
  // add() resolves later; removing before it lands would leak the source.
  pending.set(ds, viewer.dataSources.add(ds));
  return ds;
}

/** Ground radius (km) a satellite at `altKm` sees above `elevDeg`. */
export function footprintKm(altKm: number, elevDeg: number): number {
  const e = (elevDeg * Math.PI) / 180;
  const lam = Math.acos((R_EARTH_KM / (R_EARTH_KM + altKm)) * Math.cos(e)) - e;
  return R_EARTH_KM * lam;
}

function graticule(ds: Cesium.CustomDataSource): void {
  const mat = WHITE.withAlpha(0.3);
  for (let lon = -180; lon < 180; lon += 15) {
    const pts: number[] = [];
    for (let lat = -90; lat <= 90; lat += 5) pts.push(lon, lat);
    ds.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(pts),
        width: 1,
        material: mat,
        arcType: Cesium.ArcType.RHUMB,
        distanceDisplayCondition: GLOBE_ONLY,
      },
    });
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const pts: number[] = [];
    for (let lon = -180; lon <= 180; lon += 5) pts.push(lon, lat);
    ds.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(pts),
        width: 1,
        material: mat,
        arcType: Cesium.ArcType.RHUMB,
        distanceDisplayCondition: GLOBE_ONLY,
      },
    });
  }
}

interface Choke {
  name: string;
  lat: number;
  lon: number;
}

export function GlobeFx({ viewer }: { viewer: Cesium.Viewer | null }): null {
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const grid = source(viewer, "__fx_graticule");
    const aoi = source(viewer, "__fx_aoi");
    const sats = source(viewer, "__fx_sats");
    const area = source(viewer, "__fx_area");
    const dr = source(viewer, "__fx_deadreckon");
    const flight = source(viewer, "__fx_flight");
    graticule(grid);
    let alive = true;
    const paint = (): void => {
      if (!viewer.isDestroyed()) viewer.scene.requestRender();
    };

    // G51 + AOI rings: legs from the detection to its two nearest chokepoints.
    let chokes: Choke[] | null = null;
    const drawAoi = (): void => {
      aoi.entities.removeAll();
      const det = useDetected.getState().det;
      if (!det) return paint();
      for (const r of [120, 240, 360, 480]) {
        aoi.entities.add({
          position: Cesium.Cartesian3.fromDegrees(det.lon, det.lat),
          ellipse: {
            semiMajorAxis: r * 1000,
            semiMinorAxis: r * 1000,
            fill: false,
            outline: true,
            outlineColor: WHITE.withAlpha(0.35),
            height: 0,
            distanceDisplayCondition: GLOBE_ONLY,
          },
        });
      }
      aoi.entities.add({
        position: Cesium.Cartesian3.fromDegrees(det.lon, det.lat),
        point: {
          pixelSize: 9,
          color: WHITE,
          outlineColor: Cesium.Color.fromCssColorString("#1c2a33"),
          outlineWidth: 2,
          distanceDisplayCondition: GLOBE_ONLY,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          ...halo,
          text: "Detection AOI",
          pixelOffset: new Cesium.Cartesian2(0, 16),
          distanceDisplayCondition: GLOBE_ONLY,
        },
      });
      const legs = (chokes ?? [])
        .map((c) => ({ c, d: haversineKm(det.lat, det.lon, c.lat, c.lon) }))
        .filter((x) => x.d > 100)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      for (const { c } of legs) {
        aoi.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([
              det.lon,
              det.lat,
              c.lon,
              c.lat,
            ]),
            width: 3,
            arcType: Cesium.ArcType.GEODESIC,
            material:
              Cesium.Color.fromCssColorString("#5aa9e6").withAlpha(0.95),
            distanceDisplayCondition: GLOBE_ONLY,
          },
        });
        aoi.entities.add({
          position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat),
          point: {
            pixelSize: 8,
            color: WHITE,
            outlineColor: Cesium.Color.fromCssColorString("#1c2a33"),
            outlineWidth: 1.5,
            distanceDisplayCondition: GLOBE_ONLY,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            ...halo,
            text: c.name,
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            pixelOffset: new Cesium.Cartesian2(10, 0),
            distanceDisplayCondition: GLOBE_ONLY,
          },
        });
      }
      paint();
    };
    void apiFetch("/api/maritime/chokepoints")
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          fc: {
            features?: {
              geometry: { coordinates: number[] };
              properties: { name?: string };
            }[];
          } | null,
        ) => {
          if (!alive || !fc) return;
          chokes = (fc.features ?? []).flatMap((f) => {
            const [lon, lat] = f.geometry.coordinates;
            return f.properties.name && lon != null && lat != null
              ? [{ name: f.properties.name, lat, lon }]
              : [];
          });
          drawAoi();
        },
      )
      .catch(() => undefined);

    // G30: the next two SAR passes over the detection, orbit + footprint now.
    let satFor = "";
    const drawSats = (): void => {
      const det = useDetected.getState().det;
      const key = det ? `${det.lat.toFixed(3)},${det.lon.toFixed(3)}` : "";
      if (key === satFor) return;
      satFor = key;
      sats.entities.removeAll();
      if (!det) return paint();
      void satellitesOver(det.lat, det.lon, 12)
        .then((list) => {
          if (!alive || satFor !== key) return;
          const next = list
            .filter((a) => a.sensor === "SAR" && a.tle)
            .sort((a, b) => (a.tttS ?? 0) - (b.tttS ?? 0))
            .slice(0, 2);
          const now = new Date();
          const gm = gstime(now);
          const icon = satelliteStyle();
          for (const a of next) {
            const rec = a.tle ? makeSatrec(a.tle[0], a.tle[1]) : null;
            if (!rec) continue;
            const periodMin = (2 * Math.PI) / rec.no;
            const ring: Cesium.Cartesian3[] = [];
            for (let i = 0; i <= 180; i++) {
              const pv = propagate(
                rec,
                new Date(now.getTime() + (i / 180) * periodMin * 60_000),
              );
              if (!pv?.position || typeof pv.position === "boolean") continue;
              // One frozen sidereal angle: the orbit as a closed ring in space.
              const f = eciToEcf(pv.position as EciVec3<Kilometer>, gm);
              ring.push(
                new Cesium.Cartesian3(f.x * 1000, f.y * 1000, f.z * 1000),
              );
            }
            const pv = propagate(rec, now);
            if (!pv?.position || typeof pv.position === "boolean") continue;
            const f = eciToEcf(pv.position as EciVec3<Kilometer>, gm);
            const here = new Cesium.Cartesian3(
              f.x * 1000,
              f.y * 1000,
              f.z * 1000,
            );
            const c = Cesium.Cartographic.fromCartesian(here);
            const altKm = c.height / 1000;
            const rKm = footprintKm(altKm, FOOT_ELEV_DEG);
            sats.entities.add({
              id: `fx:orbit:${a.id}`,
              polyline: {
                positions: ring,
                width: 1.6,
                arcType: Cesium.ArcType.NONE,
                material: WHITE.withAlpha(0.9),
                distanceDisplayCondition: GLOBE_ONLY,
              },
            });
            sats.entities.add({
              id: `fx:foot:${a.id}`,
              position: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude),
              ellipse: {
                semiMajorAxis: rKm * 1000,
                semiMinorAxis: rKm * 1000,
                material: WHITE.withAlpha(0.16),
                outline: true,
                outlineColor: WHITE.withAlpha(0.3),
                height: 0,
                distanceDisplayCondition: GLOBE_ONLY,
              },
            });
            sats.entities.add({
              id: `fx:sat:${a.id}`,
              name: a.label,
              position: here,
              billboard: {
                image: icon.imageUri,
                scale: icon.scale,
                distanceDisplayCondition: GLOBE_ONLY,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              label: {
                ...halo,
                font: '600 12px "Source Sans 3", "Segoe UI", sans-serif',
                text: a.label,
                pixelOffset: new Cesium.Cartesian2(0, 20),
                distanceDisplayCondition: GLOBE_ONLY,
              },
            });
          }
          paint();
        })
        .catch(() => undefined);
    };

    // G28: the drawn area stays on the map as the reference's white box.
    const drawArea = (): void => {
      area.entities.removeAll();
      const a = useMapTools.getState().area;
      if (a) {
        area.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([
              a.west,
              a.north,
              a.east,
              a.north,
              a.east,
              a.south,
              a.west,
              a.south,
              a.west,
              a.north,
            ]),
            width: 2,
            clampToGround: true,
            material: Cesium.Color.fromCssColorString("#f4f6f8"),
          },
        });
      }
      paint();
    };

    // G43 dead reckoning: a static dashed line along the selected vessel's
    // reported course for DR_HOURS at its reported speed. The icon never moves.
    const drawDr = (): void => {
      dr.entities.removeAll();
      const id = useSelection.getState().selectedEntityId;
      const e = id?.startsWith("vessel:") ? findEntity(viewer, id) : undefined;
      const pos = e ? readPosition(e, viewer) : undefined;
      const p = e ? readProperties(e) : {};
      const sog = typeof p["sog"] === "number" ? p["sog"] : null;
      const cog =
        typeof p["cog"] === "number"
          ? p["cog"]
          : typeof p["heading"] === "number"
            ? p["heading"]
            : null;
      if (pos && sog !== null && sog >= 0.5 && cog !== null) {
        const end = destinationPoint(
          pos.lat,
          pos.lon,
          cog,
          sog * KN_TO_KMH * DR_HOURS,
        );
        dr.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([
              pos.lon,
              pos.lat,
              end.lon,
              end.lat,
            ]),
            width: 2,
            clampToGround: true,
            material: new Cesium.PolylineDashMaterialProperty({
              color: WHITE,
              dashLength: 10,
            }),
          },
        });
        dr.entities.add({
          position: Cesium.Cartesian3.fromDegrees(end.lon, end.lat),
          label: {
            ...halo,
            font: '600 11px "Source Sans 3", "Segoe UI", sans-serif',
            text: `+${DR_HOURS} h at ${sog.toFixed(1)} kn`,
            pixelOffset: new Cesium.Cartesian2(0, -12),
          },
        });
      }
      paint();
    };

    // G43 flight track: the longest real ADS-B history track over the
    // detection in the last six hours, drawn in the reference's blue while the
    // map workspace is open.
    let flightFor = "";
    const drawFlight = (): void => {
      const det = useDetected.getState().det;
      const on = useMaven.getState().on;
      const key =
        det && on ? `${det.lat.toFixed(3)},${det.lon.toFixed(3)}` : "";
      if (key === flightFor) return;
      flightFor = key;
      flight.entities.removeAll();
      paint();
      if (!det || !on) return;
      const now = Math.floor(Date.now() / 1000);
      const pad = 0.6;
      void apiFetch(
        `/api/history/tracks?kind=aircraft&min_lon=${det.lon - pad}&min_lat=${det.lat - pad}&max_lon=${det.lon + pad}&max_lat=${det.lat + pad}&from_ts=${now - 6 * 3600}&to_ts=${now}&limit_ids=200`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { tracks?: { id: string; points: number[][] }[] } | null) => {
          if (!alive || flightFor !== key || !j) return;
          const best = (j.tracks ?? [])
            .filter((t) => t.points.length >= 2)
            .sort((a, b) => b.points.length - a.points.length)[0];
          if (!best) return;
          flight.entities.add({
            id: `fx:flight:${best.id}`,
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(
                best.points.flatMap((p) => [p[0] ?? 0, p[1] ?? 0]),
              ),
              width: 3,
              material: Cesium.Color.fromCssColorString("#4c90f0"),
            },
          });
          paint();
        })
        .catch(() => undefined);
    };

    drawAoi();
    drawSats();
    drawArea();
    drawDr();
    drawFlight();
    const offs = [
      useDetected.subscribe(() => {
        drawAoi();
        drawSats();
        drawFlight();
      }),
      useMapTools.subscribe((s, prev) => {
        if (s.area !== prev.area) drawArea();
      }),
      useSelection.subscribe((s, prev) => {
        if (s.selectedEntityId !== prev.selectedEntityId) drawDr();
      }),
      useMaven.subscribe((s, prev) => {
        if (s.on !== prev.on) drawFlight();
      }),
    ];
    return () => {
      alive = false;
      for (const off of offs) off();
      for (const ds of [grid, aoi, sats, area, dr, flight]) {
        void pending.get(ds)?.then(() => {
          if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
        });
      }
    };
  }, [viewer]);
  return null;
}
