import { describe, expect, it } from "vitest";
import { frac, scaleNm, ticks, zoomFor } from "./view.js";

describe("native foundry view maths", () => {
  it("keeps the reference extent when the pane doubles", () => {
    expect(zoomFor(5, 1000, 1000)).toBeCloseTo(5);
    expect(zoomFor(5, 1000, 2000)).toBeCloseTo(6);
    expect(zoomFor(5, 1000, 500)).toBeCloseTo(4);
    expect(zoomFor(5, 1000, 1000, 1)).toBeCloseTo(6);
  });
  it("clamps to the tile pyramid and fills the world on world pages", () => {
    expect(zoomFor(15, 1000, 4000)).toBe(16);
    expect(zoomFor(1, 1000, 100, -5)).toBe(0);
    expect(zoomFor(2.1, 1135, 2560, 0, true)).toBeCloseTo(
      Math.log2(2560 / 256),
    );
    expect(zoomFor(2.1, 1135, 1135, 0, true)).toBeCloseTo(
      Math.log2(1135 / 256),
    );
    expect(zoomFor(5, 1000, 0)).toBe(5);
  });
  it("places times on a span and survives an empty one", () => {
    expect(frac(5, 0, 10)).toBe(0.5);
    expect(frac(-1, 0, 10)).toBe(0);
    expect(frac(99, 0, 10)).toBe(1);
    expect(frac(3, 4, 4)).toBe(0);
  });
  it("ticks multiples strictly inside the span", () => {
    expect(ticks(0, 30, 10)).toEqual([10, 20]);
    expect(ticks(5, 25, 10)).toEqual([10, 20]);
  });
  it("picks the scale bar nearest 80 px", () => {
    const s = scaleNm((1.852 * 10) / 80);
    expect(s.nm).toBe(10);
    expect(s.px).toBeCloseTo(80);
  });
});
