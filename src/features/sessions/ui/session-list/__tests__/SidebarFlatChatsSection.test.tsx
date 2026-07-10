import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type { FlatChatGroup } from "@/features/sidebar/lib/sidebarFlatChats";
import { SidebarFlatChatsSection } from "../SidebarFlatChatsSection";
import { SidebarProjectsSection } from "../SidebarProjectsSection";

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

const flatChatGroups = [
  {
    id: "last-hour",
    sessions: [
      {
        id: "project-chat",
        title: "Project Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        projectId: "project-1",
        projectName: "Project One",
        projectIcon: "",
        projectColor: "",
      },
      {
        id: "general-chat",
        title: "General Chat",
        updatedAt: "2026-04-09T11:00:00.000Z",
      },
    ],
  },
] satisfies FlatChatGroup[];

function renderFlatChatsSection(
  props: Partial<ComponentProps<typeof SidebarFlatChatsSection>> = {},
) {
  return render(
    <SidebarFlatChatsSection
      groups={flatChatGroups}
      pinnedHomeChatSessionIds={new Set()}
      collapsed={false}
      labelTransition=""
      labelVisible
      showTimestamps
      onShowTimestampsChange={vi.fn()}
      {...props}
    />,
  );
}

describe("SidebarFlatChatsSection", () => {
  it("shows new project and new chat actions in the flat chats header", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();

    renderFlatChatsSection({ onCreateProject, onNewChat });

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("does not offer chat icon visibility in the flat chats menu", async () => {
    const user = userEvent.setup();

    renderFlatChatsSection({ onNewChat: vi.fn() });

    await user.click(
      screen.getByRole("button", { name: "Chat display options" }),
    );

    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Show chat icons" }),
    ).not.toBeInTheDocument();
  });

  it("switches to grouped chats from the header", async () => {
    const user = userEvent.setup();
    const onGroupChatsByProjectChange = vi.fn();

    renderFlatChatsSection({
      onGroupChatsByProjectChange,
      onNewChat: vi.fn(),
    });

    await user.click(
      screen.getByRole("button", { name: "Group chats by project" }),
    );

    expect(onGroupChatsByProjectChange).toHaveBeenCalledWith(true);
  });

  it("switches to flat chats from the grouped projects header", async () => {
    const user = userEvent.setup();
    const onGroupChatsByProjectChange = vi.fn();

    render(
      <SidebarProjectsSection
        projects={[project]}
        projectSessions={{ byProject: {}, standalone: [] }}
        hasVisibleChats={false}
        flatChatGroups={flatChatGroups}
        hasFlatChatOverflow={false}
        groupChatsByProject
        onGroupChatsByProjectChange={onGroupChatsByProjectChange}
        showChatIcons
        onShowChatIconsChange={vi.fn()}
        showTimestamps
        onShowTimestampsChange={vi.fn()}
        showProjectChatIcons={false}
        onShowProjectChatIconsChange={vi.fn()}
        showProjectTimestamps
        onShowProjectTimestampsChange={vi.fn()}
        showGitBranches={false}
        onShowGitBranchesChange={vi.fn()}
        pinnedHomeChatSessionIds={new Set()}
        expandedProjects={{}}
        toggleProject={vi.fn()}
        collapsed={false}
        labelTransition=""
        labelVisible
        projectsSectionOpen
        recentsSectionOpen
        onToggleProjectsSection={vi.fn()}
        onToggleRecentsSection={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Show chats as one list" }),
    );

    expect(onGroupChatsByProjectChange).toHaveBeenCalledWith(false);
  });

  it("uses icon-only flat chat rows when collapsed", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();
    const onSelectSession = vi.fn();

    const { container } = renderFlatChatsSection({
      collapsed: true,
      activeSessionId: "project-chat",
      onCreateProject,
      onNewChat,
      onSelectSession,
    });

    expect(container.querySelector("[data-sidebar-chat-row]")).toBeNull();
    expect(screen.queryByText("Project Chat")).toBeNull();
    expect(screen.queryByText("General Chat")).toBeNull();
    expect(
      container.querySelector('[data-project-color-swatch="project-1"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project Chat" })).toHaveClass(
      "bg-[var(--sidebar-row-active)]",
    );
    expect(
      screen.getByRole("button", { name: "General Chat" }),
    ).not.toHaveClass("bg-[var(--sidebar-row-active)]");

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "General Chat" }));

    expect(onSelectSession).toHaveBeenCalledWith("general-chat");
  });

  it("uses an icon-only empty state when collapsed", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();

    const { container } = renderFlatChatsSection({
      collapsed: true,
      groups: [],
      onCreateProject,
      onNewChat,
    });

    expect(screen.queryByText("Start a chat")).toBeNull();
    expect(container.querySelector("[data-sidebar-chat-row]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Start a chat" }));

    expect(onNewChat).toHaveBeenCalledOnce();
  });
});
