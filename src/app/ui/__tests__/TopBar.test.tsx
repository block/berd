import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TopBar } from "../TopBar";

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
  it("does not render the Berd home logo", () => {
    renderTopBar();

    expect(
      screen.queryByRole("button", { name: /Berd home/i }),
    ).not.toBeInTheDocument();
  });

  it("does not render breadcrumbs", () => {
    renderTopBar({
      breadcrumbs: [{ label: "Chat" }, { label: "Model and system info" }],
    });

    expect(screen.queryByText("Chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Model and system info")).not.toBeInTheDocument();
  });

  it("omits search when onSearchClick is not provided", () => {
    renderTopBar();

    expect(
      screen.queryByRole("button", { name: /search/i }),
    ).not.toBeInTheDocument();
  });

  it("omits feedback when onFeedbackClick is not provided", () => {
    renderTopBar({ onFeedbackClick: undefined });

    expect(
      screen.queryByRole("button", { name: /feedback/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps a long chat title in the flexible middle track", () => {
    const { container } = renderTopBar({
      breadcrumbs: [
        {
          id: "chat-session",
          label: "A very long chat title that must truncate before controls",
        },
      ],
      onSearchClick: vi.fn(),
      rightRailLabel: "Details",
      showRightRailToggle: true,
    });

    const header = container.querySelector("header");
    const title = screen.getByText(/A very long chat title/);
    expect(header).toHaveClass(
      "grid-cols-[calc(var(--app-sidebar-outer-width)+24px)_minmax(0,1fr)_auto]",
    );
    expect(title).toHaveClass("truncate");
    expect(title).not.toHaveClass("absolute");
  });

  it("keeps right-side toolbar controls available", () => {
    renderTopBar({
      rightRailLabel: "Details",
      onSearchClick: vi.fn(),
      showRightRailToggle: true,
    });

    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /feedback/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /details/i })).toHaveAttribute(
      "data-right-rail-toggle",
      "true",
    );
  });
});
