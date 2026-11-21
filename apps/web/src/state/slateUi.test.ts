import { describe, it, expect, beforeEach } from "vitest";
import { useSlateUi } from "./slateUi.js";

describe("slateUi persisted toggles (issue 106)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writes the blob on set", () => {
    useSlateUi.getState().set("pdfPage", "browser");
    expect(JSON.parse(localStorage.getItem("velocity.slateUiPrefs")!).pdfPage).toBe("browser");
  });

  it("defaults apply before any write", () => {
    expect(localStorage.getItem("velocity.slateUiPrefs")).toBeNull();
  });

  it("ignores a corrupt blob", () => {
    localStorage.setItem("velocity.slateUiPrefs", "{not json");
    expect(() => useSlateUi.getState().set("pdfPage", "explorer")).not.toThrow();
  });
});
