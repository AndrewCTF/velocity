import * as Cesium from 'cesium';

// Reading a live entity off the viewer. Extracted from EntityPanel so the
// rebuilt Selection panel reads the SAME source rather than growing a second,
// slightly-different copy of these three functions.

export function findEntity(viewer: Cesium.Viewer, id: string): Cesium.Entity | undefined {
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const e = viewer.dataSources.get(i).entities.getById(id);
    if (e) return e;
  }
  return viewer.entities.getById(id);
}

export function readProperties(e: Cesium.Entity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = e.properties;
  if (!props) return out;
  const names = props.propertyNames as readonly string[] | undefined;
  if (!names) return out;
  const now = Cesium.JulianDate.now();
  for (const n of names) {
    const p = (props as unknown as Record<string, Cesium.Property | undefined>)[n];
    if (!p) continue;
    try {
      out[n] = p.getValue(now);
    } catch {
      /* a property that cannot be evaluated at `now` is simply absent */
    }
  }
  return out;
}

export function readPosition(
  e: Cesium.Entity,
  viewer: Cesium.Viewer,
): { lon: number; lat: number; alt: number } | undefined {
  if (!e.position) return undefined;
  const cart = e.position.getValue(viewer.clock.currentTime);
  if (!cart) return undefined;
  const c = Cesium.Cartographic.fromCartesian(cart);
  return {
    lon: Cesium.Math.toDegrees(c.longitude),
    lat: Cesium.Math.toDegrees(c.latitude),
    alt: c.height,
  };
}
