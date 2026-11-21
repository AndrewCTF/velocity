import { describe, expect, it } from "vitest";
import { frameZoom } from "./frameFit.js";

describe("frameZoom", () => {
  it("fits a frame to a host smaller than the 1080p well", () => {
    expect(frameZoom(1324, 676, 1590, 916)).toBeCloseTo(676 / 916);
  });
  it("matches plain fit in the 1920x1080 well", () => {
    expect(frameZoom(1878, 988, 1590, 916)).toBeCloseTo(Math.min(1878 / 1590, 988 / 916));
  });
  it("does not grow past its 1080p zoom in a larger window", () => {
    expect(frameZoom(2518, 1348, 1590, 916)).toBeCloseTo(frameZoom(1878, 988, 1590, 916));
  });
});
