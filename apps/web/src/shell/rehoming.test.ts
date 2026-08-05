import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REHOMED } from './panels.js';

// "Nothing is missing" as a check on the CODE, not on a record of intent.
//
// `panels.test.ts` asserts every old rail id has a recorded destination. It
// passed the whole time seven of those destinations were empty: `App.tsx` builds
// all 18 rail items, `byHome` keeps only the `kind: 'panel'` ones, and every
// other entry — the map tools, the app re-homings, the "redundant with X" ones —
// was constructed and dropped on the floor. So the annotation editor, the
// watchbox rules, the field kit, the satellite-chip controls, the extractor, the
// national-source catalogue and the all-sources registry rail were all
// unreachable in the console while the contract test stayed green.
//
// A recorded home is only true once something is at the address. This test names
// the address.

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => readFileSync(resolve(HERE, '..', p), 'utf8');

/** Old rail id → the component that served it, and the file that must render
 *  it now. Both halves are load-bearing: the component name alone would pass on
 *  an import, and the file alone would not say what should be in it. */
const ADDRESS: Record<string, { component: string; file: string }> = {
  // ── kept as a named panel ────────────────────────────────────────────────
  layers: { component: 'LayersPanel', file: 'App.tsx' },
  'search-objects': { component: 'FindPanel', file: 'App.tsx' },
  feeds: { component: 'InfoPanel', file: 'App.tsx' },
  ops: { component: 'InfoPanel', file: 'App.tsx' },
  acars: { component: 'AcarsPanel', file: 'App.tsx' },
  chokepoints: { component: 'ChokepointsList', file: 'App.tsx' },
  // App.tsx imports shell/panels/HistogramPanel under the name FacetsPanel.
  filters: { component: 'FacetsPanel', file: 'App.tsx' },
  selection: { component: 'SelectionPanel', file: 'App.tsx' },

  // ── map tools: float over the map, opened from GlobeToolbar ──────────────
  annotate: { component: 'AnnotationPanel', file: 'shell/panels/MapToolPanels.tsx' },
  watch: { component: 'WatchboxPanel', file: 'shell/panels/MapToolPanels.tsx' },
  field: { component: 'FieldPanel', file: 'shell/panels/MapToolPanels.tsx' },

  // ── folded into an app ───────────────────────────────────────────────────
  imagery: { component: 'ImageryControl', file: 'fmv/VideoApp.tsx' },
  extract: { component: 'ExtractPanel', file: 'shell/AppSurface.tsx' },
  tasking: { component: 'TaskingPanel', file: 'App.tsx' },

  // ── recorded "redundant with X": X must actually carry it ────────────────
  allsources: { component: 'LayerRail', file: 'shell/panels/LayersPanel.tsx' },
  countries: { component: 'CountriesPanel', file: 'shell/AppSurface.tsx' },
  answers: { component: 'AnswersCard', file: 'ai/AiHubApp.tsx' },
  cop: { component: 'CopEditor', file: 'App.tsx' },
  // These five used to be listed here AND mounted a second time in App.tsx's
  // `pending` parking lot. The parking lot is gone, so the address below is now
  // the only place each renders — which is what this test was always claiming.
  investigation: { component: 'InvestigationCanvas', file: 'shell/AppSurface.tsx' },
  news: { component: 'NewsPanel', file: 'reports/ReportsApp.tsx' },
  ground: { component: 'GroundReconPanel', file: 'fmv/VideoApp.tsx' },

  // ── window chrome ────────────────────────────────────────────────────────
  inbox: { component: 'InboxPanel', file: 'App.tsx' },
  alerts: { component: 'AlertsPanel', file: 'App.tsx' },
  collab: { component: 'CollabPanel', file: 'reports/ReportsApp.tsx' },
  // Info, not the dossier. IntelPanel takes no selection, so the recorded
  // "section of the dossier" home could never be filled and it fell through to
  // More. It is a railItem now, so byHome puts it in Info with the other
  // what-is-happening surfaces. See panels.ts.
  intel: { component: 'IntelPanel', file: 'App.tsx' },
};

describe('re-homed surfaces are actually rendered', () => {
  it('has an address for every recorded home', () => {
    const missing = Object.keys(REHOMED).filter((id) => !ADDRESS[id]);
    expect(missing, `recorded homes with no address in this test: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(Object.entries(ADDRESS))('renders %s', (id, { component, file }) => {
    const text = src(file);
    // `<Component ` or `<Component/` or `<Component>` — an import or a bare
    // mention is not a render, and being constructed inside `railItems` is not
    // one either unless the file that renders it is the one named above.
    const rendered = new RegExp(`<${component}[\\s/>]`).test(text);
    expect(rendered, `${id}: ${file} does not render <${component}>`).toBe(true);
  });

  // `ops` folded TWO sections into Info: AOI watch and the standing-detection
  // rollup. The first rebuild carried over only the first, and the address check
  // above cannot see that, because <InfoPanel> was rendered either way. A
  // merged home has to be checked section by section.
  // The parking lot let a surface be "reachable" without being at its address,
  // which is the failure this whole file exists to catch, one level along: five
  // of its six entries were a second copy of something already homed, and the
  // sixth (Intel) was the only thing keeping its own address honest.
  it('mounts each re-homed surface once, not also in a parking lot', () => {
    const app = src('App.tsx');
    for (const dup of ['InvestigationCanvas', 'CollabPanel', 'NewsPanel', 'GroundReconPanel', 'AlertsRailList']) {
      expect(
        new RegExp(`<${dup}[\\s/>]`).test(app),
        `${dup} is rendered by App.tsx as well as at its recorded address`,
      ).toBe(false);
    }
  });

  it('Intel lands in Info, the panel that answers what is happening', () => {
    const app = src('App.tsx');
    expect(app).toMatch(/id: 'intel'[^\n]*<IntelPanel/);
  });

  it('keeps both halves of the old Ops panel in Info', () => {
    const info = src('shell/panels/InfoPanel.tsx');
    expect(info).toContain('AOI watch');
    expect(info).toContain('Standing detections');
    expect(info, 'the standing rollup is a LEVEL poll, not the edge-triggered alert buffer').toContain(
      '/api/alerts/standing',
    );
  });
});
