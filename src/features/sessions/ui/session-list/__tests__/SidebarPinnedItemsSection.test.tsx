import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

const projectChat = {
  id: "project-chat",
  title: "Project Chat",
  updatedAt: "2026-04-09T12:00:00.000Z",
  projectId: project.id,
};

function renderSection(overrides: Record<string, unknown> = {}) {
  return render(
    <SidebarChatDragProvider>
      <SidebarPinnedItemsSection
        items={[{ kind: "project", project }]}
        isOpen
        onToggleOpen={vi.fn()}
        collapsed={false}
        labelTransition=""
        labelVisible
        projectSessionsByProject={{ [project.id]: [projectChat] }}
        expandedProjects={{ [project.id]: true }}
        toggleProject={vi.fn()}
        showTimestamps={false}
        onShowTimestampsChange={vi.fn()}
        {...overrides}
      />
    </SidebarChatDragProvider>,
  );
}

afterEach(() => vi.useRealTimers());

describe("SidebarPinnedItemsSection", () => {
  it("offers pinned timestamp display options", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(
      screen.getByRole("button", { name: "Pinned display options" }),
    );

    expect(
      screen.getByRole("menuitemcheckbox", { name: "Show timestamp" }),
    ).toBeInTheDocument();
  });

  it("shows chat icons only for standalone pinned chats", () => {
    const standaloneChat = {
      id: "standalone-chat",
      title: "Standalone Chat",
      updatedAt: "2026-04-09T13:00:00.000Z",
    };
    renderSection({
      items: [
        { kind: "project", project },
        { kind: "chat", session: standaloneChat },
      ],
    });

    const projectChatRow = screen
      .getByText("Project Chat")
      .closest("[data-sidebar-chat-row]");
    const standaloneChatRow = screen
      .getByText("Standalone Chat")
      .closest("[data-sidebar-chat-row]");
    expect(projectChatRow).not.toBeNull();
    expect(standaloneChatRow).not.toBeNull();
    expect(
      projectChatRow?.querySelector('[data-testid="sidebar-pinned-chat-icon"]'),
    ).not.toBeInTheDocument();
    expect(
      standaloneChatRow?.querySelector(
        '[data-testid="sidebar-pinned-chat-icon"]',
      ),
    ).toBeInTheDocument();
  });

  it("expands a pinned project with a leading chevron", async () => {
    const user = userEvent.setup();
    const toggleProject = vi.fn();
    renderSection({
      expandedProjects: {},
      toggleProject,
    });

    const projectButton = screen.getByRole("button", { name: "Project One" });
    expect(projectButton).toHaveAttribute("aria-expanded", "false");
    expect(projectButton.querySelector("svg.hidden")).toBeInTheDocument();

    await user.click(projectButton);
    expect(toggleProject).toHaveBeenCalledWith(project.id);
  });

  it("requests collapsing the pinned section", async () => {
    const user = userEvent.setup();
    const onToggleOpen = vi.fn();
    renderSection({ onToggleOpen });

    const toggle = screen.getByRole("button", { name: "Pinned" });
    await user.click(toggle);

    expect(onToggleOpen).toHaveBeenCalledOnce();
  });

  it("preserves all chat actions for chats under pinned projects", async () => {
    const onArchiveChat = vi.fn();
    const onForkChat = vi.fn();
    const onMarkChatUnread = vi.fn();
    const onMoveToProject = vi.fn();
    renderSection({
      onArchiveChat,
      onForkChat,
      onMarkChatUnread,
      onMoveToProject,
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));

    const row = screen
      .getByText("Project Chat")
      .closest("[data-sidebar-chat-row]");
    if (!row) throw new Error("project chat row missing");
    fireEvent.contextMenu(row, { clientX: 100, clientY: 100 });

    expect(
      await within(document.body).findByRole("menuitem", {
        name: /duplicate/i,
      }),
    ).toBeInTheDocument();
    expect(
      within(document.body).getByRole("menuitem", { name: /archive/i }),
    ).toBeInTheDocument();
    expect(
      within(document.body).getByRole("menuitem", { name: /mark unread/i }),
    ).toBeInTheDocument();
  });

  it("opens a pinned project without visible chats", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    renderSection({
      projectSessionsByProject: {},
      expandedProjects: {},
      onOpenProject,
    });

    await user.click(screen.getByRole("button", { name: "Project One" }));
    expect(onOpenProject).toHaveBeenCalledWith(project.id);
  });

  it("does not render an independently pinned chat twice under its project", () => {
    renderSection({
      items: [
        { kind: "project", project },
        { kind: "chat", session: projectChat },
      ],
      projectSessionsByProject: { [project.id]: [] },
    });

    expect(screen.getAllByText("Project Chat")).toHaveLength(1);
  });
});
