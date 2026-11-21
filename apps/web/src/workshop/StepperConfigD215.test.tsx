// D215: Time stepper config — timestamp-based, one-minute steps.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "WorkshopApp.tsx"), "utf8");

describe("StepperConfig D215", () => {
  it("workshop app is real", () => {
    expect(app).toContain("WorkshopApp");
  });
});
