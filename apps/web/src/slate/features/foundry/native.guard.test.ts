import { describe, expect, it } from "vitest";

// Every Foundry page is a native reflowing layout: no fixed-size frame, no
// transparent hit targets over drawn controls, and no button that does nothing.
const src = import.meta.glob("./*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const files = Object.entries(src).filter(([f]) => !f.endsWith("preview.tsx"));

describe("native foundry pages", () => {
  it("finds the page files", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });
  it("carries no frame, zoom or hit-target helper", () => {
    for (const [f, s] of files) {
      expect(s, f).not.toMatch(
        /frameZoom|className="copy"|<Fr\b|\bHit\(|SIZE\b/,
      );
    }
  });
  it("gives every button a handler or disables it", () => {
    for (const [f, s] of files) {
      for (const m of s.matchAll(/<button\b[^>]*?>/gs)) {
        expect(m[0], `${f}: ${m[0]}`).toMatch(/onClick|disabled/);
      }
    }
  });
});
