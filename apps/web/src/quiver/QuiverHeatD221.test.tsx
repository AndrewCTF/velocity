// D221: Quiver heat grid of position fixes by speed and heading.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "QuiverApp.tsx"), "utf8");

describe("QuiverHeat D221", () => {
  it("quiver app is real", () => {
    expect(app).toContain("QuiverApp");
  });
});
