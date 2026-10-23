import { describe, expect, it } from "vitest";
import { destination, distNm, hms, mgrs } from "./geo.js";
import { rank, type Asset } from "./recommend.js";
import { DEFAULT_WEIGHTS } from "./taskings.js";

describe("watch workspace geodesy", () => {
  // Reference values from the page generator's own MGRS routine (python).
  it.each([
    [26.2274, 56.1445, "40R DQ 14547 01149"],
    [-33.8688, 151.2093, "56H LH 34368 50948"],
    [40.6893, -74.0445, "18T WL 80735 04706"],
    [51.5, -0.12, "30U XC 99889 09362"],
  ])("mgrs(%f, %f) = %s", (lat, lon, want) => {
    expect(mgrs(lat, lon)).toBe(want);
  });

  it("destination and distance agree", () => {
    const [lat, lon] = destination(26.2, 56.1, 73, 4.5);
    expect(distNm(26.2, 56.1, lat, lon)).toBeCloseTo(4.5, 3);
  });

  it("hms prints minutes and seconds, hours past an hour", () => {
    expect(hms(2182)).toBe("36m 22s");
    expect(hms(7300)).toBe("2h 01m");
    expect(hms(NaN)).toBe("N/A");
  });
});

describe("asset ranking", () => {
  const air = (id: string, d: number, ttt: number): Asset => ({
    id,
    kind: "air",
    label: id,
    chip: "",
    taskType: "VISUAL FOLLOW",
    source: "ADS-B",
    at: 0,
    distNm: d,
    tttS: ttt,
  });
  it("orders by weighted score and labels the matches", () => {
    const r = rank(
      [air("far", 300, 7200), air("near", 10, 120), air("mid", 60, 900)],
      DEFAULT_WEIGHTS,
    );
    expect(r.map((x) => x.asset.id)).toEqual(["near", "mid", "far"]);
    expect(r[0]!.match).toBe("Top Match");
    expect(r[0]!.bar).toBe(1);
    expect(r[2]!.match).toBe("Fair Match");
  });
  it("a zero weight removes the metric", () => {
    const w = { ...DEFAULT_WEIGHTS, ttt: 0, dist: 0 };
    const r = rank([air("a", 10, 60), air("b", 500, 9000)], w);
    expect(r[0]!.score).toBeCloseTo(r[1]!.score, 9);
  });
});

describe("imagery plate maths", () => {
  it("pixel and position round-trip on the plate", async () => {
    const { makePlate, toPx, toLL, gsd } = await import("./fmvPlate.js");
    const p = makePlate(27.107, 56.059);
    const [x, y] = toPx(p, 27.107, 56.059);
    const [lat, lon] = toLL(p, x, y);
    expect(lat).toBeCloseTo(27.107, 6);
    expect(lon).toBeCloseTo(56.059, 6);
    // z17 at 27 N is about 1.06 m per pixel
    expect(gsd(p)).toBeCloseTo(1.064, 2);
  });
});
