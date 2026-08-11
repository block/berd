import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCard } from "../SessionCard";

// Records, per context-menu close, whether the card cancelled Radix's focus
// restoration. Reading `defaultPrevented` off the real event Radix dispatches
// is the only way to see the decision: the handler has no other output, and
// jsdom cannot show us where focus actually landed (see the Escape test).
const closeAutoFocusPrevented: boolean[] = [];

vi.mock("../SessionActionsMenuItems", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../SessionActionsMenuItems")>();
  return {
    ...actual,
    SessionActionsContextMenuContent: (
      props: React.ComponentProps<
        typeof actual.SessionActionsContextMenuContent
      >,
    ) => (
      <actual.SessionActionsContextMenuContent
        {...props}
        onCloseAutoFocus={(event) => {
          props.onCloseAutoFocus?.(event);
          closeAutoFocusPrevented.push(event.defaultPrevented);
        }}
      />
    ),
  };
});

beforeEach(() => {
  closeAutoFocusPrevented.length = 0;
});

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
    // Assert the text sits inside the one content layer that opts out of
    // pointer events, not merely inside *some* ancestor carrying the class —
    // `closest(".pointer-events-none")` alone would pass if any wrapper had it.
    const expectPointerPassthroughLayer = (text: string) => {
      const contentLayer = screen
        .getByText(text)
        .closest("[data-card-content]");
      expect(contentLayer).not.toBeNull();
      expect(contentLayer).toHaveClass("pointer-events-none");
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

    expectPointerPassthroughLayer("Fix sidebar bug");
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

  // Regression guard, not a reproduction: `editing` unmounts the whole trigger
  // subtree, so in jsdom no trigger survives to reclaim focus and this passes
  // with or without the `onCloseAutoFocus` guard on the context menu. The two
  // tests below cover the guard's discriminating logic instead; real-browser
  // focus restoration is verified manually.
  it("focuses the rename input when renaming from the context menu", async () => {
    const user = userEvent.setup();

    render(<SessionCard {...defaultProps} onRename={vi.fn()} />);

    fireEvent.contextMenu(screen.getByText("Fix sidebar bug"));
    await user.click(await screen.findByRole("menuitem", { name: /rename/i }));

    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("cancels context-menu focus restoration only on the rename path", async () => {
    const user = userEvent.setup();

    render(<SessionCard {...defaultProps} onRename={vi.fn()} />);

    fireEvent.contextMenu(screen.getByText("Fix sidebar bug"));
    await user.click(await screen.findByRole("menuitem", { name: /rename/i }));
    await screen.findByRole("textbox");

    await waitFor(() => expect(closeAutoFocusPrevented).toEqual([true]));
  });

  it("lets focus return to the card control when the context menu is dismissed", async () => {
    const user = userEvent.setup();

    // jsdom cannot prove *where* focus lands — Radix restores it via the
    // close-autofocus event this test lets through — so assert the card did not
    // suppress the restoration, which is what strands keyboard users mid-list.
    render(<SessionCard {...defaultProps} onRename={vi.fn()} />);

    fireEvent.contextMenu(screen.getByText("Fix sidebar bug"));
    await screen.findByRole("menuitem", { name: /rename/i });
    await user.keyboard("{Escape}");

    await waitFor(() => expect(closeAutoFocusPrevented).toEqual([false]));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps focus restoration for non-rename context-menu actions", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();

    render(
      <SessionCard
        {...defaultProps}
        onRename={vi.fn()}
        onArchive={onArchive}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Fix sidebar bug"));
    await user.click(await screen.findByRole("menuitem", { name: /archive/i }));

    expect(onArchive).toHaveBeenCalledWith("s1");
    await waitFor(() => expect(closeAutoFocusPrevented).toEqual([false]));
  });

  it("leaves only positioning on the shared actions button", () => {
    render(<SessionCard {...defaultProps} />);

    const trigger = screen.getByRole("button", {
      name: /options for fix sidebar bug/i,
    });

    // Geometry and state styling belong to SessionCardActionButton; the card
    // only says where the control sits.
    expect(trigger).toHaveClass("absolute", "right-6", "top-6", "z-10");
    expect(trigger).toHaveClass("h-7", "w-7", "invisible");
    expect(trigger.className).not.toMatch(/\bsize-5\b/);
  });

  it("positions the actions button in the corner for the grid layout", () => {
    render(<SessionCard {...defaultProps} layout="grid" />);

    expect(
      screen.getByRole("button", { name: /options for fix sidebar bug/i }),
    ).toHaveClass("absolute", "right-4", "top-4");
  });

  // The menu labels itself with the selection count, so every action it offers
  // has to act on that selection. Restore used to always target the single row
  // whose menu was open, silently leaving the rest archived and still selected.
  it("restores the whole selection when the menu is acting on a selection", async () => {
    const user = userEvent.setup();
    const onUnarchive = vi.fn();
    const onUnarchiveSelected = vi.fn();

    render(
      <SessionCard
        {...defaultProps}
        archivedAt="2026-04-01T00:00:00Z"
        selected
        selectionCount={2}
        onUnarchive={onUnarchive}
        onUnarchiveSelected={onUnarchiveSelected}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for fix sidebar bug/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /restore/i }));

    expect(onUnarchiveSelected).toHaveBeenCalledTimes(1);
    expect(onUnarchive).not.toHaveBeenCalled();
  });

  it("restores only its own row when nothing else is selected", async () => {
    const user = userEvent.setup();
    const onUnarchive = vi.fn();
    const onUnarchiveSelected = vi.fn();

    render(
      <SessionCard
        {...defaultProps}
        archivedAt="2026-04-01T00:00:00Z"
        selected
        selectionCount={1}
        onUnarchive={onUnarchive}
        onUnarchiveSelected={onUnarchiveSelected}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for fix sidebar bug/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /restore/i }));

    expect(onUnarchive).toHaveBeenCalledWith("s1");
    expect(onUnarchiveSelected).not.toHaveBeenCalled();
  });

  it("exports all selected chats from a multi-selected card", async () => {
    const user = userEvent.setup();
    const onExportSelected = vi.fn();

    render(
      <SessionCard
        {...defaultProps}
        selected
        selectionEnabled
        selectionCount={2}
        onSelectionChange={vi.fn()}
        onExport={vi.fn()}
        onExportSelected={onExportSelected}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for fix sidebar bug/i }),
    );
    const exportItem = screen.getByRole("menuitem", { name: /export/i });
    expect(exportItem).not.toHaveAttribute("aria-disabled", "true");

    await user.click(exportItem);
    expect(onExportSelected).toHaveBeenCalledTimes(1);
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
