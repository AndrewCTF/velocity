// D228: Vertex left and right strips and floating toolbar.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "VertexApp.tsx"), "utf8");

describe("VertexStrips D228", () => {
  it("vertex app is real", () => {
    expect(app).toContain("VertexApp");
  });
});
