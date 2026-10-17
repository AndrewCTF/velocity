import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Console } from "./Console.js";
import { useSelection } from "../state/stores.js";
import { usePhoneSheet } from "./phoneSheet.js";
import { PhoneNotice } from "./PhoneNotice.js";

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
  // Still mounted here (cleanup runs after), so reset before the stubs go.
  act(() => useSelection.getState().select(null));
  act(() => usePhoneSheet.setState({ open: null, tools: false }));
  vi.unstubAllGlobals();
});

/** A tab in the phone's tab bar, by its label. */
const tab = (name: string): HTMLElement =>
  within(
    document.querySelector<HTMLElement>("nav[data-primary-nav]")!,
  ).getByRole("button", { name });

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
  // The sheets measure the map well.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
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
  it("is the map and a tab bar: no title row, no tab strip, no columns, no action bar", () => {
    phone({ onOpenAlerts: () => {} });
    expect(screen.getByText("map")).toBeInTheDocument();
    expect(document.querySelector(".csl2-title")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByLabelText("Left panel")).toBeNull();
    expect(screen.queryByLabelText("Right panel")).toBeNull();
    expect(screen.queryByText("action-bar")).toBeNull();
    const nav = document.querySelector("nav[data-primary-nav]");
    expect(
      [...(nav?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
    ).toEqual(["Layers", "Find", "Time", "Alerts", "More"]);
    // The CSS keys off the same flag the markup does.
    expect(document.querySelector(".csl2")).toHaveAttribute("data-phone");
  });

  it("opens a panel from its tab as a sheet over the map, and closes it", () => {
    phone();
    fireEvent.click(tab("Find"));
    expect(screen.getByRole("region", { name: "Find" })).toBeInTheDocument();
    expect(screen.getByText("find-body")).toBeInTheDocument();
    expect(screen.getByText("map")).toBeInTheDocument();
    expect(tab("Find")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close Find" }));
    expect(screen.queryByRole("region", { name: "Find" })).toBeNull();
  });

  it("closes the sheet when its own tab is tapped again", () => {
    phone();
    fireEvent.click(tab("Layers"));
    expect(screen.getByRole("region", { name: "Layers" })).toBeInTheDocument();
    fireEvent.click(tab("Layers"));
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
  });

  it("opens Find from outside the console, through the sheet store", () => {
    // The title bar's search pill does exactly this.
    phone();
    act(() => usePhoneSheet.getState().show("find"));
    expect(screen.getByText("find-body")).toBeInTheDocument();
  });

  it("lists the other panels under More, and keeps a panel's inner tabs in its sheet", () => {
    phone();
    fireEvent.click(tab("More"));
    const more = screen.getByRole("region", { name: "More" });
    for (const name of ["Histogram", "Info", "Map tools"])
      expect(within(more).getByText(name)).toBeInTheDocument();
    fireEvent.click(within(more).getByText("Info"));
    expect(screen.queryByRole("region", { name: "More" })).toBeNull();
    expect(screen.getByText("feeds-body")).toBeInTheDocument();
    expect(screen.queryByText("chokepoints-body")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Chokepoints" }));
    expect(screen.getByText("chokepoints-body")).toBeInTheDocument();
  });

  it("runs the rows the app adds to More, and Map tools shows the tool rail", () => {
    const run = vi.fn();
    phone({ phoneMore: [{ label: "Analyst agent", icon: "sparkle", run }] });
    fireEvent.click(tab("More"));
    fireEvent.click(screen.getByText("Analyst agent"));
    expect(run).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Map tools"));
    expect(usePhoneSheet.getState().tools).toBe(true);
    expect(screen.queryByRole("region", { name: "More" })).toBeNull();
  });

  it("a number key opens the panel its tooltip names, as a sheet", () => {
    phone();
    fireEvent.keyDown(window, { key: "3" });
    expect(
      screen.getByRole("region", { name: "Histogram" }),
    ).toBeInTheDocument();
  });

  it("raises the Selection sheet when a contact is picked and drops it when cleared", () => {
    phone();
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();

    act(() => useSelection.getState().select("aircraft:abc123"));
    const sheet = screen.getByRole("region", { name: "Selection" });
    // A peek strip: the contact's name and actions, the map still above it.
    expect(sheet).toHaveAttribute("data-detent", "peek");
    expect(screen.getByText("selection-body")).toBeInTheDocument();

    act(() => useSelection.getState().select(null));
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();
  });

  it("closing the Selection sheet by hand leaves the contact picked, and More brings it back", () => {
    phone();
    act(() => useSelection.getState().select("aircraft:abc123"));
    fireEvent.click(screen.getByRole("button", { name: "Close Selection" }));
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();
    expect(useSelection.getState().selectedEntityId).toBe("aircraft:abc123");
    fireEvent.click(tab("More"));
    fireEvent.click(screen.getByText("Selection"));
    expect(
      screen.getByRole("region", { name: "Selection" }),
    ).toBeInTheDocument();
  });

  it("does not open Selection over a full-bleed app, and asks for the map when a panel is chosen", () => {
    const onPanelWhileBleed = vi.fn();
    phone({ bleed: true, onPanelWhileBleed });
    act(() => useSelection.getState().select("aircraft:abc123"));
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();
    fireEvent.click(tab("Layers"));
    expect(onPanelWhileBleed).toHaveBeenCalledTimes(1);
  });

  // The dock installs the playback controller and drives the viewer clock, so
  // unmounting it while closed would end a running replay the moment its sheet
  // was dismissed. Its sheet hides instead.
  it("keeps the time dock mounted, one node, whether its sheet is open or not", () => {
    phone();
    const dockNode = screen.getByText("dock-body");
    const sheet = dockNode.closest(".psheet");
    expect(sheet).toHaveAttribute("hidden");

    fireEvent.click(tab("Time"));
    expect(sheet).not.toHaveAttribute("hidden");
    expect(screen.getByText("dock-body")).toBe(dockNode);
    expect(tab("Time")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close Time" }));
    expect(sheet).toHaveAttribute("hidden");
    expect(screen.getByText("dock-body")).toBe(dockNode);
  });

  it("opening one sheet closes the others", () => {
    phone();
    fireEvent.click(tab("Time"));
    fireEvent.click(tab("Layers"));
    expect(screen.getByText("dock-body").closest(".psheet")).toHaveAttribute(
      "hidden",
    );
    fireEvent.click(tab("Time"));
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
  });

  it("the Alerts tab is a sheet tab: it takes over from any other sheet", () => {
    // App toggles the "alerts" sheet; AlertsPanel renders it into the map well.
    const onOpenAlerts = vi.fn(() => usePhoneSheet.getState().toggle("alerts"));
    phone({ onOpenAlerts });
    fireEvent.click(tab("Layers"));
    fireEvent.click(tab("Alerts"));
    expect(onOpenAlerts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
    expect(tab("Alerts")).toHaveAttribute("aria-pressed", "true");
  });

  it("gives sheets owned outside the console the map well to portal into", () => {
    phone();
    expect(usePhoneSheet.getState().mapWell).toBe(
      document.querySelector(".csl2-map"),
    );
  });

  it("publishes the open sheet's height for the map buttons, and zero when closed", () => {
    phone();
    expect(usePhoneSheet.getState().sheetPx).toBe(0);
    fireEvent.click(tab("Layers"));
    // 600px well in jsdom: half is 300.
    expect(usePhoneSheet.getState().sheetPx).toBe(300);
    fireEvent.click(tab("Layers"));
    expect(usePhoneSheet.getState().sheetPx).toBe(0);
  });

  it("draws notices into the Notices sheet and counts them, not over the map", () => {
    function Banner({ text }: { text: string }) {
      return (
        <PhoneNotice>
          <div className="map-banner">{text}</div>
        </PhoneNotice>
      );
    }
    phone();
    const { rerender } = render(
      <>
        <Banner text="notice-a" />
        <Banner text="notice-b" />
      </>,
    );
    expect(usePhoneSheet.getState().notices).toBe(2);
    const host = document.querySelector(".pnotices");
    expect(host?.textContent).toContain("notice-a");
    expect(host?.textContent).toContain("notice-b");

    // A banner dismissed (unmounted) leaves the count.
    rerender(<Banner text="notice-a" />);
    expect(usePhoneSheet.getState().notices).toBe(1);
  });

  it("a sheet dragged down past its lowest stop closes, and a short drag snaps back", () => {
    phone();
    fireEvent.click(tab("Layers"));
    const handle = document.querySelector(".psheet-handle")!;
    // 600px well in jsdom: half = 300px. A 100px drag leaves 200, back to half.
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 400, pointerId: 1 });
    expect(screen.getByRole("region", { name: "Layers" })).toHaveAttribute(
      "data-detent",
      "half",
    );
    // A 250px drag leaves 50, under 65% of the lowest stop: closed.
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 550, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 550, pointerId: 1 });
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
  });

  it("Escape closes the open sheet, with focus still on the tab that opened it", () => {
    phone();
    tab("Layers").focus();
    fireEvent.click(tab("Layers"));
    fireEvent.keyDown(tab("Layers"), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
  });

  it("a drag up snaps to full, and a tap on the grab bar steps back down", async () => {
    phone();
    fireEvent.click(tab("Layers"));
    const handle = document.querySelector(".psheet-handle")!;
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 80, pointerId: 1 });
    const sheet = screen.getByRole("region", { name: "Layers" });
    expect(sheet).toHaveAttribute("data-detent", "full");
    // The click a drag's own lift makes is swallowed; a later tap is not.
    fireEvent.click(screen.getByRole("button", { name: "Lower Layers" }));
    expect(sheet).toHaveAttribute("data-detent", "full");
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(screen.getByRole("button", { name: "Lower Layers" }));
    expect(sheet).toHaveAttribute("data-detent", "half");
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
