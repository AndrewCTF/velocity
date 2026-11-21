// D89 trace marks: the saved-map frame dots every 11th recorded fix of the
// selected aircraft's trace and puts a callsign chip on the live end. These
// pin the pure helpers the Cesium overlay reads, so a future edit cannot
// silently shift the stride or the chip fallback chain.
import { describe, expect, it } from "vitest";
import { TRACE_DOT_STEP, traceChipText, traceDotIndices } from "./selectionTrack.js";

describe("traceDotIndices", () => {
  it("dots every 11th recorded fix starting at index 0", () => {
    expect(TRACE_DOT_STEP).toBe(11);
    expect(traceDotIndices(0)).toEqual([]);
    expect(traceDotIndices(1)).toEqual([0]);
    expect(traceDotIndices(11)).toEqual([0]);
    expect(traceDotIndices(12)).toEqual([0, 11]);
    expect(traceDotIndices(149)).toEqual(
      [0, 11, 22, 33, 44, 55, 66, 77, 88, 99, 110, 121, 132, 143],
    );
  });
});

describe("traceChipText", () => {
  it("prefers callsign, then registration, then ICAO24, then fallback", () => {
    expect(
      traceChipText({ callsign: "UAE751", registration: "A6-AAA", icao24: "8960f1", fallback: "8960F1" }),
    ).toBe("UAE751");
    expect(
      traceChipText({ callsign: "  ", registration: "A6-AAA", icao24: "8960f1", fallback: "8960F1" }),
    ).toBe("A6-AAA");
    expect(
      traceChipText({ callsign: null, registration: null, icao24: "8960f1", fallback: "8960F1" }),
    ).toBe("8960f1");
    expect(
      traceChipText({ callsign: "", registration: "", icao24: "", fallback: "8960F1" }),
    ).toBe("8960F1");
  });
});
