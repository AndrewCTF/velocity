// Imagery/terrain licenses require visible attribution (EOX CC BY-NC-SA,
// Carto/OSM, Esri, Mapzen/AWS). The Cesium credit container is hidden for
// dark-chrome reasons, so this fixed footer is the attribution surface.
export function Attribution(): JSX.Element {
  return (
    <div className="pointer-events-none fixed bottom-1 right-2 z-40 text-[10px] leading-none text-slate-500">
      © OpenStreetMap · © CARTO · Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0, contains modified
      Copernicus Sentinel data) · Imagery © Esri · Terrain © Mapzen/AWS Open Data
    </div>
  );
}
