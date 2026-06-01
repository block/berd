import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "@/features/home/stores/homeWidgetStore";
import { SidebarChatRow } from "../SidebarChatRow";

describe("SidebarChatRow", () => {
  beforeEach(() => {
    resetHomeWidgetStoreForTests();
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

  it("shows the goose loader when the chat is active", () => {
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
      container.querySelector('img[src*="startup-loading"]'),
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
      container.querySelector('img[src*="startup-loading"]'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/chat active/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/unread messages/i)).not.toBeInTheDocument();
  });

  it("does not advertise drag with the cursor", () => {
    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    const row = container.querySelector("[draggable]");
    expect(row).not.toHaveClass("cursor-default");
    expect(row).not.toHaveClass("active:cursor-grabbing");
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

  it("shows the trailing unread dot only when the chat has unread output", () => {
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

    expect(screen.getByLabelText(/unread messages/i)).toHaveClass("bg-success");
    expect(screen.getByLabelText(/unread messages/i)).toHaveClass("right-3.5");
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

  it("shows pin-to-home in the chat options menu", async () => {
    const user = userEvent.setup();

    render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );

    expect(
      screen.getByRole("menuitem", { name: /pin to home/i }),
    ).toBeInTheDocument();
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

  it("shows the unpin-from-home option for an already pinned chat", async () => {
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
      screen.getByRole("menuitem", { name: /unpin from home/i }),
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
});
