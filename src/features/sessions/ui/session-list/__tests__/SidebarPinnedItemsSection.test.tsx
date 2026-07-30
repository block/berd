import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { SidebarChatDragProvider } from "../SidebarChatDragContext";
import { SidebarPinnedItemsSection } from "../SidebarPinnedItemsSection";

const project: ProjectInfo = {
  id: "project-1",
  path: "/tmp/project-one",
  name: "Project One",
  description: "",
  prompt: "",
  icon: "",
  color: "",
  workingDirs: [],
  projectWorkspaces: [],
  useWorktrees: false,
  order: 0,
  archivedAt: null,
};

const pinnedChat = {
  id: "pinned-chat",
  title: "Pinned Chat",
  updatedAt: "2026-04-09T12:00:00.000Z",
  activityAt: "2026-04-09T12:00:00.000Z",
};

function renderSection(overrides: Record<string, unknown> = {}) {
  return render(
    <SidebarChatDragProvider>
      <SidebarPinnedItemsSection
        items={[{ kind: "chat", session: pinnedChat }]}
        isOpen
        onToggleOpen={vi.fn()}
        collapsed={false}
        labelTransition=""
        labelVisible
        projectsById={new Map([[project.id, project]])}
        showChatIcons
        onShowChatIconsChange={vi.fn()}
        showTimestamps
        onShowTimestampsChange={vi.fn()}
        {...overrides}
      />
    </SidebarChatDragProvider>,
  );
}

afterEach(() => vi.useRealTimers());

function dispatchPointerEvent(
  target: Element | Window,
  type: string,
  { clientY, pointerId = 1 }: { clientY: number; pointerId?: number },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientY,
  });
  Object.defineProperty(event, "pointerId", {
    configurable: true,
    value: pointerId,
  });
  fireEvent(target, event);
}

describe("SidebarPinnedItemsSection", () => {
  it("offers pinned icon and timestamp display options", async () => {
    const user = userEvent.setup();
    const onShowChatIconsChange = vi.fn();
    renderSection({ onShowChatIconsChange });

    await user.click(
      screen.getByRole("button", { name: "Pinned display options" }),
    );

    const iconToggle = screen.getByRole("menuitemcheckbox", {
      name: "Show chat icons",
    });
    expect(iconToggle).toBeChecked();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Show timestamp" }),
    ).toBeInTheDocument();

    await user.click(iconToggle);
    expect(onShowChatIconsChange).toHaveBeenCalledWith(false);
  });

  it("keeps the chat icon at rest and exposes one-click pinning on hover", () => {
    renderSection();

    const leadingSlot = screen.getByTestId("sidebar-pinned-chat-icon");
    const icon = within(leadingSlot).getByTestId("sidebar-chat-menu-icon");
    const pinButton = within(leadingSlot).getByRole("button", {
      name: /pin chat/i,
    });

    expect(icon.parentElement).not.toHaveClass("opacity-0");
    expect(pinButton).toHaveAttribute("tabindex", "-1");
  });

  it("shows the activity timestamp for a pinned chat", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T15:00:00.000Z"));
    renderSection();

    expect(screen.getByText("3h")).toBeInTheDocument();
  });

  it("uses project identity for a pinned chat in a project", () => {
    renderSection({
      items: [
        {
          kind: "chat",
          session: { ...pinnedChat, projectId: project.id },
        },
      ],
    });

    const row = screen
      .getByText("Pinned Chat")
      .closest("[data-sidebar-chat-row]");
    expect(row).not.toBeNull();
    expect(
      row?.querySelector('[data-testid="sidebar-pinned-chat-icon"]'),
    ).toBeInTheDocument();
    expect(
      row?.querySelector(`[data-project-color-swatch="${project.id}"]`),
    ).toBeInTheDocument();
  });

  it("hides a pinned project chat icon when chat icons are toggled off", () => {
    renderSection({
      items: [
        {
          kind: "chat",
          session: { ...pinnedChat, projectId: project.id },
        },
      ],
      showChatIcons: false,
    });

    expect(
      screen.queryByTestId("sidebar-pinned-chat-icon"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /unpin chat/i }),
    ).not.toBeInTheDocument();
    const row = screen
      .getByText("Pinned Chat")
      .closest("[data-sidebar-chat-row]");
    expect(
      row?.querySelector(`[data-project-color-swatch="${project.id}"]`),
    ).not.toBeInTheDocument();
    expect(row?.querySelector("button")?.className).toContain("pl-3");
    expect(row?.querySelector("button")?.className).not.toContain("pl-9");
  });

  it("keeps running pinned rows aligned when icons are hidden", () => {
    renderSection({
      items: [
        {
          kind: "chat",
          session: { ...pinnedChat, isRunning: true },
        },
      ],
      showChatIcons: false,
    });

    const row = screen
      .getByText("Pinned Chat")
      .closest("[data-sidebar-chat-row]");
    expect(row?.querySelector("button")?.className).toContain("pl-3");
    expect(row?.querySelector("button")?.className).not.toContain("pl-9");
  });

  it("requests collapsing the pinned section", async () => {
    const user = userEvent.setup();
    const onToggleOpen = vi.fn();
    renderSection({ onToggleOpen });

    await user.click(screen.getByRole("button", { name: "Pinned" }));

    expect(onToggleOpen).toHaveBeenCalledOnce();
  });

  it("preserves chat actions for pinned chats", () => {
    const onArchiveChat = vi.fn();
    const onForkChat = vi.fn();
    const onMarkChatUnread = vi.fn();
    renderSection({ onArchiveChat, onForkChat, onMarkChatUnread });

    const row = screen
      .getByText("Pinned Chat")
      .closest("[data-sidebar-chat-row]");
    if (!row) throw new Error("pinned chat row missing");
    fireEvent.contextMenu(row, { clientX: 100, clientY: 100 });

    expect(
      within(document.body).getByRole("menuitem", { name: /duplicate/i }),
    ).toBeInTheDocument();
    expect(
      within(document.body).getByRole("menuitem", { name: /archive/i }),
    ).toBeInTheDocument();
    expect(
      within(document.body).getByRole("menuitem", { name: /mark unread/i }),
    ).toBeInTheDocument();
  });

  it("shows the insertion line while reordering pinned chats", () => {
    const onReorder = vi.fn();
    renderSection({
      items: [
        { kind: "chat", session: pinnedChat },
        {
          kind: "chat",
          session: {
            ...pinnedChat,
            id: "second-chat",
            title: "Second Chat",
          },
        },
      ],
      onReorder,
    });

    const firstRow = document.querySelector<HTMLElement>(
      '[data-pinned-reorder-row="chat:pinned-chat"]',
    );
    const secondRow = document.querySelector<HTMLElement>(
      '[data-pinned-reorder-row="chat:second-chat"]',
    );
    if (!firstRow || !secondRow) throw new Error("pinned rows missing");
    vi.spyOn(firstRow, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 28,
      left: 0,
      right: 200,
      width: 200,
      height: 28,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(secondRow, "getBoundingClientRect").mockReturnValue({
      top: 28,
      bottom: 56,
      left: 0,
      right: 200,
      width: 200,
      height: 28,
      x: 0,
      y: 28,
      toJSON: () => ({}),
    });

    dispatchPointerEvent(firstRow, "pointerdown", {
      pointerId: 1,
      clientY: 10,
    });
    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientY: 32,
    });

    const indicator = screen.getByTestId("pinned-reorder-indicator");
    expect(indicator).toHaveClass("top-0", "bg-border");
    expect(indicator).not.toHaveClass("bottom-0");

    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientY: 52,
    });
    expect(indicator).toHaveClass("bottom-0");

    dispatchPointerEvent(window, "pointerup", {
      pointerId: 1,
      clientY: 52,
    });
    expect(onReorder).toHaveBeenCalledWith(
      "chat:pinned-chat",
      "chat:second-chat",
      "after",
    );
    expect(
      screen.queryByTestId("pinned-reorder-indicator"),
    ).not.toBeInTheDocument();
  });

  it("shows every pinned chat", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      kind: "chat" as const,
      session: {
        ...pinnedChat,
        id: `chat-${index}`,
        title: `Chat ${index + 1}`,
      },
    }));
    renderSection({ items });

    expect(screen.getByText("Chat 1")).toBeInTheDocument();
    expect(screen.getByText("Chat 6")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View more" }),
    ).not.toBeInTheDocument();
  });
});
