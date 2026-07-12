// Runtime config returned by GET /api/config.
// Client-visible upstream keys: the Cesium ion token and the Google Maps key
// (both are browser-side keys, restricted by referrer in their consoles).

export interface RuntimeConfig {
  cesiumIonToken: string;
  // Google Maps Platform key (Map Tiles API) for global Photorealistic 3D Tiles.
  // Empty = Google 3D off. Restrict by HTTP referrer in the Google console.
  googleApiKey: string;
  features: {
    enableGoogle3D: boolean;
  };
  classification: string; // banner label, e.g. 'UNCLAS'
  buildId: string;
  // True when the backend is keyless AND ALLOW_UNAUTHENTICATED is on, so the
  // compute/LLM endpoints are served without auth. The UI shows an open-mode
  // banner. Optional for backward compatibility with older backends.
  openMode?: boolean;
}
