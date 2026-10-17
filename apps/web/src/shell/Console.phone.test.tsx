import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Console } from "./Console.js";
import { useSelection } from "../state/stores.js";

// The console on a phone, 2026-10-17. Measured on a Pixel 7 before this
// existed: the map had 23% of the screen, 77 elements ran past the right edge
// and the desktop File/Edit/View bar was the phone's navigation. What these
// pin is the behaviour, not the pixels (jsdom has no layout; the pixels are
// graded by `tools/perf/ui_clip_sweep.mjs --device "Pixel 7" --grade`).

function stubWidth(phone: boolean): void {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: phone && q.includes("max-width: 767px"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => useSelection.getState().select(null));
});

const panels = {
  layers: <div>layers-body</div>,
  find: <div>find-body</div>,
  histogram: <div>histogram-body</div>,
  // An array, like App.tsx hands over (byHome): Children.toArray flattens it
  // into the sections the inner tabs are built from, and not a fragment.
  info: [
    <section key="feeds" aria-label="Feeds">
      feeds-body
    </section>,
    <section key="chokepoints" aria-label="Chokepoints">
      chokepoints-body
    </section>,
  ],
};
const right = { selection: <div>selection-body</div> };

function phone(extra: Partial<React.ComponentProps<typeof Console>> = {}) {
  stubWidth(true);
  return render(
    <Console
      map={<div>map</div>}
      dock={<div>dock-body</div>}
      action={<div>action-bar</div>}
      leftPanels={panels}
      rightPanels={right}
      {...extra}
    />,
  );
}

describe("Console on a phone", () => {
  it("is the map and a nav bar: no tab strip, no columns, no action bar", () => {
    phone();
    expect(screen.getByText("map")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByLabelText("Left panel")).toBeNull();
    expect(screen.queryByLabelText("Right panel")).toBeNull();
    expect(screen.queryByText("action-bar")).toBeNull();
    const nav = document.querySelector("nav[data-primary-nav]");
    expect(nav).not.toBeNull();
    expect(nav?.querySelectorAll("button")).toHaveLength(2);
    // The CSS keys off the same flag the markup does.
    expect(document.querySelector(".csl2")).toHaveAttribute("data-phone");
  });

  it("opens a panel through the chooser and closes back to the map", () => {
    phone();
    fireEvent.click(screen.getByRole("button", { name: "Panels" }));
    // Every named panel and the right dock's are listed, once.
    for (const name of ["Layers", "Find", "Histogram", "Info", "Selection"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(screen.getByRole("region", { name: "Find" })).toBeInTheDocument();
    expect(screen.getByText("find-body")).toBeInTheDocument();
    // One sheet at a time: the chooser is gone while a panel is up.
    expect(screen.queryByRole("button", { name: "Close menu" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Find" }));
    expect(screen.queryByRole("region", { name: "Find" })).toBeNull();
    expect(screen.getByText("map")).toBeInTheDocument();
  });

  it("keeps a multi-section panel's inner tabs inside its sheet", () => {
    phone();
    fireEvent.click(screen.getByRole("button", { name: "Panels" }));
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByText("feeds-body")).toBeInTheDocument();
    expect(screen.queryByText("chokepoints-body")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Chokepoints" }));
    expect(screen.getByText("chokepoints-body")).toBeInTheDocument();
    expect(screen.queryByText("feeds-body")).toBeNull();
  });

  it("a number key opens the panel its tooltip names, as a sheet", () => {
    phone();
    fireEvent.keyDown(window, { key: "3" });
    expect(
      screen.getByRole("region", { name: "Histogram" }),
    ).toBeInTheDocument();
  });

  it("opens the Selection sheet when a contact is picked and closes it when cleared", () => {
    phone();
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();

    act(() => useSelection.getState().select("aircraft:abc123"));
    expect(
      screen.getByRole("region", { name: "Selection" }),
    ).toBeInTheDocument();
    expect(screen.getByText("selection-body")).toBeInTheDocument();

    act(() => useSelection.getState().select(null));
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();
  });

  it("closing the Selection sheet by hand leaves the contact picked", () => {
    phone();
    act(() => useSelection.getState().select("aircraft:abc123"));
    fireEvent.click(screen.getByRole("button", { name: "Close Selection" }));
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();
    expect(useSelection.getState().selectedEntityId).toBe("aircraft:abc123");
  });

  it("does not open Selection over a full-bleed app, and asks for the map when a panel is chosen", () => {
    const onPanelWhileBleed = vi.fn();
    phone({ bleed: true, onPanelWhileBleed });
    act(() => useSelection.getState().select("aircraft:abc123"));
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Panels" }));
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    expect(onPanelWhileBleed).toHaveBeenCalledTimes(1);
  });

  // The dock installs the playback controller and drives the viewer clock, so
  // unmounting it while closed would end a running replay the moment its sheet
  // was dismissed. It changes shape in place instead.
  it("keeps the time dock mounted, one node, whether its sheet is open or not", () => {
    phone();
    const dockNode = screen.getByText("dock-body");
    const wrapper = dockNode.closest(".csl2-dock");
    expect(wrapper).toHaveAttribute("data-sheet", "closed");

    fireEvent.click(screen.getByRole("button", { name: "Time" }));
    expect(wrapper).toHaveAttribute("data-sheet", "open");
    expect(screen.getByText("dock-body")).toBe(dockNode);
    expect(screen.getByRole("button", { name: "Time" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Time" }));
    expect(wrapper).toHaveAttribute("data-sheet", "closed");
    expect(screen.getByText("dock-body")).toBe(dockNode);
  });

  it("opening one sheet closes the others", () => {
    phone();
    fireEvent.click(screen.getByRole("button", { name: "Time" }));
    fireEvent.click(screen.getByRole("button", { name: "Panels" }));
    expect(
      document.querySelector(".csl2-dock")?.getAttribute("data-sheet"),
    ).toBe("closed");
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    fireEvent.click(screen.getByRole("button", { name: "Time" }));
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
  });
});

describe("Console above the phone breakpoint", () => {
  it("is the desktop grammar: tab strip, columns, action bar, no nav bar", () => {
    stubWidth(false);
    // The desktop dock measures itself so the map furniture clears it.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    render(
      <Console
        map={<div>map</div>}
        dock={<div>dock-body</div>}
        action={<div>action-bar</div>}
        leftPanels={panels}
        rightPanels={right}
      />,
    );
    expect(screen.getByRole("tablist", { name: "Map panels" })).toBeVisible();
    expect(screen.getByLabelText("Left panel")).toBeInTheDocument();
    expect(screen.getByLabelText("Right panel")).toBeInTheDocument();
    expect(screen.getByText("action-bar")).toBeInTheDocument();
    expect(document.querySelector("nav[data-primary-nav]")).toBeNull();
    expect(document.querySelector(".csl2")).not.toHaveAttribute("data-phone");
    expect(
      document.querySelector(".csl2-dock")?.hasAttribute("data-sheet"),
    ).toBe(false);
  });

  it("does not open a Selection sheet when a contact is picked", () => {
    stubWidth(false);
    render(
      <Console map={<div>map</div>} leftPanels={panels} rightPanels={right} />,
    );
    act(() => useSelection.getState().select("aircraft:abc123"));
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();
  });
});
