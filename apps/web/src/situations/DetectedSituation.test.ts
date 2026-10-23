import { describe, it, expect } from "vitest";
import { nextSarPass } from "./DetectedSituation.js";
import { sensorOf } from "../registry/sensorSats.js";

// Real Sentinel-1A element set captured from /api/space/gp; time pinned to its epoch.
const S1A = {
  OBJECT_NAME: "SENTINEL-1A",
  NORAD_CAT_ID: "39634",
  TLE_LINE1:
    "1 39634U 14016A   26294.30414515  .00000216  00000+0  54790-4 0  9990",
  TLE_LINE2:
    "2 39634  98.1600 299.8491 0001412  81.4885 278.6475 14.59842247668415",
};
const EPOCH_MS = 1792567078140;

describe("nextSarPass", () => {
  it("finds a high Sentinel-1A pass over the Gulf within 48 h of epoch", () => {
    const p = nextSarPass([S1A], 25.29, 55.29, EPOCH_MS);
    expect(p).not.toBeNull();
    expect(p!.satName).toBe("SENTINEL-1A");
    expect(p!.maxElevDeg).toBeGreaterThanOrEqual(30);
    expect(p!.startMs).toBeGreaterThanOrEqual(EPOCH_MS);
  });

  it("classifies Sentinel-1 by NORAD only, never Sentinel-2 by name", () => {
    expect(sensorOf("SENTINEL-1A", 39634)?.sensor).toBe("SAR");
    expect(sensorOf("SENTINEL-2A", 40697)).toBeUndefined();
  });

  it("ignores satellites that are not Sentinel-1", () => {
    const iss = { ...S1A, OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 };
    expect(nextSarPass([iss], 25.29, 55.29, EPOCH_MS)).toBeNull();
  });
});
