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
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useAlerts: typeof useAlerts }).__useAlerts = useAlerts;
}

// Simulation mode — a browser-side war-game overlay drawn on its own Cesium
// CustomDataSource over the live globe. `active` gates the SimulationOverlay UI
// and the live-feed dimming; the SimController owns all sim entities + motion.
interface SimState {
  active: boolean;
  setActive: (b: boolean) => void;
  toggle: () => void;
}

export const useSim = create<SimState>((set) => ({
  active: false,
  setActive: (b) => set({ active: b }),
  toggle: () => set((s) => ({ active: !s.active })),
}));

// ── Map-side faceted filter (HistogramPanel ↔ PollGeoJsonAdapter) ───────────
// The histogram panel aggregates live entities into facet buckets (altitude
// band, aircraft category, vessel type, flag, squawk) and lets the analyst
// click a bucket to "filter to" (keep only it) or "filter out" (hide it). The
// active filter is a flat list of AND-combined clauses; the adapter reads it
// through the PURE `matchesFilterClauses` evaluator below and de-emphasises any
// entity that fails — translucent, never removed (the SVG icon and upsert-by-id
// stay intact; see CLAUDE.md). The store holds ONLY UI state; the side effect
// (dimming Cesium billboards) lives in the adapter, not here.

// The facets the histogram buckets over. Each maps to a deterministic key the
// evaluator derives from a feature's properties (the same property shapes the
// ADS-B / AIS feeds emit). Kept as a string union so a clause is serialisable
// and cheap to compare.
export type FilterFacet =
  | 'altBucket' // altitude band id, e.g. 'fl000_100'
  | 'aircraftCategory' // airliner | private | helicopter | glider | military | emergency
  | 'vesselType' // cargo | tanker | fishing | passenger | military | sailing | pleasure | tug | sar | generic
  | 'flag' // ISO-ish country/flag code derived client-side (ICAO24 block / MMSI MID)
  | 'squawk'; // 4-digit Mode-A code (or an 'emergency' bucket)

// One filter clause. `mode:'only'` = an entity must match this value to pass;
// `mode:'not'` = an entity matching this value fails. Multiple clauses combine
// with AND, but clauses on the SAME facet in `only` mode combine with OR (so
// "only airliner OR military" is expressible by clicking two category bars).
export type FilterMode = 'only' | 'not';
export interface FilterClause {
  facet: FilterFacet;
  value: string;
  mode: FilterMode;
}

// The bucket id an entity falls into for a given facet, or null when the facet
// doesn't apply to that entity (e.g. `vesselType` on an aircraft). The adapter
// passes the entity's bucket ids in; keeping the derivation OUT of the store
// means the evaluator is pure and unit-testable with plain objects. `facetValue`
// returns the SET of values an entity carries for a facet (squawk can match both
// its literal code and the synthetic 'emergency' bucket), so callers should pass
// a resolver that returns string[] per facet.
export type FacetResolver = (facet: FilterFacet) => readonly string[];

// PURE predicate: does an entity (described by its per-facet values) satisfy the
// active clause list? Combination rules:
//   • `not` clauses: entity fails if it carries the clause value (hard exclude).
//   • `only` clauses: grouped by facet; within a facet the entity must carry at
//     least one of the requested values (OR); across facets every group with an
//     `only` clause must be satisfied (AND). A facet with no `only` clause is
//     unconstrained. An entity that doesn't apply to a constrained facet (empty
//     value set) fails that facet — a vessel can't satisfy "only airliner".
// No clauses → everything passes (returns true). Exported so the adapter and the
// panel share ONE definition of "matches".
export function matchesFilterClauses(
  clauses: readonly FilterClause[],
  resolve: FacetResolver,
): boolean {
  if (clauses.length === 0) return true;
  // Hard excludes first — cheapest rejection.
  for (const c of clauses) {
    if (c.mode !== 'not') continue;
    if (resolve(c.facet).includes(c.value)) return false;
  }
  // Group the `only` clauses by facet, then require each group be satisfied.
  const onlyByFacet = new Map<FilterFacet, Set<string>>();
  for (const c of clauses) {
    if (c.mode !== 'only') continue;
    const set = onlyByFacet.get(c.facet) ?? new Set<string>();
    set.add(c.value);
    onlyByFacet.set(c.facet, set);
  }
  for (const [facet, wanted] of onlyByFacet) {
    const have = resolve(facet);
    if (!have.some((v) => wanted.has(v))) return false;
  }
  return true;
}

interface FiltersState {
  clauses: readonly FilterClause[];
  // `epoch` bumps on every mutation. The adapter watches it (cheap integer
  // compare) to know a re-evaluation of already-rendered entities is due
  // WITHOUT subscribing to the array identity from a non-React module.
  epoch: number;
  // Toggle a clause: clicking the same facet+value+mode again removes it.
  // Adding an `only` and a `not` for the same facet+value is contradictory, so
  // setting one drops the opposite for that exact value.
  toggleClause: (facet: FilterFacet, value: string, mode: FilterMode) => void;
  // Remove one specific clause (the chip "✕").
  removeClause: (facet: FilterFacet, value: string, mode: FilterMode) => void;
  // Drop every clause for a facet (a column header "clear").
  clearFacet: (facet: FilterFacet) => void;
  // Drop everything.
  clear: () => void;
  // Convenience: is this exact clause active right now?
  isActive: (facet: FilterFacet, value: string, mode: FilterMode) => boolean;
}

function sameClause(a: FilterClause, facet: FilterFacet, value: string, mode: FilterMode): boolean {
  return a.facet === facet && a.value === value && a.mode === mode;
}

export const useFilters = create<FiltersState>((set, get) => ({
  clauses: [],
  epoch: 0,
  toggleClause: (facet, value, mode) =>
    set((s) => {
      const already = s.clauses.some((c) => sameClause(c, facet, value, mode));
      let next: FilterClause[];
      if (already) {
        // Clicking the active chip toggles it off.
        next = s.clauses.filter((c) => !sameClause(c, facet, value, mode));
      } else {
        // Drop the opposite mode for this exact facet+value (can't be both
        // "only X" and "not X"), then add the requested clause.
        const opposite: FilterMode = mode === 'only' ? 'not' : 'only';
        next = s.clauses.filter((c) => !sameClause(c, facet, value, opposite));
        next.push({ facet, value, mode });
      }
      return { clauses: next, epoch: s.epoch + 1 };
    }),
  removeClause: (facet, value, mode) =>
    set((s) => ({
      clauses: s.clauses.filter((c) => !sameClause(c, facet, value, mode)),
      epoch: s.epoch + 1,
    })),
  clearFacet: (facet) =>
    set((s) => ({ clauses: s.clauses.filter((c) => c.facet !== facet), epoch: s.epoch + 1 })),
  clear: () => set((s) => (s.clauses.length === 0 ? s : { clauses: [], epoch: s.epoch + 1 })),
  isActive: (facet, value, mode) => get().clauses.some((c) => sameClause(c, facet, value, mode)),
}));
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useFilters: typeof useFilters }).__useFilters = useFilters;
}
