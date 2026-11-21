// The page nav keeps every destination the old dark rail reached, and the
// lineage scene model keeps each node inside the box it reports.
import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DESTINATIONS, PageNav, type FoundryNav } from "./pg.js";
import { graphModel } from "./Lineage.js";

describe("PageNav", () => {
  it("reaches every destination and marks the current page", () => {
    const seen: FoundryNav[] = [];
    render(<PageNav here="lineage" nav={(v) => seen.push(v)} />);
    expect(DESTINATIONS.map((d) => d[0]).sort()).toEqual(
      ["board", "control", "lineage", "map", "registry", "terminal", "titan", "transforms"].sort(),
    );
    for (const [v, label] of DESTINATIONS)
      if (v !== "lineage") fireEvent.click(screen.getByRole("button", { name: label }));
    expect(seen).toHaveLength(DESTINATIONS.length - 1);
    expect(screen.getByRole("button", { name: "Lineage" }).getAttribute("aria-current")).toBe("page");
    cleanup();
  });
});

describe("graphModel", () => {
  it("places every node inside the reported box and draws the real edges", () => {
    const st = {
      lin: {
        nodes: [
          { id: "a", type: "dataset" as const, name: "raw_a", kind: "raw" },
          { id: "t", type: "transform" as const, name: "tf" },
          { id: "b", type: "dataset" as const, name: "out_b", kind: "derived" },
        ],
        edges: [{ src: "a", dst: "t" }, { src: "t", dst: "b" }],
      },
      ds: new Map(),
      bound: new Map([["b", { id: "x", dataset_id: "b", object_kind: "vessel" }]]),
      kinds: ["vessel"],
    };
    const m = graphModel(st, "color", "a");
    const [x0, y0, w, h] = m.box;
    for (const n of m.nodes) {
      expect(n.x - n.w / 2).toBeGreaterThanOrEqual(x0);
      expect(n.x + n.w / 2).toBeLessThanOrEqual(x0 + w);
      expect(n.y - n.h / 2).toBeGreaterThanOrEqual(y0);
      expect(n.y + n.h / 2).toBeLessThanOrEqual(y0 + h);
    }
    expect(m.edges).toHaveLength(3); // two lineage edges + one dashed binding
    expect(m.edges.filter((e) => e.hot)).toHaveLength(1);
    expect(m.nodes.some((n) => n.label === "[Velocity] Vessel" && !n.real)).toBe(true);
  });
});
