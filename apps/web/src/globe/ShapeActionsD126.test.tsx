// D126: shape toolbar Actions menu — watchbox + assess over the drawn box.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const actions = readFileSync(path.join(here, "mapActions.ts"), "utf8");
const menu = readFileSync(path.join(here, "ContextMenu.tsx"), "utf8");

describe("ShapeActions D126", () => {
  it("area actions include watchbox and assess", () => {
    expect(actions).toContain("Create watchbox over box");
    expect(actions).toContain("AI assess this area");
    expect(menu).toContain("areaActions(area!)");
  });
});
