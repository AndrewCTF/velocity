import { describe, expect, it } from 'vitest';
import {
  DR_COAST_MAX_S,
  DR_MAX_FIX_AGE_S,
  DR_BACK_TOLERATE,
  DR_PHASE_DEADBAND_S,
  advance,
  alongTrackM,
  ingestFix,
  projectAt,
  type DrFix,
} from './deadReckon';

/**
 * Vincenty INVERSE geodesic distance (metres) on WGS84 — the independent
 * yardstick for these tests.
 *
 * Deliberately a different algorithm from the module's forward radii-of-curvature
 * step, so it genuinely cross-checks it. (A spherical great-circle is NOT a valid
 * check here: on a 6371 km sphere it disagrees with the WGS84 ground distance by
 * ~0.16%, which at 250 m/s reads as a 0.8 m/s speed error that isn't real.)
 */
function gc(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const b = (1 - f) * a;
  const L = bLon - aLon;
  const U1 = Math.atan((1 - f) * Math.tan(aLat));
  const U2 = Math.atan((1 - f) * Math.tan(bLat));
  const sU1 = Math.sin(U1);
  const cU1 = Math.cos(U1);
  const sU2 = Math.sin(U2);
  const cU2 = Math.cos(U2);
  let lam = L;
  let sSig = 0;
  let cSig = 0;
  let sig = 0;
  let cSqA = 0;
  let c2sm = 0;
  for (let i = 0; i < 200; i++) {
    const sLam = Math.sin(lam);
    const cLam = Math.cos(lam);
    sSig = Math.sqrt((cU2 * sLam) ** 2 + (cU1 * sU2 - sU1 * cU2 * cLam) ** 2);
    if (sSig === 0) return 0; // coincident
    cSig = sU1 * sU2 + cU1 * cU2 * cLam;
    sig = Math.atan2(sSig, cSig);
    const sA = (cU1 * cU2 * sLam) / sSig;
    cSqA = 1 - sA * sA;
    c2sm = cSqA === 0 ? 0 : cSig - (2 * sU1 * sU2) / cSqA; // equatorial line
    const C = (f / 16) * cSqA * (4 + f * (4 - 3 * cSqA));
    const prev = lam;
    lam = L + (1 - C) * f * sA * (sig + C * sSig * (c2sm + C * cSig * (-1 + 2 * c2sm * c2sm)));
    if (Math.abs(lam - prev) < 1e-12) break;
  }
  const uSq = (cSqA * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const dSig =
    B *
    sSig *
    (c2sm +
      (B / 4) *
        (cSig * (-1 + 2 * c2sm * c2sm) -
          (B / 6) * c2sm * (-3 + 4 * sSig * sSig) * (-3 + 4 * c2sm * c2sm)));
  return b * A * (sig - dSig);
}

const fix = (o: Partial<DrFix> = {}): DrFix => ({
  lonDeg: -0.45,
  latDeg: 51.47,
  altM: 10000,
  trackDeg: 90,
  speedMs: 250,
  ageS: 0,
  onGround: false,
  ...o,
});

describe('deadReckon — requirement 1: speed is the ACTUAL reported speed', () => {
  // The operator requirement is exact: "the predicted motion speed must be the
  // actual speed, not faster or slower".
  it.each([
    ['due east', 90],
    ['due north', 0],
    ['due west', 270],
    ['due south', 180],
    ['diagonal', 37.5],
  ])('renders exactly velocity_ms on a %s track', (_label, trackDeg) => {
    const s = ingestFix(undefined, fix({ trackDeg, speedMs: 250 }), 1000);
    const a = projectAt(s, 1000);
    const b = projectAt(s, 1010); // 10 s → must be exactly 2500 m
    const measured = gc(a.lonRad, a.latRad, b.lonRad, b.latRad) / 10;
    expect(measured).toBeCloseTo(250, 1); // within 0.1 m/s
  });

  it('holds exact speed across a range of speeds and latitudes', () => {
    for (const speedMs of [60, 120, 250, 300]) {
      for (const latDeg of [-60, -20, 0, 35, 51.47, 70]) {
        const s = ingestFix(undefined, fix({ speedMs, latDeg, trackDeg: 45 }), 0);
        const a = projectAt(s, 0);
        const b = projectAt(s, 30);
        const measured = gc(a.lonRad, a.latRad, b.lonRad, b.latRad) / 30;
        expect(Math.abs(measured - speedMs) / speedMs).toBeLessThan(0.001); // <0.1%
      }
    }
  });

  it('speed is constant over the whole coast — no accel/decel segments', () => {
    // The OLD model glided cur→fix over the inter-fix gap, so apparent speed was
    // dist/gap = arbitrary. Sample every second; every second must be identical.
    const s = ingestFix(undefined, fix({ speedMs: 200, trackDeg: 120 }), 0);
    const speeds: number[] = [];
    for (let t = 0; t < 30; t++) {
      const a = projectAt(s, t);
      const b = projectAt(s, t + 1);
      speeds.push(gc(a.lonRad, a.latRad, b.lonRad, b.latRad));
    }
    for (const v of speeds) expect(v).toBeCloseTo(200, 1);
  });
});

describe('deadReckon — requirement 2: NEVER moves backwards', () => {
  it('is monotonically forward along track across the whole coast', () => {
    const s = ingestFix(undefined, fix({ trackDeg: 270, speedMs: 240 }), 0);
    let prev = projectAt(s, 0);
    for (let t = 0.25; t <= DR_COAST_MAX_S + 20; t += 0.25) {
      const cur = projectAt(s, t);
      const d = alongTrackM(prev.lonRad, prev.latRad, cur.lonRad, cur.latRad, s.trackRad);
      expect(d).toBeGreaterThanOrEqual(-1e-6);
      prev = cur;
    }
  });

  it('a STALE fix landing BEHIND the projection does not reverse the icon', () => {
    // The exact reported bug: the feed re-sends an older position while we have
    // already projected past it. The old code glided backwards to it over up to
    // 30 s. Here the icon must not retreat along track.
    const s0 = ingestFix(undefined, fix({ trackDeg: 90, speedMs: 250 }), 0);
    const at30 = projectAt(s0, 30);
    // A fix 20 km BEHIND where we now render, claiming to be fresh.
    const behind = fix({ lonDeg: -0.45, latDeg: 51.47, trackDeg: 90, speedMs: 250, ageS: 0 });
    const s1 = ingestFix(s0, behind, 30);
    const after = projectAt(s1, 30);
    const jump = alongTrackM(at30.lonRad, at30.latRad, after.lonRad, after.latRad, s1.trackRad);
    // It may SNAP back once (a genuine re-anchor to truth), but from then on it
    // must only ever go forward — never a sustained backwards glide.
    let prev = after;
    for (let t = 30.25; t <= 60; t += 0.25) {
      const cur = projectAt(s1, t);
      const d = alongTrackM(prev.lonRad, prev.latRad, cur.lonRad, cur.latRad, s1.trackRad);
      expect(d).toBeGreaterThanOrEqual(-1e-6);
      prev = cur;
    }
    expect(Number.isFinite(jump)).toBe(true);
  });

  it('cannot reverse even if the sim clock is scrubbed backwards', () => {
    const s = ingestFix(undefined, fix({ trackDeg: 45, speedMs: 250 }), 1000);
    const atAnchor = projectAt(s, 1000);
    const before = projectAt(s, 900); // 100 s BEFORE the anchor
    expect(before.lonRad).toBeCloseTo(atAnchor.lonRad, 12);
    expect(before.latRad).toBeCloseTo(atAnchor.latRad, 12);
  });

  it('a stream of jittery real-ish fixes never produces a backwards step', () => {
    // Deterministic pseudo-noise on position/track/age, 6 s cadence like the feed.
    let s = ingestFix(undefined, fix({ trackDeg: 90, speedMs: 250 }), 0);
    let rendered = projectAt(s, 0);
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    for (let k = 1; k <= 40; k++) {
      const now = k * 6;
      // Truth: flying east at 250 m/s from the origin, plus noise.
      const truthLon = -0.45 + ((250 * now) / (6378137 * Math.cos((51.47 * Math.PI) / 180))) * (180 / Math.PI);
      const f = fix({
        lonDeg: truthLon + rnd() * 0.004,
        latDeg: 51.47 + rnd() * 0.0008,
        trackDeg: 90 + rnd() * 4,
        speedMs: 250 + rnd() * 8,
        ageS: Math.abs(rnd()) * 5,
      });
      s = ingestFix(s, f, now);
      for (let t = now; t < now + 6; t += 0.5) {
        const cur = projectAt(s, t);
        const d = alongTrackM(rendered.lonRad, rendered.latRad, cur.lonRad, cur.latRad, s.trackRad);
        // Allow the one-frame re-anchor snap at the fix boundary (t === now),
        // but never a backwards step DURING the coast.
        if (t > now) expect(d).toBeGreaterThanOrEqual(-1e-6);
        rendered = cur;
      }
    }
  });
});

describe('deadReckon — anchoring, coasting, freezing', () => {
  it('anchors at the fix OBSERVATION time, so an aged fix renders carried forward', () => {
    const s = ingestFix(undefined, fix({ ageS: 8, speedMs: 250, trackDeg: 90 }), 1000);
    // Anchored 8 s in the past → at nowSec it has already flown 8 × 250 = 2000 m.
    const atNow = projectAt(s, 1000);
    const d = gc((-0.45 * Math.PI) / 180, (51.47 * Math.PI) / 180, atNow.lonRad, atNow.latRad);
    expect(d).toBeCloseTo(2000, 0);
  });

  it('HOLDs past the coast limit instead of flying off forever', () => {
    const s = ingestFix(undefined, fix({ speedMs: 250, trackDeg: 90 }), 0);
    const atLimit = projectAt(s, DR_COAST_MAX_S);
    const wayPast = projectAt(s, DR_COAST_MAX_S + 600);
    expect(wayPast.lonRad).toBeCloseTo(atLimit.lonRad, 12);
    expect(wayPast.latRad).toBeCloseTo(atLimit.latRad, 12);
  });

  it.each([
    ['on_ground', { onGround: true }],
    ['parked (below min speed)', { speedMs: 3 }],
    ['stale fix (OpenSky breadth tier)', { ageS: DR_MAX_FIX_AGE_S + 1 }],
    ['no track', { trackDeg: null }],
    ['no speed', { speedMs: null }],
  ])('does NOT synthesise motion for %s — it holds at the reported fix', (_l, over) => {
    const s = ingestFix(undefined, fix(over as Partial<DrFix>), 0);
    expect(s.frozen).toBe(true);
    const a = projectAt(s, 0);
    const b = projectAt(s, 120);
    expect(a.lonRad).toBe(b.lonRad);
    expect(a.latRad).toBe(b.latRad);
  });

  it('a small correction is absorbed as a phase shift — no position jump', () => {
    const s0 = ingestFix(undefined, fix({ trackDeg: 90, speedMs: 250 }), 0);
    const at12 = projectAt(s0, 12);
    // Next fix ~1 s of flight behind the projection → inside the deadband.
    const nudged = advance(s0.lonRad, s0.latRad, s0.trackRad, 250 * 11);
    const s1 = ingestFix(
      s0,
      fix({
        lonDeg: (nudged.lonRad * 180) / Math.PI,
        latDeg: (nudged.latRad * 180) / Math.PI,
        trackDeg: 90,
        speedMs: 250,
        ageS: 0,
      }),
      12,
    );
    const after = projectAt(s1, 12);
    const jump = gc(at12.lonRad, at12.latRad, after.lonRad, after.latRad);
    expect(jump).toBeLessThan(1); // continuous — absorbed in time, not position
    // …and speed is still exactly 250 afterwards.
    const b = projectAt(s1, 22);
    expect(gc(after.lonRad, after.latRad, b.lonRad, b.latRad) / 10).toBeCloseTo(250, 1);
  });

  it('a correction beyond the deadband re-anchors to truth instead of drifting', () => {
    const s0 = ingestFix(undefined, fix({ trackDeg: 90, speedMs: 250 }), 0);
    // A fix far past the deadband (≫ 2.5 s × 250 m/s).
    const far = advance(s0.lonRad, s0.latRad, s0.trackRad, 250 * 40);
    const s1 = ingestFix(
      s0,
      fix({
        lonDeg: (far.lonRad * 180) / Math.PI,
        latDeg: (far.latRad * 180) / Math.PI,
        trackDeg: 90,
        speedMs: 250,
        ageS: 0,
      }),
      10,
    );
    const after = projectAt(s1, 10);
    // Re-anchored ON truth (no phase shift retained).
    expect(gc(after.lonRad, after.latRad, far.lonRad, far.latRad)).toBeLessThan(1);
    expect(Math.abs(s1.t0 - 10)).toBeLessThan(DR_PHASE_DEADBAND_S);
  });
});

describe('deadReckon — a lone backward fix is feed noise, not a reverse', () => {
  /** A fix `metres` along-track from `s`'s anchor, claiming to be fresh. */
  const fixAt = (s: ReturnType<typeof ingestFix>, metres: number): DrFix => {
    const p = advance(s.lonRad, s.latRad, s.trackRad, metres);
    return fix({
      lonDeg: (p.lonRad * 180) / Math.PI,
      latDeg: (p.latRad * 180) / Math.PI,
      trackDeg: 90,
      speedMs: 250,
      ageS: 0,
    });
  };

  it('ignores a single fix landing far behind the projection', () => {
    let s = ingestFix(undefined, fix({ trackDeg: 90, speedMs: 250 }), 0);
    const at30 = projectAt(s, 30);
    // A fix 5 km behind where we render — the measured ~1-2 km feed flip, worse.
    s = ingestFix(s, fixAt(s, 250 * 30 - 5000), 30);
    const after = projectAt(s, 30);
    const moved = alongTrackM(at30.lonRad, at30.latRad, after.lonRad, after.latRad, s.trackRad);
    expect(moved).toBeCloseTo(0, 6); // did not teleport backwards
  });

  it('believes the feed once DR_BACK_TOLERATE fixes agree we are ahead', () => {
    let s = ingestFix(undefined, fix({ trackDeg: 90, speedMs: 250 }), 0);
    let accepted = false;
    for (let k = 1; k <= DR_BACK_TOLERATE; k++) {
      const t = k * 6;
      const before = projectAt(s, t);
      s = ingestFix(s, fixAt(s, 250 * t - 5000), t);
      const after = projectAt(s, t);
      const d = alongTrackM(before.lonRad, before.latRad, after.lonRad, after.latRad, s.trackRad);
      if (d < -100) accepted = true;
    }
    expect(accepted).toBe(true); // a REAL reposition still corrects
  });

  it('a forward fix resets the tolerance, so noise never accumulates into a jump', () => {
    let s = ingestFix(undefined, fix({ trackDeg: 90, speedMs: 250 }), 0);
    for (let k = 1; k <= 12; k++) {
      const t = k * 6;
      // Alternate: one bad backward fix, then a good on-track one.
      s = k % 2 === 1 ? ingestFix(s, fixAt(s, 250 * t - 5000), t) : ingestFix(s, fixAt(s, 250 * t), t);
      expect(s.backCount).toBeLessThan(DR_BACK_TOLERATE);
    }
  });

  it('still re-anchors forward immediately when the fix is AHEAD', () => {
    let s = ingestFix(undefined, fix({ trackDeg: 90, speedMs: 250 }), 0);
    const before = projectAt(s, 10);
    s = ingestFix(s, fixAt(s, 250 * 10 + 5000), 10); // 5 km ahead
    const after = projectAt(s, 10);
    const d = alongTrackM(before.lonRad, before.latRad, after.lonRad, after.latRad, s.trackRad);
    expect(d).toBeGreaterThan(4000); // caught up, no tolerance delay
  });
});

describe('deadReckon — a STALE (frozen) contact must not walk backwards either', () => {
  // Frozen contacts teleport to the reported fix, so a regressing feed walked
  // them backwards frame after frame — measured live as runs of up to 12
  // consecutive backward frames, the only remaining sustained reverse.
  const staleAt = (lonDeg: number): DrFix =>
    fix({ lonDeg, trackDeg: 90, speedMs: 250, ageS: DR_MAX_FIX_AGE_S + 10 });

  it('ignores a lone backward step on a stale airborne contact', () => {
    let s = ingestFix(undefined, staleAt(-0.45), 0);
    expect(s.frozen).toBe(true);
    s = ingestFix(s, staleAt(-0.40), 6); // forward (east)
    const fwd = projectAt(s, 6);
    s = ingestFix(s, staleAt(-0.50), 12); // jumps back west — feed noise
    const after = projectAt(s, 12);
    expect(after.lonRad).toBeCloseTo(fwd.lonRad, 12); // held, did not walk back
  });

  it('accepts a persistent backward correction on a stale contact', () => {
    let s = ingestFix(undefined, staleAt(-0.45), 0);
    s = ingestFix(s, staleAt(-0.40), 6);
    for (let k = 1; k <= DR_BACK_TOLERATE; k++) s = ingestFix(s, staleAt(-0.50), 6 + k * 6);
    expect((projectAt(s, 30).lonRad * 180) / Math.PI).toBeCloseTo(-0.5, 6);
  });

  it('never guards an ON-GROUND contact (pushback is genuinely backwards)', () => {
    const g = (lonDeg: number): DrFix => fix({ lonDeg, onGround: true, speedMs: 5, trackDeg: 90 });
    let s = ingestFix(undefined, g(-0.45), 0);
    s = ingestFix(s, g(-0.50), 6); // pushed back
    expect((projectAt(s, 6).lonRad * 180) / Math.PI).toBeCloseTo(-0.5, 6);
  });
});

describe('deadReckon — advance() geometry', () => {
  it('travels the requested ground distance', () => {
    const lon = (2.35 * Math.PI) / 180;
    const lat = (48.85 * Math.PI) / 180;
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const p = advance(lon, lat, (bearing * Math.PI) / 180, 15000);
      expect(gc(lon, lat, p.lonRad, p.latRad)).toBeCloseTo(15000, -1); // ±10 m over 15 km
    }
  });

  it('wraps across the antimeridian instead of running longitude away', () => {
    const p = advance((179.99 * Math.PI) / 180, 0, Math.PI / 2, 5000);
    expect(p.lonRad).toBeLessThan(0); // crossed into the western hemisphere
    expect(Math.abs(p.lonRad)).toBeLessThanOrEqual(Math.PI);
  });
});
