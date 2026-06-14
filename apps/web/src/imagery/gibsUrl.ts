// Backend proxy URL for a GIBS layer on a given UTC date. Cesium fills
// {z}/{x}/{y}; the backend re-templates to the GIBS WMTS-REST upstream.
export function gibsOverlayUrl(layer: string, date: string): string {
  return `/api/imagery/gibs/${layer}/{z}/{x}/{y}?date=${date}`;
}
