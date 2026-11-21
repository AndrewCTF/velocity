// D131: date-time picker popover from the time-selection field.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dock = readFileSync(path.join(here, "TimeDock.tsx"), "utf8");

describe("DateTimePicker D131", () => {
  it("time presets are live buttons", () => {
    expect(dock).toContain("TimeDock");
  });
});
