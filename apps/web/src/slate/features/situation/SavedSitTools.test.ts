import { describe, expect, it } from "vitest";
import { proposeError, rectArea } from "./SavedSitTools.js";

describe("rectArea", () => {
  it("centres on the view and fits the circle inside its shorter side", () => {
    const a = rectArea(20, 36, 26, 40); // ~536 km wide at 38N, ~442 km tall
    expect(a.centroid).toEqual({ lat: 38, lon: 23 });
    expect(a.radius_km).toBe(221);
  });
  it("handles a view across the antimeridian", () => {
    const a = rectArea(170, -10, -170, 10);
    expect(a.centroid.lon).toBe(180);
    expect(a.radius_km).toBeGreaterThan(1000);
  });
  it("clamps a whole-globe view", () => {
    expect(rectArea(-180, -80, 180, 80).radius_km).toBe(2000);
  });
});

describe("proposeError", () => {
  it("names an embedding-only model instead of echoing the raw error", () => {
    const m = proposeError(200, {
      error: 'ollama 400: {"error":"\\"nomic-embed-text:latest\\" does not support chat"}',
      model: "nomic-embed-text:latest",
    });
    expect(m).toContain("nomic-embed-text:latest");
    expect(m).toContain("Settings, Local AI");
    expect(m).not.toContain("{");
  });
  it("says when no chat model is installed", () => {
    expect(
      proposeError(200, { error: "ollama unreachable at http://x or no models installed" }),
    ).toMatch(/No local chat model is installed/);
  });
  it("keeps the HTTP code", () => {
    expect(proposeError(503, null)).toBe("AI proposals unavailable (HTTP 503).");
    expect(proposeError(401, null)).toMatch(/Sign in/);
  });
});
