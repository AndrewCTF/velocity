import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UTC,
  chipsOf,
  clusters,
  graphData,
  grow,
  gx,
  gy,
  hull,
  isSar,
  ll2px,
  lineageChains,
  lineageLayoutEu,
  merc,
  pickMarkers,
  planPasses,
  profileVessel,
  solarElev,
  subsolar,
  warnRings,
  withPx,
  type Incident,
  type SatV,
} from "./data.js";

const sv = (
  id: string,
  x: number,
  y: number,
  extra: Partial<SatV> = {},
): SatV => ({ id, mmsi: 1, lat: 0, lon: 0, name: id, px: [x, y], ...extra });

describe("Europa copy derivations (ported from _build_features.py / _eu_data.py)", () => {
  it("formats UTC like the builder's strftime patterns", () => {
    const t = Date.UTC(2026, 9, 22, 9, 20, 37) / 1000;
    expect(UTC(t, "%H:%MZ")).toBe("09:20Z");
    expect(UTC(t, "%b %d %Y %H:%M:%SZ").toUpperCase()).toBe(
      "OCT 22 2026 09:20:37Z",
    );
    expect(UTC(t, "%m/%d/%Y %I:%M %p")).toBe("10/22/2026 09:20 AM");
    expect(UTC(t, "%-d %B %Y")).toBe("22 October 2026");
  });

  it("projects the Gaia map with the copy's mercator constants", () => {
    expect(merc(0)).toBeCloseTo(0);
    expect(gx(-168)).toBe(777);
    expect(gy(0)).toBe(537);
    expect(gy(45)).toBeCloseTo(537 - 50.4987 * 1.94, 2);
  });

  it("keeps one NGA ring per 9 px cell, 2024 and later, inside the pane", () => {
    const r = warnRings([
      { y: 2025, lon: 0, lat: 0 },
      { y: 2025, lon: 0.5, lat: 0.5 }, // same cell
      { y: 2022, lon: 20, lat: 0 }, // too old
      { y: 2024, lon: 20, lat: 0 },
    ]);
    expect(r).toHaveLength(2);
  });

  it("turns a replay-window title into arrived/departed/stayed chips", () => {
    const c = chipsOf({
      sha256: "ac3ae6a7f50479a5",
      size_bytes: 86046,
      media_type: "application/json",
      capture_method: "replay_window",
      source_context: "North Sea, one hour",
      title: "Replay window: 45 arrived, 66 departed, 979 stayed",
      captured_at: "2026-08-30T06:57:47Z",
    });
    expect(c.map((x) => x[0])).toEqual([
      "Source",
      "Method",
      "Arrived",
      "Departed",
      "Stayed",
    ]);
    expect(c[0]![1]).toBe("North Sea, one…");
  });

  it("places the mosaic so the Port Rashid centre sits inside it", () => {
    const [x, y] = ll2px(25.27, 55.286);
    expect(x).toBeGreaterThan(3 * 256);
    expect(x).toBeLessThan(4 * 256);
    expect(y).toBeGreaterThan(2 * 256);
    expect(y).toBeLessThan(3 * 256);
  });

  it("clusters by single linkage and keeps groups of three or more", () => {
    const vs = [
      sv("a", 0, 0),
      sv("b", 50, 0),
      sv("c", 100, 0),
      sv("d", 500, 500),
      sv("e", 540, 500),
    ];
    const g = clusters(vs);
    expect(g).toHaveLength(1);
    expect(g[0]!.map((v) => v.id)).toEqual(["a", "b", "c"]);
  });

  it("hull drops interior points and grow pushes vertices out", () => {
    const h = hull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
    ]);
    expect(h).toHaveLength(4);
    const g = grow(h, 1);
    expect(Math.min(...g.map((p) => p[0]))).toBeLessThan(0);
  });

  it("picks farthest-point markers inside the view", () => {
    const vs = [
      sv("a", 100, 100),
      sv("b", 110, 100),
      sv("c", 400, 400),
      sv("x", 10, 10),
    ];
    const m = pickMarkers(vs, 2, [0, 0, 500, 500]);
    expect(m.map((v) => v.id).sort()).toEqual(["a", "c"]);
  });

  it("profiles the freshest named cargo track inside the mosaic", () => {
    const vs = withPx([]).concat([
      sv("old", 900, 600, { shipType: "Cargo", ageS: 300 }),
      sv("new", 900, 600, { shipType: "Tanker", ageS: 20 }),
      sv("tug", 900, 600, { shipType: "Tug", ageS: 1 }),
    ]);
    expect(profileVessel(vs)?.id).toBe("new");
    expect(profileVessel([])).toBeNull();
  });

  it("samples incidents by score and lists their domains", () => {
    const inc: Incident[] = Array.from({ length: 92 }, (_, i) => ({
      id: `incident:${i}`,
      threat: "high",
      score: i % 5,
      domains: i % 2 ? ["ais-gap"] : ["military", "dark-vessel"],
    }));
    const { inc: s, doms } = graphData(inc);
    expect(s).toHaveLength(46);
    expect(s[0]!.score).toBe(4);
    expect(new Set(doms)).toEqual(
      new Set(["military", "dark-vessel", "ais-gap"]),
    );
  });

  it("derives lineage rows from the live edges, shared sources between their rows", () => {
    const lin = {
      nodes: [
        { id: "a", type: "dataset" as const, name: "a" },
        { id: "t1", type: "transform" as const, name: "t1" },
        { id: "b", type: "dataset" as const, name: "b" },
        { id: "t2", type: "transform" as const, name: "t2" },
        { id: "c", type: "dataset" as const, name: "c" },
      ],
      edges: [
        { src: "a", dst: "t1" },
        { src: "t1", dst: "b" },
        { src: "a", dst: "t2" },
        { src: "t2", dst: "c" },
      ],
    };
    expect(lineageChains(lin)).toEqual([
      ["a", "t1", "b"],
      ["a", "t2", "c"],
    ]);
    expect(lineageLayoutEu(lin).get("a")).toEqual([430, 480 + 48]);
  });

  it("puts the sun overhead near the subsolar point", () => {
    const t = Date.UTC(2026, 5, 21, 12) / 1000; // June solstice, noon UTC
    const [dec, lon] = subsolar(t);
    expect(dec).toBeCloseTo(23.4, 0);
    expect(Math.abs(lon)).toBeLessThan(3);
    expect(solarElev(t, dec, lon)).toBeGreaterThan(89);
    expect(solarElev(t, -dec, lon + 180)).toBeLessThan(-80);
  });

  it("finds SAR passes over Hormuz and picks the collect", () => {
    expect(isSar("CAPELLA-17 (ACADIA-7)")).toBe(true);
    expect(isSar("SENTINEL-1A DEB")).toBe(false);
    // ISS elements renamed: any LEO at 51.6 deg passes over 26.5 N several times in 12 h
    const now = 1221913521;
    const plan = planPasses(
      [
        {
          OBJECT_NAME: "ICEYE-TEST",
          NORAD_CAT_ID: 25544,
          TLE_LINE1:
            "1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927",
          TLE_LINE2:
            "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537",
        },
        { OBJECT_NAME: "STARLINK-1" },
      ],
      now,
    );
    expect(plan.sarCount).toBe(1);
    expect(plan.best).not.toBeNull();
    expect(plan.best!.t0).toBeGreaterThan(now);
    expect(plan.win0).toBe(plan.best!.t0 - Math.trunc(2.7 * 3600));
    for (const p of plan.passes) expect(p.peak).toBeGreaterThanOrEqual(15);
  });
});

describe("Europa copy strings", () => {
  it("carry no vendor names and no em dashes", () => {
    const dir = __dirname;
    for (const f of readdirSync(dir).filter(
      (n) => /\.(tsx?|html)$/.test(n) && !n.endsWith(".test.ts"),
    )) {
      const src = readFileSync(join(dir, f), "utf8");
      const lits = src.match(/"[^"\n]*"|`[^`]*`/g) ?? [];
      for (const l of lits) {
        expect(l, `${f}: ${l}`).not.toMatch(/palantir|gotham/i);
        // a lone dash is "no value reported", not prose
        if (l !== '"\u2014"') expect(l, `${f}: ${l}`).not.toContain("\u2014");
      }
    }
  });
});
