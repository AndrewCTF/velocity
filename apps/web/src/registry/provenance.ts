// Provenance tiers — docs/plan-99-2026-08.md §0.
//
// Every OSINT globe on the market fuses ADS-B, AIS and a news firehose and
// presents the three as peers. Two of them are machines reporting themselves
// and the third is somebody's assertion, and once they share a list the whole
// surface inherits the credibility of the weakest source. This is the fix: the
// tier is a property of the source, it is stated everywhere the data appears,
// and `claim` is never the reason anything is on the map.
//
// The tier answers one question: WHO SAID SO, and were they in a position to
// be wrong about it?

export type Tier = 'sensor' | 'registry' | 'filing' | 'claim';

export const TIER_ORDER: readonly Tier[] = ['sensor', 'registry', 'filing', 'claim'];

export const TIER_META: Readonly<
  Record<Tier, { label: string; short: string; blurb: string }>
> = {
  sensor: {
    label: 'Sensor',
    short: 'T0',
    blurb:
      'A machine emitted it. Transponders, AIS, seismometers, magnetometers, SAR, grid telemetry. Wrong only by malfunction or deliberate spoof, and both of those are themselves signal.',
  },
  registry: {
    label: 'Registry',
    short: 'T1',
    blurb:
      'An authority maintains it as a register of record. Aircraft and vessel registries, sanctions lists, orbital catalogues, infrastructure inventories. Goes stale, rarely goes false.',
  },
  filing: {
    label: 'Filing',
    short: 'T2',
    blurb:
      'Somebody was compelled to disclose it. NOTAMs, official warnings, tenders and awards, securities filings, customs records. Adversarially shaded, but on the record and dated.',
  },
  claim: {
    label: 'Claim',
    short: 'T3',
    blurb:
      'A human asserted it. News, social, coded event datasets built from media reporting. Off by default. It corroborates an observation, it never sources one.',
  },
};

// Keyed by layer id rather than written into each of the 55 descriptors: the
// tier is an editorial judgement about a source and belongs in one reviewable
// list, not scattered across a 1000-line literal. `provenance.test.ts` fails if
// a registered layer is missing here or an entry here names no layer.
export const LAYER_TIERS: Readonly<Record<string, Tier>> = {
  // ── sensor ───────────────────────────────────────────────────────────────
  'hazards.usgs.quakes': 'sensor',
  'hazards.emsc.quakes': 'sensor',
  'hazards.nasa.firms': 'sensor',
  'aviation.adsb.global': 'sensor',
  'aviation.adsb.fi.global': 'sensor',
  'aviation.opensky.states': 'sensor',
  'aviation.adsb.live.mil': 'sensor',
  'aviation.adsb.live.emergencies': 'sensor',
  'env.jamming.nacp': 'sensor',
  'maritime.digitraffic': 'sensor',
  'maritime.keyless': 'sensor',
  'maritime.parked': 'sensor',
  'maritime.aisstream': 'sensor',
  'maritime.sar.hormuz': 'sensor',
  'maritime.sar.bab-el-mandeb': 'sensor',
  'maritime.sar.gulf-of-aden': 'sensor',
  'maritime.sar.suez-gulf-approach': 'sensor',
  'maritime.sar.kerch-strait': 'sensor',
  'maritime.sar.taiwan-strait': 'sensor',
  'cyber.ioda.outages': 'sensor',
  // A country coming off the internet is route collectors observing what other
  // machines stopped announcing. It is normally reported as news, and the news
  // is a claim ABOUT this.
  'cyber.routing.national': 'sensor',
  'infra.cams.public': 'sensor',
  'hazards.fireperimeters': 'sensor',
  'hazards.radiation': 'sensor',
  'climate.anomalies': 'sensor',
  'env.airquality': 'sensor',
  'maritime.buoys': 'sensor',
  'weather.spacewx.aurora': 'sensor',
  'oceans.surge': 'sensor',
  // Fused warnings: GPS jamming, dark vessels, AIS gaps, emergency squawks.
  // Every input is a transponder or a radar image, so the fusion inherits the
  // tier of what it fuses. Derivation does not demote.
  'intel.incidents.live': 'sensor',
  // Privacy-filtered airframes are still transponder returns. The filtering is
  // an operator request applied downstream; the emission is the same machine.
  'aviation.adsb.ladd': 'sensor',
  'aviation.adsb.pia': 'sensor',
  // DeepState's fire and radiation overlays are VIIRS and dosimeters carrying a
  // war-relevant filter. The filter chooses what to show, not what happened.
  'conflict.deepstate.fires': 'sensor',
  'conflict.deepstate.radiation': 'sensor',
  // Amateur ground segment: a received pass and a sonde's own beacon.
  'space.satnogs.observations': 'sensor',
  'env.sondes': 'sensor',

  // ── registry ─────────────────────────────────────────────────────────────
  // TLE sets are derived from radar tracking but are PUBLISHED as a catalogue
  // and consumed as one. The catalogue is what we read, so registry it is.
  'space.celestrak.stations': 'registry',
  'space.celestrak.starlink': 'registry',
  'space.celestrak.gps': 'registry',
  'space.celestrak.visual': 'registry',
  'hazards.nasa.eonet': 'registry',
  'infra.cables.lines': 'registry',
  'infra.cables.landings': 'registry',
  'places.airports': 'registry',
  'places.ports': 'registry',
  'places.bases': 'registry',
  'military.installations': 'registry',
  'maritime.chokepoints': 'registry',
  'infra.powerplants': 'registry',
  'intel.sanctions.vessels': 'registry',
  'intel.sanctions.aircraft': 'registry',
  'infra.power': 'registry',
  'infra.nuclear': 'registry',
  'infra.water': 'registry',
  'infra.desalination': 'registry',
  'infra.datacenters': 'registry',
  'infra.telecom': 'registry',
  'infra.ground_stations': 'registry',
  'infra.telescopes': 'registry',
  'infra.launch': 'registry',
  // A launch manifest is an operator's declared schedule, not an observation of
  // a rocket. It becomes sensor data the moment CelesTrak catalogues the object.
  'space.launches': 'registry',
  // Volunteers register a receiver's location and hardware; the list is a
  // roster of stations, not a reading from any of them.
  'space.satnogs.stations': 'registry',
  'rf.kiwisdr': 'registry',
  'infra.mines': 'registry',
  'aviation.airports.full': 'registry',
  'aviation.airports.openflights': 'registry',
  'osm.military': 'registry',

  // ── filing ───────────────────────────────────────────────────────────────
  'hazards.nws.alerts': 'filing',
  'airspace.tfr': 'filing',
  'airspace.nasstatus': 'filing',
  'aviation.sigmet': 'filing',
  'maritime.warnings': 'filing',
  'hazards.gdacs': 'filing',
  'hazards.cyclones': 'filing',
  'hazards.volcanoes': 'filing',
  // An air-raid alert is a civil-defense authority ordering a population to
  // shelter. Both relays report the same official state.
  'alerts.ukraine': 'filing',
  'alerts.ukraine.alt': 'filing',
  'alerts.fema': 'filing',
  // A storm report is a spotter's account that NOAA logs and stands behind.
  'hazards.spc.storms': 'filing',

  // ── claim ────────────────────────────────────────────────────────────────
  // ACLED and UCDP are research-grade and academically coded, and their input
  // is still media reporting. Coding a claim carefully does not turn it into an
  // observation, and pretending otherwise is the exact laundering this tier
  // exists to stop.
  'news.gdelt.events': 'claim',
  'news.acled.events': 'claim',
  'conflict.gdelt.live': 'claim',
  'conflict.ucdp': 'claim',
  'hazards.reliefweb': 'claim',
  // Notional COP tracks: nothing reported this, we drew it.
  'mil.cop.notional': 'claim',
  // DeepState's written reports, and a crowd-edited gazetteer anyone can label.
  'conflict.deepstate.news': 'claim',
  'osm.wikimapia': 'claim',
};

export function tierOf(layerId: string): Tier | undefined {
  return LAYER_TIERS[layerId];
}
