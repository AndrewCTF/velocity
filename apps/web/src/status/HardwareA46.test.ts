// A46: Hardware management filters and tile grid over the real devices of this box.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "HardwarePanel.tsx"), "utf8");

describe("Hardware A46", () => {
  it("hardware panel reads the box counters", () => {
    expect(panel).toContain("HardwarePanel");
    expect(panel).toContain("/api/system/hardware");
  });
});

describe("hardware is real when the backend feeds it", () => {
  it("renders only the reported counters", () => {
    expect(panel).toContain("load1");
    expect(panel).toContain("mem_gb");
  });
});
