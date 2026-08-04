import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/shared/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";

function pointerEvent(
  type: "pointerdown" | "pointermove",
  { x, y }: { x: number; y: number },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  return event;
}

describe("Tooltip", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the standard hover-intent delay", async () => {
    vi.useFakeTimers();

    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button">Attach</Button>
          </TooltipTrigger>
          <TooltipContent>Attach files</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    fireEvent.pointerMove(screen.getByRole("button", { name: "Attach" }), {
      pointerType: "mouse",
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_DELAY.standard - 1));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Attach files");
  });

  it("requires pointer movement before reopening after activation", async () => {
    vi.useFakeTimers();

    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button">Attach</Button>
          </TooltipTrigger>
          <TooltipContent>Attach files</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Attach" });
    fireEvent.pointerMove(trigger, {
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_DELAY.standard));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Attach files");

    fireEvent(trigger, pointerEvent("pointerdown", { x: 10, y: 10 }));
    fireEvent.pointerUp(document, { pointerType: "mouse" });
    fireEvent.click(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_DELAY.standard * 2));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent(trigger, pointerEvent("pointermove", { x: 20, y: 10 }));
    await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_DELAY.standard - 1));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Attach files");
  });

  it("does not block unrelated tooltips while another trigger owns an overlay", async () => {
    vi.useFakeTimers();

    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" aria-expanded="true">
              Model
            </Button>
          </TooltipTrigger>
          <TooltipContent>GPT-5.6 Sol</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button">Voice dictation</Button>
          </TooltipTrigger>
          <TooltipContent>Voice dictation</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    fireEvent.pointerMove(
      screen.getByRole("button", { name: "Voice dictation" }),
      { pointerType: "mouse" },
    );
    await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_DELAY.standard));

    expect(screen.getByRole("tooltip")).toHaveTextContent("Voice dictation");
  });

  it("stays hidden while an expanded trigger owns an overlay", async () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" aria-expanded="false">
              Project
            </Button>
          </TooltipTrigger>
          <TooltipContent>/Users/example/project</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    let trigger = screen.getByRole("button", { name: "Project" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_DELAY.standard));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "/Users/example/project",
    );

    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    rerender(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" aria-expanded="true">
              Project
            </Button>
          </TooltipTrigger>
          <TooltipContent>/Users/example/project</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    trigger = screen.getByRole("button", { name: "Project" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_DELAY.standard * 2));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" aria-expanded="false">
              Project
            </Button>
          </TooltipTrigger>
          <TooltipContent>/Users/example/project</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(TOOLTIP_DELAY.standard * 2));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("moves between adjacent tooltip triggers", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button">One</Button>
          </TooltipTrigger>
          <TooltipContent>First tooltip</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button">Two</Button>
          </TooltipTrigger>
          <TooltipContent>Second tooltip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole("button", { name: "One" }));
    expect(
      await screen.findByRole("tooltip", { name: "First tooltip" }),
    ).toBeInTheDocument();
    await user.unhover(screen.getByRole("button", { name: "One" }));

    await user.hover(screen.getByRole("button", { name: "Two" }));
    expect(
      await screen.findByRole("tooltip", { name: "Second tooltip" }),
    ).toBeInTheDocument();
  });

  it("moves between adjacent Button tooltip props", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider>
        <Button type="button" tooltip="First tooltip">
          One
        </Button>
        <Button type="button" tooltip="Second tooltip">
          Two
        </Button>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole("button", { name: "One" }));
    expect(
      await screen.findByRole("tooltip", { name: "First tooltip" }),
    ).toBeInTheDocument();
    await user.unhover(screen.getByRole("button", { name: "One" }));

    await user.hover(screen.getByRole("button", { name: "Two" }));
    expect(
      await screen.findByRole("tooltip", { name: "Second tooltip" }),
    ).toBeInTheDocument();
  });

  it("uses the product tooltip surface and defaults above its trigger", async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button">Attach</Button>
          </TooltipTrigger>
          <TooltipContent>Attach files</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole("button", { name: "Attach" }));

    const tooltip = await screen.findByRole("tooltip");
    const tooltipContent = document.querySelector(
      '[data-slot="tooltip-content"]',
    );
    expect(tooltip).toHaveTextContent("Attach files");
    expect(tooltipContent).toHaveAttribute("data-preferred-side", "top");
    expect(tooltipContent).toHaveClass(
      "bg-popover-inverse",
      "text-popover-inverse-foreground",
      "rounded-md",
    );
  });
});
