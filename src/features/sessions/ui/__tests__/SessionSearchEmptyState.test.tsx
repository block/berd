import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionSearchEmptyState } from "../SessionSearchEmptyState";

describe("SessionSearchEmptyState", () => {
  it("names the query and every searched field", () => {
    render(<SessionSearchEmptyState query="needle" />);

    expect(screen.getByText('No sessions match "needle"')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Search covers titles, agents, projects, dates, and conversation text.",
      ),
    ).toBeInTheDocument();
  });

  it("hints at archived matches when asked", () => {
    render(<SessionSearchEmptyState query="needle" hasArchivedMatchesHint />);

    expect(
      screen.getByText(
        "Search covers titles, agents, projects, dates, and conversation text. Archived sessions may have matches.",
      ),
    ).toBeInTheDocument();
  });

  // A one-character query is matched against metadata only, so blaming the
  // archive for the miss would send the user looking in the wrong place.
  it("does not claim conversation text for a query too short to sweep", () => {
    render(<SessionSearchEmptyState query="a" />);

    expect(
      screen.getByText(
        "Search covers titles, agents, projects, and dates. Type at least 2 characters to also search conversation text.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the archived hint honest for a too-short query", () => {
    render(<SessionSearchEmptyState query="a" hasArchivedMatchesHint />);

    expect(
      screen.getByText(
        "Search covers titles, agents, projects, and dates. Type at least 2 characters to also search conversation text. Archived sessions may have matches.",
      ),
    ).toBeInTheDocument();
  });

  it("renders no action buttons when no callbacks are provided", () => {
    render(<SessionSearchEmptyState query="needle" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("fires onClearFilters from the clear filters button", async () => {
    const user = userEvent.setup();
    const onClearFilters = vi.fn();
    render(
      <SessionSearchEmptyState
        query="needle"
        onClearFilters={onClearFilters}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Search archived" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("fires onShowArchived from the search archived button", async () => {
    const user = userEvent.setup();
    const onShowArchived = vi.fn();
    render(
      <SessionSearchEmptyState
        query="needle"
        onShowArchived={onShowArchived}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Clear filters" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search archived" }));

    expect(onShowArchived).toHaveBeenCalledTimes(1);
  });

  it("renders both actions when both callbacks are provided", () => {
    render(
      <SessionSearchEmptyState
        query="needle"
        onClearFilters={vi.fn()}
        onShowArchived={vi.fn()}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toHaveAttribute("type", "button");
    }
  });
});
