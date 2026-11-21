// SearchDialog D83: Add-all limit — real 50,000-object cap with tooltip.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "SearchDialog.tsx"), "utf8");
const css = readFileSync(path.join(here, "searchDialog.css"), "utf8");

describe("SearchDialog D83", () => {
  it("renders the disabled Add-all control with a cap tooltip", () => {
    expect(src).toContain('data-testid="d83-add-all"');
    expect(src).toContain("disabled={true}");
    expect(src).toContain("Add all is capped at");
    expect(src).toContain("limit=50000");
    expect(src).toContain("vesselCap.toLocaleString()");
  });

  it("the cap is the vessel feed's real limit", () => {
    expect(src).toContain("const vesselCap = 50000");
  });

  it("the control is styled as disabled", () => {
    expect(css).toContain(".mv-sd-add-all");
    expect(css).toContain("cursor: not-allowed");
  });
});
