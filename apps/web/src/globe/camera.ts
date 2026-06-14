import * as Cesium from 'cesium';
import type { Chokepoint } from '../registry/chokepoints.js';

// Camera helpers. All slews respect prefers-reduced-motion via the duration arg
// passed by the caller (0 = instant set).

export function flyToChokepoint(viewer: Cesium.Viewer, c: Chokepoint, durationSec = 1.4): void {
  const [west, south, east, north] = c.bbox;
  const rect = Cesium.Rectangle.fromDegrees(west, south, east, north);
  viewer.camera.flyTo({
    destination: rect,
    duration: durationSec,
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-55), // tilt for situational awareness
      roll: 0,
    },
  });
}

export function flyToPosition(
  viewer: Cesium.Viewer,
  lon: number,
  lat: number,
  altMeters = 350_000,
  durationSec = 0.8,
): void {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, altMeters),
    duration: durationSec,
  });
}

export function flyToGlobal(viewer: Cesium.Viewer, durationSec = 1.0): void {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(20, 35, 22_000_000),
    duration: durationSec,
    orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
  });
}

// Find an entity by id across all data sources + the root collection.
function findEntity(viewer: Cesium.Viewer, entityId: string): Cesium.Entity | null {
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const e = viewer.dataSources.get(i).entities.getById(entityId);
    if (e) return e;
  }
  return viewer.entities.getById(entityId) ?? null;
}

// CONTINUOUS follow — the camera stays centred on the entity as its position
// updates (FR24 "follow this flight"). Cesium's trackedEntity reads the
// entity's SampledPositionProperty every frame, so the camera flies WITH the
// aircraft instead of a one-shot slew that stops the moment it lands. Returns
// false when the entity isn't on the globe (e.g. it left the viewport).
// Active-follow bookkeeping so we can keep the camera glued to the contact even
// as the feed prunes + re-adds its entity on a poll (which would otherwise
// orphan viewer.trackedEntity and freeze/lose the camera).
let followId: string | null = null;
let followTick: (() => void) | null = null;

export function followEntity(viewer: Cesium.Viewer, entityId: string): boolean {
  const e = findEntity(viewer, entityId);
  if (!e) return false;
  stopFollow(viewer); // clear any prior follow first
  followId = entityId;
  // The tracked camera is recomputed every clock tick, but under
  // requestRenderMode nothing schedules a render for that move, so the view
  // froze the instant the initial slew ended ("follow doesn't work" / "doesn't
  // follow fast enough"). Force continuous rendering for the follow's duration;
  // stopFollow restores the power-saving default.
  viewer.scene.requestRenderMode = false;
  viewer.trackedEntity = e; // trackedEntity keeps the icon centred + orbitable
  // Re-assert the tracked entity whenever the feed replaces it. A poll that
  // momentarily drops then re-adds this contact creates a NEW Entity object;
  // viewer.trackedEntity still points at the destroyed one, so the camera
  // stopped following and the icon "went missing". On each tick, if a live
  // entity with our id exists but isn't the one we're tracking, re-point. The
  // identity guard means no churn (and no re-zoom) on the common path.
  followTick = (): void => {
    if (!followId) return;
    const live = findEntity(viewer, followId);
    if (live && viewer.trackedEntity !== live) viewer.trackedEntity = live;
  };
  viewer.clock.onTick.addEventListener(followTick);
  return true;
}

export function stopFollow(viewer: Cesium.Viewer): void {
  followId = null;
  if (followTick) {
    viewer.clock.onTick.removeEventListener(followTick);
    followTick = null;
  }
  viewer.trackedEntity = undefined;
  // Restore the default scene's power-saving render mode (CLAUDE.md invariant).
  viewer.scene.requestRenderMode = true;
}

export function isFollowing(viewer: Cesium.Viewer, entityId: string | null): boolean {
  const t = viewer.trackedEntity;
  return !!t && !!entityId && t.id === entityId;
}
