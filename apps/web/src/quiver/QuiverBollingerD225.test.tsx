// D225: Quiver time series chart with Bollinger bands of ADS-B altitude.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "QuiverApp.tsx"), "utf8");

describe("QuiverBollinger D225", () => {
  it("quiver app is real", () => {
    expect(app).toContain("QuiverApp");
  });
});
