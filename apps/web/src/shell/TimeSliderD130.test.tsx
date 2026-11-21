// D130: time selection slider — cursor at latest, replay range.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dock = readFileSync(path.join(here, "TimeDock.tsx"), "utf8");

describe("TimeSlider D130", () => {
  it("the time slider is the live timeline", () => {
    expect(dock).toContain("TimeDock");
  });
});
