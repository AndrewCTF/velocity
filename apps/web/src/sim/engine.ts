// Pure simulation engine: Scenario → SimPlan. No Cesium, no wall-clock, no
// Math.random — deterministic given the scenario. For swarm/attack it lays out
// link-equipped drone AGENTS (initial conditions); the SimController runs the
// live dynamics (control-link state, EW, terrain, behaviours). Drone-landing
// still uses the simple static-fix path (no contested-link modelling needed).

import type {
  LatLon,
  Scenario,
  SimPlan,
  SwarmParams,
  LandingParams,
  AttackParams,
  UnitTrack,
  RouteLine,
  DefenseSite,
  AgentSpec,
} from './types.js';
import { getSystem } from './catalog.js';
import { resolveRaid, salvoForDefender, RENDER_AGENT_CAP } from './combat.js';
import { PROFILES, linkProfileFor, type LinkProfile } from './links.js';
import type { Jammer } from './ew.js';

const R_KM = 6371;
const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(s));
}

export function bearingDeg(a: LatLon, b: LatLon): number {
  const phi1 = rad(a.lat);
  const phi2 = rad(b.lat);
  const dl = rad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function destPoint(origin: LatLon, brgDeg: number, distKm: number): LatLon {
  const d = distKm / R_KM;
  const brg = rad(brgDeg);
  const lat1 = rad(origin.lat);
  const lon1 = rad(origin.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lon2 =
    lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lon: ((deg(lon2) + 540) % 360) - 180 };
}

// mulberry32 — tiny deterministic PRNG so dispersion is stable per scenario.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(p: SwarmParams): number {
  const n =
    p.count * 1000 +
    Math.round(p.launch.lat * 97) +
    Math.round(p.launch.lon * 89) +
    Math.round(p.target.lat * 71) +
    Math.round(p.target.lon * 53);
  return Math.abs(n) % 0xffffffff;
}

// Uniformly-distributed point within spreadKm of center (sqrt for disk uniformity).
function disperse(center: LatLon, spreadKm: number, rnd: () => number): LatLon {
  if (spreadKm <= 0) return center;
  const brg = rnd() * 360;
  const dist = Math.sqrt(rnd()) * spreadKm;
  return destPoint(center, brg, dist);
}

// Lay out a wave of drone agents: dispersed launch + impact points, staggered
// launch times, each carrying a control-link profile. The SimController runs the
// dynamics (link/EW/terrain) — the engine only sets initial conditions.
function buildAgents(
  launch: LatLon,
  target: LatLon,
  count: number,
  speedKph: number,
  cruiseAltM: number,
  profile: LinkProfile,
  spreadKm: number,
  seed: number,
  color: string,
  swarmId: string,
): { agents: AgentSpec[]; routes: RouteLine[]; durationSec: number } {
  // Render-only bound: draw at most RENDER_AGENT_CAP real agents. The saturation
  // math (resolveRaid in buildAttack) runs on the caller's TRUE count, not n.
  const n = Math.max(1, Math.min(RENDER_AGENT_CAP, Math.floor(count)));
  const speedKphC = Math.max(40, speedKph);
  const speedMps = speedKphC / 3.6;
  const rnd = mulberry32(seed >>> 0);
  const refLegSec = (haversineKm(launch, target) / speedKphC) * 3600;
  const gap = n > 1 ? Math.min(120, refLegSec * 0.12) / (n - 1) : 0;
  const agents: AgentSpec[] = [];
  const routes: RouteLine[] = [];
  let maxEnd = 0;
  for (let i = 0; i < n; i++) {
    const from = disperse(launch, spreadKm, rnd);
    const to = disperse(target, spreadKm, rnd);
    const legSec = (haversineKm(from, to) / speedKphC) * 3600;
    const startDelaySec = i * gap;
    agents.push({
      id: `sim:agent:${i}`,
      label: `UAV ${String(i + 1).padStart(2, '0')}`,
      color,
      launch: from,
      target: to,
      speedMps,
      cruiseAltM,
      profile,
      startDelaySec,
      swarmId,
    });
    if (n <= 40) routes.push({ id: `sim:agent:${i}:route`, color, points: [from, to] });
    maxEnd = Math.max(maxEnd, startDelaySec + legSec);
  }
  if (n > 40) routes.push({ id: 'sim:corridor', color, points: [launch, target] });
  // Headroom past the nominal leg so RTL / loiter behaviours have time to play.
  const durationSec = Math.ceil(maxEnd * 1.6 + 10);
  return { agents, routes, durationSec };
}

function buildSwarm(p: SwarmParams, jammers: Jammer[], napOfEarth: boolean): SimPlan {
  const profile = PROFILES[p.linkKey ?? 'fpv_rf'] ?? PROFILES.fpv_rf!;
  const { agents, routes, durationSec } = buildAgents(
    p.launch,
    p.target,
    p.count,
    p.speedKph,
    p.altM,
    profile,
    p.spreadKm,
    seedFrom(p),
    '#ef4444',
    'sim:swarm:0',
  );
  // A swarm flying unopposed never gets engaged ("0 intercepted") and draws no
  // defensive ring. Place a notional point air-defence at the target so the raid
  // is a real engagement: the site engages up to its salvo cap, the rest leak
  // through (a 100-drone swarm saturates a single battery — the whole point).
  const defenses: DefenseSite[] = [
    {
      id: 'sim:swarm:def:0',
      name: 'Point air defence',
      lat: p.target.lat,
      lon: p.target.lon,
      rangeKm: 30,
      color: '#4d8dff',
      pk: 0.45,
    },
  ];
  return {
    scenario: 'drone-swarm',
    durationSec,
    units: [],
    routes,
    agents,
    defenses,
    jammers,
    station: p.launch,
    napOfEarth,
  };
}

function buildLanding(p: LandingParams): SimPlan {
  const speed = Math.max(20, p.speedKph);
  const legKm = haversineKm(p.start, p.pad);
  const legSec = (legKm / speed) * 3600;
  const brg = bearingDeg(p.start, p.pad);
  const flare = destPoint(p.start, brg, legKm * 0.6);
  const id = 'sim:landing:0';
  const color = '#2dd4bf';
  const units: UnitTrack[] = [
    {
      id,
      kind: 'drone',
      label: 'DRONE 01',
      color,
      fixes: [
        { tSec: 0, lat: p.start.lat, lon: p.start.lon, alt: p.startAltM },
        { tSec: legSec * 0.6, lat: flare.lat, lon: flare.lon, alt: p.startAltM * 0.3 },
        { tSec: legSec, lat: p.pad.lat, lon: p.pad.lon, alt: 0 },
      ],
    },
  ];
  const routes: RouteLine[] = [{ id: `${id}:route`, color, points: [p.start, p.pad] }];
  return { scenario: 'drone-landing', durationSec: Math.ceil(legSec), units, routes };
}

function cruiseAltFor(category: string): number {
  if (category === 'fighter') return 8000;
  if (category === 'drone') return 4000;
  return 1500; // loitering munition
}

// Lay the attacker strike force as link-equipped agents, place the defender's
// SAM sites + range rings, and size the impact footprint (nap-of-earth gives
// terrain cover). The SimController runs the live link/EW/terrain dynamics.
export function buildAttack(p: AttackParams, jammers: Jammer[], napOfEarth: boolean): SimPlan {
  const attacker = getSystem(p.attackerId);
  const defender = getSystem(p.defenderId);
  if (!attacker) throw new Error(`unknown attacker system: ${p.attackerId}`);
  if (!defender) throw new Error(`unknown defender system: ${p.defenderId}`);

  // TRUE attacker count drives the saturation math + impact sizing below;
  // buildAgents internally caps the RENDERED agents to RENDER_AGENT_CAP.
  const count = Math.max(1, Math.floor(p.attackerCount));
  const speed = Math.max(60, attacker.specs.speed_kph ?? 200);
  const alt = cruiseAltFor(attacker.category);
  const profile = linkProfileFor(attacker.id, attacker.category);
  const seed = (count * 131 + Math.round(p.target.lat * 53) + Math.round(p.target.lon * 31)) >>> 0;
  const { agents, routes, durationSec } = buildAgents(
    p.launch,
    p.target,
    count,
    speed,
    alt,
    profile,
    6,
    seed,
    '#ef4444',
    'sim:strike:0',
  );

  // Defence sites ringed around the target; the controller draws range rings.
  const drawRangeKm = Math.min(120, Math.max(8, defender.specs.range_km ?? 30));
  const sites = Math.max(1, Math.floor(p.defenderCount));
  const defenses: DefenseSite[] = [];
  for (let s = 0; s < sites; s++) {
    const a = (s / sites) * 360;
    const c = destPoint(p.target, a, sites > 1 ? drawRangeKm * 0.25 : 0);
    defenses.push({
      id: `sim:def:${s}`,
      name: defender.name,
      lat: c.lat,
      lon: c.lon,
      rangeKm: drawRangeKm,
      color: '#4d8dff',
      pk: defender.specs.pk_est ?? 0.6,
    });
  }

  // Impact estimate. Nap-of-earth flight buys terrain cover, lowering the
  // defender's effective kill probability (coverFactor) so more leak through.
  const cover = napOfEarth ? 0.7 : 1;
  const raid = resolveRaid(
    count,
    attacker.specs.pk_est ?? 0.6,
    [{ id: defender.id, name: defender.name, pk: defender.specs.pk_est ?? 0.6, count: sites, salvoPerSite: salvoForDefender(defender.id) }],
    cover,
  );
  const severity = Math.min(1, raid.leakers / count + 0.15);
  const impact = {
    lat: p.target.lat,
    lon: p.target.lon,
    radiusKm: Math.min(40, 2 + raid.leakers * 0.6),
    severity,
  };

  return {
    scenario: 'attack',
    durationSec,
    units: [],
    routes,
    defenses,
    impact,
    agents,
    jammers,
    station: p.launch,
    napOfEarth,
  };
}

export function buildPlan(scenario: Scenario): SimPlan {
  const jammers = scenario.jammers ?? [];
  const noe = scenario.napOfEarth ?? false;
  if (scenario.kind === 'drone-swarm') {
    if (!scenario.swarm) throw new Error('drone-swarm scenario missing swarm params');
    return buildSwarm(scenario.swarm, jammers, noe);
  }
  if (scenario.kind === 'drone-landing') {
    if (!scenario.landing) throw new Error('drone-landing scenario missing landing params');
    return buildLanding(scenario.landing);
  }
  if (scenario.kind === 'attack') {
    if (!scenario.attack) throw new Error('attack scenario missing attack params');
    return buildAttack(scenario.attack, jammers, noe);
  }
  throw new Error(`unknown scenario kind: ${(scenario as { kind: string }).kind}`);
}

// Linear interpolation of a static-fix unit's position at sim-second t (used by
// drone-landing). Holds the first/last fix outside the track's time span.
export function sampleUnit(
  fixes: { tSec: number; lat: number; lon: number; alt: number }[],
  t: number,
): { lat: number; lon: number; alt: number; brg: number } {
  if (fixes.length === 0) return { lat: 0, lon: 0, alt: 0, brg: 0 };
  const first = fixes[0]!;
  const last = fixes[fixes.length - 1]!;
  if (t <= first.tSec) {
    const nxt = fixes[1] ?? first;
    return { lat: first.lat, lon: first.lon, alt: first.alt, brg: bearingDeg(first, nxt) };
  }
  if (t >= last.tSec) {
    const prv = fixes[fixes.length - 2] ?? last;
    return { lat: last.lat, lon: last.lon, alt: last.alt, brg: bearingDeg(prv, last) };
  }
  for (let i = 0; i < fixes.length - 1; i++) {
    const a = fixes[i]!;
    const b = fixes[i + 1]!;
    if (t >= a.tSec && t <= b.tSec) {
      const f = b.tSec === a.tSec ? 0 : (t - a.tSec) / (b.tSec - a.tSec);
      return {
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        alt: a.alt + (b.alt - a.alt) * f,
        brg: bearingDeg(a, b),
      };
    }
  }
  return { lat: last.lat, lon: last.lon, alt: last.alt, brg: 0 };
}
