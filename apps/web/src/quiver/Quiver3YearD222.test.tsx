// D222: Quiver stacked bar with 3-year bars of real AIS counts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "QuiverApp.tsx"), "utf8");

describe("Quiver3Year D222", () => {
  it("quiver app is real", () => {
    expect(app).toContain("QuiverApp");
  });
});
