import { describe, expect, it } from "vitest";
import { SATH, SATW } from "./data.js";
import { coverView } from "./SatMap.js";

describe("coverView", () => {
  it.each([
    [1366, 700],
    [2300, 1000],
    [800, 1200],
  ])("covers a %ix%i pane with the mosaic, centred", (w, h) => {
    const { k, mx, my } = coverView(w, h);
    expect(mx).toBeGreaterThanOrEqual(-1e-9);
    expect(my).toBeGreaterThanOrEqual(-1e-9);
    expect(mx + w / k).toBeLessThanOrEqual(SATW + 1e-9);
    expect(my + h / k).toBeLessThanOrEqual(SATH + 1e-9);
    expect(Math.abs(mx - (SATW - w / k - mx))).toBeLessThan(1e-9);
  });
});
