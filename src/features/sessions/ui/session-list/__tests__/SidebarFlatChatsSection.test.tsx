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

  it("offers the Session History route even when few chats are loaded", () => {
    // Regression: the escape hatch used to be gated on loaded-chat counts,
    // which hid it exactly when sessions failed to load (BOT-1688).
    renderFlatChatsSection({
      onNewChat: vi.fn(),
      onNavigate: vi.fn(),
      showViewAllInHistory: true,
      groups: [
        {
          id: "last-hour",
          sessions: [
            {
              id: "only-chat",
              title: "Only Chat",
              updatedAt: "2026-04-09T12:00:00.000Z",
              projectId: "project-1",
              projectName: "Project One",
              projectIcon: "",
              projectColor: "",
            },
          ],
        },
      ],
    });

    expect(
      screen.getByRole("button", { name: "View all chats" }),
    ).toBeInTheDocument();
  });

  it("offers grouping in the flat chats menu", async () => {
    const user = userEvent.setup();
    const onGroupChatsByProjectChange = vi.fn();

    renderFlatChatsSection({
      onNewChat: vi.fn(),
      onGroupChatsByProjectChange,
    });

    await user.click(
      screen.getByRole("button", { name: "Chat display options" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", {
        name: "Group chats by project",
      }),
    );

    expect(onGroupChatsByProjectChange).toHaveBeenCalledWith(true);
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

  it("uses shared display settings across grouped project and general chats", async () => {
    const user = userEvent.setup();
    const onShowChatIconsChange = vi.fn();
    const onShowTimestampsChange = vi.fn();

    render(
      <SidebarProjectsSection
        projects={[project]}
        projectSessions={{
          byProject: {
            "project-1": [
              {
                id: "project-chat",
                title: "Project Chat",
                updatedAt: "2026-04-09T12:00:00.000Z",
              },
            ],
          },
          standalone: [
            {
              id: "general-chat",
              title: "General Chat",
              updatedAt: "2026-04-09T11:00:00.000Z",
            },
          ],
        }}
        hasVisibleChats
        flatChatGroups={flatChatGroups}
        hasFlatChatOverflow={false}
        groupChatsByProject
        pinnedShowChatIcons
        onPinnedShowChatIconsChange={vi.fn()}
        pinnedShowTimestamps={false}
        onPinnedShowTimestampsChange={vi.fn()}
        projectShowChatIcons={false}
        onProjectShowChatIconsChange={onShowChatIconsChange}
        projectShowTimestamps={false}
        onProjectShowTimestampsChange={onShowTimestampsChange}
        chatShowChatIcons={false}
        onChatShowChatIconsChange={vi.fn()}
        chatShowTimestamps={false}
        onChatShowTimestampsChange={vi.fn()}
        expandedProjects={{ "project-1": true }}
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

    expect(screen.queryAllByTestId("sidebar-chat-menu-icon")).toHaveLength(0);
    expect(screen.queryAllByTestId("sidebar-chat-timestamp")).toHaveLength(0);

    await user.click(
      screen.getByRole("button", { name: "Project display options" }),
    );
    const showChatIcons = screen.getByRole("menuitemcheckbox", {
      name: "Show chat icons",
    });
    expect(showChatIcons).not.toBeChecked();
    await user.click(showChatIcons);
    expect(onShowChatIconsChange).toHaveBeenCalledWith(true);
    await user.click(
      screen.getByRole("button", { name: "Project display options" }),
    );
    const showTimestamps = screen.getByRole("menuitemcheckbox", {
      name: "Show timestamp",
    });
    expect(showTimestamps).not.toBeChecked();
    await user.click(showTimestamps);
    expect(onShowTimestampsChange).toHaveBeenCalledWith(true);
  });

  it("shows the Session History route in grouped mode when more sessions exist but none are loaded", () => {
    // Regression: hasMoreSessions && hasVisibleChats meant a project list
    // whose chats never loaded (BOT-1688) had no route to Session History.
    render(
      <SidebarProjectsSection
        projects={[project]}
        projectSessions={{ byProject: {}, standalone: [] }}
        hasVisibleChats={false}
        flatChatGroups={[]}
        hasFlatChatOverflow={false}
        groupChatsByProject
        pinnedShowChatIcons={false}
        onPinnedShowChatIconsChange={vi.fn()}
        pinnedShowTimestamps={false}
        onPinnedShowTimestampsChange={vi.fn()}
        projectShowChatIcons={false}
        onProjectShowChatIconsChange={vi.fn()}
        projectShowTimestamps={false}
        onProjectShowTimestampsChange={vi.fn()}
        chatShowChatIcons={false}
        onChatShowChatIconsChange={vi.fn()}
        chatShowTimestamps={false}
        onChatShowTimestampsChange={vi.fn()}
        expandedProjects={{}}
        toggleProject={vi.fn()}
        collapsed={false}
        labelTransition=""
        labelVisible
        projectsSectionOpen
        recentsSectionOpen
        onToggleProjectsSection={vi.fn()}
        onToggleRecentsSection={vi.fn()}
        hasMoreSessions
        onNavigate={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "View all chats" }),
    ).toBeInTheDocument();
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
