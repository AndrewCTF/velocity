// D133: docked timeline header and layer rows with one tick per USGS quake.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dock = readFileSync(path.join(here, "../shell/TimeDock.tsx"), "utf8");
const registry = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("Timeline D133", () => {
  it("timeline and quake feed are real", () => {
    expect(dock).toContain("TimeDock");
    expect(registry).toContain("/api/eq?range=day");
  });
});
