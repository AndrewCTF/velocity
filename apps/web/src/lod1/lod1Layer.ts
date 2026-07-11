import * as Cesium from 'cesium';

import { apiFetch } from '../transport/http.js';

let current: Cesium.GeoJsonDataSource | null = null;

interface BuildingItem {
  e: Cesium.Entity;
  ext: number; // extruded height above its own base (m)
  carto: Cesium.Cartographic; // a representative footprint vertex
}

// Pin each building's base to the terrain height beneath it. LOD1 footprints
// carry no elevation, so a base left at ellipsoid height 0 sits at sea level —
// correct on the flat 2d-dark ellipsoid, but on real terrain (3d-sat) the
// buildings float above / sink below the ground. `sampleTerrainMostDetailed`
// is unusable here (our cesium-martini provider exposes no tile availability),
// so we read the loaded surface via `globe.getHeight`.
//
// The hard part (found by live probing over Beirut, coast): getHeight resolves
// as soon as ANY tile covers the point, but a coarse early tile there decodes
// to a bathymetry-skewed ~-330 m and stays that way for ~15-20 s of the fly-in
// before finer land tiles refine it to the true ~+30 m. A fixed poll loses that
// race — it "settles" on the stable-but-coarse value and stops before the
// refinement lands. So we drive off terrain itself: re-clamp EVERY time the
// terrain tile queue drains (a new LOD has streamed in), so bases track the
// height coarse→fine however long refinement takes, bounded by a generous
// lifetime and torn down when the layer is cleared. No-op on the ellipsoid.
function clampBasesToTerrain(
  viewer: Cesium.Viewer,
  ds: Cesium.GeoJsonDataSource,
  items: BuildingItem[],
): void {
  if (viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) return;
  const globe = viewer.scene.globe;
  const apply = (): boolean => {
    if (ds !== current) return false; // swapped out or cleared — stop
    let any = false;
    for (const it of items) {
      if (!it.e.polygon) continue;
      const gh = globe.getHeight(it.carto);
      if (gh == null) continue;
      it.e.polygon.height = new Cesium.ConstantProperty(gh);
      it.e.polygon.extrudedHeight = new Cesium.ConstantProperty(gh + it.ext);
      any = true;
    }
    if (any) viewer.scene.requestRender();
    return true;
  };
  apply(); // best-effort immediately with whatever terrain is already loaded
  let stop = (): void => {};
  const remove = globe.tileLoadProgressEvent.addEventListener((queued: number) => {
    // queued === 0 means the terrain tiles for the current view have finished
    // loading — re-sample so bases follow each refinement. apply() returns
    // false once the layer is gone, at which point we unsubscribe.
    if (queued > 0) return;
    if (!apply()) stop();
  });
  // Hard stop after a generous window so we don't re-clamp forever as the user
  // pans elsewhere; refinement over an AOI settles well within this.
  const timer = setTimeout(() => stop(), 45_000);
  stop = (): void => {
    remove();
    clearTimeout(timer);
  };
}

// Extrude an LOD1 GeoJSON FeatureCollection in place: height from properties,
// damaged buildings red and knocked down to a rubble height. Returns the data
// source so the caller can decide whether to fly to it.
async function extrude(viewer: Cesium.Viewer, gj: unknown): Promise<Cesium.GeoJsonDataSource> {
  if (current) {
    viewer.dataSources.remove(current, true);
    current = null;
  }
  const ds = await Cesium.GeoJsonDataSource.load(gj, { clampToGround: false });
  const intact = Cesium.Color.fromCssColorString('#b8ad97');
  const dmgCol = Cesium.Color.fromCssColorString('#e23b2e');
  const now = Cesium.JulianDate.now();
  const items: BuildingItem[] = [];
  for (const e of ds.entities.values) {
    if (!e.polygon) continue;
    const h = (e.properties?.height?.getValue?.(now) as number) ?? 12;
    const dmg = (e.properties?.damaged?.getValue?.(now) as boolean) ?? false;
    const ext = dmg ? h * 0.25 : h;
    e.polygon.height = new Cesium.ConstantProperty(0);
    e.polygon.extrudedHeight = new Cesium.ConstantProperty(ext);
    e.polygon.material = new Cesium.ColorMaterialProperty(dmg ? dmgCol : intact);
    e.polygon.outline = new Cesium.ConstantProperty(false);
    const hierarchy = e.polygon.hierarchy?.getValue(now) as Cesium.PolygonHierarchy | undefined;
    const p0 = hierarchy?.positions?.[0];
    if (p0) items.push({ e, ext, carto: Cesium.Cartographic.fromCartesian(p0) });
  }
  await viewer.dataSources.add(ds);
  current = ds;
  // Buildings render at base 0 immediately, then settle onto the terrain as
  // tiles stream in (event-driven, self-tearing-down).
  clampBasesToTerrain(viewer, ds, items);
  return ds;
}

// Load a curated war-damage AOI (footprints + Sentinel-1 damage flag) and fly
// the camera in tilted. Used by the named presets (e.g. Beirut Dahieh).
export async function loadLod1(viewer: Cesium.Viewer, aoi: string): Promise<number> {
  const r = await apiFetch(`/api/intel/lod1?aoi=${encodeURIComponent(aoi)}`);
  if (!r.ok) throw new Error(`lod1 ${r.status}`);
  const ds = await extrude(viewer, await r.json());
  await viewer.flyTo(ds, {
    duration: 2.5,
    offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(20), Cesium.Math.toRadians(-32), 2200),
  });
  return ds.entities.values.length;
}

// Load freeform buildings for an arbitrary bbox (lon0,lat0,lon1,lat1) — anywhere
// on Earth. Does NOT fly the camera: the user asked for "buildings here", so we
// extrude in place under the current view. Returns the building count.
export async function loadLod1Bbox(
  viewer: Cesium.Viewer,
  bbox: [number, number, number, number],
): Promise<number> {
  const r = await apiFetch(`/api/intel/lod1?bbox=${bbox.join(',')}`);
  if (!r.ok) throw new Error(`lod1 ${r.status}`);
  const ds = await extrude(viewer, await r.json());
  viewer.scene.requestRender();
  return ds.entities.values.length;
}

export function clearLod1(viewer: Cesium.Viewer): void {
  if (current) {
    viewer.dataSources.remove(current, true);
    current = null;
  }
}
