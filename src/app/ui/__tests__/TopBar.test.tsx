import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/updates/ui/BetaBadge", () => ({
  BetaBadge: () => null,
}));

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
  it("renders the Berd home logo and navigates home", async () => {
    const onHomeClick = vi.fn();
    renderTopBar({ onHomeClick });

    const home = screen.getByRole("button", { name: /Berd home/i });
    home.click();
    expect(onHomeClick).toHaveBeenCalledOnce();
  });

  it("does not render breadcrumbs", () => {
    renderTopBar({
      breadcrumbs: [{ label: "Chat" }, { label: "Model and system info" }],
    });

    expect(screen.queryByText("Chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Model and system info")).not.toBeInTheDocument();
  });

  it("renders the skills title in the chat-title position", () => {
    renderTopBar({ breadcrumbs: [{ id: "skills", label: "Skills" }] });

    expect(screen.getByText("Skills")).toHaveClass("w-full", "truncate");
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

  it("shows the agents page title in the chat-title position", () => {
    renderTopBar({ breadcrumbs: [{ id: "agents", label: "Agents" }] });

    expect(screen.getByText("Agents")).toHaveClass(
      "text-[length:var(--text-app-top-bar-title)]",
      "font-normal",
    );
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
    expect(header).toHaveClass("grid-cols-[max-content_minmax(0,1fr)_auto]");
    expect(title).toHaveClass("w-full", "min-w-0", "truncate");
    expect(title).not.toHaveAttribute("title");
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
