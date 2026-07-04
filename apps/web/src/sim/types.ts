// Shared types for the browser-side simulation. The engine (engine.ts) is pure
// data → data: it turns a Scenario into a SimPlan (timed fixes per unit) that
// the SimController renders on Cesium. No Cesium types leak in here so the
// engine stays unit-testable.

import type { LinkProfile } from './links.js';
import type { Jammer } from './ew.js';

export interface LatLon {
  lat: number;
  lon: number;
}

export type ScenarioKind = 'drone-swarm' | 'drone-landing' | 'attack';

export interface SwarmParams {
  launch: LatLon;
  target: LatLon;
  count: number; // number of drones
  speedKph: number; // cruise speed
  altM: number; // cruise altitude (metres AGL/MSL, rendered as ellipsoid height)
  spreadKm: number; // lateral dispersion of launch + impact points
  linkKey?: string; // control-link archetype (PROFILES key); default fpv_rf
}

export interface LandingParams {
  start: LatLon; // approach fix
  pad: LatLon; // touchdown point
  startAltM: number; // altitude at the approach fix
  speedKph: number;
}

// Attacker strike force from the catalog vs a defender air-defence force. The
// engine lays the strike route (like a swarm) using the attacker's catalog
// speed/altitude; combat.ts resolves how many leak past the defence.
export interface AttackParams {
  attackerId: string; // catalog id (drone / loitering_munition / fighter)
  attackerCount: number;
  defenderId: string; // catalog id (sam)
  defenderCount: number;
  launch: LatLon;
  target: LatLon;
}

export interface Scenario {
  kind: ScenarioKind;
  swarm?: SwarmParams;
  landing?: LandingParams;
  attack?: AttackParams;
  /** EW environment applied to swarm/attack drones */
  jammers?: Jammer[];
  /** drones hug terrain (ground + AGL) instead of flying constant MSL */
  napOfEarth?: boolean;
}

// Initial state for one drone in the agent integrator (SimController runs the
// dynamics; the engine only lays out the start conditions).
export interface AgentSpec {
  id: string;
  label: string;
  color: string;
  launch: LatLon;
  target: LatLon;
  speedMps: number;
  cruiseAltM: number;
  profile: LinkProfile;
  startDelaySec: number;
  /**
   * Group id shared by every drone laid out from a single SwarmParams (or one
   * attacker strike force). The SimController buckets agents by this id to draw
   * a swarm roll-up entity + AOI circle, so the group stays visible even when
   * individual icons hit RENDER_AGENT_CAP. Undefined for ungrouped agents.
   */
  swarmId?: string;
}

// A defending air-defence site rendered with a range ring.
export interface DefenseSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  rangeKm: number;
  color: string;
  /** single-shot intercept probability (for the in-sim engagement roll) */
  pk?: number;
}

// A battle-damage footprint at the target, sized by leakers/severity.
export interface ImpactZone {
  lat: number;
  lon: number;
  radiusKm: number;
  severity: number; // 0..1
}

// One observed-style fix on a unit's timeline. tSec is seconds from sim start.
export interface UnitFix {
  tSec: number;
  lat: number;
  lon: number;
  alt: number; // metres
}

export type UnitKind = 'drone' | 'uav';

export interface UnitTrack {
  id: string; // sim:<scenario>:<n>
  kind: UnitKind;
  label: string;
  color: string; // css hex
  fixes: UnitFix[]; // chronological, >= 2 points
  /** true when the defence intercepts this unit; its track ends at the kill point. */
  intercepted?: boolean;
}

// A static planned path drawn as a faint polyline (the route the unit follows).
export interface RouteLine {
  id: string;
  color: string;
  points: LatLon[];
}

export interface SimPlan {
  scenario: ScenarioKind;
  durationSec: number; // wall length of the scenario at 1× sim speed
  units: UnitTrack[]; // static-fix units (landing); empty when agents drive motion
  routes: RouteLine[];
  defenses?: DefenseSite[];
  impact?: ImpactZone;
  // Agent-driven scenarios (swarm/attack): the integrator owns motion + link/EW.
  agents?: AgentSpec[];
  jammers?: Jammer[];
  station?: LatLon; // RF control station (= launch point)
  napOfEarth?: boolean;
}
