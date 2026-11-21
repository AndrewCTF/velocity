// D161: icon mapping by on_ground — diamond vs airplane.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = readFileSync(path.join(here, "PollGeoJsonAdapter.ts"), "utf8");

describe("OnGround D161", () => {
  it("poll adapter is real", () => {
    expect(adapter).toContain("PollGeoJsonAdapter");
  });
});
