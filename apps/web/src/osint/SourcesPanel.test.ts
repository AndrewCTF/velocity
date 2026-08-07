import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLayers } from '../registry/defaults.js';

// The mega-ledger wave (2026-08-06) added ~40 backend routes. A route reaches
// the operator one of two ways: it carries coordinates and is a registered map
// layer, or it answers a question and is a row in this panel. A route that is
// in neither list is a feature nobody can find, which is the exact failure this
// guard exists to catch — the previous wave shipped `groundstop` backend-only
// and it stayed invisible for three weeks.
const PANEL_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'SourcesPanel.tsx'),
  'utf8',
);

/** Every non-geo route the wave added. Keep in step with the route files. */
const LOOKUP_ROUTES = [
  '/api/cyber/kev',
  '/api/cyber/shodan/{ip}',
  '/api/legal/gleif',
  '/api/legal/courtlistener',
  '/api/displacement/unhcr',
  '/api/population/worldpop',
  '/api/humanitarian/hdx',
  '/api/news/telegram',
  '/api/events/gdelt-doc',
  '/api/events/gdelt-summary',
  '/api/adsb/hex/{icao}',
  '/api/adsb/registration/{reg}',
  '/api/adsb/callsign/{cs}',
  '/api/adsb/type/{type_code}',
  '/api/adsb/history/dates',
  '/api/aviation/routes',
  '/api/adsb/fr24/search',
  '/api/space/satnogs/transmitters',
  '/api/space/tinygs',
  '/api/imagery/wayback',
  '/api/buildings/microsoft',
  '/api/buildings/overture',
  '/api/splats/search',
  '/api/splats/huggingface',
  '/api/jamming/gpsjam-manifest',
  '/api/cams/insecam',
  '/api/sources/catalog',
];

/** Every geo route the wave added, and the layer that has to carry it. */
const LAYER_ROUTES: ReadonlyArray<[string, string]> = [
  ['/api/alerts/ukraine', 'alerts.ukraine'],
  ['/api/alerts/ukraine-alt', 'alerts.ukraine.alt'],
  ['/api/alerts/meteoalarm', 'alerts.meteoalarm'],
  ['/api/alerts/fema', 'alerts.fema'],
  ['/api/alerts/spc-storms', 'hazards.spc.storms'],
  ['/api/conflict/deepstate-firms', 'conflict.deepstate.fires'],
  ['/api/conflict/deepstate-radiation', 'conflict.deepstate.radiation'],
  ['/api/conflict/deepstate-news', 'conflict.deepstate.news'],
  ['/api/space/satnogs/observations', 'space.satnogs.observations'],
  ['/api/space/satnogs/stations', 'space.satnogs.stations'],
  ['/api/space/sondes', 'env.sondes'],
  ['/api/sdr/kiwisdr', 'rf.kiwisdr'],
  ['/api/infra/mines', 'infra.mines'],
  ['/api/osm/military', 'osm.military'],
  ['/api/osm/wikimapia', 'osm.wikimapia'],
  ['/api/adsb/ladd', 'aviation.adsb.ladd'],
  ['/api/adsb/pia', 'aviation.adsb.pia'],
  ['/api/aviation/airports/full', 'aviation.airports.full'],
  ['/api/aviation/airports/openflights', 'aviation.airports.openflights'],
];

describe('mega-ledger routes are reachable from the UI', () => {
  it('every non-geo route is a row in the Sources panel', () => {
    const missing = LOOKUP_ROUTES.filter((r) => !PANEL_SRC.includes(r));
    expect(missing, 'backend routes with no UI address').toEqual([]);
  });

  it('every geo route is a registered layer on the stated endpoint', () => {
    for (const [route, id] of LAYER_ROUTES) {
      const d = defaultLayers.find((l) => l.id === id);
      expect(d, id).toBeDefined();
      expect(d?.endpoint.split('?')[0], id).toBe(route);
    }
  });
});
