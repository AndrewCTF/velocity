// D155: expression colour builder over the jamming feed.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = readFileSync(path.join(here, "PollGeoJsonAdapter.ts"), "utf8");
const registry = readFileSync(path.join(here, "../../registry/defaults.ts"), "utf8");

describe("ExprColor D155", () => {
  it("poll adapter and jamming feed are real", () => {
    expect(adapter).toContain("PollGeoJsonAdapter");
    expect(registry).toContain("/api/jamming/nacp");
  });
});
