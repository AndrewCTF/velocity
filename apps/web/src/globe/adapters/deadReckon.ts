// FlightRadar24-style aircraft dead-reckoning — the MOTION MODEL only (no Cesium
// entity plumbing; PollGeoJsonAdapter owns that). Pure functions so the two hard
// operator requirements are unit-testable:
//
//   1. The icon moves at the aircraft's ACTUAL reported ground speed — not
//      faster, not slower.
//   2. The icon NEVER moves backwards.
//
// Both are structural here, not tuned:
//
//   position(t) = advance(anchor, track_deg, velocity_ms * max(0, t - t0))
//
// `advance` steps along the WGS84 surface using the local radii of curvature, so
// |dP/dt| == velocity_ms EXACTLY (req 1). `max(0, ...)` means elapsed distance is
// monotonically non-decreasing along a FIXED bearing, so the icon cannot reverse
// even if the clock is scrubbed backwards (req 2).
//
// WHY REPORTED track/speed AND NOT A FIT THROUGH CONSECUTIVE FIXES: measured
// 2026-07-14 against /api/adsb/global, only 13.5% of consecutive same-source fix
// pairs yield a great-circle speed within ±10% of the reported `velocity_ms`
// (median error +47%). The fix TIMEBASE (`seen_at - seen_pos_s`) is too coarse to
// differentiate — but `velocity_ms`/`track_deg` are the aircraft's OWN downlinked
// GNSS ground speed and track. They are the authoritative signal; positions are
// the noisy one. So we integrate the reported vector and use fixes only to
// re-anchor. This is also why the old code overshot then snapped back.
//
// See docs/decisions.md + the scratchpad findings for the full measurement.

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;

/** Meridional + prime-vertical radii of curvature (metres per radian) at `latRad`. */
function radii(latRad: number): { m: number; n: number } {
  const s = Math.sin(latRad);
  const w2 = 1 - WGS84_E2 * s * s;
  return { m: (WGS84_A * (1 - WGS84_E2)) / (w2 * Math.sqrt(w2)), n: WGS84_A / Math.sqrt(w2) };
}

/**
 * Advance a geodetic point `distM` metres along constant bearing `trackRad`.
 * Uses the local radii of curvature so the travelled ground distance is exactly
 * `distM` — that exactness is requirement 1 (speed == reported speed).
 */
export function advance(
  lonRad: number,
  latRad: number,
  trackRad: number,
  distM: number,
): { lonRad: number; latRad: number } {
  const { m, n } = radii(latRad);
  const north = distM * Math.cos(trackRad);
  const east = distM * Math.sin(trackRad);
  const lat2 = latRad + north / m;
  // Mid-latitude for the east step: second-order accurate, so a 60 s projection
  // at 300 m/s (18 km) stays sub-metre instead of drifting with the cosine.
  const latMid = latRad + north / (2 * m);
  const cosMid = Math.cos(latMid);
  // Pole guard: cos → 0 would blow the longitude step up. Aircraft this close to
  // a pole are vanishingly rare and sub-pixel anyway.
  const cosSafe = Math.sign(cosMid || 1) * Math.max(Math.abs(cosMid), 1e-6);
  let lon2 = lonRad + east / (n * cosSafe);
  // Wrap to [-π, π] so the antimeridian doesn't produce a runaway longitude.
  if (lon2 > Math.PI) lon2 -= 2 * Math.PI;
  else if (lon2 < -Math.PI) lon2 += 2 * Math.PI;
  return { lonRad: lon2, latRad: lat2 };
}

/** Signed along-track metres from A to B, projected on `trackRad`. */
export function alongTrackM(
  aLonRad: number,
  aLatRad: number,
  bLonRad: number,
  bLatRad: number,
  trackRad: number,
): number {
  const { m, n } = radii(aLatRad);
  const dN = (bLatRad - aLatRad) * m;
  const dE = (bLonRad - aLonRad) * n * Math.cos(aLatRad);
  return dN * Math.cos(trackRad) + dE * Math.sin(trackRad);
}

/** A real fix as reported by /api/adsb/global. */
export type DrFix = {
  lonDeg: number;
  latDeg: number;
  altM: number;
  /** Reported track (deg true). null → not projectable. */
  trackDeg: number | null;
  /** Reported ground speed (m/s). null → not projectable. */
  speedMs: number | null;
  /** How old this POSITION is, in seconds (`seen_at - seen_pos_s` vs now). */
  ageS: number;
  onGround: boolean;
};

/**
 * A contact's motion anchor. `frozen` contacts hold still at `lon/lat` — that is
 * the TELEPORT behaviour, reused for anything we must not invent motion for.
 */
export type DrState = {
  lonRad: number;
  latRad: number;
  altM: number;
  trackRad: number;
  speedMs: number;
  /** Sim-clock seconds at which the contact was AT lon/lat. */
  t0: number;
  /** Seconds past t0 after which motion HOLDs (coast limit). */
  holdS: number;
  frozen: boolean;
  /** Consecutive fixes that landed behind our projection (see DR_BACK_TOLERATE). */
  backCount: number;
};

// Below this ground speed a contact is taxiing/parked — projecting it just makes
// GPS noise look like motion.
export const DR_MIN_SPEED_MS = 15;
// A fix older than this is NOT dead-reckoned. The p90 of position age is ~69 s
// and p95 ~184 s (the OpenSky breadth tier, a once-per-UTC-day cache); flying a
// 3-minute-old fix forward at 250 m/s invents ~45 km of fiction. Those contacts
// hold at their last reported position instead — honest, and the PredictedMotion
// badge already says positions are estimated.
export const DR_MAX_FIX_AGE_S = 45;
// Cap on how far back a fix's own age may push the anchor. Bounds the projection
// a single stale-ish fix can trigger.
export const DR_MAX_ANCHOR_AGE_S = 30;
// Coast limit: with no fresh fix, keep flying the last reported vector for this
// long, then HOLD. Live contacts re-fix every ~6 s (measured p50 6.2 s, p99
// 10.4 s), so a healthy contact is always mid-coast and moves continuously; one
// that truly lost signal coasts ~1 min then stops rather than flying off forever.
export const DR_COAST_MAX_S = 60;
// Phase deadband. A new fix rarely lands exactly where we projected; the residual
// is absorbed as a TIME shift (fly the same true track at the same true speed,
// just phase-shifted) instead of a position jump — smooth, and it changes neither
// speed nor direction. Beyond this the model has genuinely lost the contact
// (reacquisition, manoeuvre, bad fix) and we re-anchor to truth in ONE frame.
//
// A snap is a single-frame position correction. It is NOT the operator's "goes in
// reverse" complaint, which was the old code GLIDING backwards over up to 30 s.
// Never trade a snap for a backwards glide.
export const DR_PHASE_DEADBAND_S = 2.5;
// How many CONSECUTIVE fixes must agree that the contact is behind our
// projection before we believe them and re-anchor backwards.
//
// WHY THIS EXISTS: the feed still lands the occasional fix ~1-2 km BEHIND the
// contact's own trajectory — measured 2026-07-14, ~1% of airborne moves even
// after the backend's freshest-wins union fix, because some contacts are covered
// only by a source that oscillates between aggregators with different lag. A
// one-off backward fix is that noise, and honouring it is EXACTLY the "plane goes
// in reverse" the operator rejects. So a lone backward fix is IGNORED (we keep
// flying the last good vector — still real reported track+speed, never invented).
//
// It is a tolerance, not a veto: if the contact is CONSISTENTLY behind us we were
// genuinely wrong (a real reposition, a turn we flew through, a corrected bad
// fix), and after this many fixes we re-anchor to truth. At the measured ~6 s
// cadence that is ~18 s to correct a real disagreement, versus never showing a
// transient reverse. Forward fixes reset the count immediately.
export const DR_BACK_TOLERATE = 3;
// Backward tolerance for FROZEN (stale-fix) contacts, in metres — they have no
// projection to phase-shift, so the deadband is a distance, not a time. 250 m
// matches the backend's _BACKWARD_REJECT_M: ADS-B position noise is ~10-30 m, so
// 250 m of reverse is never real jitter.
export const DR_FROZEN_BACK_M = 250;

/** Where `s` renders at sim-clock time `tSec`. */
export function projectAt(s: DrState, tSec: number): { lonRad: number; latRad: number } {
  if (s.frozen || s.speedMs <= 0) return { lonRad: s.lonRad, latRad: s.latRad };
  // max(0, …) ⇒ never reverse; min(holdS, …) ⇒ HOLD past the coast limit.
  const dt = Math.max(0, Math.min(tSec - s.t0, s.holdS));
  if (dt <= 0) return { lonRad: s.lonRad, latRad: s.latRad };
  return advance(s.lonRad, s.latRad, s.trackRad, s.speedMs * dt);
}

/**
 * Fold a REAL fix into the motion model.
 *
 * `prev` is this contact's current state (undefined on first sight), `nowSec` the
 * sim-clock time the fix was applied. Returns the new anchor.
 */
export function ingestFix(prev: DrState | undefined, fix: DrFix, nowSec: number): DrState {
  const lonRad = (fix.lonDeg * Math.PI) / 180;
  const latRad = (fix.latDeg * Math.PI) / 180;

  const projectable =
    !fix.onGround &&
    fix.trackDeg != null &&
    fix.speedMs != null &&
    Number.isFinite(fix.trackDeg) &&
    Number.isFinite(fix.speedMs) &&
    fix.speedMs >= DR_MIN_SPEED_MS &&
    fix.ageS <= DR_MAX_FIX_AGE_S;

  if (!projectable) {
    // Parked / on-ground / stale → hold at the reported position. No synthesis:
    // a frozen contact TELEPORTS to each real fix, exactly like the default path.
    //
    // Keep the reported track even while frozen, so the backward guard below has
    // a bearing to project on.
    const trackRad =
      fix.trackDeg != null && Number.isFinite(fix.trackDeg)
        ? (fix.trackDeg * Math.PI) / 180
        : (prev?.trackRad ?? 0);
    const frozen: DrState = {
      lonRad,
      latRad,
      altM: fix.altM,
      trackRad,
      speedMs: 0,
      t0: nowSec,
      holdS: 0,
      frozen: true,
      backCount: 0,
    };
    // A contact frozen only because its fix is STALE (airborne, moving, but the
    // breadth tier is minutes behind) still mirrors the feed verbatim — so a feed
    // that regresses walks the icon backwards for as long as it keeps regressing.
    // Measured live: this was the ONLY remaining way to see sustained reverse
    // (runs of up to 12 consecutive frames). Same tolerance as the projected path:
    // ignore a lone backward fix, believe a persistent one.
    //
    // Deliberately NOT applied to on-ground or parked contacts: pushback is
    // literally backwards, and a parked contact's track is meaningless noise.
    const guardable =
      !fix.onGround &&
      fix.speedMs != null &&
      fix.speedMs >= DR_MIN_SPEED_MS &&
      fix.trackDeg != null &&
      Number.isFinite(fix.trackDeg);
    if (prev && guardable) {
      const cur = projectAt(prev, nowSec);
      const back = alongTrackM(cur.lonRad, cur.latRad, lonRad, latRad, trackRad);
      if (back < -DR_FROZEN_BACK_M && prev.backCount + 1 < DR_BACK_TOLERATE) {
        return { ...prev, backCount: prev.backCount + 1 };
      }
    }
    return frozen;
  }

  // Anchor at the fix's OWN observation time, so at `nowSec` the icon already
  // renders the fix carried forward by its age — the aircraft is where it IS, not
  // where it was when the packet left it.
  const ageS = Math.min(Math.max(fix.ageS, 0), DR_MAX_ANCHOR_AGE_S);
  const cand: DrState = {
    lonRad,
    latRad,
    altM: fix.altM,
    trackRad: ((fix.trackDeg as number) * Math.PI) / 180,
    speedMs: fix.speedMs as number,
    t0: nowSec - ageS,
    holdS: DR_COAST_MAX_S,
    frozen: false,
    backCount: 0,
  };

  if (prev && !prev.frozen && prev.speedMs > 0) {
    const cur = projectAt(prev, nowSec);
    const next = projectAt(cand, nowSec);
    const along = alongTrackM(cur.lonRad, cur.latRad, next.lonRad, next.latRad, cand.trackRad);
    const phaseS = along / cand.speedMs;
    if (Math.abs(phaseS) <= DR_PHASE_DEADBAND_S) {
      // Inside the deadband: shift the anchor in TIME so the icon keeps rendering
      // where it already is (continuity, no jump) while flying the fix's true
      // track at its true speed. The residual lag stays inside the deadband — it
      // cannot accumulate, because every fix re-derives it from truth rather than
      // compounding.
      cand.t0 += phaseS;
      return cand;
    }
    if (phaseS < 0) {
      // The fix is materially BEHIND our projection. Believe it only once
      // consecutive fixes agree (see DR_BACK_TOLERATE) — a lone one is feed noise
      // and honouring it would show the operator a reverse.
      const backCount = prev.backCount + 1;
      if (backCount < DR_BACK_TOLERATE) {
        // Keep flying the previous anchor untouched. Its track/speed are still
        // the contact's own last REPORTED values, so this invents nothing; we
        // simply decline to teleport backwards on one disagreeing fix.
        return { ...prev, backCount };
      }
      // Consistently behind → we were wrong. Re-anchor to truth.
      cand.backCount = 0;
      return cand;
    }
    // Materially AHEAD of us → we were lagging; re-anchor forward immediately.
  }
  return cand;
}
