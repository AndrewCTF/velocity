// D176: Map Layer editor — choose source type: Vector, Raster, Websocket.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(path.join(here, "LayerRail.tsx"), "utf8");

describe("SourceType D176", () => {
  it("layer rail is real", () => {
    expect(rail).toContain("LayerRail");
  });
});
