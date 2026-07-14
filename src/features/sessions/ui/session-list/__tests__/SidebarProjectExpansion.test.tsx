import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { SidebarChatDragProvider } from "../SidebarChatDragContext";
import { SidebarProjectSection } from "../SidebarProjectSection";

const PROJECT: ProjectInfo = {
  id: "alpha",
  path: "/tmp/alpha",
  name: "Alpha",
  description: "",
  prompt: "",
  icon: "",
  color: "",
  projectWorkspaces: [],
  workingDirs: [],
  useWorktrees: false,
  order: 0,
  archivedAt: null,
};

const CHATS = Array.from({ length: 7 }, (_, index) => ({
  id: `chat-${index + 1}`,
  title: `Chat ${index + 1}`,
  updatedAt: "2026-01-01T00:00:00Z",
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("project chat expansion", () => {
  it("places the new chat action to the right of the project menu", () => {
    render(
      <SidebarChatDragProvider>
        <SidebarProjectSection
          project={PROJECT}
          projectChats={CHATS}
          isExpanded
          toggleProject={vi.fn()}
          onNewChatInProject={vi.fn()}
          showChatIcons
          showTimestamps
        />
      </SidebarChatDragProvider>,
    );

    const projectMenu = screen.getByRole("button", {
      name: "Options for Alpha",
    });
    const newChat = screen.getByRole("button", {
      name: "New chat in project",
    });

    expect(
      projectMenu.compareDocumentPosition(newChat) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps View more visible until extra chats begin revealing", () => {
    vi.useFakeTimers();
    render(
      <SidebarChatDragProvider>
        <SidebarProjectSection
          project={PROJECT}
          projectChats={CHATS}
          isExpanded
          toggleProject={vi.fn()}
          showChatIcons
          showTimestamps
        />
      </SidebarChatDragProvider>,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });
    const viewMore = screen.getByRole("button", { name: "View more" });
    fireEvent.click(viewMore);

    expect(screen.getByRole("button", { name: "View more" })).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(24);
    });

    expect(
      screen.queryByRole("button", { name: "View more" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Chat 6")).toBeVisible();
  });
});
