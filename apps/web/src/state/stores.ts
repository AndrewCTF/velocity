// Zustand stores — one per domain per frontend.md §1.
// Stores hold UI state. Cross-store side effects live in adapters, not here.

import { create } from 'zustand';
import type { Alert } from '@osint/shared';

export type FeedStatus = 'green' | 'amber' | 'red' | 'unknown';

export interface FeedHealth {
  id: string;
  label: string;
  status: FeedStatus;
  lastSeen?: number; // epoch ms
  note?: string;     // reason when non-green (no key, rate limited, transport error)
}

interface FeedsState {
  feeds: Record<string, FeedHealth>;
  setFeed: (f: FeedHealth) => void;
}

export const useFeeds = create<FeedsState>((set) => ({
  feeds: {},
  setFeed: (f) =>
    set((s) => ({
      feeds: { ...s.feeds, [f.id]: f },
    })),
}));

interface SelectionState {
  selectedEntityId: string | null;
  select: (id: string | null) => void;
}

export const useSelection = create<SelectionState>((set) => ({
  selectedEntityId: null,
  select: (id) => set({ selectedEntityId: id }),
}));
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useSelection: typeof useSelection }).__useSelection = useSelection;
}

export type SceneMode = '3D' | '2.5D' | '2D';

interface TimeState {
  playing: boolean;
  multiplier: number; // 1..3600
  currentTime: number; // epoch ms
  sceneMode: SceneMode;
  togglePlay: () => void;
  setMultiplier: (m: number) => void;
  setCurrentTime: (t: number) => void;
  setSceneMode: (m: SceneMode) => void;
}

export const useTime = create<TimeState>((set) => ({
  // Default to "playing" so SampledPositionProperty interpolation animates
  // aircraft icons smoothly between fixes. Operator can pause to freeze.
  playing: true,
  multiplier: 1,
  currentTime: Date.now(),
  sceneMode: '3D',
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setMultiplier: (m) => {
    if (m < 1 || m > 3600) throw new RangeError(`multiplier must be in [1,3600], got ${m}`);
    set({ multiplier: m });
  },
  setCurrentTime: (t) => set({ currentTime: t }),
  setSceneMode: (m) => set({ sceneMode: m }),
}));

export type ImageryMode = '2d-dark' | '3d-sat';

// Date-templated imagery overlay drawn on top of the base layer.
// null = off; else a provider + layer id + UTC date (YYYY-MM-DD) + max zoom.
export interface ImageryOverlay {
  provider: string;
  layer: string;
  date: string;
  maxZ: number;
}

// Operator-chosen focus point for the "events anywhere" search — a location
// (lat/lon, optionally named) plus a radius in km. Drives /api/events/all.
export interface EventsLocation {
  lat: number;
  lon: number;
  name?: string;
}

// A one-shot request for GlobeCanvas to fly the camera to a point. Mirrors the
// lod1Here request/clear pattern: the producer sets it, the GlobeCanvas
// consumer acts on it and clears it back to null. seq forces a new object even
// when the same coordinates are requested twice in a row.
export interface FlyToRequest {
  lat: number;
  lon: number;
  altMeters?: number;
  seq: number;
}

interface ImageryState {
  mode: ImageryMode;
  setMode: (m: ImageryMode) => void;
  overlay: ImageryOverlay | null;
  setOverlay: (o: ImageryOverlay | null) => void;
  // Overlay blend opacity 0..1 (applied to the GIBS/CDSE imagery layer alpha).
  overlayOpacity: number;
  setOverlayOpacity: (a: number) => void;
  // LOD1 war-damage 3D: curated AOI to load + extrude in the globe (null = none).
  lod1Aoi: string | null;
  setLod1Aoi: (a: string | null) => void;
  // On-demand 3D buildings anywhere. 'here' = extrude the current camera view;
  // GlobeCanvas resolves it to a bbox and clears it back to null once loaded.
  // null = no freeform request pending/active.
  lod1Here: boolean;
  requestLod1Here: () => void;
  clearLod1Here: () => void;
  // Events-anywhere focus: the operator-chosen location + search radius (km).
  eventsLocation: EventsLocation | null;
  eventsRadiusKm: number;
  setEventsLocation: (l: EventsLocation | null) => void;
  setEventsRadiusKm: (km: number) => void;
  // One-shot camera flyTo request consumed by GlobeCanvas (null = none pending).
  flyTo: FlyToRequest | null;
  requestFlyTo: (lat: number, lon: number, altMeters?: number) => void;
  clearFlyTo: () => void;
}

// Imagery stack toggle — flips the GlobeCanvas between the default
// proxied Carto Dark Matter basemap (no ion token required) and Cesium
// World Imagery + World Terrain + OSM Buildings (ion token required, free
// Community tier). Implemented as a runtime swap inside the existing
// viewer so the toggle does NOT remount Cesium.
export const useImagery = create<ImageryState>((set) => ({
  mode: '2d-dark',
  setMode: (m) => set({ mode: m }),
  overlay: null,
  setOverlay: (o) => set({ overlay: o }),
  overlayOpacity: 1,
  setOverlayOpacity: (a) => set({ overlayOpacity: Math.min(1, Math.max(0, a)) }),
  lod1Aoi: null,
  setLod1Aoi: (a) => set({ lod1Aoi: a }),
  lod1Here: false,
  requestLod1Here: () => set({ lod1Here: true }),
  clearLod1Here: () => set({ lod1Here: false }),
  eventsLocation: null,
  eventsRadiusKm: 500,
  setEventsLocation: (l) => set({ eventsLocation: l }),
  setEventsRadiusKm: (km) => set({ eventsRadiusKm: Math.min(20000, Math.max(1, km)) }),
  flyTo: null,
  requestFlyTo: (lat, lon, altMeters) =>
    set((s) => ({
      flyTo: {
        lat,
        lon,
        seq: (s.flyTo?.seq ?? 0) + 1,
        ...(altMeters !== undefined ? { altMeters } : {}),
      },
    })),
  clearFlyTo: () => set({ flyTo: null }),
}));

export type WsStatus = 'connecting' | 'open' | 'closed';

interface ConnectionState {
  ws: WsStatus;
  setWs: (s: WsStatus) => void;
}

// Connection status — surfaced as a "WS · live"/"WS · down" pill in the
// command bar so operators can immediately see whether incoming alerts
// reflect reality or a stale buffer.
export const useConnection = create<ConnectionState>((set) => ({
  ws: 'connecting',
  setWs: (s) => set({ ws: s }),
}));

interface AlertsState {
  alerts: readonly Alert[];
  push: (a: Alert) => void;
  clear: () => void;
}

const MAX_ALERT_BUFFER = 500;

export const useAlerts = create<AlertsState>((set) => ({
  alerts: [],
  push: (a) =>
    set((s) => {
      const next = [a, ...s.alerts];
      if (next.length > MAX_ALERT_BUFFER) next.length = MAX_ALERT_BUFFER;
      return { alerts: next };
    }),
  clear: () => set({ alerts: [] }),
}));
