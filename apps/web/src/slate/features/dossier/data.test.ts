import { describe, expect, it } from "vitest";
import { chipRuns, storyParagraphs } from "./data.js";

describe("dossier data", () => {
  it("marks whole-word names as chips, longest first", () => {
    expect(
      chipRuns("Iran and the Strait of Hormuz; Iranian oil", [
        "Iran",
        "Strait of Hormuz",
      ]),
    ).toEqual([
      { t: "Iran", chip: "Iran" },
      { t: " and the ", chip: null },
      { t: "Strait of Hormuz", chip: "Strait of Hormuz" },
      { t: "; Iranian oil", chip: null },
    ]);
    expect(chipRuns("plain", [])).toEqual([{ t: "plain", chip: null }]);
  });

  it("reads the story's own text fields in order", () => {
    expect(
      storyParagraphs({
        id: "x",
        title: "t",
        neutral_summary: "A.",
        neutral_rewrite: "",
        verified_facts: [{ text: "B." }, "C."],
        attributed_claims: [{ claim: "D." }],
      }),
    ).toEqual(["A.", "B.", "C.", "D."]);
  });
});
