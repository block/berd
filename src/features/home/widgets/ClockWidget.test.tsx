import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClockWidget } from "./ClockWidget";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "widgets.clock.current" ? "Current time" : key,
  }),
}));

vi.mock("@/shared/i18n", () => ({
  useLocaleFormatting: () => ({
    formatDate: () => "Sunday, June 1 at 2:30 PM",
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
    const { container } = render(<ClockWidget />);

    expect(
      screen.getByRole("timer", {
        name: /current time: sunday, june 1 at 2:30 pm/i,
      }),
    ).toBeInTheDocument();
    expect(container.querySelector(".bg-clock-minute-hand")).toBeInTheDocument();
    expect(container.querySelector(".bg-clock-hand")).toBeInTheDocument();
  });

  it("advances the second hand every second", async () => {
    const { container } = render(<ClockWidget />);

    expect(container.innerHTML).toContain("rotate(270deg)");

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.innerHTML).toContain("rotate(276deg)");
  });
});
