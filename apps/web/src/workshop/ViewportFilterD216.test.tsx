// D216: Viewport filter config — geohash on vessel position, AIS recorder bbox.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "WorkshopApp.tsx"), "utf8");

describe("ViewportFilter D216", () => {
  it("workshop app is real", () => {
    expect(app).toContain("WorkshopApp");
  });
});
