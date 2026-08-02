// panels.ts — the re-homing contract for the console rebuild.
//
// The old shell exposed 18 left-rail panels and 9 right-rail tabs as a flat
// list of unlabelled icons, plus 14 apps in a separate switcher. That is 27
// rail entries an operator had to learn by clicking, several of which were the
// same thing twice.
//
// The rebuild has FOUR named left panels, THREE right panels and one app
// launcher. Everything else is either merged into one of those, moved to the
// surface it actually belongs on, or deleted because another surface already
// did the job. This file records where each of the 27 went, so "nothing is
// missing" is a list that can be checked rather than a claim.
//
// Nothing here is deleted without a named replacement.

/** The 27 rail surfaces that existed BEFORE the rebuild, frozen.
 *
 *  The contract test used to read these out of App.tsx. That broke the moment
 *  the migration removed `rightTabs` from App.tsx — the guard lost the very
 *  list it was guarding. Freezing it here is the point: this is the record of
 *  what must not be lost, and it must not shrink as the migration proceeds. */
export const LEGACY_LEFT = [
  'layers', 'search-objects', 'feeds', 'ops', 'watch', 'annotate', 'inbox',
  'answers', 'imagery', 'chokepoints', 'acars', 'extract', 'countries',
  'allsources', 'filters', 'field', 'tasking', 'cop',
] as const;
export const LEGACY_RIGHT = [
  'selection', 'investigation', 'collab', 'filters', 'alerts', 'intel',
  'news', 'ground', 'field',
] as const;

export type Home =
  | { kind: 'panel'; panel: LeftPanelId | RightPanelId } // merged into a named panel
  | { kind: 'tool'; tool: string } // it was a map tool wearing a panel
  | { kind: 'app'; app: string } // it was an app wearing a panel
  | { kind: 'titlebar'; slot: string } // it belongs in the window chrome
  | { kind: 'redundant'; with: string }; // another surface already did this

export type LeftPanelId = 'layers' | 'find' | 'histogram' | 'info';
export type RightPanelId = 'selection' | 'series' | 'time';

export const LEFT_PANELS: ReadonlyArray<{ id: LeftPanelId; label: string; key: string }> = [
  { id: 'layers', label: 'Layers', key: '1' },
  { id: 'find', label: 'Find', key: '2' },
  { id: 'histogram', label: 'Histogram', key: '3' },
  { id: 'info', label: 'Info', key: '4' },
];

export const RIGHT_PANELS: ReadonlyArray<{ id: RightPanelId; label: string }> = [
  { id: 'selection', label: 'Selection' },
  { id: 'series', label: 'Series' },
  { id: 'time', label: 'Time selection' },
];

/** Every old rail id, and where it lives now. Exhaustive by construction: the
 *  test asserts this covers the old registries with nothing left over. */
export const REHOMED: Readonly<Record<string, Home>> = {
  // ── left rail, 18 ────────────────────────────────────────────────────────
  // The curated catalog and the raw registry rail were two views of ONE thing.
  // Operator: "some of them are even redundant like the landing layers tab".
  layers: { kind: 'panel', panel: 'layers' },
  allsources: { kind: 'redundant', with: 'Layers, which gains a curated/all toggle' },
  'search-objects': { kind: 'panel', panel: 'find' },
  filters: { kind: 'panel', panel: 'histogram' },
  // "What is the system doing" is one question, and it had four answers.
  feeds: { kind: 'panel', panel: 'info' },
  ops: { kind: 'panel', panel: 'info' },
  acars: { kind: 'panel', panel: 'info' },
  chokepoints: { kind: 'panel', panel: 'info' },
  // These were never panels. They are things you do TO the map.
  annotate: { kind: 'tool', tool: 'annotate' },
  watch: { kind: 'tool', tool: 'watchbox' },
  field: { kind: 'tool', tool: 'field' },
  // These were whole workflows squeezed into a 300px flyout.
  imagery: { kind: 'app', app: 'video' },
  extract: { kind: 'app', app: 'investigate' },
  tasking: { kind: 'app', app: 'decide' },
  // Already an app, twice over.
  countries: { kind: 'redundant', with: 'the Country app' },
  answers: { kind: 'redundant', with: 'the AI app' },
  cop: { kind: 'redundant', with: 'the COP workspace mode' },
  inbox: { kind: 'titlebar', slot: 'inbox' },

  // ── right rail, 9 ────────────────────────────────────────────────────────
  selection: { kind: 'panel', panel: 'selection' },
  intel: { kind: 'panel', panel: 'selection' }, // a section of the dossier
  investigation: { kind: 'redundant', with: 'the Graph app' },
  news: { kind: 'redundant', with: 'Reports, which already has a News tab' },
  ground: { kind: 'redundant', with: 'Video, which already has a Ground recon tab' },
  collab: { kind: 'titlebar', slot: 'share' },
  alerts: { kind: 'titlebar', slot: 'alerts' },
  // `filters` and `field` appear in BOTH rails in the old shell; the left-rail
  // entries above are their single home now.
};

/** Panels that keep a dedicated surface, for the coverage test to assert
 *  against the old registries. */
export const KEPT = new Set<string>([
  ...LEFT_PANELS.map((p) => p.id),
  ...RIGHT_PANELS.map((p) => p.id),
]);

/** Human-readable destination, for the coverage test's failure message and for
 *  the Info panel's "where did it go" list. */
export function describeHome(id: string): string {
  const h = REHOMED[id];
  if (!h) return `${id} has no recorded home`;
  switch (h.kind) {
    case 'panel':
      return `${id} → the ${h.panel} panel`;
    case 'tool':
      return `${id} → the ${h.tool} map tool`;
    case 'app':
      return `${id} → the ${h.app} app`;
    case 'titlebar':
      return `${id} → the title bar (${h.slot})`;
    case 'redundant':
      return `${id} → removed, superseded by ${h.with}`;
  }
}
