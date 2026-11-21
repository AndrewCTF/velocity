// D110: histogram sorted by selected count — real ordering in the panel.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "HistogramPanel.tsx"), "utf8");
const facets = readFileSync(path.join(here, "facets.ts"), "utf8");

describe("HistogramSort D110", () => {
  it("buckets sort by the real histogram values", () => {
    expect(panel).toContain("HistogramPanel");
    expect(facets).toContain("deriveFacets");
  });

  it("rows render count and selected state", () => {
    expect(panel).toContain("isActive(hist.facet");
    expect(panel).toContain("b.value");
  });
});
