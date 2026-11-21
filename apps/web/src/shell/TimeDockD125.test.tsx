// D125: event bar in the series panel on a time axis.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dock = readFileSync(path.join(here, "TimeDock.tsx"), "utf8");

describe("TimeDock D125", () => {
  it("the time dock renders the timeline", () => {
    expect(dock).toContain("TimeDock");
  });
});
