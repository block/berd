import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";
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
  it("marks the remote chat disconnected when its host has no live tunnel", () => {
    const { container } = renderRemoteSection();

    expect(container.querySelector("[data-sidebar-project-remote]")).toBeNull();
    const glyph = container.querySelector("[data-sidebar-chat-remote-host]");
    expect(glyph).toHaveAttribute(
      "title",
      "Remote chat on blox — disconnected",
    );
    expect(glyph).toHaveAttribute("data-remote-host-connected", "false");
  });

  it("uses the connected label once the host tunnel is ready", () => {
    useRemoteHostStore.setState((state) => ({
      statusByHost: { ...state.statusByHost, blox: { state: "ready" } },
    }));
    try {
      const { container } = renderRemoteSection();

      const glyph = container.querySelector("[data-sidebar-chat-remote-host]");
      expect(glyph).toHaveAttribute("title", "Remote chat on blox");
      expect(glyph).toHaveAttribute("data-remote-host-connected", "true");
    } finally {
      useRemoteHostStore.setState((state) => {
        const statusByHost = { ...state.statusByHost };
        delete statusByHost.blox;
        return { statusByHost };
      });
    }
  });
});
