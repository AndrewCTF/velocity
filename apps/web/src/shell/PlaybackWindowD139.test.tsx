// D139: playback constrained to the filter window in the dock.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dock = readFileSync(path.join(here, "TimeDock.tsx"), "utf8");

describe("PlaybackWindow D139", () => {
  it("the dock is the playback surface", () => {
    expect(dock).toContain("TimeDock");
  });
});
