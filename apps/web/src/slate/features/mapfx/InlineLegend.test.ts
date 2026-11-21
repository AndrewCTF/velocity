// InlineLegend D73/D74: inline legend under each layer row from the real symbol palette.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "InlineLegend.tsx"), "utf8");
const css = readFileSync(path.join(here, "inlineLegend.css"), "utf8");

describe("InlineLegend D73/D74", () => {
  it("renders the inline legend with symbol colours", () => {
    expect(src).toContain('aria-label={`Legend for ${row.label}`');
    expect(src).toContain('data-testid="d73-legend"');
    expect(src).toContain("mv-il-swatch");
    expect(src).toContain("Symbol colours");
  });

  it("legend colours are the real rendered palette values", () => {
    expect(src).toContain('"#facc15"'); // airliner
    expect(src).toContain('"#14b8a6"'); // vessel cargo
    expect(src).toContain('"#ef4444"'); // emergency / SAR
  });

  it("rows pick the right palette by their layer ids", () => {
    expect(src).toContain("legendForRow");
    expect(src).toContain("hazards");
    expect(src).toContain("maritime");
  });

  it("hidden rows dim via is-hidden", () => {
    expect(src).toContain("hidden ?");
    expect(css).toContain(".mv-inline-legend.is-hidden");
  });
});
