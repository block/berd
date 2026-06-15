import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionCard } from "../SessionCard";

describe("SessionCard", () => {
  const defaultProps = {
    id: "s1",
    title: "Fix sidebar bug",
    updatedAt: new Date().toISOString(),
    onSelect: vi.fn(),
  };

  it("renders title", () => {
    render(<SessionCard {...defaultProps} />);

    expect(screen.getByText("Fix sidebar bug")).toBeInTheDocument();
  });

  it("renders persona name when provided", () => {
    render(<SessionCard {...defaultProps} personaName="Code Assistant" />);

    expect(screen.getByText("Code Assistant")).toBeInTheDocument();
  });

  it("renders project name with color dot when provided", () => {
    render(
      <SessionCard
        {...defaultProps}
        projectName="My Project"
        projectColor="#3b82f6"
      />,
    );

    expect(screen.getByText("My Project")).toBeInTheDocument();
  });

  it("renders snippets at three lines by default", () => {
    render(<SessionCard {...defaultProps} snippet="Needle in message" />);

    expect(screen.getByText("Needle in message")).toHaveClass("line-clamp-3");
  });

  it("can render snippets as a one-line preview", () => {
    render(
      <SessionCard
        {...defaultProps}
        snippet="Latest session text"
        snippetLineClamp={1}
      />,
    );

    expect(screen.getByText("Latest session text")).toHaveClass("line-clamp-1");
  });

  it("calls onSelect when clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<SessionCard {...defaultProps} onSelect={onSelect} />);

    await user.click(screen.getByLabelText("Open Fix sidebar bug"));

    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("lets the click overlay receive pointer events through visible content", () => {
    const expectPointerPassthroughLayer = (text: string) => {
      expect(screen.getByText(text).closest(".pointer-events-none")).not.toBe(
        null,
      );
    };

    render(
      <SessionCard
        {...defaultProps}
        projectName="My Project"
        personaName="Code Assistant"
        snippet="Matched message excerpt"
        matchCount={3}
      />,
    );

    expect(screen.getByText("Fix sidebar bug")).toHaveClass(
      "pointer-events-none",
    );
    expectPointerPassthroughLayer("My Project");
    expectPointerPassthroughLayer("Matched message excerpt");
    expectPointerPassthroughLayer("3 message matches");
    expect(
      screen.getByRole("button", { name: /options for fix sidebar bug/i }),
    ).not.toHaveClass("pointer-events-none");
  });

  it("toggles selection with command-click instead of opening", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();

    render(
      <SessionCard
        {...defaultProps}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
      />,
    );

    await user.keyboard("[MetaLeft>]");
    await user.click(screen.getByLabelText("Open Fix sidebar bug"));
    await user.keyboard("[/MetaLeft]");

    expect(onSelectionChange).toHaveBeenCalledWith("s1", true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clears selection and opens on plain click while selection is active", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onSelectionClear = vi.fn();
    const onSelectionChange = vi.fn();

    render(
      <SessionCard
        {...defaultProps}
        selected
        selectionEnabled
        onSelect={onSelect}
        onSelectionClear={onSelectionClear}
        onSelectionChange={onSelectionChange}
      />,
    );

    await user.click(screen.getByLabelText("Open Fix sidebar bug"));

    expect(onSelectionClear).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("s1");
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("shows rename and archive in menu for active sessions", async () => {
    const user = userEvent.setup();

    render(
      <SessionCard {...defaultProps} onRename={vi.fn()} onArchive={vi.fn()} />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for fix sidebar bug/i }),
    );

    expect(
      screen.getByRole("menuitem", { name: /rename/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /archive/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /^select$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /^duplicate$/i }),
    ).not.toBeInTheDocument();
  });

  it("opens a session window from the active session menu", async () => {
    const user = userEvent.setup();
    const onOpenInWindow = vi.fn();

    render(<SessionCard {...defaultProps} onOpenInWindow={onOpenInWindow} />);

    await user.click(
      screen.getByRole("button", { name: /options for fix sidebar bug/i }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: /open in new window/i }),
    );

    expect(onOpenInWindow).toHaveBeenCalledWith("s1");
  });

  it("uses focus copy when the session is already open in a window", async () => {
    const user = userEvent.setup();

    render(
      <SessionCard {...defaultProps} isOpenInWindow onOpenInWindow={vi.fn()} />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for fix sidebar bug/i }),
    );

    expect(
      screen.getByRole("menuitem", { name: /^open window$/i }),
    ).toBeInTheDocument();
  });

  it("shows restore option for archived sessions", async () => {
    const user = userEvent.setup();

    render(
      <SessionCard
        {...defaultProps}
        archivedAt="2026-04-01T00:00:00Z"
        onUnarchive={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for fix sidebar bug/i }),
    );

    expect(
      screen.getByRole("menuitem", { name: /restore/i }),
    ).toBeInTheDocument();
  });
});
