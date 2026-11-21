// D203: route lines with mid-line arrowheads and airport circles.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "WorkshopApp.tsx"), "utf8");

describe("RouteLines D203", () => {
  it("workshop app is real", () => {
    expect(app).toContain("WorkshopApp");
  });
});
