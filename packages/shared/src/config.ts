// Runtime config returned by GET /api/config.
// The Cesium ion token is the ONLY upstream key the browser ever sees.

export interface RuntimeConfig {
  cesiumIonToken: string;
  features: {
    enableGoogle3D: boolean;
  };
  classification: string; // banner label, e.g. 'UNCLAS'
  buildId: string;
}
