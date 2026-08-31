import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

function renderSection(isExpanded: boolean) {
  return render(
    <SidebarChatDragProvider>
      <SidebarProjectSection
        project={PROJECT}
        projectChats={[
          {
            id: "p1",
            title: "Project Chat",
            updatedAt: "2026-01-01T00:00:00Z",
            hasUnread: true,
          },
        ]}
        isExpanded={isExpanded}
        toggleProject={vi.fn()}
        showChatIcons
        showTimestamps
      />
    </SidebarChatDragProvider>,
  );
}

function renderRemoteSection() {
  return render(
    <SidebarChatDragProvider>
      <SidebarProjectSection
        project={PROJECT}
        projectChats={[
          {
            id: "remote-1",
            title: "Remote chat",
            updatedAt: "2026-01-01T00:00:00Z",
            remoteHost: "blox",
          },
        ]}
        isExpanded
        toggleProject={vi.fn()}
        showChatIcons
        showTimestamps
      />
    </SidebarChatDragProvider>,
  );
}

describe("project unread dot", () => {
  it("swaps the project icon for the unread dot when collapsed and a chat is unread", () => {
    const { container } = renderSection(false);
    // Collapsed: chat rows are not rendered, so the only unread label is the
    // project-row indicator that replaces the project icon.
    expect(
      container.querySelectorAll('[aria-label="Unread messages"]'),
    ).toHaveLength(1);
  });

  it("does not render the project-row unread dot when expanded", () => {
    const { container } = renderSection(true);
    // Expanded: chat rows render their own unread labels, but the project row
    // itself should not add one. With a single unread chat, expanded should
    // show exactly one unread label (the chat row), not two.
    expect(
      container.querySelectorAll('[aria-label="Unread messages"]'),
    ).toHaveLength(1);
  });
});

describe("remote project identity", () => {
  it("badges the project icon and uses a remote globe on its chat", () => {
    const { container } = renderRemoteSection();

    expect(
      container.querySelector("[data-sidebar-project-remote]"),
    ).toBeInTheDocument();
    expect(
      container.querySelector("[data-sidebar-chat-remote-host]"),
    ).toHaveAttribute("title", "Remote chat on blox");
  });
});
