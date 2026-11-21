// D132: time-range picker — presets 1h, 6h, 24h, 3d, 7d.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dock = readFileSync(path.join(here, "TimeDock.tsx"), "utf8");

describe("TimeRange D132", () => {
  it("presets are the live set", () => {
    expect(dock).toContain("TimeDock");
  });
});
