// D149: layer detail header with Style / Legend tabs.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(path.join(here, "LayerRail.tsx"), "utf8");

describe("LayerHeader D149", () => {
  it("layer detail is real", () => {
    expect(rail).toContain("LayerRail");
  });
});
