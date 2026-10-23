import { beforeEach, describe, expect, it, vi } from "vitest";

describe("theme default", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("falls back to slate when nothing is stored", async () => {
    const { useTheme } = await import("./theme.js");
    expect(useTheme.getState().mode).toBe("slate");
  });

  it("migrates the retired measured id to slate", async () => {
    localStorage.setItem("velocity.theme", "measured");
    const { useTheme } = await import("./theme.js");
    expect(useTheme.getState().mode).toBe("slate");
  });

  it("keeps an operator's explicit choice", async () => {
    localStorage.setItem("velocity.theme", "amber");
    const { useTheme } = await import("./theme.js");
    expect(useTheme.getState().mode).toBe("amber");
  });
});
