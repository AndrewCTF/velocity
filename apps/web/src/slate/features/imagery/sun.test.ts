import { describe, expect, it } from "vitest";
import { sunElevationDeg, zoneTime } from "./sun.js";

describe("sun elevation", () => {
  it("is near 90 at the subsolar point and below zero at midnight", () => {
    // 2024-03-20 12:00Z equinox: sun overhead near 0 N, ~0 E.
    const t = Date.UTC(2024, 2, 20, 12, 7);
    expect(sunElevationDeg(0, 0, t)).toBeGreaterThan(88);
    expect(sunElevationDeg(0, 180, t)).toBeLessThan(-80);
  });

  it("matches the copy's Al Hamriyah value (50 deg at 2026-10-22 09:05Z)", () => {
    const t = Date.UTC(2026, 9, 22, 9, 5);
    expect(Math.round(sunElevationDeg(25.48, 55.5, t))).toBe(50);
    expect(zoneTime(55.5, t)).toBe("13:05");
  });
});
