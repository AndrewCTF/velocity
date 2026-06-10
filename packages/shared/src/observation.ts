// Source of truth: research_updated.md §1.3
// Every emitting layer normalizes its output to an Observation so the fusion
// engine can treat all sources uniformly.

import type { EmitsKind } from './layer.js';

export type GeoPoint = {
  type: 'Point';
  coordinates: [number, number] | [number, number, number]; // [lon, lat] or [lon, lat, alt]
};
export type GeoLineString = {
  type: 'LineString';
  coordinates: Array<[number, number] | [number, number, number]>;
};
export type GeoPolygon = {
  type: 'Polygon';
  coordinates: Array<Array<[number, number]>>;
};

export type Geometry = GeoPoint | GeoLineString | GeoPolygon;

export interface Observation {
  id: string;
  source: string;            // e.g. 'opensky', 'aisstream', 'firms'
  t: number;                 // epoch ms
  geom: Geometry;
  attrs: Record<string, unknown>;
  emitsKind: EmitsKind;
}

export type AlertSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Alert {
  id: string;
  ruleId: string;            // matches Fusion rule id, e.g. 'ais_gap_sar'
  severity: AlertSeverity;
  t: number;                 // epoch ms
  geom: Geometry;
  confidence: number;        // 0..1
  message: string;
  contributingObservations: readonly string[]; // Observation.id refs
}

export function isObservation(v: unknown): v is Observation {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['source'] === 'string' &&
    typeof o['t'] === 'number' &&
    typeof o['emitsKind'] === 'string' &&
    typeof o['geom'] === 'object' &&
    o['geom'] !== null &&
    typeof o['attrs'] === 'object' &&
    o['attrs'] !== null
  );
}
