import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DropdownMenu } from "@/shared/ui/dropdown-menu";
import { SessionActionsMenuContent } from "../SessionActionsMenuItems";

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
