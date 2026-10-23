import { describe, expect, it } from "vitest";
import {
  TRK,
  funnel,
  hhmm,
  km,
  nearbyEvents,
  nearestWarnings,
  placeFor,
  propCounts,
  record,
  results,
  series,
  shown,
  stype,
  valueHist,
  type Alert,
  type Vessel,
  type Warning,
} from "./data.js";
import { toPx } from "./kit.js";

const V = (
  mmsi: number,
  lon: number,
  lat: number,
  extra: Partial<Vessel> = {},
): Vessel => ({
  id: `vessel:${mmsi}`,
  mmsi,
  lon,
  lat,
  t: 1792736000,
  sog: 0,
  name: `V${mmsi}`,
  origin: "AIS",
  ...extra,
});
const port = {
  name: "Al Hamriyah Lpg Terminal",
  lon: 55.483333,
  lat: 25.466667,
};

describe("pdf data", () => {
  it("formats the builder's labels", () => {
    expect(TRK(533132902)).toBe("Track 2902");
    expect(TRK(636000000)).toBe("Track 0000");
    expect(hhmm(1792736050, true)).toBe("06:14:10Z");
    expect(stype("Cargo")).toBe("Cargo");
    expect(stype("TANKER")).toBe("Tanker");
    expect(stype(84)).toBe("Tanker");
    expect(stype(null)).toBe("Unknown");
  });

  it("finds the keyword's place and the hulls within 10 km, nearest first", () => {
    expect(placeFor([port], "al hamriyah")).toBe(port);
    expect(placeFor([port], "Dubai")).toBeNull();
    const vs = [
      V(1, 55.49, 25.47),
      V(2, 55.483, 25.4667),
      V(3, 56.5, 26),
      V(4, 55.48, 25.46, { name: " " }),
    ];
    const r = results(vs, port);
    expect(r.map((h) => h.mmsi)).toEqual([2, 1]);
    expect(km([55, 25], [55, 25])).toBe(0);
  });

  it("lays the selected hit out third", () => {
    const h = [1, 2, 3, 4].map(
      (m) => results([V(m, 55.483 + m * 0.001, 25.4667)], port)[0]!,
    );
    expect(shown(h, h[0]!).map((x) => x.mmsi)).toEqual([2, 3, 1, 4]);
  });

  it("runs the filter path as a funnel and drops removed steps", () => {
    const box = [
      V(1, 55.49, 25.47),
      V(2, 55.483, 25.4667, { sog: 3 }),
      V(3, 56.5, 26),
    ];
    const f = funnel(1000, box, port, ["box", "radius", "stationary"]);
    expect(f.stages.map((s) => [s.from, s.to])).toEqual([
      [1000, 3],
      [3, 2],
      [2, 1],
    ]);
    expect(f.set.map((v) => v.mmsi)).toEqual([1]);
    expect(
      funnel(1000, box, port, ["box", "stationary"]).set.map((v) => v.mmsi),
    ).toEqual([1, 3]);
    expect(funnel(1000, box, port, []).set).toHaveLength(3);
  });

  it("counts properties with Origin sixth and histograms a property", () => {
    const set = [
      V(1, 0, 0, { origin: "AIS", heading: 3 }),
      V(2, 0, 0, { origin: "aishub" }),
      V(3, 0, 0, { origin: "AIS" }),
    ];
    const p = propCounts(set);
    expect(p[5]![0]).toBe("Origin");
    expect(p.find((x) => x[0] === "Heading")![1]).toBe(1);
    expect(valueHist(set, "Origin")).toEqual([
      ["AIS", 2],
      ["aishub", 1],
    ]);
  });

  it("words nearby events and nearest warnings", () => {
    const al: Alert[] = [
      {
        id: "a",
        severity: "high",
        t: 1792736050000,
        geom: { coordinates: [55.6, 25.5] },
        message: "",
        contributingObservations: ["55.5:25.5:ais-gap+dark-vessel"],
      },
      {
        id: "b",
        severity: "high",
        t: 1792736050000,
        geom: { coordinates: [28, 60] },
        message: "",
        contributingObservations: ["x"],
      },
    ];
    const ev = nearbyEvents(al, 55.48, 25.47);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatch(
      /^High incident, ais-gap, dark-vessel, 06:14Z · \d+ km$/,
    );
    const ws: Warning[] = [
      {
        geometry: { coordinates: [55, 25] },
        properties: { msgNumber: 1, msgYear: 2024, navArea: "P" },
      },
      {
        geometry: { coordinates: [55.1, 25] },
        properties: { msgNumber: 1, msgYear: 2024, navArea: "P" },
      },
      {
        geometry: { coordinates: [50, 25] },
        properties: { msgNumber: 9, msgYear: 2023, navArea: "P" },
      },
    ];
    expect(nearestWarnings(ws, 55, 25)).toEqual([
      "NAVAREA P 1/24",
      "NAVAREA P 9/23",
    ]);
  });

  it("records box pulls into a per-hull fix series merged with the archive", () => {
    record([V(77, 55, 25, { t: 100 })]);
    record([V(77, 55.1, 25, { t: 160 })]);
    const s = series(77, [
      [54.9, 25, 40],
      [55, 25, 100],
    ]);
    expect(s.map((f) => f[0])).toEqual([40, 100, 160]);
  });

  it("maps lon/lat to the Gulf plate within the fit's error", () => {
    // Al Hamriyah LPG Terminal's label anchor on scene-gulf-live (about 1019, 535)
    const [x, y] = toPx(55.4833, 25.4667);
    expect(Math.abs(x - 1019)).toBeLessThan(15);
    expect(Math.abs(y - 537)).toBeLessThan(15);
  });
});

describe("fixBins", () => {
  it("bins fixes per source from the first fix to the last, sources by total", async () => {
    const { fixBins } = await import("./data.js");
    const r = fixBins(
      [
        { t: 600, src: "a" },
        { t: 650, src: "b" },
        { t: 1250, src: "b" },
        { t: 1260, src: "b" },
      ],
      300,
    )!;
    expect(r.bins.length).toBe(3);
    expect(r.order).toEqual([
      ["b", 3],
      ["a", 1],
    ]);
    expect(r.max).toBe(2);
    expect(r.bins[1]!.size).toBe(0);
    expect(fixBins([], 300)).toBeNull();
  });
});
