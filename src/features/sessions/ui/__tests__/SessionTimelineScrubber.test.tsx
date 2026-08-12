import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SessionTimelineMarker,
  SessionTimelineScrubber,
} from "../SessionTimelineScrubber";

const markers: SessionTimelineMarker[] = [
  { key: "today", label: "Today", index: 0 },
  { key: "yesterday", label: "Yesterday", index: 5 },
  { key: "aug-4", label: "August 4, 2026", index: 12 },
  { key: "aug-1", label: "August 1, 2026", index: 20 },
  { key: "jul-20", label: "July 20, 2026", index: 31 },
];

const RAIL_HEIGHT = 400;

function mockRailRect(rail: HTMLElement) {
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
    top: 0,
    left: 0,
    right: 48,
    bottom: RAIL_HEIGHT,
    width: 48,
    height: RAIL_HEIGHT,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function renderScrubber(props?: {
  markers?: SessionTimelineMarker[];
  activeKey?: string;
  onJump?: (index: number) => void;
}) {
  const onJump = props?.onJump ?? vi.fn();
  const view = render(
    <SessionTimelineScrubber
      markers={props?.markers ?? markers}
      activeKey={props?.activeKey}
      onJump={onJump}
    />,
  );
  const rail = screen.queryByRole("slider");
  if (rail) mockRailRect(rail);
  return { ...view, rail, onJump };
}

// jsdom does not implement PointerEvent; without it fireEvent drops clientY.
class PointerEventPolyfill extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

describe("SessionTimelineScrubber", () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === "undefined") {
      window.PointerEvent =
        PointerEventPolyfill as unknown as typeof PointerEvent;
    }
    // jsdom does not implement pointer capture.
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders null with fewer than two markers", () => {
    const { container } = render(
      <SessionTimelineScrubber markers={[markers[0]]} onJump={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("renders one tick dash per marker", () => {
    const { container } = renderScrubber();

    expect(container.querySelectorAll("[data-timeline-dash]")).toHaveLength(
      markers.length,
    );
  });

  it("exposes slider aria attributes", () => {
    const { rail } = renderScrubber({ activeKey: "aug-4" });

    expect(rail).toHaveAttribute("aria-orientation", "vertical");
    expect(rail).toHaveAttribute("aria-valuemin", "0");
    expect(rail).toHaveAttribute("aria-valuemax", "4");
    expect(rail).toHaveAttribute("aria-valuenow", "2");
    expect(rail).toHaveAttribute("aria-valuetext", "August 4, 2026");
    expect(rail).toHaveAccessibleName("Jump to date");
  });

  it("jumps to the nearest marker on click (pointer down)", () => {
    const { rail, onJump } = renderScrubber();

    // 5 markers over 400px: marker slots at 0, 100, 200, 300, 400.
    // y=190 is nearest to the third marker (index 12).
    fireEvent.pointerDown(rail as HTMLElement, {
      pointerId: 1,
      clientY: 190,
    });

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(12);
  });

  it("supports ArrowDown/ArrowUp/Home/End from the active marker", () => {
    const { rail, onJump } = renderScrubber({ activeKey: "aug-4" });

    fireEvent.keyDown(rail as HTMLElement, { key: "ArrowDown" });
    expect(onJump).toHaveBeenLastCalledWith(20);

    fireEvent.keyDown(rail as HTMLElement, { key: "ArrowUp" });
    expect(onJump).toHaveBeenLastCalledWith(5);

    fireEvent.keyDown(rail as HTMLElement, { key: "Home" });
    expect(onJump).toHaveBeenLastCalledWith(0);

    fireEvent.keyDown(rail as HTMLElement, { key: "End" });
    expect(onJump).toHaveBeenLastCalledWith(31);

    expect(onJump).toHaveBeenCalledTimes(4);
  });

  it("clamps keyboard navigation at the ends", () => {
    const first = renderScrubber({ activeKey: "today" });
    fireEvent.keyDown(first.rail as HTMLElement, { key: "ArrowUp" });
    expect(first.onJump).toHaveBeenLastCalledWith(0);
    first.unmount();

    const last = renderScrubber({ activeKey: "jul-20" });
    fireEvent.keyDown(last.rail as HTMLElement, { key: "ArrowDown" });
    expect(last.onJump).toHaveBeenLastCalledWith(31);
  });

  it("drags: fires onJump only when the nearest marker changes", () => {
    const { rail, onJump } = renderScrubber();
    const element = rail as HTMLElement;

    fireEvent.pointerDown(element, { pointerId: 1, clientY: 0 });
    expect(onJump).toHaveBeenNthCalledWith(1, 0);
    expect(element.setPointerCapture).toHaveBeenCalledWith(1);

    // Small move within the same marker slot: no additional call.
    fireEvent.pointerMove(element, { pointerId: 1, clientY: 20 });
    expect(onJump).toHaveBeenCalledTimes(1);

    // Move into the second marker slot.
    fireEvent.pointerMove(element, { pointerId: 1, clientY: 110 });
    expect(onJump).toHaveBeenNthCalledWith(2, 5);

    // Still within the second slot: no repeat.
    fireEvent.pointerMove(element, { pointerId: 1, clientY: 120 });
    expect(onJump).toHaveBeenCalledTimes(2);

    // Jump down to the last slot.
    fireEvent.pointerMove(element, { pointerId: 1, clientY: 395 });
    expect(onJump).toHaveBeenNthCalledWith(3, 31);

    fireEvent.pointerUp(element, { pointerId: 1 });
    expect(element.releasePointerCapture).toHaveBeenCalledWith(1);

    // Moves after pointer-up (hover only) do not jump.
    fireEvent.pointerMove(element, { pointerId: 1, clientY: 210 });
    expect(onJump).toHaveBeenCalledTimes(3);
  });

  describe("unloaded-history tail", () => {
    // Captured so the loading-state tests can flip `isLoadingOlder` the way the
    // parent does, without re-mounting and losing focus/guard state.
    let rerenderTail: ReturnType<typeof render>["rerender"] | undefined;

    function renderWithTail(props?: {
      isLoadingOlder?: boolean;
      onLoadOlder?: () => void;
      onJump?: (index: number) => void;
    }) {
      const onJump = props?.onJump ?? vi.fn();
      const onLoadOlder = props?.onLoadOlder ?? vi.fn();
      const view = render(
        <SessionTimelineScrubber
          markers={markers}
          onJump={onJump}
          hasMore
          onLoadOlder={onLoadOlder}
          isLoadingOlder={props?.isLoadingOlder}
        />,
      );
      const rail = screen.getByRole("slider");
      mockRailRect(rail);
      rerenderTail = view.rerender;
      return { ...view, rail, onJump, onLoadOlder };
    }

    function rerenderWithTail(props: {
      onJump: (index: number) => void;
      onLoadOlder: () => void;
      isLoadingOlder: boolean;
    }) {
      rerenderTail?.(
        <SessionTimelineScrubber
          markers={markers}
          onJump={props.onJump}
          hasMore
          onLoadOlder={props.onLoadOlder}
          isLoadingOlder={props.isLoadingOlder}
        />,
      );
    }

    it("renders no tail when there is no older history", () => {
      const { container } = renderScrubber();

      expect(
        container.querySelectorAll("[data-timeline-tail-dash]"),
      ).toHaveLength(0);
      expect(screen.queryByText("Older")).not.toBeInTheDocument();
    });

    it("renders the tail when older history exists", () => {
      const { container } = renderWithTail();

      expect(
        container.querySelectorAll("[data-timeline-tail-dash]").length,
      ).toBeGreaterThan(0);
      expect(screen.getByText("Older")).toBeInTheDocument();
    });

    it("requests older history once per gesture when scrubbed into the tail", () => {
      const { rail, onLoadOlder, onJump } = renderWithTail();

      // Loaded markers occupy the top 85% of the rail; below that is the tail.
      fireEvent.pointerDown(rail, { pointerId: 1, clientY: 395 });

      expect(onLoadOlder).toHaveBeenCalledTimes(1);
      // Also lands on the oldest loaded group.
      expect(onJump).toHaveBeenLastCalledWith(31);

      // Staying in the tail during the same drag must not spam requests.
      fireEvent.pointerMove(rail, { pointerId: 1, clientY: 398 });
      expect(onLoadOlder).toHaveBeenCalledTimes(1);

      // A new gesture may ask again.
      fireEvent.pointerUp(rail, { pointerId: 1 });
      fireEvent.pointerDown(rail, { pointerId: 1, clientY: 396 });
      expect(onLoadOlder).toHaveBeenCalledTimes(2);
    });

    it("does not request older history from the loaded span", () => {
      const { rail, onLoadOlder } = renderWithTail();

      fireEvent.pointerDown(rail, { pointerId: 1, clientY: 10 });

      expect(onLoadOlder).not.toHaveBeenCalled();
    });

    it("loads older history from the keyboard and announces loading", async () => {
      const user = userEvent.setup();
      const { rail, onLoadOlder, onJump } = renderWithTail();

      // Pointer users reach the tail by scrubbing; a keyboard user has to be
      // able to get to the same action from the rail itself.
      rail.focus();
      expect(rail).toHaveFocus();

      await user.tab();
      const older = screen.getByRole("button", { name: "Older" });
      expect(older).toHaveFocus();

      await user.keyboard("{Enter}");

      expect(onLoadOlder).toHaveBeenCalledTimes(1);
      // Same landing spot as the pointer gesture: the oldest loaded group.
      expect(onJump).toHaveBeenLastCalledWith(31);

      rerenderWithTail({ onJump, onLoadOlder, isLoadingOlder: true });

      const announcement = screen.getByText("Loading\u2026");
      expect(announcement).toHaveAttribute("aria-live", "polite");
    });

    it("does not queue a second page while one is in flight, and re-arms after it lands", async () => {
      const user = userEvent.setup();
      const { onLoadOlder, onJump } = renderWithTail();

      await user.click(screen.getByRole("button", { name: "Older" }));
      expect(onLoadOlder).toHaveBeenCalledTimes(1);

      rerenderWithTail({ onJump, onLoadOlder, isLoadingOlder: true });

      // Pressing again mid-flight must not stack up requests.
      const loading = screen.getByRole("button", { name: "Loading\u2026" });
      expect(loading).toHaveAttribute("aria-disabled", "true");
      await user.click(loading);
      expect(onLoadOlder).toHaveBeenCalledTimes(1);

      // Once the page lands the control has to work again rather than latch.
      rerenderWithTail({ onJump, onLoadOlder, isLoadingOlder: false });

      await user.click(screen.getByRole("button", { name: "Older" }));
      expect(onLoadOlder).toHaveBeenCalledTimes(2);
    });

    it("narrates loading in the tail so a filtered-out page is not silent", () => {
      const { rerender } = renderWithTail({ isLoadingOlder: true });

      // A page can arrive filtered down to nothing (no new markers), so the
      // tail itself has to show that work is happening.
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      expect(screen.queryByText("Older")).not.toBeInTheDocument();

      rerender(
        <SessionTimelineScrubber
          markers={markers}
          onJump={vi.fn()}
          hasMore
          onLoadOlder={vi.fn()}
          isLoadingOlder={false}
        />,
      );

      expect(screen.getByText("Older")).toBeInTheDocument();
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
  });

  it("reveals the nearest marker label on hover", () => {
    const many: SessionTimelineMarker[] = Array.from(
      { length: 30 },
      (_, i) => ({ key: `k${i}`, label: `Day ${i}`, index: i * 3 }),
    );
    const { rail } = renderScrubber({ markers: many });
    const element = rail as HTMLElement;

    // Marker 1 (of 0..29) sits at y ≈ 400/29 ≈ 13.8, and is not labelled at
    // rest — only the newest group and the scrubbed-to group get labels.
    expect(screen.queryByText("Day 1")).not.toBeInTheDocument();

    fireEvent.pointerMove(element, { pointerId: 1, clientY: 14 });
    expect(screen.getByText("Day 1")).toBeInTheDocument();

    fireEvent.pointerLeave(element, { pointerId: 1 });
    expect(screen.queryByText("Day 1")).not.toBeInTheDocument();
  });

  it("labels only the newest group and the one being scrubbed to", () => {
    // 30 groups: the old rail sampled ~8 of these, which read as a set of
    // arbitrary dates. Now it shows the newest as a fixed anchor plus whatever
    // the user is actually pointing at.
    const many: SessionTimelineMarker[] = Array.from(
      { length: 30 },
      (_, i) => ({ key: `k${i}`, label: `Day ${i}`, index: i * 3 }),
    );
    const { rail } = renderScrubber({ markers: many, activeKey: "k0" });
    const element = rail as HTMLElement;

    // At rest, parked at the top: the newest label only.
    expect(screen.getByText("Day 0")).toBeInTheDocument();
    const labelledAtRest = many.filter(
      (marker) => screen.queryByText(marker.label) !== null,
    );
    expect(labelledAtRest).toHaveLength(1);

    // Scrubbing adds exactly one more: the date under the pointer.
    fireEvent.pointerMove(element, { pointerId: 1, clientY: 200 });
    const labelledWhileScrubbing = many.filter(
      (marker) => screen.queryByText(marker.label) !== null,
    );
    expect(labelledWhileScrubbing).toHaveLength(2);
    expect(screen.getByText("Day 0")).toBeInTheDocument();
  });
});
