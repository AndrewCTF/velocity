import * as Cesium from 'cesium';

import { apiFetch } from '../transport/http.js';

let current: Cesium.GeoJsonDataSource | null = null;

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
  for (const e of ds.entities.values) {
    if (!e.polygon) continue;
    const h = (e.properties?.height?.getValue?.(Cesium.JulianDate.now()) as number) ?? 12;
    const dmg = (e.properties?.damaged?.getValue?.(Cesium.JulianDate.now()) as boolean) ?? false;
    e.polygon.height = new Cesium.ConstantProperty(0);
    e.polygon.extrudedHeight = new Cesium.ConstantProperty(dmg ? h * 0.25 : h);
    e.polygon.material = new Cesium.ColorMaterialProperty(dmg ? dmgCol : intact);
    e.polygon.outline = new Cesium.ConstantProperty(false);
  }
  await viewer.dataSources.add(ds);
  current = ds;
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
