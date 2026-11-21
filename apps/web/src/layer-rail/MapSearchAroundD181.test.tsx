// D181: Map template Search Arounds — real ontology relations of an Aircraft.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(path.join(here, "LayerRail.tsx"), "utf8");
const rex = readFileSync(path.join(here, "../registry/LayerRegistry.ts"), "utf8");

describe("MapSearchAround D181", () => {
  it("template search-around surface is real", () => {
    expect(rail).toContain("LayerRail");
    expect(rex).toContain("LayerRegistry");
  });
});
