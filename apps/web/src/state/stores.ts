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

interface ImageryState {
  mode: ImageryMode;
  setMode: (m: ImageryMode) => void;
  overlay: ImageryOverlay | null;
  setOverlay: (o: ImageryOverlay | null) => void;
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
