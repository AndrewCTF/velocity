// Military vessel recognition catalog — naval CLASSES identified from DETAILED
// overhead imagery by their visible WEAPONS / SENSOR FIT, not by length (length is
// a weak, unreliable cue). The analyst marks the features they can see in the chip
// (VLS bank layout, deck AShM launchers, gun count, phased-array panels, ski-jump
// vs catapult, tumblehome hull, sub sail …) and the matcher ranks candidate classes
// by weighted feature overlap. Length is only a tiebreak.
//
// Every figure is an OPEN-SOURCE estimate (Wikipedia / naval-technology / CSIS),
// rendered as an analytic suggestion — a shortlist, never a positive ID. There is
// no CV auto-detector wired; the operator supplies the observed features.

import { RAW_VESSEL_CLASSES, type RawVesselClass } from './vesselClasses.data.js';

export type VesselType =
  | 'carrier'
  | 'cruiser'
  | 'destroyer'
  | 'frigate'
  | 'corvette'
  | 'amphibious'
  | 'submarine'
  | 'auxiliary'
  | 'patrol';

// Controlled vocabulary of features visible from detailed overhead imagery. Weight
// = how DISCRIMINATING the feature is (a deck-mounted AShM bank or twin carrier
// islands narrows hard; a helo deck barely narrows at all).
export type FeatureTag =
  // platform / deck
  | 'ski_jump'
  | 'catapult'
  | 'angled_flight_deck'
  | 'full_flight_deck'
  | 'twin_island'
  | 'well_deck'
  | 'tumblehome'
  | 'submarine_sail'
  | 'trimaran'
  | 'flush_deck'
  | 'helo_deck'
  // weapons
  | 'deck_ashm_launchers'
  | 'vls_forward'
  | 'vls_aft'
  | 'vls_large'
  | 'vls_medium'
  | 'gun_dual_main'
  | 'gun_large'
  | 'ciws_multiple'
  | 'torpedo_tubes'
  // sensors / superstructure
  | 'phased_array_panels'
  | 'integrated_mast'
  | 'pyramidal_superstructure'
  | 'single_funnel'
  | 'twin_funnel';

interface FeatureDef {
  label: string;
  group: 'Platform / deck' | 'Weapons' | 'Sensors / superstructure';
  weight: number;
}

export const FEATURE_DEFS: Record<FeatureTag, FeatureDef> = {
  ski_jump: { label: 'Ski-jump bow ramp', group: 'Platform / deck', weight: 3 },
  catapult: { label: 'Catapults (CATOBAR)', group: 'Platform / deck', weight: 3 },
  angled_flight_deck: { label: 'Angled flight deck', group: 'Platform / deck', weight: 2 },
  full_flight_deck: { label: 'Full-length flight deck', group: 'Platform / deck', weight: 2 },
  twin_island: { label: 'Two islands', group: 'Platform / deck', weight: 3 },
  well_deck: { label: 'Stern well deck', group: 'Platform / deck', weight: 2 },
  tumblehome: { label: 'Tumblehome hull', group: 'Platform / deck', weight: 3 },
  submarine_sail: { label: 'Submarine sail/hull', group: 'Platform / deck', weight: 3 },
  trimaran: { label: 'Trimaran hull', group: 'Platform / deck', weight: 3 },
  flush_deck: { label: 'Flush clean deck', group: 'Platform / deck', weight: 1 },
  helo_deck: { label: 'Helicopter deck', group: 'Platform / deck', weight: 1 },
  deck_ashm_launchers: { label: 'Deck AShM canister/box launchers', group: 'Weapons', weight: 3 },
  vls_forward: { label: 'VLS bank forward', group: 'Weapons', weight: 1 },
  vls_aft: { label: 'VLS bank aft', group: 'Weapons', weight: 1 },
  vls_large: { label: 'Large VLS (≥96 cells)', group: 'Weapons', weight: 2 },
  vls_medium: { label: 'Medium VLS (32–64)', group: 'Weapons', weight: 1 },
  gun_dual_main: { label: 'Two main guns', group: 'Weapons', weight: 2 },
  gun_large: { label: 'Large main gun (≥100 mm)', group: 'Weapons', weight: 1 },
  ciws_multiple: { label: 'Multiple CIWS mounts', group: 'Weapons', weight: 1 },
  torpedo_tubes: { label: 'Deck torpedo tubes', group: 'Weapons', weight: 1 },
  phased_array_panels: { label: 'Flat phased-array radar panels', group: 'Sensors / superstructure', weight: 2 },
  integrated_mast: { label: 'Enclosed/integrated mast', group: 'Sensors / superstructure', weight: 2 },
  pyramidal_superstructure: { label: 'Large pyramidal superstructure', group: 'Sensors / superstructure', weight: 2 },
  single_funnel: { label: 'Single funnel', group: 'Sensors / superstructure', weight: 1 },
  twin_funnel: { label: 'Twin funnels', group: 'Sensors / superstructure', weight: 1 },
};

export interface VesselClass {
  id: string;
  name: string;
  country: string;
  vesselType: VesselType;
  lengthM: number;
  beamM?: number;
  displacementT?: number; // full load (submerged for subs)
  hull?: string; // hull/pennant series and/or NATO reporting name
  features: FeatureTag[]; // distinctive, overhead-visible weapon/sensor/deck fit
  recognition: string[]; // human-readable cues (sourced)
  role: string;
  armament?: string;
  sources: string[];
}

// Derive feature tags from the sourced recognition cues + armament text + type, so
// agent-delivered classes get structured features without hand-tagging each. Keyword
// rules over the open-source text — conservative (only tags it can justify).
export function deriveFeatures(cls: Pick<VesselClass, 'recognition' | 'armament' | 'vesselType'>): FeatureTag[] {
  const t = (cls.recognition.join(' ') + ' ' + (cls.armament ?? '')).toLowerCase();
  const f = new Set<FeatureTag>();
  const has = (...ks: string[]): boolean => ks.some((k) => t.includes(k));
  // Negation-guarded: "NO ski-jump (CATOBAR)" / "STOVL, no catapults" must NOT tag
  // the feature they deny — the ski-jump vs catapult split is the key carrier cue.
  if (has('ski-jump', 'ski jump', 'ramp at the bow', 'bow ramp') && !has('no ski-jump', 'no ski jump', 'without ski')) f.add('ski_jump');
  if (has('catapult', 'catobar', 'emals') && !has('no catapult', 'without catapult')) f.add('catapult');
  // full phrase only — avoids matching "without an angled deck" (e.g. QE-class).
  if (has('angled flight deck')) f.add('angled_flight_deck');
  if (has('full-length flight deck', 'full length flight deck', 'full flight deck', 'flat flight deck', 'through deck')) f.add('full_flight_deck');
  if (has('twin-island', 'twin island', 'two islands', 'two separate superstructure')) f.add('twin_island');
  if (has('well deck', 'well-deck', 'stern gate')) f.add('well_deck');
  if (has('tumblehome')) f.add('tumblehome');
  if (cls.vesselType === 'submarine' || has('sail forward', 'sail-mounted', 'sail amidships', 'conning tower', 'ssn hull', 'teardrop')) f.add('submarine_sail');
  if (has('trimaran')) f.add('trimaran');
  if (has('flush deck', 'flush-decked', 'flush clean deck', 'clean deck', 'clean uncluttered')) f.add('flush_deck');
  if (has('helo deck', 'helicopter deck', 'flight deck aft', 'hangar + flight deck', 'hangar aft', 'helo hangar', 'helicopter hangar', 'flight deck for')) f.add('helo_deck');
  // Soviet/Russian BIG deck-mounted AShM batteries — the distinctive cue. Western
  // Harpoon/Exocet canisters are common + low value, so NOT tagged here.
  if (has('p-500', 'p-700', 'p-1000', 'granit', 'vulkan', 'ss-n-', 'angled along the deck', 'launchers angled along')) f.add('deck_ashm_launchers');
  const vlsCounts = [...t.matchAll(/(\d{2,3})\s*(?:-?\s*cell|\s*vls|\s*mk\s*41|\s*mk41|\s*sylver)/g)].map((m) => Number(m[1]));
  const vlsMax = vlsCounts.length ? Math.max(...vlsCounts) : 0;
  if (vlsMax >= 96) f.add('vls_large');
  else if (vlsMax >= 24) f.add('vls_medium');
  if (has('fore + aft', 'fore+aft', 'fore and aft', 'fore (', 'forward (')) f.add('vls_forward');
  if (has('fore + aft', 'fore+aft', 'fore and aft', '+ aft', 'aft (', 'and aft')) f.add('vls_aft');
  if (has('two 127', 'two 130', 'two 5in', '2x 127', '2x 130', 'two 76mm guns', 'two 76 mm guns', 'two main gun')) f.add('gun_dual_main');
  if (has('127mm', '127 mm', '130mm', '130 mm', '125mm', '5in', '4.5in', '100mm', '100 mm', '152mm', '152 mm', '155mm', '155 mm')) f.add('gun_large');
  if (has('2x ciws', '2x phalanx', '3x ciws', 'multiple ciws', '2x type 730', '3x type 1130')) f.add('ciws_multiple');
  if (has('torpedo tube', 'deck torpedo')) f.add('torpedo_tubes');
  // Flat AESA/phased panels. Ball (SAMPSON) and dome (SMART-L) radars are NOT panels.
  if (has('phased array', 'phased-array', 'spy-1', 'spy-6', 'spy-1d', 'type 346', 'apar', 'aesa', 'sea fire', 'sampson')) {
    if (has('phased array', 'phased-array', 'spy-', 'type 346', 'apar', 'aesa', 'sea fire')) f.add('phased_array_panels');
  }
  if (has('integrated mast', 'enclosed mast', 'tower mast', 'advanced enclosed mast', 'aem/s', 'single large integrated', 'single enclosed')) f.add('integrated_mast');
  if (has('pyramidal', 'massive superstructure')) f.add('pyramidal_superstructure');
  if (has('twin funnel', 'two funnel', 'twin funnels')) f.add('twin_funnel');
  else if (has('single funnel', 'one funnel')) f.add('single_funnel');
  return [...f];
}

// Built from the sourced raw data: snake_case → VesselClass, with feature tags
// derived from each class's open-source recognition/armament text.
const _VALID_TYPES = new Set<VesselType>([
  'carrier', 'cruiser', 'destroyer', 'frigate', 'corvette', 'amphibious', 'submarine', 'auxiliary', 'patrol',
]);

function normalize(r: RawVesselClass): VesselClass {
  const vesselType = (_VALID_TYPES.has(r.vesselType as VesselType) ? r.vesselType : 'patrol') as VesselType;
  return {
    id: r.id,
    name: r.name,
    country: r.country,
    vesselType,
    lengthM: r.length_m,
    ...(r.beam_m != null ? { beamM: r.beam_m } : {}),
    ...(r.displacement_t != null ? { displacementT: r.displacement_t } : {}),
    ...(r.hull ? { hull: r.hull } : {}),
    features: deriveFeatures({ recognition: r.recognition, ...(r.armament ? { armament: r.armament } : {}), vesselType }),
    recognition: r.recognition,
    role: r.role,
    ...(r.armament ? { armament: r.armament } : {}),
    sources: r.sources,
  };
}

export const VESSEL_CLASSES: VesselClass[] = RAW_VESSEL_CLASSES.map(normalize);

// ── matchers ────────────────────────────────────────────────────────────────────

export interface ClassMatch {
  cls: VesselClass;
  matched: FeatureTag[]; // observed features this class has
  missing: FeatureTag[]; // class features the analyst did NOT mark
  score: number; // total weight of matched features (0 = no overlap)
  lenDeltaM?: number;
}

// PRIMARY matcher: rank classes by weighted overlap with the OBSERVED features.
// length (optional) is only a tiebreak among equal feature scores.
export function matchByFeatures(
  observed: FeatureTag[],
  opts: { lengthM?: number; max?: number } = {},
): ClassMatch[] {
  const { lengthM, max = 5 } = opts;
  const obs = new Set(observed);
  if (obs.size === 0) return [];
  return VESSEL_CLASSES.map((cls): ClassMatch => {
    const matched = cls.features.filter((f) => obs.has(f));
    const missing = cls.features.filter((f) => !obs.has(f));
    const score = matched.reduce((s, f) => s + FEATURE_DEFS[f].weight, 0);
    return { cls, matched, missing, score, ...(lengthM ? { lenDeltaM: Math.abs(cls.lengthM - lengthM) } : {}) };
  })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || (a.lenDeltaM ?? 0) - (b.lenDeltaM ?? 0))
    .slice(0, max);
}

// ── AIS cross-verification ────────────────────────────────────────────────────
// When the vessel is broadcasting AIS (esp. moored at a dock — a stable position
// to co-locate with imagery), AIS gives a GROUND-TRUTH length. Cross-check the
// visually-recognised class against it: lengths agree → confirmed; they disagree →
// a flag (possible AIS spoof, mis-ID, or a dark/decoy hull). Length is the robust
// AIS field (type is often generic/wrong on warships), so the verdict keys on it.

export type AisVerdictLevel = 'confirmed' | 'plausible' | 'mismatch' | 'no_ais';
export interface AisVerdict {
  level: AisVerdictLevel;
  lenDeltaPct: number | null; // |class − AIS| / AIS, %
  note: string;
}

export function verifyAgainstAis(cls: VesselClass, aisLengthM?: number | null): AisVerdict {
  if (!aisLengthM || aisLengthM <= 0) {
    return { level: 'no_ais', lenDeltaPct: null, note: 'no AIS length to verify against' };
  }
  const pct = Math.round((Math.abs(cls.lengthM - aisLengthM) / aisLengthM) * 100);
  if (pct <= 8) return { level: 'confirmed', lenDeltaPct: pct, note: `AIS length ${Math.round(aisLengthM)} m agrees (±${pct}%)` };
  if (pct <= 18) return { level: 'plausible', lenDeltaPct: pct, note: `AIS length ${Math.round(aisLengthM)} m close (±${pct}%)` };
  return { level: 'mismatch', lenDeltaPct: pct, note: `AIS length ${Math.round(aisLengthM)} m disagrees (±${pct}%) — possible spoof / mis-ID` };
}

// Weak SECONDARY matcher: length proximity only. Kept for the no-features case;
// the UI labels it as a coarse cue.
export function matchVesselClass(
  lengthM: number,
  opts: { max?: number; minScore?: number } = {},
): ClassMatch[] {
  if (!Number.isFinite(lengthM) || lengthM <= 0) return [];
  const { max = 4, minScore = 0.25 } = opts;
  return VESSEL_CLASSES.map((cls) => {
    const lenDeltaM = Math.abs(cls.lengthM - lengthM);
    const rel = lenDeltaM / lengthM;
    const score = Math.max(0, 1 - rel * 6);
    return { cls, matched: [], missing: cls.features, score, lenDeltaM };
  })
    .filter((m) => m.score >= minScore)
    .sort((a, b) => (a.lenDeltaM ?? 0) - (b.lenDeltaM ?? 0))
    .slice(0, max);
}
