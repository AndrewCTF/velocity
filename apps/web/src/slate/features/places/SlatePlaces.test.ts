import { describe, expect, it } from "vitest";
import { maxRankAt, pickLabel } from "./SlatePlaces.js";
import rows from "./countryLabels.json";

describe("country labels", () => {
  it("names a country at the candidate nearest its on-screen middle", () => {
    expect(pickLabel([])).toBeNull();
    expect(
      pickLabel([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 45, y: 5 },
      ]),
    ).toEqual({ x: 45, y: 5 });
  });

  it("thins to the large countries as the camera rises", () => {
    expect(maxRankAt(300_000)).toBeGreaterThan(maxRankAt(5_000_000));
    expect(maxRankAt(5_000_000)).toBeGreaterThan(maxRankAt(20_000_000));
  });

  it("ships rank-ordered rows with lon/lat pairs", () => {
    const r = rows as unknown as [string, number, number[], string][];
    expect(r.length).toBeGreaterThan(200);
    for (let i = 1; i < r.length; i++)
      expect(r[i]![1]).toBeGreaterThanOrEqual(r[i - 1]![1]);
    const oman = r.find((x) => x[0] === "OMAN");
    expect(oman && oman[2].length % 2).toBe(0);
  });
});

describe("farFor", () => {
  it("keeps the biggest countries at every height and hides small ones when far", async () => {
    const { farFor } = await import("./SlatePlaces.js");
    expect(farFor(1)).toBe(Number.POSITIVE_INFINITY);
    expect(farFor(4)).toBe(7_000_000);
    expect(farFor(8)).toBe(2_500_000);
  });
});
