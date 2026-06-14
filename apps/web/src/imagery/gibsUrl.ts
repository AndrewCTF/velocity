// Backend proxy URL for an imagery layer on a given UTC date. Cesium fills
// {z}/{x}/{y}; the backend re-templates to the provider's upstream
// (GIBS WMTS-REST or CDSE Sentinel Hub Process API).
export function imageryOverlayUrl(provider: string, layer: string, date: string): string {
  return `/api/imagery/${provider}/${layer}/{z}/{x}/{y}?date=${date}`;
}
