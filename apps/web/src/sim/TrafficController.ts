// TrafficController — cam-detection → animated vehicles on the road network.
//
// Desktop-only: a cam snapshot is run through the CUDA sidecar (detectImage),
// the vehicle count seeds N sim vehicles, and they animate along the nearest
// OSM road way (Overpass, keyless, cached) on the globe. OWN Cesium
// CustomDataSource('sim:traffic') + OWN rAF — never touches viewer.clock or the
// ADS-B/AIS datasources. Vehicles are SVG icons (never dots), created once with
// CallbackPositionProperty/CallbackProperty reading the mutable struct, so there
// is NO per-tick entity churn (the refresh-smoothness guardrail).

import * as Cesium from 'cesium';
import { bearingDeg, destPoint, haversineKm } from './engine.js';
import type { GroundDetection } from '../ground/types.js';
import type { Capture } from '../state/captures.js';

export interface CamInfo {
  cam_id: string;
  name: string;
  lat: number;
  lon: number;
}

interface Vehicle {
  id: string;
  lat: number;
  lon: number;
  heading: number;
  speedMps: number;
  s: number; // arc-length travelled along the way (m)
  way: Way; // the road this vehicle drives (real-data mode spans many roads)
}

const VEHICLE_CLASSES = new Set(['car', 'truck', 'bus', 'motorcycle']);
function vehCount(dets: GroundDetection[]): number {
  return dets.filter((d) => VEHICLE_CLASSES.has(d.cls)).length;
}

const GLOBAL_VEHICLE_CAP = 200; // real-data mode spans many captures

interface Way {
  nodes: { lat: number; lon: number }[];
  cum: number[]; // cumulative arc length (m), len == nodes.length
  total: number; // total length (m)
}

const HEX_CAR = '#facc15';
const HEX_TRUCK = '#fb923c';
const DEFAULT_SPEED_MPS = 13; // ~47 km/h urban arterial (heuristic; see note)
const VEHICLE_CAP = 40;
const ROAD_RADIUS_M = 600;

function carSvg(hex: string): string {
  // ponytail: top-down car — rounded body + windshields. No art lib needed.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="48" viewBox="0 0 32 48">
    <rect x="6" y="3" width="20" height="42" rx="6" fill="${hex}" stroke="rgba(0,0,0,0.6)" stroke-width="1.5"/>
    <rect x="9" y="8" width="14" height="8" rx="2" fill="rgba(0,0,0,0.45)"/>
    <rect x="9" y="33" width="14" height="7" rx="2" fill="rgba(0,0,0,0.35)"/>
  </svg>`;
}

function toDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

const CAR_ICON = toDataUri(carSvg(HEX_CAR));
const TRUCK_ICON = toDataUri(carSvg(HEX_TRUCK));

/** Build a Way from a coordinate ring, computing cumulative arc length. */
function buildWay(coords: { lat: number; lon: number }[]): Way | null {
  if (coords.length < 2) return null;
  const nodes = coords;
  const cum = [0];
  for (let i = 1; i < nodes.length; i++) {
    cum[i] = cum[i - 1]! + haversineKm(nodes[i - 1]!, nodes[i]!) * 1000;
  }
  return { nodes, cum, total: cum[cum.length - 1]! };
}

function posAtArc(w: Way, sMeters: number): { lat: number; lon: number; heading: number } {
  const total = w.total;
  if (total <= 0) return { lat: w.nodes[0]!.lat, lon: w.nodes[0]!.lon, heading: 0 };
  const s = ((sMeters % total) + total) % total;
  // find segment i where cum[i] <= s < cum[i+1]
  let i = 1;
  while (i < w.cum.length && w.cum[i]! < s) i++;
  const a = w.nodes[i - 1]!;
  const b = w.nodes[i] ?? w.nodes[0]!;
  const segLen = (w.cum[i] ?? total) - w.cum[i - 1]!;
  const frac = segLen > 0 ? (s - w.cum[i - 1]!) / segLen : 0;
  const dlat = b.lat - a.lat;
  const dlon = b.lon - a.lon;
  const lat = a.lat + dlat * frac;
  const lon = a.lon + dlon * frac;
  return { lat, lon, heading: bearingDeg(a, b) };
}

/** Keyless Overpass fetch of road ways around a point; cached per (lat,lon) key. */
const _roadCache = new Map<string, Way[]>();
async function fetchRoads(lat: number, lon: number, radiusM: number): Promise<Way[]> {
  const key = `${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusM}`;
  const cached = _roadCache.get(key);
  if (cached) return cached;
  const q = `[out:json][timeout:10];way[highway](around:${radiusM},${lat},${lon});out geom;`;
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(q)}`,
    });
    if (!r.ok) throw new Error(`overpass ${r.status}`);
    const j = (await r.json()) as { elements?: Array<{ geometry?: Array<{ lat: number; lon: number }> }> };
    const ways: Way[] = [];
    for (const el of j.elements ?? []) {
      const coords = el.geometry ?? [];
      const w = buildWay(coords);
      if (w) ways.push(w);
    }
    // ponytail: ceiling — keep the 8 longest ways only (avoid over-dense render).
    ways.sort((x, y) => y.total - x.total);
    const top = ways.slice(0, 8);
    _roadCache.set(key, top);
    return top;
  } catch {
    // Fallback: a short line through the cam along its heading so something moves.
    const dir = 0;
    const a = destPoint({ lat, lon }, dir, 0.05);
    const b = destPoint({ lat, lon }, dir + 180, 0.05);
    const fb = buildWay([a, { lat, lon }, b])!;
    _roadCache.set(key, [fb]);
    return [fb];
  }
}

function nearestWay(ways: Way[], lat: number, lon: number): Way | null {
  let best: Way | null = null;
  let bestD = Infinity;
  for (const w of ways) {
    for (const n of w.nodes) {
      const d = haversineKm({ lat, lon }, n);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
  }
  return best;
}

export class TrafficController {
  private ds: Cesium.CustomDataSource;
  private raf = 0;
  private lastMs = 0;
  private vehicles: Vehicle[] = [];
  private disposed = false;

  constructor(private readonly viewer: Cesium.Viewer) {
    this.ds = new Cesium.CustomDataSource('sim:traffic');
    void viewer.dataSources.add(this.ds);
  }

  /** Seed vehicles from a cam + its detections. Replaces any previous sim. */
  async seed(cam: CamInfo, dets: GroundDetection[]): Promise<{ count: number; road: boolean }> {
    const roads = await fetchRoads(cam.lat, cam.lon, ROAD_RADIUS_M);
    const way = nearestWay(roads, cam.lat, cam.lon);
    if (!way) return { count: 0, road: false };

    // Vehicle count from detections: COCO vehicle classes, capped.
    let count = vehCount(dets);
    if (count === 0) count = Math.max(3, Math.min(8, dets.length || 4)); // no vehicles detected → light traffic
    count = Math.min(count, VEHICLE_CAP);

    this.clearEntities();
    this.vehicles = [];
    for (let i = 0; i < count; i++) {
      const id = `sim:traffic:${cam.cam_id}:${i}`;
      const s = (way.total * i) / Math.max(1, count);
      const p = posAtArc(way, s);
      // ponytail: per-vehicle speed varies deterministically around the default;
      // bbox-displacement flow tracking is a future upgrade (needs cross-poll track).
      const speed = DEFAULT_SPEED_MPS * (0.8 + ((i * 37) % 7) / 10);
      const v: Vehicle = { id, lat: p.lat, lon: p.lon, heading: p.heading, speedMps: speed, s, way };
      this.vehicles.push(v);
      this.addVehicleEntity(v, i % 5 === 0);
    }
    this.start();
    return { count, road: true };
  }

  /**
   * Real-data mode: seed the sim from the CAPTURES store — each cam capture is a
   * real detected car-count at a real location. Spawn that many vehicles on the
   * nearest OSM road per capture (multi-road), then overlay a density-based
   * traffic-jam prediction. Not desktop-gated: captures already carry detections,
   * so this replays real data on the website too.
   */
  async seedFromCaptures(caps: Capture[]): Promise<{ count: number; roads: number; jams: number }> {
    this.clearEntities();
    this.vehicles = [];
    let total = 0;
    const roadStats: { id: string; way: Way; count: number; lat: number; lon: number }[] = [];
    for (const cap of caps) {
      if (total >= GLOBAL_VEHICLE_CAP) break;
      const want = vehCount(cap.dets);
      if (want === 0) continue;
      const roads = await fetchRoads(cap.lat, cap.lon, ROAD_RADIUS_M);
      const way = nearestWay(roads, cap.lat, cap.lon);
      if (!way) continue;
      const n = Math.min(want, GLOBAL_VEHICLE_CAP - total);
      for (let i = 0; i < n; i++) {
        const id = `sim:traffic:${cap.srcId}:${i}`;
        const s = (way.total * i) / Math.max(1, n);
        const p = posAtArc(way, s);
        const speed = DEFAULT_SPEED_MPS * (0.7 + ((i * 37) % 7) / 10);
        const v: Vehicle = { id, lat: p.lat, lon: p.lon, heading: p.heading, speedMps: speed, s, way };
        this.vehicles.push(v);
        this.addVehicleEntity(v, i % 5 === 0);
      }
      total += n;
      roadStats.push({ id: cap.srcId, way, count: n, lat: cap.lat, lon: cap.lon });
    }
    const jams = this.renderJams(roadStats);
    this.start();
    return { count: total, roads: roadStats.length, jams };
  }

  private addVehicleEntity(v: Vehicle, isTruck: boolean): void {
    this.ds.entities.add({
      id: v.id,
      position: new Cesium.CallbackPositionProperty(
        () => Cesium.Cartesian3.fromDegrees(v.lon, v.lat, 0),
        false,
      ),
      billboard: {
        image: isTruck ? TRUCK_ICON : CAR_ICON,
        scale: 0.9,
        rotation: new Cesium.CallbackProperty(() => -Cesium.Math.toRadians(v.heading), false),
        alignedAxis: Cesium.Cartesian3.ZERO,
        color: Cesium.Color.WHITE,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2_000_000),
      },
      properties: { kind: 'sim-vehicle', sim: true },
    });
  }

  /**
   * Traffic-jam prediction: classify each seeded road by the cars-in-frame count
   * (a cam snapshot count, a congestion proxy — NOT a flow rate) and draw a
   * coloured polyline + a JAM/HEAVY label. Heuristic thresholds; a single frame
   * rarely exceeds ~15 vehicles, so a production model would use flow over time.
   * Returns #congested roads.
   */
  private renderJams(
    roads: { id: string; way: Way; count: number; lat: number; lon: number }[],
  ): number {
    let jamCount = 0;
    for (const r of roads) {
      const level = r.count >= 10 ? 'JAM' : r.count >= 5 ? 'HEAVY' : 'FLOW';
      const hex = level === 'JAM' ? '#ef4444' : level === 'HEAVY' ? '#f59e0b' : '#4ade80';
      if (level !== 'FLOW') jamCount++;
      this.ds.entities.add({
        id: `sim:traffic:road:${r.id}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(r.way.nodes.flatMap((n) => [n.lon, n.lat])),
          width: 6,
          material: Cesium.Color.fromCssColorString(hex).withAlpha(0.65),
          clampToGround: true,
        },
        properties: { kind: 'sim-road', sim: true },
      });
      if (level !== 'FLOW') {
        this.ds.entities.add({
          id: `sim:traffic:jamlbl:${r.id}`,
          position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
          label: {
            text: `${level} · ${r.count} veh`,
            font: '600 11px "IBM Plex Mono", monospace',
            fillColor: Cesium.Color.fromCssColorString(hex),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.8),
            backgroundPadding: new Cesium.Cartesian2(6, 3),
            pixelOffset: new Cesium.Cartesian2(0, -22),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1_500_000),
          },
          properties: { kind: 'sim-jam', sim: true },
        });
      }
    }
    return jamCount;
  }

  private start(): void {
    if (this.raf || this.disposed) return;
    this.lastMs = performance.now();
    const loop = (now: number): void => {
      if (this.disposed) return;
      const dt = Math.min(0.1, (now - this.lastMs) / 1000);
      this.lastMs = now;
      this.tick(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick(dt: number): void {
    for (const v of this.vehicles) {
      v.s += v.speedMps * dt;
      const p = posAtArc(v.way, v.s);
      v.lat = p.lat;
      v.lon = p.lon;
      v.heading = p.heading;
    }
  }

  get count(): number {
    return this.vehicles.length;
  }

  private clearEntities(): void {
    this.ds.entities.removeAll();
  }

  stop(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.clearEntities();
    this.vehicles = [];
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    void this.viewer.dataSources.remove(this.ds);
  }
}
