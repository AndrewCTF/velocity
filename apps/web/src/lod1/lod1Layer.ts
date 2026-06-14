import * as Cesium from 'cesium';

import { apiFetch } from '../transport/http.js';

let current: Cesium.GeoJsonDataSource | null = null;

// Load the LOD1 building GeoJSON for an AOI and extrude it in the globe:
// height from properties, damaged buildings red. Flies the camera in tilted.
export async function loadLod1(viewer: Cesium.Viewer, aoi: string): Promise<number> {
  const r = await apiFetch(`/api/intel/lod1?aoi=${encodeURIComponent(aoi)}`);
  if (!r.ok) throw new Error(`lod1 ${r.status}`);
  const gj = await r.json();
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
  await viewer.flyTo(ds, {
    duration: 2.5,
    offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(20), Cesium.Math.toRadians(-32), 2200),
  });
  return ds.entities.values.length;
}

export function clearLod1(viewer: Cesium.Viewer): void {
  if (current) {
    viewer.dataSources.remove(current, true);
    current = null;
  }
}
