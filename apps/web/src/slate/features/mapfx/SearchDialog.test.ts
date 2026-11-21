// SearchDialog D80: type facet with counts, mixed live results, inline key-values.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "SearchDialog.tsx"), "utf8");
const css = readFileSync(path.join(here, "searchDialog.css"), "utf8");

describe("SearchDialog D80", () => {
  it("renders the search dialog shell", () => {
    expect(src).toContain('aria-label="Object search"');
    expect(src).toContain('data-testid="d80-search-dialog"');
    expect(src).toContain('aria-label="Type facet"');
  });

  it("live results come from the real search + vessels endpoints", () => {
    expect(src).toContain("searchObjects");
    expect(src).toContain("/api/search/objects");
    expect(src).toContain("/api/maritime/vessels?bbox=-180,-85,180,85");
    expect(src).toContain("by_type");
  });

  it("rows carry inline key-values and select on click", () => {
    expect(src).toContain("shipType");
    expect(src).toContain("sog");
    expect(src).toContain("useSelection.getState().select(r.id)");
  });

  it("reuses the D81 facet checklist", () => {
    expect(src).toContain("FacetChecklist");
    expect(src).toContain("useFacetChecked");
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-search-dialog");
    expect(css).toContain(".mv-sd-row");
  });
});
