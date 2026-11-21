// FilterPicker D82: add-filter property picker with type glyphs.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "FilterPicker.tsx"), "utf8");
const css = readFileSync(path.join(here, "filterPicker.css"), "utf8");

describe("FilterPicker D82", () => {
  it("renders the picker dialog", () => {
    expect(src).toContain('aria-label="Add filter"');
    expect(src).toContain('data-testid="d82-filter-picker"');
    expect(src).toContain("Add filter");
  });

  it("properties come from the live airport entity", () => {
    expect(src).toContain("apiFetch(`/api/entity/airport:");
    expect(src).toContain("runways");
    expect(src).toContain("frequencies");
    expect(src).toContain("Object.entries(ent)");
  });

  it("every row carries a type glyph", () => {
    expect(src).toContain("glyphFor");
    expect(src).toContain('"runway"');
    expect(src).toContain('"frequency"');
    expect(src).toContain("GLYPH_ICON");
    expect(src).toContain("mv-fp-glyph");
  });

  it("adding a filter writes a useFilters clause", () => {
    expect(src).toContain("toggleClause(");
    expect(src).toContain('"flag", r.key, "only"');
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-filter-picker");
    expect(css).toContain(".mv-fp-row");
  });
});
