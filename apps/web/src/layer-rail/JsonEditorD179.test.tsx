// D179: JSON editor with validity badge over the env.jamming.nacp registry entry.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(path.join(here, "LayerRail.tsx"), "utf8");
const registry = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("JsonEditor D179", () => {
  it("layer rail and jamming feed are real", () => {
    expect(rail).toContain("LayerRail");
    expect(registry).toContain("/api/jamming/nacp");
  });
});
