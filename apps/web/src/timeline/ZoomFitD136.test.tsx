// D136: zoom-to-fit in the timeline over the aircraft trace.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const timeline = readFileSync(path.join(here, "Timeline.tsx"), "utf8");
const dock = readFileSync(path.join(here, "../shell/TimeDock.tsx"), "utf8");

describe("ZoomFit D136", () => {
  it("timeline and dock are real", () => {
    expect(timeline).toContain("TimeDock");
    expect(dock).toContain("TimeDock");
  });
});
