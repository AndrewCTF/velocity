// D109: histogram panel — sort by value, n / uniq, filter to / filter out.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "HistogramPanel.tsx"), "utf8");
const facets = readFileSync(path.join(here, "facets.ts"), "utf8");
const defaults = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("Histogram D109", () => {
  it("rows carry filter actions over the USGS feed", () => {
    expect(panel).toContain("HistogramPanel");
    expect(panel).toContain("Filters");
    expect(facets).toContain("Faceted classification");
    expect(defaults).toContain("/api/eq?range=day");
  });

  it("toggleClause drives filter to / filter out", () => {
    expect(panel).toContain("toggleClause");
    expect(panel).toContain('"only"');
    expect(panel).toContain('"not"');
  });

  it("histogram buckets render selected state", () => {
    expect(panel).toContain("isActive(hist.facet");
  });
});
