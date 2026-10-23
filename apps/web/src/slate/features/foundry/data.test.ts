import { describe, expect, it } from "vitest";
import {
  KM,
  aisType,
  countryOrder,
  d192,
  d200,
  densCenter,
  depsOf,
  fmt_slash,
  fmt_t,
  lengthRamp,
  magRamp,
  ofvOf,
  proj,
  quakeCell,
  splitWrap,
  wpx,
  type Airport,
} from "./data.js";
import { pyRound, scaleFs } from "./kit.js";
import { descOf, subOf, wrap } from "./Marketplace.js";

const ap = (
  iata: string,
  lon: number,
  lat: number,
  country = "X",
): Airport => ({ iata, name: iata, city: iata, country, lon, lat });

describe("foundry copy derivations", () => {
  it("projects like raw_plate: centre lands mid-plate", () => {
    const fn = proj(8.6, 50.2, 5.4, 1131, 699);
    const [x, y] = fn(8.6, 50.2);
    expect(x).toBeCloseTo(565.5);
    expect(y).toBeCloseTo(349.5);
    expect(wpx(-180, 0, 0)[0]).toBe(0);
  });
  it("haversine on a 12742 km diameter", () => {
    expect(KM([0, 0], [0, 1])).toBeCloseTo(111.19, 1);
  });
  it("python round half to even, font-size post-pass skips decimals", () => {
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
    expect(scaleFs("font-size:25px;font-size:28.75px", 1.16)).toBe(
      "font-size:29px;font-size:28.75px",
    );
  });
  it("counts departures and keeps only airports that have them", () => {
    const deps = depsOf([
      { src: "A", dst: "B" },
      { src: "A", dst: "C" },
    ]);
    expect(deps.get("A")).toBe(2);
    expect(
      ofvOf([ap("A", 0, 0), ap("B", 1, 1)], deps).map((a) => a.iata),
    ).toEqual(["A"]);
  });
  it("d192 bins by percentile and selects inside the radius", () => {
    const deps = new Map<string, number>();
    const aps: Airport[] = [];
    for (let i = 0; i < 12; i++) {
      aps.push(ap(`P${i}`, 2 + (i % 4) * 0.9, 48 + Math.floor(i / 4) * 0.9));
      deps.set(`P${i}`, i + 1);
    }
    const r = d192(aps, deps, proj(3.5, 49, 5.4, 1131, 699), 1131, 699)!;
    expect(r.inview.length).toBe(12);
    expect(r.edges[0]![0]).toBe(1);
    expect(r.bin(12)).toBe(3);
    if (r.ctr)
      for (const a of r.selected)
        expect(KM([r.ctr.lon, r.ctr.lat], [a.lon, a.lat])).toBeLessThanOrEqual(
          r.rkm,
        );
  });
  it("d200 picks the ringed airport clear of the edges", () => {
    const deps = new Map<string, number>();
    const aps = [
      ap("C", 10, 49),
      ap("N1", 10.5, 49),
      ap("N2", 9.5, 49),
      ap("N3", 10, 49.6),
      ap("E", 30, 49),
    ];
    aps.forEach((a, i) => deps.set(a.iata, 10 - i));
    const r = d200(aps, deps, proj(10, 49, 5.7, 897, 375), 897, 375)!;
    expect(r.sel.iata).toBe("C");
    expect(r.nb.iata).toBe("N3");
  });
  it("orders countries by airports with 15+ departures", () => {
    const deps = new Map([
      ["A", 20],
      ["B", 20],
      ["C", 30],
      ["D", 3],
    ]);
    expect(
      countryOrder(
        [
          ap("A", 0, 0, "Fr"),
          ap("C", 0, 0, "De"),
          ap("B", 0, 0, "De"),
          ap("D", 0, 0, "It"),
        ],
        deps,
      ),
    ).toEqual(["De", "Fr"]);
  });
  it("ramps", () => {
    expect(magRamp(0, 0, 4)).toBe("#f7ce6b");
    expect(magRamp(4, 0, 4)).toBe("#c43434");
    expect(lengthRamp(650, 650, 3000)).toBe("#2e8b57");
    expect(lengthRamp(3000, 650, 3000)).toBe("#c8463c");
  });
  it("densest cell and quake cell", () => {
    const pts = [
      { lon: 4.4, lat: 51.9 },
      { lon: 4.41, lat: 51.9 },
      { lon: 50, lat: 25 },
    ];
    const [lo, la, n] = densCenter(10, 1661, 813, pts);
    expect(n).toBe(2);
    expect(Math.abs(lo - 4.4)).toBeLessThan(1);
    expect(Math.abs(la - 51.9)).toBeLessThan(1);
    const q = Array.from({ length: 5 }, () => ({
      mag: 2,
      place: "x",
      time: 0,
      lon: -150,
      lat: 60,
    }));
    expect(quakeCell(q, 30)).toEqual([-160, 55]); // first cell with |dlon| < 15 and |dlat| < 9.3
  });
  it("ais_type", () => {
    expect(aisType(null)).toBe("No value");
    expect(aisType(52)).toBe("Tug");
    expect(aisType("71")).toBe("Cargo");
    expect(aisType(84)).toBe("Tanker");
    expect(aisType("Cargo")).toBe("Cargo");
  });
  it("splits ground tracks at the antimeridian", () => {
    expect(
      splitWrap([
        [170, 0],
        [179, 1],
        [-179, 2],
      ]).length,
    ).toBe(2);
  });
  it("UTC time formats", () => {
    expect(fmt_t(0)).toBe("12:00:00 AM");
    expect(fmt_slash(86400 * 31 + 13 * 3600)).toBe("02/01/1970, 1:00:00 PM");
  });
  it("marketplace copy carries no em dash and wraps like textwrap", () => {
    const d = descOf(
      "Live intel as MCP tools — ADS-B, AIS — bundled with a skill.",
    );
    expect(d).not.toContain("—");
    expect(d.startsWith("Live intel as MCP tools. ADS-B")).toBe(true);
    expect(subOf("A — B, as 46 tools")).toBe("A, B");
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });
});
