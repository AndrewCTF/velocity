import { describe, expect, it } from "vitest";
import { metresPerPx, mosaic, project, worldPx } from "./plate.js";

describe("plate maths", () => {
  it("puts the centre at the origin and east/north in the right direction", () => {
    expect(project(55, 25, 12, 55, 25)).toEqual([0, 0]);
    const [dx, dy] = project(55, 25, 12, 55.01, 25.01);
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeLessThan(0);
  });
  it("covers the window with tiles whose union contains the centre", () => {
    const m = mosaic(55.48, 25.47, 11, 640, 360);
    expect(m.length).toBeGreaterThanOrEqual(4);
    expect(m.some((t) => t.x <= 0 && t.y <= 0 && t.x + 256 > 0 && t.y + 256 > 0)).toBe(true);
    expect(m.every((t) => t.x + 256 > -320 && t.x < 320 && t.y + 256 > -180 && t.y < 180)).toBe(true);
    expect(new Set(m.map((t) => t.key)).size).toBe(m.length);
  });
  it("drops tiles off the world and halves the ground pixel per zoom", () => {
    expect(mosaic(179.99, 0, 1, 2000, 100).every((t) => !t.key.includes("/2/"))).toBe(true);
    expect(metresPerPx(0, 1) * 2).toBeCloseTo(metresPerPx(0, 0), 6);
    expect(worldPx(0, 0, 0)).toEqual([128, 128]);
  });
});
