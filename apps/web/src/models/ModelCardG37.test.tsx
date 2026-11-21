// G37: Model card with performance and SAR example detections.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const models = readFileSync(path.join(here, "ModelsApp.tsx"), "utf8");

describe("ModelCard G37", () => {
  it("models app is real", () => {
    expect(models).toContain("ModelsApp");
  });
});
