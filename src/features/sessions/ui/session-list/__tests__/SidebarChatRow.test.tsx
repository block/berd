import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "@/features/home/stores/homeWidgetStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { formatSidebarChatTimestamp, SidebarChatRow } from "../SidebarChatRow";
import {
  focusSessionWindow,
  getSessionWindowSupport,
} from "@/features/chat/lib/sessionWindowCommands";

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  focusSessionWindow: vi.fn().mockResolvedValue(undefined),
  getSessionWindowSupport: vi
    .fn()
    .mockResolvedValue({ supported: true, reason: undefined }),
  openSessionWindow: vi.fn().mockResolvedValue(undefined),
  releaseSession: vi.fn().mockResolvedValue(undefined),
}));

describe("SidebarChatRow", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    resetHomeWidgetStoreForTests();
    useSessionWindowStore.getState().setSnapshot([]);
    vi.mocked(getSessionWindowSupport).mockResolvedValue({
      supported: true,
      reason: undefined,
    });
  });

  it("starts inline rename on double-click and commits on Enter", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Original Title"
        isActive={false}
        onRename={onRename}
      />,
    );

    await user.dblClick(screen.getByTitle("Double-click to rename"));

    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Renamed Chat{Enter}");

    expect(onRename).toHaveBeenCalledWith("session-1", "Renamed Chat");
  });

  it("opens rename from menu and cancels on Escape", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Original Title"
        isActive={false}
        onRename={onRename}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for original title/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /rename/i }));

    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Should Not Save{Escape}");

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("trims input and does not rename when empty or unchanged", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Same Title"
        isActive={false}
        onRename={onRename}
      />,
    );

    await user.dblClick(screen.getByTitle("Double-click to rename"));
    const input = screen.getByRole("textbox");

    await user.clear(input);
    await user.type(input, "   {Enter}");

    expect(onRename).not.toHaveBeenCalled();

    await user.dblClick(screen.getByTitle("Double-click to rename"));
    const input2 = screen.getByRole("textbox");
    await user.clear(input2);
    await user.type(input2, "  Same Title  {Enter}");

    expect(onRename).not.toHaveBeenCalled();
  });

  it("shows the Berd loader when the chat is active", () => {
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Busy Chat"
        isActive={false}
        isRunning
      />,
    );

    expect(screen.getByLabelText(/chat active/i)).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="berd-loader"]'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-chat-menu-icon"),
    ).not.toBeInTheDocument();
  });

  it("shows an unread dot when the chat has unread output", () => {
    render(
      <SidebarChatRow
        id="session-1"
        title="Unread Chat"
        isActive={false}
        hasUnread
      />,
    );

    expect(screen.getByLabelText(/unread messages/i)).toBeInTheDocument();
  });

  it("shows a chat menu icon for idle chats without an activity indicator", () => {
    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    expect(screen.getByTestId("sidebar-chat-menu-icon")).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="berd-loader"]'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/chat active/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/unread messages/i)).not.toBeInTheDocument();
  });

  it("does not show the idle chat icon in flat project rows", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        flatProjectName="Project One"
      />,
    );

    expect(screen.queryByTestId("sidebar-chat-menu-icon")).toBeNull();
    expect(screen.queryByText("Project One")).not.toBeInTheDocument();
    expect(screen.getByText("Idle Chat")).toBeInTheDocument();
    const projectIcon = container.querySelector(
      "[data-sidebar-flat-project-icon]",
    );
    expect(projectIcon?.tagName).toBe("SPAN");

    if (!projectIcon) {
      throw new Error("Flat project icon was not rendered");
    }
    await user.hover(projectIcon);
    expect(await screen.findAllByText("Project One")).not.toHaveLength(0);
  });

  it("uses dense flat-row spacing when requested", () => {
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        density="dense"
        flatProjectName="Project One"
      />,
    );

    expect(container.querySelector("[data-sidebar-chat-row]")).toHaveAttribute(
      "data-sidebar-chat-density",
      "dense",
    );
    expect(container.querySelector("[data-sidebar-chat-row]")).toHaveClass(
      "gap-1.5",
    );
    expect(screen.getByTitle("Double-click to rename")).toHaveClass("pr-6");
    expect(screen.getByLabelText("Project One")).toHaveClass("ml-1", "size-5");
    expect(
      screen.getByRole("button", { name: "Options for Idle Chat" }),
    ).toHaveClass("right-1");
  });

  it("lets flat-row status take space only when visible", () => {
    render(
      <SidebarChatRow
        id="session-1"
        title="Unread Chat"
        isActive={false}
        density="dense"
        flatProjectName="Project One"
        hasUnread
      />,
    );

    expect(screen.getByTitle("Double-click to rename")).toHaveClass("gap-1.5");
    expect(screen.getByLabelText(/unread messages/i)).toBeInTheDocument();
  });

  it("opens the flat row project editor without selecting the chat", async () => {
    const user = userEvent.setup();
    const onEditProject = vi.fn();
    const onSelect = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Project Chat"
        isActive={false}
        density="dense"
        flatProjectName="Project One"
        flatProjectColor="sage"
        currentProjectId="project-1"
        onEditProject={onEditProject}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Project One" }));

    await waitFor(() =>
      expect(onEditProject).toHaveBeenCalledWith("project-1"),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-project-color-swatch="project-1"]'),
    ).toBeInTheDocument();
  });

  it("does not use native HTML draggable affordances", () => {
    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    expect(container.querySelector("[draggable]")).not.toBeInTheDocument();
    expect(
      container.querySelector("[data-sidebar-chat-draggable]"),
    ).toBeInTheDocument();
    expect(screen.getByTitle("Double-click to rename")).toHaveClass(
      "cursor-pointer",
    );
  });

  it("toggles selection with command-click instead of selecting the row", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Selectable Chat"
        isActive={false}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
      />,
    );

    await user.keyboard("[MetaLeft>]");
    await user.click(screen.getByTitle("Double-click to rename"));
    await user.keyboard("[/MetaLeft]");

    expect(onSelectionChange).toHaveBeenCalledWith("session-1", true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clears selection and selects the row on plain click while selection is active", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onSelectionClear = vi.fn();
    const onSelectionChange = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Selectable Chat"
        isActive={false}
        selected
        selectionEnabled
        onSelect={onSelect}
        onSelectionClear={onSelectionClear}
        onSelectionChange={onSelectionChange}
      />,
    );

    await user.click(screen.getByTitle("Double-click to rename"));

    expect(onSelectionClear).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("session-1");
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("selects normally when a session window exists but session windows are unsupported", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    vi.mocked(getSessionWindowSupport).mockResolvedValue({
      supported: false,
      reason: "unsupported platform",
    });

    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session:a" }]);

    render(
      <SidebarChatRow
        id="session-1"
        title="Windowed Chat"
        isActive={false}
        onSelect={onSelect}
      />,
    );

    await waitFor(() => expect(getSessionWindowSupport).toHaveBeenCalled());
    expect(screen.queryByLabelText(/open in window/i)).not.toBeInTheDocument();

    await user.click(screen.getByTitle("Double-click to rename"));

    expect(focusSessionWindow).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("session-1");
  });

  it("focuses an existing session window instead of selecting the row when session windows are supported", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session:a" }]);

    render(
      <SidebarChatRow
        id="session-1"
        title="Windowed Chat"
        isActive={false}
        onSelect={onSelect}
      />,
    );

    expect(await screen.findByLabelText(/open in window/i)).toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", { name: /windowed chat/i })[0],
    );

    expect(focusSessionWindow).toHaveBeenCalledWith("session-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows the unread dot in the icon slot only when the chat has unread output", () => {
    const { rerender } = render(
      <SidebarChatRow id="session-1" title="Recent Chat" isActive={false} />,
    );

    expect(screen.queryByLabelText(/unread messages/i)).not.toBeInTheDocument();

    rerender(
      <SidebarChatRow
        id="session-1"
        title="Recent Chat"
        isActive={false}
        hasUnread
      />,
    );

    const slot = screen.getByLabelText(/unread messages/i);
    const dot = slot.querySelector("span");
    expect(dot).toHaveClass("bg-success");
  });

  it("hides the unread dot while the chat is running", () => {
    render(
      <SidebarChatRow
        id="session-1"
        title="Running Chat"
        isActive={false}
        isRunning
        hasUnread
      />,
    );

    expect(screen.queryByLabelText(/unread messages/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/chat active/i)).toBeInTheDocument();
  });

  it("can mark an idle chat unread from the menu", async () => {
    const user = userEvent.setup();
    const onMarkUnread = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        onMarkUnread={onMarkUnread}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /mark unread/i }));

    expect(onMarkUnread).toHaveBeenCalledWith("session-1");
  });

  it("can duplicate an idle chat from the menu", async () => {
    const user = userEvent.setup();
    const onFork = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        onFork={onFork}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /duplicate/i }));

    expect(onFork).toHaveBeenCalledWith("session-1");
  });

  it("shows pin chat in the chat options menu", async () => {
    const user = userEvent.setup();

    render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );

    expect(
      screen.getByRole("menuitem", { name: /pin chat/i }),
    ).toBeInTheDocument();
  });

  it("opens the chat options as a cursor-anchored context menu on right-click", async () => {
    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    const row = container.querySelector("[data-sidebar-chat-row]");
    if (!row) {
      throw new Error("Sidebar chat row was not rendered");
    }

    fireEvent.contextMenu(row, { clientX: 128, clientY: 256 });

    expect(
      await screen.findByRole("menuitem", { name: /rename/i }),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="context-menu-content"]'),
    ).toHaveAttribute("data-variant", "inverse");
    expect(
      document.querySelector('[data-slot="dropdown-menu-content"]'),
    ).not.toBeInTheDocument();
  });

  it("does not show selection actions in the chat options menu", async () => {
    const user = userEvent.setup();

    render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        onSelectionChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );

    expect(
      screen.queryByRole("menuitem", { name: /select idle chat/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the unpin-chat option for an already pinned chat", async () => {
    const user = userEvent.setup();
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "session-1" },
        },
      ],
    });

    render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );

    expect(
      screen.getByRole("menuitem", { name: /unpin chat/i }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("can mark an unread chat read from the menu", async () => {
    const user = userEvent.setup();
    const onMarkRead = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Unread Chat"
        isActive={false}
        hasUnread
        onMarkRead={onMarkRead}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for unread chat/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /mark read/i }));

    expect(onMarkRead).toHaveBeenCalledWith("session-1");
  });

  it("keeps the localized default title in rename mode without persisting it", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title={DEFAULT_CHAT_TITLE}
        isActive={false}
        onRename={onRename}
      />,
    );

    await user.dblClick(screen.getByTitle("Double-click to rename"));

    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("New chat");

    await user.tab();

    expect(onRename).not.toHaveBeenCalled();
  });

  it("formats sidebar chat activity as compact single-unit relative time", () => {
    const now = new Date("2026-07-07T12:00:00");

    expect(formatSidebarChatTimestamp("2026-07-07T11:59:40", { now })).toBe(
      "now",
    );
    expect(formatSidebarChatTimestamp("2026-07-07T11:55:00", { now })).toBe(
      "5m",
    );
    expect(formatSidebarChatTimestamp("2026-07-07T09:00:00", { now })).toBe(
      "3h",
    );
    expect(formatSidebarChatTimestamp("2026-07-05T12:00:00", { now })).toBe(
      "2d",
    );
    expect(formatSidebarChatTimestamp("2026-06-22T12:00:00", { now })).toBe(
      "2w",
    );
    expect(formatSidebarChatTimestamp("2026-05-01T12:00:00", { now })).toBe(
      "2mo",
    );
    expect(formatSidebarChatTimestamp("2024-07-07T12:00:00", { now })).toBe(
      "2y",
    );
  });

  it("returns empty for missing or invalid activity values", () => {
    expect(formatSidebarChatTimestamp(undefined)).toBe("");
    expect(formatSidebarChatTimestamp(null)).toBe("");
    expect(formatSidebarChatTimestamp("  ")).toBe("");
    expect(formatSidebarChatTimestamp("not a timestamp")).toBe("");
  });

  it("renders a muted subtitle line beneath the title when a snippet is present", () => {
    render(
      <SidebarChatRow
        id="session-1"
        title="Refactor session list"
        subtitle="Let's refactor the session list query"
        isActive={false}
      />,
    );

    const subtitle = screen.getByText("Let's refactor the session list query");
    expect(subtitle).toHaveClass("text-muted-foreground");
    expect(subtitle).toHaveClass("truncate");
  });

  it("renders a compact activity timestamp on the right edge of the row", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);

    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Refactor session list"
        subtitle="Let's refactor the session list query"
        activityAt={fiveMinutesAgo.toISOString()}
        isActive={false}
      />,
    );

    const timestamp = container.querySelector(
      "[data-sidebar-chat-timestamp]",
    ) as HTMLElement;
    expect(timestamp).toBeInTheDocument();
    expect(timestamp).toHaveTextContent("5m");
    expect(timestamp).toHaveClass("text-muted-foreground/70");
    // The row title and snippet stay visible alongside the timestamp.
    expect(screen.getByText("Refactor session list")).toBeInTheDocument();
    expect(
      screen.getByText("Let's refactor the session list query"),
    ).toBeInTheDocument();
  });

  it("omits the timestamp when the activity value is missing or invalid", () => {
    const { container, rerender } = render(
      <SidebarChatRow id="session-1" title="No activity" isActive={false} />,
    );
    expect(
      container.querySelector("[data-sidebar-chat-timestamp]"),
    ).not.toBeInTheDocument();

    rerender(
      <SidebarChatRow
        id="session-1"
        title="No activity"
        activityAt="not a timestamp"
        isActive={false}
      />,
    );
    expect(
      container.querySelector("[data-sidebar-chat-timestamp]"),
    ).not.toBeInTheDocument();
  });

  it("renders the timestamp on flat chat rows too", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);

    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Refactor session list"
        activityAt={twoHoursAgo.toISOString()}
        isActive={false}
        density="dense"
        flatProjectName="Project One"
      />,
    );

    const timestamp = container.querySelector(
      "[data-sidebar-chat-timestamp]",
    ) as HTMLElement;
    expect(timestamp).toBeInTheDocument();
    expect(timestamp).toHaveTextContent("2h");
    expect(screen.getByText("Refactor session list")).toBeInTheDocument();
  });
  it("stays a single line for sessions without a usable snippet", () => {
    const { container, rerender } = render(
      <SidebarChatRow id="session-1" title="No snippet" isActive={false} />,
    );

    expect(screen.getByText("No snippet")).toBeInTheDocument();
    // The two-line column wrapper only renders when a subtitle is shown.
    expect(container.querySelector(".flex-col")).toBeNull();

    // Whitespace-only snippets are treated as absent.
    rerender(
      <SidebarChatRow
        id="session-1"
        title="No snippet"
        subtitle="   "
        isActive={false}
      />,
    );
    expect(screen.getByText("No snippet")).toBeInTheDocument();
    expect(container.querySelector(".flex-col")).toBeNull();
  });
});
