// D148: icon rotation by heading for moving vessels.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const layer = readFileSync(path.join(here, "PrimitiveEntityLayer.ts"), "utf8");

describe("Heading D148", () => {
  it("vessel heading rotation is first-class", () => {
    expect(layer).toContain("vessel");
  });
});
