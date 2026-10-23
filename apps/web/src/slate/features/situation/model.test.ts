import { describe, expect, it } from "vitest";
import {
  authorityShort,
  classCounts,
  farthestPick,
  nearestWarnings,
  published,
  tclass,
  wrapChips,
} from "./model.js";

describe("situation object model", () => {
  it("classes AIS types as the copy does", () => {
    expect(tclass(52)).toBe("Tug / special craft");
    expect(tclass("84")).toBe("Tanker");
    expect(tclass("Cargo ship")).toBe("Cargo");
    expect(tclass(null)).toBe("Other");
    expect(classCounts([80, 81, 70, 52])).toEqual([
      ["Tanker", 2],
      ["Cargo", 1],
      ["Tug / special craft", 1],
    ]);
  });

  it("keeps warnings within range, nearest first, one per message", () => {
    const f = (n: number, lon: number, lat: number) => ({
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { msgNumber: n, msgYear: 2023, text: `w${n}` },
    });
    const w = nearestWarnings(
      {
        features: [
          f(1, 56.3, 27),
          f(2, 56.1, 27),
          f(2, 56.05, 27),
          f(3, 60, 27),
        ],
      },
      27,
      56,
    );
    expect(w.map((x) => x.msgNumber)).toEqual([2, 1]);
    expect(w[0]!.d_km).toBeCloseTo(4.96, 1);
  });

  it("reads NGA dates and authorities", () => {
    expect(published("091931Z JUN 2023")).toBe("09 Jun 2023");
    expect(authorityShort("NAVAREA IX 245/23 091931Z JUN 23.")).toBe(
      "NAVAREA IX 245/23",
    );
  });

  it("picks points that are apart", () => {
    const pts = [0, 1, 2, 10, 11, 20].map((x) => ({ x, y: 0 }));
    expect(farthestPick(pts, 3).map((p) => p.x)).toEqual([0, 20, 10]);
  });

  it("wraps at the column and marks chip phrases across lines", () => {
    const l = wrapChips(
      "PERSIAN GULF. DANGEROUS WRECK, LEAST DEPTH",
      ["GULF. DANGEROUS"],
      22,
    );
    expect(l.map((s) => s.map((x) => x.t).join(""))).toEqual([
      "PERSIAN GULF.",
      "DANGEROUS WRECK, LEAST",
      "DEPTH",
    ]);
    expect(l[0]).toEqual([
      { t: "PERSIAN ", chip: false },
      { t: "GULF.", chip: true },
    ]);
    expect(l[1]![0]).toEqual({ t: "DANGEROUS", chip: true });
  });
});
