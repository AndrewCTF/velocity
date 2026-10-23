import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TimelinePanel, binLane, rulerLabels } from "./TimelinePanel.js";

const H = 3_600_000;
const FROM = Date.UTC(2026, 9, 23, 4, 0, 0);

describe("TimelinePanel (G23)", () => {
  it("bins events onto the 46px tile pitch and drops ones outside the window", () => {
    const cells = binLane(
      [
        { t: FROM + 1000, label: "a" },
        { t: FROM + 2000, label: "b" },
        { t: FROM + H / 2, label: "c" },
        { t: FROM + 2 * H, label: "outside" },
      ],
      FROM,
      H,
      460,
    );
    expect(cells.get(0)?.map((e) => e.label)).toEqual(["a", "b"]);
    expect(cells.get(5)?.map((e) => e.label)).toEqual(["c"]);
    expect([...cells.values()].flat().length).toBe(3);
  });

  it("labels whole days across a multi-day window and clock times inside one", () => {
    expect(rulerLabels(FROM, 4 * 24 * H).map((l) => l.text)).toEqual([
      "Oct 24th",
      "Oct 25th",
      "Oct 26th",
      "Oct 27th",
    ]);
    const hour = rulerLabels(FROM, H).map((l) => l.text);
    expect(hour.length).toBeLessThanOrEqual(5);
    expect(hour[0]).toBe("04:00");
  });

  it("a tile seeks to its first event and the legend counts the lane", () => {
    const seek = vi.fn();
    render(
      <TimelinePanel
        lanes={[
          {
            id: "inc",
            label: "Incidents",
            events: [{ t: FROM + 1000, label: "x" }],
          },
        ]}
        from={FROM}
        span={H}
        clockMs={FROM + H / 2}
        playing={false}
        onPlay={() => {}}
        seek={seek}
        onFit={() => {}}
        controls={false}
        onControls={() => {}}
        onReplayDay={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Incidents, 1 event/ }));
    expect(seek).toHaveBeenCalledWith(FROM + 1000);
    expect(screen.getByText("Incidents").nextSibling?.textContent).toBe("1");
  });
});
