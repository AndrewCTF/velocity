import { describe, expect, it } from "vitest";
import { ORDER, PAGES } from "./pages.js";

describe("workspace pages", () => {
  it("lists every page once and gives each a label, icon and tone", () => {
    expect(new Set(ORDER).size).toBe(ORDER.length);
    expect([...ORDER].sort()).toEqual(Object.keys(PAGES).sort());
    for (const p of Object.values(PAGES)) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.icon).toMatch(/^[a-z-]+$/);
      expect(["dark", "light"]).toContain(p.tone);
    }
  });
});
