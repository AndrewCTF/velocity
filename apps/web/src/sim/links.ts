// Control-link + navigation model. A drone is only as good as its link: RF
// command links are range- and line-of-sight-limited and JAMMABLE; fiber-optic
// links are unjammable but tethered to ~20 km; one-way-attack munitions fly a
// preprogrammed INS/GPS profile with no live link (so nothing to jam — but GPS
// denial makes them drift). This is the layer the v1 sim was missing.

import type { EwEffect } from './ew.js';

export type LinkType = 'rf_los' | 'rf_satcom' | 'fiber' | 'autonomous' | 'manned';
export type NavMode = 'manual' | 'gps_ins' | 'ins_only';
export type LinkState = 'nominal' | 'degraded' | 'lost';
export type OnLinkLoss = 'rtl' | 'loiter' | 'crash' | 'continue_ins';

export interface LinkProfile {
  type: LinkType;
  label: string;
  /** command-link range (km); fiber = physical tether length */
  commsRangeKm: number;
  /** RF line-of-sight needed (terrain masks it); false for satcom/fiber/autonomous */
  losRequired: boolean;
  /** can a comms jammer cut it? fiber + autonomous = false */
  jammable: boolean;
  navMode: NavMode;
  /** GPS-dependent navigation → GNSS jamming forces INS drift */
  gpsDependent: boolean;
  onLinkLoss: OnLinkLoss;
  /** INS lateral drift rate (m per km flown) when GPS denied */
  insDriftMPerKm: number;
}

export const PROFILES: Record<string, LinkProfile> = {
  fpv_rf: {
    type: 'rf_los',
    label: 'FPV · RF command',
    commsRangeKm: 10,
    losRequired: true,
    jammable: true,
    navMode: 'manual',
    gpsDependent: false,
    onLinkLoss: 'crash', // manual pilot, no autonomy → falls when jammed
    insDriftMPerKm: 0,
  },
  fpv_fiber: {
    type: 'fiber',
    label: 'FPV · fiber-optic',
    commsRangeKm: 20, // spool length; unjammable
    losRequired: false,
    jammable: false,
    navMode: 'manual',
    gpsDependent: false,
    onLinkLoss: 'crash', // tether snapped / spooled out
    insDriftMPerKm: 0,
  },
  loiter_rf: {
    type: 'rf_los',
    label: 'Loitering · RF + INS fallback',
    commsRangeKm: 40,
    losRequired: true,
    jammable: true,
    navMode: 'gps_ins',
    gpsDependent: true,
    onLinkLoss: 'continue_ins', // autonomous terminal attack
    insDriftMPerKm: 8,
  },
  owa_ins: {
    type: 'autonomous',
    label: 'One-way attack · GPS/INS',
    commsRangeKm: 0, // preprogrammed; no live link to cut
    losRequired: false,
    jammable: false,
    navMode: 'gps_ins',
    gpsDependent: true,
    onLinkLoss: 'continue_ins',
    insDriftMPerKm: 12, // Shahed-class drift badly under GPS denial
  },
  male_satcom: {
    type: 'rf_satcom',
    label: 'MALE · satcom',
    commsRangeKm: 250,
    losRequired: false, // via satellite
    jammable: true, // harder, but modeled jammable
    navMode: 'gps_ins',
    gpsDependent: true,
    onLinkLoss: 'rtl', // returns to base on link loss
    insDriftMPerKm: 4,
  },
  manned: {
    type: 'manned',
    label: 'Manned',
    commsRangeKm: Infinity,
    losRequired: false,
    jammable: false,
    navMode: 'gps_ins',
    gpsDependent: false,
    onLinkLoss: 'continue_ins',
    insDriftMPerKm: 1,
  },
};

export type ProfileKey = keyof typeof PROFILES;

// Map a catalog system → its default link archetype.
export function linkProfileFor(systemId: string, category: string): LinkProfile {
  const id = systemId.toLowerCase();
  if (id.includes('fiber')) return PROFILES.fpv_fiber!;
  if (id.includes('fpv')) return PROFILES.fpv_rf!;
  if (id.includes('shahed') || id.includes('geran')) return PROFILES.owa_ins!;
  if (id.includes('lancet') || id.includes('switchblade') || id.includes('warmate') || id.includes('harop'))
    return PROFILES.loiter_rf!;
  if (category === 'fighter') return PROFILES.manned!;
  if (category === 'drone') return PROFILES.male_satcom!;
  if (category === 'loitering_munition') return PROFILES.owa_ins!;
  return PROFILES.fpv_rf!;
}

// Resolve the live link state from geometry + EW. `losClear` is the terrain
// line-of-sight from the control station to the drone (only meaningful for
// losRequired links). Returns the state plus whether GNSS is denied (drives
// INS drift even when comms are fine).
export function evaluateLink(
  p: LinkProfile,
  distToStationKm: number,
  losClear: boolean,
  ew: EwEffect,
): { state: LinkState; gnssDenied: boolean } {
  const gnssDenied = p.gpsDependent && ew.gnssDenied;

  // Autonomous / manned have no live command link to lose.
  if (p.type === 'autonomous' || p.type === 'manned') {
    return { state: gnssDenied ? 'degraded' : 'nominal', gnssDenied };
  }

  let commsOk = distToStationKm <= p.commsRangeKm;
  if (p.losRequired && !losClear) commsOk = false;
  if (p.jammable && ew.commsCut) commsOk = false;

  if (!commsOk) return { state: 'lost', gnssDenied };
  return { state: gnssDenied ? 'degraded' : 'nominal', gnssDenied };
}
