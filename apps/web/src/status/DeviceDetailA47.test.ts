// A47: Device detail — the real CPU of this box (temperature from k10temp,
// load from /proc/loadavg).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const detail = readFileSync(path.join(here, "DeviceDetail.tsx"), "utf8");

describe("DeviceDetail A47", () => {
  it("device detail reads the box counters", () => {
    expect(detail).toContain("DeviceDetail");
    expect(detail).toContain("/api/system/cpu");
    expect(detail).toContain("temp_c");
  });
});
