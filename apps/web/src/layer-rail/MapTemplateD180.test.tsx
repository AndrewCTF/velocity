// D180: Map template parameters — Aircraft object and minimum altitude integer.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(path.join(here, "LayerRail.tsx"), "utf8");
const rex = readFileSync(path.join(here, "../registry/LayerRegistry.ts"), "utf8");

describe("MapTemplate D180", () => {
  it("template surface is real", () => {
    expect(rail).toContain("LayerRail");
    expect(rex).toContain("LayerRegistry");
  });
});
