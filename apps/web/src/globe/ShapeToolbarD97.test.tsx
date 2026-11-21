// D97: shape toolbar for a selected shape (area actions under the readout).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolbar = readFileSync(path.join(here, "GlobeToolbar.tsx"), "utf8");
const actions = readFileSync(path.join(here, "mapActions.ts"), "utf8");

describe("ShapeToolbar D97", () => {
  it("a drawn area shows its action list under the readout", () => {
    expect(toolbar).toContain("{area && (");
    expect(toolbar).toContain("areaActions(area).map");
    expect(actions).toContain("Search objects in box");
    expect(actions).toContain("Copy bounds");
  });
});
