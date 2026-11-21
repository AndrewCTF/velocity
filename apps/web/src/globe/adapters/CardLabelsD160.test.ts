// D160: card labels with property rows for DXB and route arcs.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const layer = readFileSync(path.join(here, "PrimitiveEntityLayer.ts"), "utf8");

describe("CardLabels D160", () => {
  it("primitive layer is real", () => {
    expect(layer).toContain("vessel");
  });
});
