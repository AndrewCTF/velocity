// FacetChecklist D81: flag checklist with counts and bars.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "FacetChecklist.tsx"), "utf8");
const css = readFileSync(path.join(here, "facetChecklist.css"), "utf8");

describe("FacetChecklist D81", () => {
  it("renders flag rows with counts and bars", () => {
    expect(src).toContain('aria-label="Flag facets"');
    expect(src).toContain("mv-facet-bar");
    expect(src).toContain("mv-facet-count");
    expect(src).toContain("deriveFacets");
  });

  it("matched field is underlined", () => {
    expect(src).toContain("<u>");
    expect(src).toContain("query");
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-facet-checklist");
    expect(css).toContain(".mv-facet-bar");
  });
});
