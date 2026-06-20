import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "../TopBar";

const DEFAULT_WINDOW_WIDTH = 1440;

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function renderTopBar(props: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return render(
    <TopBar
      breadcrumbs={[{ label: "Home" }]}
      onFeedbackClick={vi.fn()}
      {...props}
    />,
  );
}

describe("TopBar", () => {
  afterEach(() => {
    setWindowWidth(DEFAULT_WINDOW_WIDTH);
  });

  it("navigates home when the goose logo is clicked", async () => {
    const user = userEvent.setup();
    const onGoHome = vi.fn();

    renderTopBar({ onGoHome });

    await user.click(screen.getByRole("button", { name: /goose home/i }));

    expect(onGoHome).toHaveBeenCalledOnce();
  });

  it("keeps the goose home logo at its top-bar brand size", () => {
    renderTopBar({ onGoHome: vi.fn() });

    const button = screen.getByRole("button", { name: /goose home/i });
    const icon = button.querySelector('[role="img"]');

    expect(icon).toHaveClass("size-5");
  });

  it("omits the goose home logo when onGoHome is not provided", () => {
    renderTopBar();

    expect(
      screen.queryByRole("button", { name: /goose home/i }),
    ).not.toBeInTheDocument();
  });

  it("omits search when onSearchClick is not provided", () => {
    renderTopBar();

    expect(
      screen.queryByRole("button", { name: /search/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps only the current breadcrumb at narrow widths", () => {
    setWindowWidth(900);

    renderTopBar({
      breadcrumbs: [
        { label: "Chat" },
        { label: "Goose Internal" },
        { label: "Model and system info" },
      ],
    });

    expect(screen.queryByText("Chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Goose Internal")).not.toBeInTheDocument();
    expect(screen.getByText("Model and system info")).toBeInTheDocument();
  });

  it("keeps toolbar controls available at narrow widths", () => {
    setWindowWidth(900);

    renderTopBar({
      contextPanelLabel: "Details",
      onGoHome: vi.fn(),
      onSearchClick: vi.fn(),
      showContextPanelToggle: true,
    });

    expect(
      screen.getByRole("button", { name: /goose home/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /feedback/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /details/i })).toHaveAttribute(
      "data-context-panel-toggle",
      "true",
    );
  });
});
