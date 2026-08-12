import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContextMenu, ContextMenuTrigger } from "@/shared/ui/context-menu";
import { DropdownMenu } from "@/shared/ui/dropdown-menu";
import {
  SessionActionsContextMenuContent,
  SessionActionsMenuContent,
} from "../SessionActionsMenuItems";

function renderMenu(
  props: Omit<Parameters<typeof SessionActionsMenuContent>[0], "sessionId">,
) {
  render(
    <DropdownMenu open>
      <SessionActionsMenuContent sessionId="session-1" {...props} />
    </DropdownMenu>,
  );
}

function menuItemLabels() {
  return screen
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.trim());
}

describe("SessionActionsMenuContent", () => {
  it("renders active-session actions in the canonical grouped order", () => {
    renderMenu({
      onClose: vi.fn(),
      onMarkUnread: vi.fn(),
      onTogglePin: vi.fn(),
      onRename: vi.fn(),
      onOpenInWindow: vi.fn(),
      onDuplicate: vi.fn(),
      onExport: vi.fn(),
      onArchive: vi.fn(),
    });

    expect(menuItemLabels()).toEqual([
      "Mark unread",
      "Pin chat",
      "Rename",
      "Open in new window",
      "Duplicate",
      "Copy chat link",
      "Export…",
      "Archive",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("uses stateful labels without changing the action positions", () => {
    renderMenu({
      onClose: vi.fn(),
      hasUnread: true,
      isPinned: true,
      isOpenInWindow: true,
      onMarkRead: vi.fn(),
      onTogglePin: vi.fn(),
      onRename: vi.fn(),
      onOpenInWindow: vi.fn(),
      onArchive: vi.fn(),
    });

    expect(menuItemLabels()).toEqual([
      "Mark read",
      "Unpin chat",
      "Rename",
      "Open window",
      "Copy chat link",
      "Archive",
    ]);
  });

  it("keeps archived sessions to export and restore", () => {
    renderMenu({
      onClose: vi.fn(),
      archived: true,
      onExport: vi.fn(),
      onRestore: vi.fn(),
    });

    expect(menuItemLabels()).toEqual(["Export…", "Restore"]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });
});

describe("SessionActionsContextMenuContent", () => {
  it("forwards onCloseAutoFocus to the menu content", async () => {
    // The items component destructures a fixed prop set with no rest spread,
    // so a content-level prop only reaches Radix if the wrapper names it.
    // Callers rely on this to stop close-focus restoration stealing focus from
    // an input the menu action just opened (SessionCard's rename).
    const onCloseAutoFocus = vi.fn();

    render(
      <ContextMenu>
        <ContextMenuTrigger>Card</ContextMenuTrigger>
        <SessionActionsContextMenuContent
          sessionId="session-1"
          onCloseAutoFocus={onCloseAutoFocus}
          onRename={vi.fn()}
          onArchive={vi.fn()}
        />
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText("Card"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /rename/i }));

    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalled());
  });
});
