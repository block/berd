import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { Sidebar } from "../Sidebar";

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

describe("Sidebar", () => {
  it("shows an empty state when there are no projects or chats", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();

    mockSessions.splice(0, mockSessions.length);

    render(
      <Sidebar
        collapsed={false}
        onCollapse={vi.fn()}
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
        onCollapse={vi.fn()}
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

    mockSessions.splice(0, mockSessions.length);
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
        onCollapse={vi.fn()}
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
        onCollapse={vi.fn()}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
        projects={[]}
      />,
    );

    expect(screen.getByText("Recovered Session")).toBeInTheDocument();

    mockSessions.splice(0, mockSessions.length);
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
        onCollapse={vi.fn()}
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

    render(
      <Sidebar
        collapsed={false}
        onCollapse={vi.fn()}
        onNavigate={onNavigate}
        projects={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /home/i }));

    expect(onNavigate).toHaveBeenCalledWith("home");
  });

  it("renders an automations button in main navigation", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(
      <Sidebar
        collapsed={false}
        onCollapse={vi.fn()}
        onNavigate={onNavigate}
        projects={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /automations/i }));

    expect(onNavigate).toHaveBeenCalledWith("automations");
  });

  it("keeps the home button visible when the sidebar is collapsed", () => {
    render(
      <Sidebar
        collapsed
        onCollapse={vi.fn()}
        onNavigate={vi.fn()}
        projects={[]}
      />,
    );

    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
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
        onCollapse={vi.fn()}
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

    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(onSettingsBack).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /general/i }));
    expect(onSettingsSectionChange).toHaveBeenCalledWith("general");
  });

  it("shows an expand control in collapsed settings navigation", async () => {
    const user = userEvent.setup();
    const onCollapse = vi.fn();

    render(
      <Sidebar
        collapsed
        activeView="settings"
        activeSettingsSection="general"
        onCollapse={onCollapse}
        onNavigate={vi.fn()}
        onSettingsBack={vi.fn()}
        onSettingsSectionChange={vi.fn()}
        projects={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /expand sidebar/i }));

    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});
