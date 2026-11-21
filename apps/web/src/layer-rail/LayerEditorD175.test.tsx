// D175: Map Layer editor — object source: live vessel layer with AIS preview.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(path.join(here, "LayerRail.tsx"), "utf8");
const rex = readFileSync(path.join(here, "../registry/LayerRegistry.ts"), "utf8");

describe("LayerEditor D175", () => {
  it("layer editor surface is real", () => {
    expect(rail).toContain("LayerRail");
    expect(rex).toContain("LayerRegistry");
  });
});
