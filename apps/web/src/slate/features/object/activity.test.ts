import { describe, expect, it } from "vitest";
import { bandCounts, distKm, hourlyBaseline, scaleMax } from "./activity.js";

describe("object activity", () => {
  it("bins contacts into 3.5 km bands and drops those past 28 km", () => {
    const lat = 27;
    const lon = 56;
    const north = (km: number) => ({ lat: lat + km / 111.2, lon });
    const c = bandCounts(lat, lon, [
      north(1),
      north(3),
      north(5),
      north(27),
      north(40),
    ]);
    expect(c).toEqual([2, 1, 0, 0, 0, 0, 0, 1]);
    expect(distKm(lat, lon, north(10).lat, lon)).toBeCloseTo(10, 0);
  });

  it("averages per archived hour, counting each id once per hour", () => {
    const lat = 27;
    const lon = 56;
    const p = (t: number) => [lon, lat + 0.01, t, 0];
    // Hour A: two ids (one with two fixes); hour B: one id.
    const b = hourlyBaseline(lat, lon, [
      {
        id: "v:1",
        points: [p(3600 * 10 + 1), p(3600 * 10 + 5), p(3600 * 11 + 1)],
      },
      { id: "v:2", points: [p(3600 * 10 + 9)] },
    ]);
    expect(b).toBeCloseTo((2 + 1) / 2 / 8);
    expect(hourlyBaseline(lat, lon, [])).toBeNull();
  });

  it("keeps the top tick a multiple of 3 and at least 6", () => {
    expect(scaleMax([0, 1, 2], null)).toBe(6);
    expect(scaleMax([0, 7], null)).toBe(9);
    expect(scaleMax([1], 10.2)).toBe(12);
  });
});
