import { describe, expect, it } from "vitest";
import type { Incident, Lineage } from "./data.js";
import { along, boxOf, graphLayout, lineageLayout, NODE_H, NODE_W, stageScale } from "./layout.js";

describe("stageScale", () => {
  it("fits the limiting axis and is 0 before the pane is measured", () => {
    expect(stageScale(1600, 450, 1600, 900)).toBeCloseTo(0.5);
    expect(stageScale(800, 900, 1600, 900)).toBeCloseTo(0.5);
    expect(stageScale(0, 900, 1600, 900)).toBe(0);
  });
});

describe("graphLayout", () => {
  const inc: Incident[] = Array.from({ length: 12 }, (_, i) => ({
    id: `incident:${i}`,
    threat: null,
    score: i,
    domains: i % 3 ? ["dark-vessel"] : ["military", "mystery"],
  }));
  it("places every incident inside a box that holds hubs and nodes", () => {
    const { pos, box } = graphLayout(inc, ["dark-vessel", "military", "mystery"]);
    expect(pos.size).toBe(12);
    for (const [x, y] of pos.values()) {
      expect(x).toBeGreaterThanOrEqual(box[0]);
      expect(x).toBeLessThanOrEqual(box[0] + box[2]);
      expect(y).toBeGreaterThanOrEqual(box[1]);
      expect(y).toBeLessThanOrEqual(box[1] + box[3]);
    }
  });
  it("handles no incidents", () => {
    expect(graphLayout([], []).pos.size).toBe(0);
  });
});

describe("lineageLayout", () => {
  it("boxes every placed node with its width", () => {
    const lin: Lineage = {
      nodes: [
        { id: "a", type: "dataset", name: "a", kind: "raw" },
        { id: "t", type: "transform", name: "t" },
        { id: "b", type: "dataset", name: "b", kind: "derived" },
      ],
      edges: [
        { src: "a", dst: "t" },
        { src: "t", dst: "b" },
      ],
    };
    const { pos, box } = lineageLayout(lin);
    expect(pos.size).toBe(3);
    for (const [x, y] of pos.values()) {
      expect(x).toBeGreaterThanOrEqual(box[0]);
      expect(x + NODE_W).toBeLessThanOrEqual(box[0] + box[2]);
      expect(y - NODE_H / 2).toBeGreaterThanOrEqual(box[1]);
      expect(y + NODE_H / 2).toBeLessThanOrEqual(box[1] + box[3]);
    }
  });
});

describe("boxOf / along", () => {
  it("falls back to the minimum for no points and clamps times", () => {
    expect(boxOf([], 10)).toEqual([0, 0, 200, 120]);
    expect(along(5, 10, 100)).toBe(0);
    expect(along(500, 10, 100)).toBe(1);
    expect(along(60, 10, 100)).toBeCloseTo(0.5);
  });
});
