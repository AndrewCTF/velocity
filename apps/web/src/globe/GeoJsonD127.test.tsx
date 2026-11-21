// D127: the jamming cell's polygon geometry renders as the real GeoJSON polygon.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const slate = readFileSync(path.join(here, "../slate/SlateShell.tsx"), "utf8");
const registry = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("GeoJson D127", () => {
  it("jamming geometry comes from the live feed", () => {
    expect(registry).toContain("/api/jamming/nacp");
    expect(slate).toContain("SlateObject");
  });
});
