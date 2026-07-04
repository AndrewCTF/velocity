// Renders a SimPlan on Cesium and plays it on its OWN clock (decoupled from
// viewer.clock so live ADS-B/AIS interpolation is untouched). Two paths:
//   - agents (swarm/attack): a per-tick integrator that flies each drone and
//     reacts to its control link, EW jamming, terrain (nap-of-earth + LOS
//     masking) and air-defence engagement. This is the real model.
//   - units (landing): the simple static-fix glide.
// Sim entities live in a dedicated CustomDataSource with sim:* ids.

import * as Cesium from 'cesium';
import { icons } from '../globe/icons.js';
import { labelFor } from '../globe/adapters/labelStyle.js';
import { bearingDeg, destPoint, haversineKm, sampleUnit } from './engine.js';
import { evaluateLink, type LinkState } from './links.js';
import { ewAt, NO_EW } from './ew.js';
import { routeGroundProfile, profileAt, lineMasked } from './terrain.js';
import type { AgentSpec, LatLon, SimPlan } from './types.js';

export interface SimStats {
  airborne: number;
  struck: number;
  intercepted: number;
  linkLost: number;
  degraded: number;
}
export interface SimClock {
  simTime: number;
  duration: number;
  playing: boolean;
  stats?: SimStats;
}

type UpdateCb = (s: SimClock) => void;
type Fate = 'flying' | 'struck' | 'intercepted' | 'ew_lost';
type Mode = 'pre' | 'cruise' | 'rtl' | 'loiter' | 'crashed' | 'arrived';

const SALVO_PER_SITE = 4;
const NOE_AGL_M = 120; // nap-of-earth height above ground
const ARRIVE_KM = 0.4;

interface RtAgent {
  spec: AgentSpec;
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  mode: Mode;
  fate: Fate;
  link: LinkState;
  driftBiasDeg: number;
  loiterPhase: number;
  legKm: number;
  roll: number; // seeded 0..1 for the SAM engagement
  samChecked: boolean;
}

// Deterministic per-index roll (no Math.random — stable replays).
function rollFor(i: number): number {
  let t = (i + 1) * 0x9e3779b9;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export class SimController {
  private ds: Cesium.CustomDataSource;
  private plan: SimPlan | null = null;
  private simTime = 0;
  private playing = false;
  private speed = 20;
  private raf = 0;
  private lastMs = 0;
  private onUpdate: UpdateCb | null = null;
  private placeHandler: Cesium.ScreenSpaceEventHandler;
  private placeCb: ((p: LatLon) => void) | null = null;
  private disposed = false;

  private agents: RtAgent[] = [];
  private siteEngaged = new Map<string, number>();
  private groundProfile: number[] | null = null;
  // swarmId → indices into this.agents. One bucket per SwarmParams/strike force;
  // drives the per-swarm roll-up entity + AOI circle and swarmAoi().
  private swarms = new Map<string, number[]>();

  constructor(private readonly viewer: Cesium.Viewer) {
    this.ds = new Cesium.CustomDataSource('simulation');
    void viewer.dataSources.add(this.ds);
    this.placeHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    this.placeHandler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (!this.placeCb) return;
      const cart = viewer.camera.pickEllipsoid(e.position, viewer.scene.globe.ellipsoid);
      if (!cart) return;
      const c = Cesium.Cartographic.fromCartesian(cart);
      const p = { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
      const cb = this.placeCb;
      this.placeCb = null;
      cb(p);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  setUpdateListener(cb: UpdateCb | null): void {
    this.onUpdate = cb;
  }
  beginPlace(cb: (p: LatLon) => void): void {
    this.placeCb = cb;
  }
  cancelPlace(): void {
    this.placeCb = null;
  }
  get placing(): boolean {
    return this.placeCb != null;
  }
  // Resolve the armed one-shot from EXPLICIT lat/lon instead of a map click —
  // mirrors the LEFT_CLICK handler above (which builds
  // `{ lat, lon } = toDegrees(pickEllipsoid(...))` then consumes `placeCb`),
  // but skips the pick since the operator typed the coordinates. Same callback
  // path, so A / B / jammer set by `beginPlace()` fill programmatically. The
  // click path is untouched. Returns false when nothing is armed.
  placeAt(lat: number, lon: number): boolean {
    if (!this.placeCb) return false;
    const cb = this.placeCb;
    this.placeCb = null;
    cb({ lat, lon });
    return true;
  }

  load(plan: SimPlan): void {
    this.plan = plan;
    this.simTime = 0;
    this.pause();
    this.ds.entities.removeAll();
    this.agents = [];
    this.siteEngaged.clear();
    this.swarms.clear();
    this.groundProfile = null;

    this.drawRoutes(plan);
    this.drawDefenses(plan);
    this.drawJammers(plan);
    this.drawStation(plan);

    if (plan.agents && plan.agents.length > 0) {
      this.initAgents(plan);
      if (plan.napOfEarth || plan.agents.some((a) => a.profile.losRequired)) {
        void this.precomputeTerrain(plan);
      }
    } else {
      this.drawUnits(plan);
    }

    this.viewer.scene.requestRender();
    this.emit();
  }

  // ── static-fix units (landing) ───────────────────────────────────────────
  private drawUnits(plan: SimPlan): void {
    for (const unit of plan.units) {
      const color = Cesium.Color.fromCssColorString(unit.color);
      const position = new Cesium.CallbackPositionProperty(() => {
        const s = sampleUnit(unit.fixes, this.simTime);
        return Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.alt);
      }, false);
      const rotation = new Cesium.CallbackProperty(
        () => -Cesium.Math.toRadians(sampleUnit(unit.fixes, this.simTime).brg),
        false,
      );
      this.ds.entities.add({
        id: unit.id,
        position,
        billboard: {
          image: unit.kind === 'drone' ? icons.drone(unit.color) : icons.uav(unit.color),
          scale: 1.0,
          rotation,
          alignedAxis: Cesium.Cartesian3.ZERO,
          color,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60_000_000),
        },
        label: labelFor(unit.label),
        name: unit.label,
        properties: { kind: `sim-${unit.kind}`, sim: true },
      });
    }
  }

  // ── agent integrator (swarm / attack) ────────────────────────────────────
  private initAgents(plan: SimPlan): void {
    // A dense swarm labels every drone → an unreadable pile of overlapping text.
    // Above this count, swarm members carry NO per-drone label (the single swarm
    // summary label covers them); standalone units always keep their label.
    const dense = (plan.agents?.length ?? 0) > 24;
    plan.agents!.forEach((spec, i) => {
      const showLabel = !(spec.swarmId && dense);
      const rt: RtAgent = {
        spec,
        lat: spec.launch.lat,
        lon: spec.launch.lon,
        alt: 0,
        heading: bearingDeg(spec.launch, spec.target),
        mode: 'pre',
        fate: 'flying',
        link: 'nominal',
        driftBiasDeg: 0,
        loiterPhase: 0,
        legKm: Math.max(0.1, haversineKm(spec.launch, spec.target)),
        roll: rollFor(i),
        samChecked: false,
      };
      const idx = this.agents.push(rt) - 1;
      if (spec.swarmId) {
        const bucket = this.swarms.get(spec.swarmId);
        if (bucket) bucket.push(idx);
        else this.swarms.set(spec.swarmId, [idx]);
      }
      const color = new Cesium.CallbackProperty(() => this.agentColor(rt), false);
      const position = new Cesium.CallbackPositionProperty(
        () => Cesium.Cartesian3.fromDegrees(rt.lon, rt.lat, rt.alt),
        false,
      );
      const rotation = new Cesium.CallbackProperty(() => -Cesium.Math.toRadians(rt.heading), false);
      this.ds.entities.add({
        id: spec.id,
        position,
        billboard: {
          image: icons.uav('#ffffff'),
          scale: 1.0,
          rotation,
          alignedAxis: Cesium.Cartesian3.ZERO,
          color,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60_000_000),
        },
        ...(showLabel ? { label: labelFor(spec.label) } : {}),
        name: spec.label,
        properties: {
          kind: 'sim-uav',
          sim: true,
          ...(spec.swarmId ? { swarmId: spec.swarmId } : {}),
          link_profile: spec.profile.type,
          // Live runtime fields. A CallbackProperty stays live inside a
          // PropertyBag, so the EntityPanel shows real status (mode / link /
          // altitude / heading) when a sim drone is clicked — the de-silo.
          mode: new Cesium.CallbackProperty(() => rt.mode, false),
          link: new Cesium.CallbackProperty(() => rt.link, false),
          fate: new Cesium.CallbackProperty(() => rt.fate, false),
          alt_m: new Cesium.CallbackProperty(() => Math.round(rt.alt), false),
          heading_deg: new Cesium.CallbackProperty(() => Math.round(rt.heading), false),
        },
      });
      // Fiber-optic tether: a line from the control station to the drone while
      // the link is alive (the physical spooled fiber).
      if (spec.profile.type === 'fiber' && plan.station) {
        const station = plan.station;
        this.ds.entities.add({
          id: `${spec.id}:fiber`,
          polyline: {
            positions: new Cesium.CallbackProperty(
              () =>
                rt.mode === 'crashed' || rt.fate === 'ew_lost'
                  ? []
                  : [
                      Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 20),
                      Cesium.Cartesian3.fromDegrees(rt.lon, rt.lat, rt.alt),
                    ],
              false,
            ),
            width: 1,
            material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#5eead4').withAlpha(0.5)),
          },
        });
      }
    });
    this.drawSwarms();
  }

  // ── swarm roll-up (one selectable entity + AOI circle per swarmId) ─────────
  // The centroid/radius/label are CallbackPropertys evaluated each render, so a
  // single entity tracks the moving cloud without per-tick recreation (the
  // upsert-by-id discipline). The roll-up stays visible even when the swarm has
  // more members than RENDER_AGENT_CAP renders as individual icons.
  private drawSwarms(): void {
    for (const [swarmId, indices] of this.swarms) {
      if (indices.length === 0) continue;
      const color = Cesium.Color.fromCssColorString('#ef4444');
      this.ds.entities.add({
        id: swarmId,
        position: new Cesium.CallbackPositionProperty(() => {
          const aoi = this.swarmAoi(swarmId);
          if (!aoi) return undefined;
          return Cesium.Cartesian3.fromDegrees(aoi.lon, aoi.lat, 0);
        }, false),
        ellipse: {
          semiMajorAxis: new Cesium.CallbackProperty(() => (this.swarmAoi(swarmId)?.radiusKm ?? 0) * 1000, false),
          semiMinorAxis: new Cesium.CallbackProperty(() => (this.swarmAoi(swarmId)?.radiusKm ?? 0) * 1000, false),
          material: new Cesium.ColorMaterialProperty(color.withAlpha(0.07)),
          outline: true,
          outlineColor: color.withAlpha(0.5),
          height: 0,
        },
        label: {
          ...labelFor(''),
          text: new Cesium.CallbackProperty(() => this.swarmLabel(swarmId), false),
        },
        name: 'Swarm',
        properties: { kind: 'sim-swarm', sim: true, swarmId },
      });
    }
  }

  // Tallies for a swarm's rendered members (matches the SimStats fate buckets).
  private swarmTally(indices: number[]): {
    total: number;
    live: number;
    struck: number;
    intercepted: number;
    linkLost: number;
  } {
    let live = 0;
    let struck = 0;
    let intercepted = 0;
    let linkLost = 0;
    for (const i of indices) {
      const rt = this.agents[i];
      if (!rt) continue;
      if (rt.fate === 'struck') struck++;
      else if (rt.fate === 'intercepted') intercepted++;
      else if (rt.fate === 'ew_lost') linkLost++;
      else live++;
    }
    return { total: indices.length, live, struck, intercepted, linkLost };
  }

  private swarmLabel(swarmId: string): string {
    const indices = this.swarms.get(swarmId);
    if (!indices) return 'Swarm';
    const t = this.swarmTally(indices);
    return `Swarm: ${t.total} UAV, ${t.struck} struck, ${t.intercepted} intercepted`;
  }

  // Centroid (mean lat/lon) + bounding CIRCLE (max member distance from the
  // centroid + a margin) over the swarm's LIVE members; falls back to all
  // members once the swarm is fully resolved. Bounding circle, NOT a hull —
  // the dispersion model produces near-circular clouds. Returns null for an
  // unknown/empty swarm.
  swarmAoi(swarmId: string): { lat: number; lon: number; radiusKm: number } | null {
    const indices = this.swarms.get(swarmId);
    if (!indices || indices.length === 0) return null;
    const isLive = (rt: RtAgent): boolean =>
      rt.fate === 'flying' && rt.mode !== 'crashed' && rt.mode !== 'arrived';
    let members = indices.map((i) => this.agents[i]).filter((rt): rt is RtAgent => !!rt && isLive(rt));
    if (members.length === 0) {
      members = indices.map((i) => this.agents[i]).filter((rt): rt is RtAgent => !!rt);
    }
    if (members.length === 0) return null;
    let sumLat = 0;
    let sumLon = 0;
    for (const rt of members) {
      sumLat += rt.lat;
      sumLon += rt.lon;
    }
    const lat = sumLat / members.length;
    const lon = sumLon / members.length;
    const center = { lat, lon };
    let maxKm = 0;
    for (const rt of members) {
      const d = haversineKm(center, { lat: rt.lat, lon: rt.lon });
      if (d > maxKm) maxKm = d;
    }
    // Margin: 20% of the spread plus a 0.5 km floor so a tight/single-member
    // cloud still draws a visible ring.
    const radiusKm = maxKm * 1.2 + 0.5;
    return { lat, lon, radiusKm };
  }

  private agentColor(rt: RtAgent): Cesium.Color {
    if (rt.mode === 'crashed' || rt.fate === 'ew_lost') return Cesium.Color.fromCssColorString('#64748b');
    if (rt.fate === 'intercepted') return Cesium.Color.fromCssColorString('#f59e0b');
    if (rt.link === 'lost') return Cesium.Color.fromCssColorString('#94a3b8');
    if (rt.link === 'degraded') return Cesium.Color.fromCssColorString('#f59e0b');
    return Cesium.Color.fromCssColorString('#ef4444');
  }

  private async precomputeTerrain(plan: SimPlan): Promise<void> {
    if (!plan.station || !plan.agents?.length) return;
    const target = plan.agents[0]!.target;
    try {
      const profile = await routeGroundProfile(plan.station, target, 24);
      if (this.disposed) return;
      this.groundProfile = profile;
      this.viewer.scene.requestRender();
    } catch {
      /* terrain unavailable → flat-earth fallback (LOS clear, MSL alt) */
    }
  }

  // Terrain LOS from the control station to an agent at route fraction f.
  private stationLosClear(frac: number, agentAlt: number): boolean {
    const g = this.groundProfile;
    if (!g || g.length < 3) return true;
    const idx = Math.max(1, Math.round(frac * (g.length - 1)));
    const stationAlt = (g[0] ?? 0) + 30; // operator antenna ~30 m
    const interior = g.slice(1, idx);
    if (interior.length === 0) return true;
    return !lineMasked(stationAlt, agentAlt, interior, 15);
  }

  private stepAgents(dt: number): void {
    const plan = this.plan;
    if (!plan) return;
    const station = plan.station ?? { lat: this.agents[0]?.spec.launch.lat ?? 0, lon: this.agents[0]?.spec.launch.lon ?? 0 };
    const jammers = plan.jammers ?? [];
    const noe = !!plan.napOfEarth;
    const defenses = plan.defenses ?? [];

    for (const rt of this.agents) {
      if (rt.mode === 'arrived') continue;
      if (rt.mode === 'crashed') {
        // settle to the ground
        const ground = this.groundProfile ? profileAt(this.groundProfile, this.fracOf(rt)) : 0;
        if (rt.alt > ground) rt.alt = Math.max(ground, rt.alt - 250 * dt);
        continue;
      }
      if (this.simTime < rt.spec.startDelaySec) {
        rt.mode = 'pre';
        rt.lat = rt.spec.launch.lat;
        rt.lon = rt.spec.launch.lon;
        rt.alt = 0;
        continue;
      }
      if (rt.mode === 'pre') {
        rt.mode = 'cruise';
        rt.alt = rt.spec.cruiseAltM;
      }

      const pos = { lat: rt.lat, lon: rt.lon };
      const frac = this.fracOf(rt);
      const distToStationKm = haversineKm(pos, station);

      // link state: range + terrain LOS + EW
      const losClear = rt.spec.profile.losRequired ? this.stationLosClear(frac, rt.alt) : true;
      const ew = jammers.length ? ewAt(rt.lat, rt.lon, jammers) : NO_EW;
      const { state, gnssDenied } = evaluateLink(rt.spec.profile, distToStationKm, losClear, ew);
      rt.link = state;

      // fiber: beyond the tether length the spool is exhausted → cut.
      if (rt.spec.profile.type === 'fiber' && distToStationKm > rt.spec.profile.commsRangeKm) {
        rt.mode = 'crashed';
        rt.fate = 'ew_lost';
        this.spawnBurst(rt, '#5eead4');
        continue;
      }

      // link loss behaviour
      if (state === 'lost') {
        switch (rt.spec.profile.onLinkLoss) {
          case 'crash':
            rt.mode = 'crashed';
            rt.fate = 'ew_lost';
            this.spawnBurst(rt, '#94a3b8');
            continue;
          case 'rtl':
            rt.mode = 'rtl';
            break;
          case 'loiter':
            rt.mode = 'loiter';
            break;
          case 'continue_ins':
            rt.mode = 'cruise';
            break;
        }
      } else if (rt.mode !== 'loiter' && rt.mode !== 'rtl') {
        rt.mode = 'cruise';
      }

      // GNSS denial → INS drift (heading bias grows with exposure)
      if (gnssDenied && rt.spec.profile.navMode !== 'manual') {
        rt.driftBiasDeg += rt.spec.profile.insDriftMPerKm * 0.02 * (rt.roll > 0.5 ? 1 : -1);
        rt.driftBiasDeg = Math.max(-25, Math.min(25, rt.driftBiasDeg));
      }

      // SAM engagement: first time inside a site's ring, within its salvo capacity.
      if (!rt.samChecked && (rt.mode === 'cruise' || rt.mode === 'rtl')) {
        for (const d of defenses) {
          if (haversineKm(pos, d) <= d.rangeKm) {
            rt.samChecked = true;
            const eng = this.siteEngaged.get(d.id) ?? 0;
            if (eng < SALVO_PER_SITE) {
              this.siteEngaged.set(d.id, eng + 1);
              const cover = noe ? 0.7 : 1;
              if (rt.roll < (d.pk ?? 0.6) * cover) {
                rt.mode = 'crashed';
                rt.fate = 'intercepted';
                this.spawnBurst(rt, '#f59e0b');
              }
            }
            break;
          }
        }
        if (rt.mode === 'crashed') continue;
      }

      // movement
      const stepKm = (rt.spec.speedMps * dt) / 1000;
      if (rt.mode === 'loiter') {
        rt.loiterPhase += dt * 0.4;
        const c = destPoint(pos, (rt.loiterPhase * 57.3) % 360, 0.5);
        rt.heading = bearingDeg(pos, c);
        rt.lat = c.lat;
        rt.lon = c.lon;
      } else {
        const goal = rt.mode === 'rtl' ? station : rt.spec.target;
        rt.heading = (bearingDeg(pos, goal) + rt.driftBiasDeg + 360) % 360;
        const next = destPoint(pos, rt.heading, stepKm);
        rt.lat = next.lat;
        rt.lon = next.lon;
      }

      // altitude
      if (noe) {
        const ground = this.groundProfile ? profileAt(this.groundProfile, frac) : 0;
        rt.alt = ground + NOE_AGL_M;
      } else {
        const dGoal = haversineKm({ lat: rt.lat, lon: rt.lon }, rt.spec.target);
        rt.alt = dGoal < 1.5 && rt.mode === 'cruise' ? Math.max(0, rt.spec.cruiseAltM * (dGoal / 1.5)) : rt.spec.cruiseAltM;
      }

      // arrival
      if (rt.mode === 'rtl' && haversineKm({ lat: rt.lat, lon: rt.lon }, station) < ARRIVE_KM) {
        rt.mode = 'crashed';
        rt.alt = 0;
      } else if (rt.mode === 'cruise' && haversineKm({ lat: rt.lat, lon: rt.lon }, rt.spec.target) < ARRIVE_KM) {
        rt.mode = 'arrived';
        rt.fate = 'struck';
        rt.alt = 0;
      }
    }
  }

  // Fraction of an agent's leg flown (launch→target), for terrain lookups.
  private fracOf(rt: RtAgent): number {
    const d = haversineKm({ lat: rt.lat, lon: rt.lon }, rt.spec.launch);
    return Math.max(0, Math.min(1, d / rt.legKm));
  }

  private spawnBurst(rt: RtAgent, color: string): void {
    const killT = this.simTime;
    const lat = rt.lat;
    const lon = rt.lon;
    const alt = rt.alt;
    this.ds.entities.add({
      id: `${rt.spec.id}:burst`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
      point: {
        color: Cesium.Color.fromCssColorString(color),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        pixelSize: new Cesium.CallbackProperty(() => {
          const dtk = this.simTime - killT;
          if (dtk < 0) return 0;
          if (dtk < 3) return 8 + 8 * Math.abs(Math.sin(dtk * 4));
          return 6;
        }, false),
      },
      properties: { kind: 'sim-burst', sim: true },
    });
  }

  // ── static scenery (routes / defenses / jammers / station) ────────────────
  private drawRoutes(plan: SimPlan): void {
    for (const route of plan.routes) {
      this.ds.entities.add({
        id: route.id,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(route.points.flatMap((p) => [p.lon, p.lat])),
          width: 1.5,
          material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(route.color).withAlpha(0.28)),
          clampToGround: true,
        },
      });
    }
  }

  private drawDefenses(plan: SimPlan): void {
    for (const def of plan.defenses ?? []) {
      const c = Cesium.Color.fromCssColorString(def.color);
      this.ds.entities.add({
        id: def.id,
        position: Cesium.Cartesian3.fromDegrees(def.lon, def.lat),
        billboard: {
          image: icons.samSite(def.color),
          scale: 1.0,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60_000_000),
        },
        ellipse: {
          semiMajorAxis: def.rangeKm * 1000,
          semiMinorAxis: def.rangeKm * 1000,
          material: new Cesium.ColorMaterialProperty(c.withAlpha(0.05)),
          outline: true,
          outlineColor: c.withAlpha(0.5),
          height: 0,
        },
        label: labelFor(def.name),
        name: def.name,
        properties: { kind: 'sim-defense', sim: true },
      });
    }
    if (plan.impact) {
      const im = plan.impact;
      const appearT = plan.durationSec * 0.85;
      const red = Cesium.Color.fromCssColorString('#ef4444');
      this.ds.entities.add({
        id: 'sim:impact',
        position: Cesium.Cartesian3.fromDegrees(im.lon, im.lat),
        ellipse: {
          semiMajorAxis: im.radiusKm * 1000,
          semiMinorAxis: im.radiusKm * 1000,
          material: new Cesium.ColorMaterialProperty(red.withAlpha(0.05 + 0.2 * im.severity)),
          outline: true,
          outlineColor: red.withAlpha(0.6),
          height: 0,
          show: new Cesium.CallbackProperty(() => this.simTime >= appearT, false),
        },
        properties: { kind: 'sim-impact', sim: true },
      });
    }
  }

  private drawJammers(plan: SimPlan): void {
    for (const j of plan.jammers ?? []) {
      const css = j.kind === 'gnss' ? '#a855f7' : j.kind === 'both' ? '#e25bef' : '#f97316';
      const c = Cesium.Color.fromCssColorString(css);
      this.ds.entities.add({
        id: `${j.id}:zone`,
        position: Cesium.Cartesian3.fromDegrees(j.lon, j.lat),
        ellipse: {
          semiMajorAxis: j.radiusKm * 1000,
          semiMinorAxis: j.radiusKm * 1000,
          material: new Cesium.ColorMaterialProperty(c.withAlpha(0.07)),
          outline: true,
          outlineColor: c.withAlpha(0.55),
          height: 0,
        },
        point: { color: c, pixelSize: 7, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
        label: labelFor(j.kind === 'gnss' ? 'GNSS jam' : j.kind === 'both' ? 'EW' : 'comms jam'),
        properties: { kind: 'sim-jammer', sim: true },
      });
    }
  }

  private drawStation(plan: SimPlan): void {
    if (!plan.station || !plan.agents?.length) return;
    // Comms range ring for RF links (skip autonomous/fiber).
    const rf = plan.agents.find((a) => a.profile.type === 'rf_los' || a.profile.type === 'rf_satcom');
    const station = plan.station;
    this.ds.entities.add({
      id: 'sim:station',
      position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat),
      billboard: {
        image: icons.groundUnit('#38bdf8'),
        scale: 1.0,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60_000_000),
      },
      ...(rf && Number.isFinite(rf.profile.commsRangeKm)
        ? {
            ellipse: {
              semiMajorAxis: rf.profile.commsRangeKm * 1000,
              semiMinorAxis: rf.profile.commsRangeKm * 1000,
              material: new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.04)),
              outline: true,
              outlineColor: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.4),
              height: 0,
            },
          }
        : {}),
      label: labelFor('GCS'),
      name: 'Control station',
      properties: { kind: 'sim-station', sim: true },
    });
  }

  // ── clock ────────────────────────────────────────────────────────────────
  play(): void {
    if (this.disposed || !this.plan || this.playing) return;
    if (this.simTime >= this.plan.durationSec) this.reset();
    this.playing = true;
    this.lastMs = performance.now();
    this.tick();
    this.emit();
  }
  pause(): void {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.emit();
  }
  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }
  setSpeed(x: number): void {
    this.speed = Math.max(1, Math.min(200, x));
  }
  seek(sec: number): void {
    if (!this.plan) return;
    // stepping backwards is ambiguous for the integrator → re-run from 0.
    const target = Math.max(0, Math.min(this.plan.durationSec, sec));
    if (target < this.simTime) {
      this.load(this.plan);
    }
    this.advanceTo(target);
    this.viewer.scene.requestRender();
    this.emit();
  }
  reset(): void {
    if (this.plan) this.load(this.plan);
  }
  clear(): void {
    this.plan = null;
    this.pause();
    this.agents = [];
    this.swarms.clear();
    this.ds.entities.removeAll();
    this.viewer.scene.requestRender();
    this.emit();
  }

  // Fast-forward the integrator to a target sim time in fixed steps.
  private advanceTo(target: number): void {
    const step = 0.25;
    while (this.simTime < target) {
      const dt = Math.min(step, target - this.simTime);
      this.simTime += dt;
      if (this.agents.length) this.stepAgents(dt);
    }
  }

  private tick(): void {
    if (!this.playing || this.disposed || !this.plan) return;
    const now = performance.now();
    // Cap the REAL frame gap (e.g. after a tab-away) to 100 ms, then scale by
    // sim speed. Integrate in ≤0.5 s sub-steps so fast speeds stay accurate
    // without capping throughput (the old single-0.5 s clamp pinned speed ~30×).
    const real = Math.min(0.1, (now - this.lastMs) / 1000);
    this.lastMs = now;
    const dt = real * this.speed;
    this.simTime += dt;
    if (this.agents.length) {
      let remaining = dt;
      while (remaining > 0) {
        const s = Math.min(0.5, remaining);
        this.stepAgents(s);
        remaining -= s;
      }
    }
    if (this.simTime >= this.plan.durationSec) {
      this.simTime = this.plan.durationSec;
      this.playing = false;
    }
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame(() => this.tick());
  }

  private stats(): SimStats {
    let airborne = 0;
    let struck = 0;
    let intercepted = 0;
    let linkLost = 0;
    let degraded = 0;
    for (const rt of this.agents) {
      if (rt.fate === 'struck') struck++;
      else if (rt.fate === 'intercepted') intercepted++;
      else if (rt.fate === 'ew_lost') linkLost++;
      else {
        airborne++;
        if (rt.link === 'degraded') degraded++;
      }
    }
    return { airborne, struck, intercepted, linkLost, degraded };
  }

  private emit(): void {
    this.onUpdate?.({
      simTime: this.simTime,
      duration: this.plan?.durationSec ?? 0,
      playing: this.playing,
      ...(this.agents.length ? { stats: this.stats() } : {}),
    });
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    this.placeHandler.destroy();
    try {
      this.viewer.dataSources.remove(this.ds, true);
    } catch {
      /* viewer gone */
    }
  }
}
