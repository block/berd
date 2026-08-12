import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClockWidget } from "./ClockWidget";
import type { WidgetRenderProps } from "./types";

const clockWidgetProps: WidgetRenderProps = {
  instance: { id: "clock-test", type: "clock", x: 0, y: 0, z: 0 },
  onUpdateState: vi.fn(),
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "widgets.clock.current" ? "Current time" : key,
  }),
}));

vi.mock("@/shared/i18n", () => ({
  useLocaleFormatting: () => ({
    locale: "en",
    formatDate: () => "Sunday, June 1 at 2:30 PM",
    getTimeParts: () => ({ hour: "2", minute: "30", dayPeriod: "PM" }),
  }),
}));

describe("ClockWidget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T14:30:45"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes an accessible timer label and themed hands", () => {
    const { container } = render(<ClockWidget {...clockWidgetProps} />);

    expect(
      screen.getByRole("timer", {
        name: /current time: sunday, june 1 at 2:30 pm/i,
      }),
    ).toBeInTheDocument();
    expect(
      container.querySelector(".bg-clock-minute-hand"),
    ).toBeInTheDocument();
    expect(container.querySelector(".bg-clock-hand")).toBeInTheDocument();
  });

  it("advances the second hand every second", async () => {
    const { container } = render(<ClockWidget {...clockWidgetProps} />);

    expect(container.innerHTML).toContain("rotate(270deg)");

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.innerHTML).toContain("rotate(276deg)");
  });

  it("toggles to digital when the toggle button is clicked", () => {
    const onUpdateState = vi.fn();
    render(<ClockWidget {...clockWidgetProps} onUpdateState={onUpdateState} />);
    fireEvent.click(
      screen.getByRole("button", { name: "widgets.clock.toggleToDigital" }),
    );
    expect(onUpdateState).toHaveBeenCalledWith({ mode: "digital" });
  });

  it("does not toggle while a drag/resize gesture is active", () => {
    const onUpdateState = vi.fn();
    render(
      <ClockWidget
        {...clockWidgetProps}
        onUpdateState={onUpdateState}
        shouldIgnoreActivation={() => true}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "widgets.clock.toggleToDigital" }),
    );
    expect(onUpdateState).not.toHaveBeenCalled();
  });

  it("renders a digital readout (no second hand) when mode is digital", () => {
    const { container } = render(
      <ClockWidget
        {...clockWidgetProps}
        instance={{ ...clockWidgetProps.instance, state: { mode: "digital" } }}
      />,
    );
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("PM")).toBeInTheDocument();
    expect(container.querySelector(".bg-clock-hand")).not.toBeInTheDocument();
  });
});
