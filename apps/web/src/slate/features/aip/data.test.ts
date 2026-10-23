import { describe, expect, it } from "vitest";
import {
  css,
} from "./ui.js";
import {
  inHormuz,
  inWatchRegion,
  keepAtLeast,
  prio,
  runName,
  sancRows,
  scenePx,
  shipCls,
  stamp,
  tsFmt,
  vstatus,
  wrap,
  type Sar,
} from "./data.js";
import { routeOf } from "./Terminal.js";
import { lineageLayout } from "./Lineage.js";

describe("AIP copy derivations (ported from _build_features_a.py)", () => {
  it("vessel status, ship class and priority follow the builder's rules", () => {
    expect(vstatus({ parked: true, sog: 9 })).toBe("Parked");
    expect(vstatus({ sog: 0.4 })).toBe("Stationary");
    expect(vstatus({ sog: null })).toBe("Stationary");
    expect(vstatus({ sog: 2.9 })).toBe("Slow");
    expect(vstatus({ sog: 3 })).toBe("Underway");
    expect([shipCls(80), shipCls(71), shipCls(30), shipCls(null)]).toEqual([
      "Tanker",
      "Cargo",
      "Fishing",
      "Other",
    ]);
    expect([prio(1), prio(2), prio(3), prio(5)]).toEqual([
      "Low",
      "Medium",
      "High",
      "High",
    ]);
  });

  it("boxes: Hormuz and the watch region", () => {
    expect(inHormuz([56.3, 26.6])).toBe(true);
    expect(inHormuz([52, 26.6])).toBe(false);
    expect(inWatchRegion([43, 12.6])).toBe(true);
    expect(inWatchRegion([24.9, 60.1])).toBe(false);
  });

  it("hull-length thresholds count the hulls kept", () => {
    const sar = [258, 154, 100, 77, 64, 48, 48].map(
      (lengthM) => ({ lengthM }) as Sar,
    );
    expect(keepAtLeast(sar, 30)).toEqual({ n: 7, pct: 100 });
    expect(keepAtLeast(sar, 50)).toEqual({ n: 5, pct: 71 });
    expect(keepAtLeast(sar, 80)).toEqual({ n: 3, pct: 43 });
    expect(keepAtLeast([], 50)).toEqual({ n: 0, pct: 0 });
  });

  it("sanctions rows carry status, class and program count", () => {
    const [r] = sancRows({
      features: [
        {
          geometry: { type: "Point", coordinates: [56, 26] },
          properties: {
            mmsi: 1,
            name: "X",
            sog: 0.2,
            shipType: 80,
            t: 0,
            sanction_programs: ["A", "B"],
          },
        },
      ],
    });
    expect(r).toMatchObject({ status: "Stationary", cls: "Tanker", np: 2, xy: [56, 26] });
  });

  it("formats dates the way the builder's strftime does (UTC)", () => {
    const d = new Date(Date.UTC(2026, 9, 22, 9, 6, 27));
    expect(stamp(d)).toBe("Oct 22, 2026, 09:06 UTC");
    expect(runName(d)).toBe("simulation-22-Oct-2026-09-06-27");
    expect(tsFmt("2026-09-18T09:33:35Z")).toBe("Sep 18, 2026, 9:33 AM");
    expect(tsFmt("2026-09-18T21:03:35Z", false)).toBe("Sep 18, 2026");
  });

  it("projects onto the light map with the scene fit", () => {
    // the fit's own anchor region: Hormuz lands inside the 1882x1242 image
    const [x, y] = scenePx(56.3, 26.6);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(1882);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(1242);
  });

  it("parses the builder's inline CSS strings", () => {
    expect(css("border-radius:2px;border-width:2px;")).toEqual({
      borderRadius: "2px",
      borderWidth: "2px",
    });
    expect(css("font-family:'DejaVu Sans Mono',monospace")).toEqual({
      fontFamily: "'DejaVu Sans Mono',monospace",
    });
  });

  it("routes a prompt to the tool query that answers it, or to the model", () => {
    expect(routeOf("How many vessels sit inside each chokepoint, and how many are stationary?")).toBe("a6");
    expect(routeOf("To what extent is the Strait of Hormuz congested right now?")).toBe("a3");
    expect(routeOf("Summarise the last day")).toBe("none");
    expect(wrap("a ".repeat(60), 74).every((l) => l.length <= 74)).toBe(true);
  });

  it("lays lineage out as the builder does", () => {
    const pos = lineageLayout({
      nodes: [
        { id: "iso", type: "dataset", name: "iso", kind: "raw" },
        { id: "in", type: "dataset", name: "in", kind: "raw" },
        { id: "tf", type: "transform", name: "tf" },
        { id: "out", type: "dataset", name: "out", kind: "derived" },
        { id: "ref", type: "dataset", name: "ref", kind: "reference" },
      ],
      edges: [
        { src: "in", dst: "tf" },
        { src: "tf", dst: "out" },
      ],
    });
    expect(pos.get("iso")).toEqual([460, 300]);
    expect(pos.get("in")).toEqual([820, 330]);
    expect(pos.get("tf")).toEqual([1090, 330]);
    expect(pos.get("out")).toEqual([1370, 330]);
    expect(pos.get("ref")).toEqual([450, 905]);
  });
});
