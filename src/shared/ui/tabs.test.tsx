import { forwardRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

function StandardTabs() {
  return (
    <Tabs defaultValue="one">
      <TabsList variant="buttons">
        <TabsTrigger value="one" variant="buttons">
          <span>Label</span>
          <span data-testid="marker">@</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

const motionMocks = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock("motion/react", () => ({
  motion: {
    span: forwardRef<
      HTMLSpanElement,
      React.ComponentProps<"span"> & {
        animate?: unknown;
        initial?: unknown;
        layoutId?: string;
        transition?: unknown;
      }
    >(
      (
        {
          animate,
          initial: _initial,
          layoutId,
          transition: _transition,
          ...props
        },
        ref,
      ) => (
        <span
          ref={ref}
          data-animate={animate ? JSON.stringify(animate) : undefined}
          data-layout-id={layoutId}
          {...props}
        />
      ),
    ),
  },
  useReducedMotion: () => motionMocks.reducedMotion,
}));

function SegmentedTabs() {
  const [value, setValue] = useState("one");

  return (
    <Tabs value={value} onValueChange={setValue}>
      <TabsList variant="segmented">
        {/* biome-ignore lint/complexity/noUselessFragments: verifies trigger registration through fragments */}
        <>
          <TabsTrigger value="one" variant="segmented">
            One
          </TabsTrigger>
          <TabsTrigger value="two" variant="segmented">
            Two
          </TabsTrigger>
          <TabsTrigger value="three" variant="segmented">
            Three
          </TabsTrigger>
        </>
      </TabsList>
    </Tabs>
  );
}

function getStretchIndicator(): HTMLElement {
  const activeContainer = document.querySelector(
    "[data-segmented-active-container]",
  );
  const indicator = activeContainer?.querySelector("[data-animate]");
  if (!(indicator instanceof HTMLElement)) {
    throw new Error("Expected the segmented active indicator to render");
  }
  return indicator;
}

describe("Tabs", () => {
  it("preserves direct children for non-segmented trigger layouts", () => {
    render(<StandardTabs />);

    const marker = screen.getByTestId("marker");
    expect(marker.parentElement).toHaveAttribute("role", "tab");
  });

  describe("segmented", () => {
    beforeEach(() => {
      vi.useRealTimers();
      motionMocks.reducedMotion = false;
    });

    it("mounts at rest without a directional stretch", () => {
      render(<SegmentedTabs />);

      expect(getStretchIndicator()).toHaveAttribute(
        "data-animate",
        JSON.stringify({ left: "0%", right: "0%" }),
      );
    });

    it("derives direction from DOM order through fragments", async () => {
      const user = userEvent.setup();
      render(<SegmentedTabs />);

      await user.click(screen.getByRole("tab", { name: "Three" }));
      await waitFor(() => {
        expect(getStretchIndicator().getAttribute("data-animate")).toContain(
          '"left":[',
        );
      });

      await user.click(screen.getByRole("tab", { name: "One" }));
      await waitFor(() => {
        expect(getStretchIndicator().getAttribute("data-animate")).toContain(
          '"right":[',
        );
      });
    });

    it("removes sparkle effects after the transition completes", async () => {
      const user = userEvent.setup();
      render(<SegmentedTabs />);

      await user.click(screen.getByRole("tab", { name: "Two" }));
      await waitFor(() =>
        expect(
          document.querySelector("[data-segmented-sparkles]"),
        ).toBeInTheDocument(),
      );
      expect(
        document.querySelector("[data-segmented-refraction]"),
      ).toBeInTheDocument();

      await waitFor(
        () => {
          expect(
            document.querySelector("[data-segmented-sparkles]"),
          ).toBeNull();
          expect(
            document.querySelector("[data-segmented-refraction]"),
          ).toBeNull();
        },
        { timeout: 600 },
      );
    });

    it("disables stretch keyframes when reduced motion is requested", async () => {
      motionMocks.reducedMotion = true;
      const user = userEvent.setup();
      render(<SegmentedTabs />);

      await user.click(screen.getByRole("tab", { name: "Two" }));

      expect(getStretchIndicator()).toHaveAttribute(
        "data-animate",
        JSON.stringify({ left: "0%", right: "0%" }),
      );
    });
  });
});
