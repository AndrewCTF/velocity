import { describe, it, expect } from 'vitest';
import { matchByFeatures, matchVesselClass, deriveFeatures, verifyAgainstAis, VESSEL_CLASSES } from './vesselClasses.js';

describe('feature-based vessel recognition', () => {
  it('loaded the full sourced catalog', () => {
    expect(VESSEL_CLASSES.length).toBeGreaterThanOrEqual(80);
    for (const c of VESSEL_CLASSES) {
      expect(c.lengthM).toBeGreaterThan(0);
      expect(c.recognition.length).toBeGreaterThan(0);
      expect(c.sources.length).toBeGreaterThan(0);
    }
  });

  it('deck AShM canister/silo launchers → a Russian missile combatant on top', () => {
    const m = matchByFeatures(['deck_ashm_launchers']);
    expect(m.length).toBeGreaterThan(0);
    expect(m.every((x) => x.cls.features.includes('deck_ashm_launchers'))).toBe(true);
    expect(m[0]?.cls.country).toBe('Russia');
  });

  it('tumblehome hull → Zumwalt is among the top (derived from sourced text)', () => {
    const m = matchByFeatures(['tumblehome']);
    expect(m[0]?.cls.features).toContain('tumblehome');
    expect(m.some((x) => x.cls.id === 'zumwalt-destroyer')).toBe(true);
  });

  it('trimaran → Independence LCS (unique cue)', () => {
    const m = matchByFeatures(['trimaran']);
    expect(m[0]?.cls.id).toBe('independence-lcs');
  });

  it('two islands → Queen Elizabeth carrier among matches', () => {
    const m = matchByFeatures(['twin_island']);
    expect(m.some((x) => x.cls.id === 'queen-elizabeth-carrier')).toBe(true);
  });

  it('catapult + angled deck → a carrier on top', () => {
    const m = matchByFeatures(['catapult', 'angled_flight_deck']);
    expect(m[0]?.cls.vesselType).toBe('carrier');
  });

  it('phased array + two main guns → Ticonderoga ranks above Arleigh Burke', () => {
    const m = matchByFeatures(['phased_array_panels', 'gun_dual_main', 'vls_large']);
    const tico = m.find((x) => x.cls.id === 'ticonderoga-cruiser');
    const burke = m.find((x) => x.cls.id === 'arleigh-burke-destroyer');
    expect((tico?.score ?? 0)).toBeGreaterThan(burke?.score ?? -1);
  });

  it('no observed features → empty (does not guess)', () => {
    expect(matchByFeatures([])).toEqual([]);
  });

  it('deriveFeatures pulls structured tags from sourced text', () => {
    const f = deriveFeatures({
      recognition: ['ski-jump ramp at the bow', 'full flight deck'],
      armament: '',
      vesselType: 'carrier',
    });
    expect(f).toContain('ski_jump');
    expect(f).toContain('full_flight_deck');
    const sub = deriveFeatures({ recognition: ['long hull, sail forward'], armament: 'torpedo tubes', vesselType: 'submarine' });
    expect(sub).toContain('submarine_sail');
  });

  it('length matcher still works as a weak fallback', () => {
    expect(matchVesselClass(180)[0]?.cls.id).toBe('type-055-destroyer');
  });
});

describe('AIS cross-verification', () => {
  const t055 = VESSEL_CLASSES.find((c) => c.id === 'type-055-destroyer')!; // 180 m

  it('confirms when AIS length agrees with the visual class', () => {
    expect(verifyAgainstAis(t055, 181).level).toBe('confirmed');
  });

  it('flags a mismatch when AIS length contradicts the visual class', () => {
    // a 180 m class reported as a 60 m AIS hull → spoof / mis-ID flag
    const v = verifyAgainstAis(t055, 60);
    expect(v.level).toBe('mismatch');
    expect(v.lenDeltaPct).toBeGreaterThan(18);
  });

  it('returns no_ais when there is no AIS length (dark contact)', () => {
    expect(verifyAgainstAis(t055, null).level).toBe('no_ais');
    expect(verifyAgainstAis(t055, 0).level).toBe('no_ais');
  });
});
