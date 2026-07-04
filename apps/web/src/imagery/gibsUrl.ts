// Backend proxy URL for an imagery layer on a given UTC date. Cesium fills
// {z}/{x}/{y}; the backend re-templates to the provider's upstream
// (GIBS WMTS-REST or CDSE Sentinel Hub Process API).
import { backendUrl } from '../transport/http.js';

export function imageryOverlayUrl(provider: string, layer: string, date: string): string {
  return backendUrl(`/api/imagery/${provider}/${layer}/{z}/{x}/{y}?date=${date}`);
}
