import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { Sidebar } from "../Sidebar";

const designSystemExplorer = vi.hoisted(() => ({
  isEnabled: vi.fn(() => false),
}));

const mockSessions: Array<{
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  projectId?: string;
  archivedAt?: string;
}> = [];

function mockProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    path: "/tmp/project-1",
    name: "Project One",
    description: "",
    prompt: "",
    icon: "",
    color: "",
    preferredProvider: null,
    preferredModel: null,
    workingDirs: [],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

vi.mock("@/features/chat/stores/chatStore", () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({
      messagesBySession: {},
      sessionStateById: {},
    }),
}));

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  getVisibleSessions: (sessions: typeof mockSessions) =>
    sessions.filter((session) => session.messageCount > 0),
  useChatSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: mockSessions,
    }),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: (selector: (state: unknown) => unknown) =>
    selector({
      getPersonaById: () => undefined,
    }),
}));

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({
      projects: [],
    }),
}));

vi.mock("@/features/design-system/lib/designSystemEnabled", () => ({
  isDesignSystemExplorerEnabled: () => designSystemExplorer.isEnabled(),
}));

describe("Sidebar", () => {
  beforeEach(() => {
    mockSessions.splice(0, mockSessions.length);
    window.localStorage.clear();
    designSystemExplorer.isEnabled.mockReturnValue(false);
  });

  it("shows an empty state when there are no projects or chats", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();

    mockSessions.splice(0, mockSessions.length);

    render(
      <Sidebar
        collapsed={false}
        onNavigate={vi.fn()}
        onCreateProject={onCreateProject}
        onNewChat={onNewChat}
        projects={[]}
      />,
    );

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    expect(within(mainNavigation).getByText("Projects")).toBeInTheDocument();
    expect(within(mainNavigation).getByText("Chats")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create a project" }));
    await user.click(screen.getByRole("button", { name: "Start a chat" }));

    expect(onCreateProject).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("shows the projects empty state when chats exist", () => {
    mockSessions.splice(0, mockSessions.length, {
      id: "session-1",
      title: "Agents page UI redesign",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    render(
      <Sidebar
        collapsed={false}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
        projects={[]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Create a project" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Agents page UI redesign")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start a chat" }),
    ).not.toBeInTheDocument();
  });

  it("shows the chats empty state when only project chats exist", () => {
    mockSessions.splice(0, mockSessions.length, {
      id: "session-1",
      title: "Project Chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    render(
      <Sidebar
        collapsed={false}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
        projects={[mockProject()]}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Create a project" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start a chat" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Project One")).toBeInTheDocument();

    mockSessions.splice(0, mockSessions.length);
  });

  it("expands all project chats from the view all chats control", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    mockSessions.splice(
      0,
      mockSessions.length,
      ...Array.from({ length: 13 }, (_, index) => {
        const chatNumber = index + 1;
        return {
          id: `session-${chatNumber}`,
          title: `Project Chat ${chatNumber}`,
          updatedAt: `2026-04-09T12:${String(index).padStart(2, "0")}:00.000Z`,
          messageCount: 3,
          projectId: "project-1",
        };
      }),
    );

    render(
      <Sidebar
        collapsed={false}
        onNavigate={onNavigate}
        onSelectSession={vi.fn()}
        projects={[mockProject()]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(screen.getByText("Project Chat 13")).toBeInTheDocument();
    expect(screen.queryByText("Project Chat 8")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View all 13 chats" }));

    expect(screen.getByText("Project Chat 8")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show less" }),
    ).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalledWith("projects");
  });

  it("shows sessions in recents when their project is not loaded", () => {
    mockSessions.splice(0, mockSessions.length, {
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "missing-project",
    });

    render(
      <Sidebar
        collapsed={false}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
        projects={[]}
      />,
    );

    expect(screen.getByText("Recovered Session")).toBeInTheDocument();
  });

  it("hides zero-message sessions from recents", () => {
    mockSessions.splice(
      0,
      mockSessions.length,
      {
        id: "home-session",
        title: "New Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 0,
      },
      {
        id: "session-1",
        title: "Recovered Session",
        updatedAt: "2026-04-09T12:01:00.000Z",
        messageCount: 3,
      },
    );

    render(
      <Sidebar
        collapsed={false}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
        projects={[]}
      />,
    );

    expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
    expect(screen.getByText("Recovered Session")).toBeInTheDocument();

    mockSessions.splice(0, mockSessions.length);
  });

  it("renders a home button in the sidebar header and navigates home", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(<Sidebar collapsed={false} onNavigate={onNavigate} projects={[]} />);

    await user.click(screen.getByRole("button", { name: /home/i }));

    expect(onNavigate).toHaveBeenCalledWith("home");
  });

  it("renders an automations button in main navigation", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(<Sidebar collapsed={false} onNavigate={onNavigate} projects={[]} />);

    await user.click(screen.getByRole("button", { name: /automations/i }));

    expect(onNavigate).toHaveBeenCalledWith("automations");
  });

  it("renders the dev-only design system button after session history", () => {
    designSystemExplorer.isEnabled.mockReturnValue(true);

    render(<Sidebar collapsed onNavigate={vi.fn()} projects={[]} />);

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    const labels = within(mainNavigation)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));

    expect(labels).toEqual([
      "Home",
      "Agents",
      "Skills",
      "Automations",
      "Session history",
      "Design system (dev only)",
    ]);
  });

  it("keeps the home button visible when the sidebar is collapsed", () => {
    render(<Sidebar collapsed onNavigate={vi.fn()} projects={[]} />);

    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
  });

  it("collapses and expands the recents section", async () => {
    const user = userEvent.setup();
    mockSessions.splice(0, mockSessions.length, {
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    render(
      <Sidebar
        collapsed={false}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
        projects={[]}
      />,
    );

    const recentsHeader = screen.getByRole("button", { name: /chats/i });
    expect(screen.getByText("Recovered Session")).toBeInTheDocument();

    await user.click(recentsHeader);
    expect(screen.queryByText("Recovered Session")).not.toBeInTheDocument();

    await user.click(recentsHeader);
    expect(screen.getByText("Recovered Session")).toBeInTheDocument();
  });

  it("keeps the active chat in the selection while multi-selection is active", async () => {
    const user = userEvent.setup();
    mockSessions.splice(
      0,
      mockSessions.length,
      {
        id: "active-session",
        title: "Active Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "session-2",
        title: "Second Chat",
        updatedAt: "2026-04-09T12:01:00.000Z",
        messageCount: 3,
      },
      {
        id: "session-3",
        title: "Third Chat",
        updatedAt: "2026-04-09T12:02:00.000Z",
        messageCount: 3,
      },
    );

    render(
      <Sidebar
        collapsed={false}
        activeSessionId="active-session"
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
        projects={[]}
      />,
    );

    await user.keyboard("[ControlLeft>]");
    await user.click(screen.getByRole("button", { name: "Second Chat" }));
    await user.click(screen.getByRole("button", { name: "Third Chat" }));
    await user.keyboard("[/ControlLeft]");

    await user.click(
      screen.getByRole("button", { name: /options for third chat/i }),
    );

    expect(screen.getByText("3 chats selected")).toBeInTheDocument();
  });

  it("clears selection when the last manually selected chat is toggled off", async () => {
    const user = userEvent.setup();
    mockSessions.splice(
      0,
      mockSessions.length,
      {
        id: "active-session",
        title: "Active Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "session-2",
        title: "Second Chat",
        updatedAt: "2026-04-09T12:01:00.000Z",
        messageCount: 3,
      },
    );

    render(
      <Sidebar
        collapsed={false}
        activeSessionId="active-session"
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
        projects={[]}
      />,
    );

    await user.keyboard("[ControlLeft>]");
    await user.click(screen.getByRole("button", { name: "Second Chat" }));
    await user.click(screen.getByRole("button", { name: "Second Chat" }));
    await user.keyboard("[/ControlLeft]");

    expect(
      screen.getByRole("button", { name: "Active Chat" }),
    ).not.toHaveAttribute("aria-pressed");
  });

  it("confirms before bulk archiving selected chats", async () => {
    const user = userEvent.setup();
    const onArchiveChat = vi.fn().mockResolvedValue(undefined);
    mockSessions.splice(
      0,
      mockSessions.length,
      {
        id: "active-session",
        title: "Active Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "session-2",
        title: "Second Chat",
        updatedAt: "2026-04-09T12:01:00.000Z",
        messageCount: 3,
      },
    );

    render(
      <Sidebar
        collapsed={false}
        activeSessionId="active-session"
        onArchiveChat={onArchiveChat}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
        projects={[]}
      />,
    );

    await user.keyboard("[ControlLeft>]");
    await user.click(screen.getByRole("button", { name: "Second Chat" }));
    await user.keyboard("[/ControlLeft]");
    await user.click(
      screen.getByRole("button", { name: /options for second chat/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /^archive$/i }));

    expect(
      screen.getByRole("dialog", { name: /archive selected chats/i }),
    ).toBeInTheDocument();
    expect(onArchiveChat).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^archive$/i }));

    await waitFor(() => {
      expect(onArchiveChat).toHaveBeenCalledWith("active-session");
      expect(onArchiveChat).toHaveBeenCalledWith("session-2");
    });
  });

  it("renders settings navigation as the active sidebar surface", async () => {
    const user = userEvent.setup();
    const onSettingsBack = vi.fn();
    const onSettingsSectionChange = vi.fn();

    render(
      <Sidebar
        collapsed={false}
        activeView="settings"
        activeSettingsSection="providers"
        onNavigate={vi.fn()}
        onSettingsBack={onSettingsBack}
        onSettingsSectionChange={onSettingsSectionChange}
        projects={[]}
      />,
    );

    expect(
      screen.getByRole("navigation", { name: /settings navigation/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /providers/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("button", { name: /^home$/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/^v\d+\.\d+\.\d+-dev$/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(onSettingsBack).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /general/i }));
    expect(onSettingsSectionChange).toHaveBeenCalledWith("general");
  });

  it("does not render an in-panel expand control in collapsed settings navigation", () => {
    render(
      <Sidebar
        collapsed
        activeView="settings"
        activeSettingsSection="general"
        onNavigate={vi.fn()}
        onSettingsBack={vi.fn()}
        onSettingsSectionChange={vi.fn()}
        projects={[]}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /expand sidebar/i }),
    ).not.toBeInTheDocument();
  });
});
