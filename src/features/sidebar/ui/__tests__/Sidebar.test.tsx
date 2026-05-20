import type { ComponentProps } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { Sidebar } from "../Sidebar";

const designSystemExplorer = vi.hoisted(() => ({
  isEnabled: vi.fn(() => false),
}));

type MockSession = {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  projectId?: string;
  workingDir?: string | null;
  archivedAt?: string;
};

type SidebarProps = ComponentProps<typeof Sidebar>;
const mockSessions: MockSession[] = [];
let mockHasMoreSessions = false;
let mockIsLoadingMoreSessions = false;
let mockSessionPageCursor: string | null = null;
const mockLoadMoreSessions = vi.fn();
const mockAcpSearchSessions = vi.fn();

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

function seedSessions(...sessions: MockSession[]) {
  mockSessions.splice(0, mockSessions.length, ...sessions);
}

function seedProjectChats(count: number, overrides: Partial<MockSession> = {}) {
  seedSessions(
    ...Array.from({ length: count }, (_, index) => {
      const chatNumber = index + 1;
      return {
        id: `session-${chatNumber}`,
        title: `Project Chat ${chatNumber}`,
        updatedAt: `2026-04-09T12:${String(index).padStart(2, "0")}:00.000Z`,
        messageCount: 3,
        projectId: "project-1",
        ...overrides,
      };
    }),
  );
}

function sidebarProps(props: Partial<SidebarProps> = {}): SidebarProps {
  return {
    collapsed: false,
    onNavigate: vi.fn(),
    onSelectSession: vi.fn(),
    projects: [],
    ...props,
  };
}

function renderSidebar(props: Partial<SidebarProps> = {}) {
  return render(<Sidebar {...sidebarProps(props)} />);
}

async function clickViewMore(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "View more chats" }));
}

vi.mock("@/features/chat/stores/chatStore", () => ({
  useChatStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        messagesBySession: {},
        sessionStateById: {},
      }),
    {
      getState: () => ({
        messagesBySession: {},
        sessionStateById: {},
      }),
    },
  ),
}));

vi.mock("@/shared/api/acp", () => ({
  acpSearchSessions: (...args: unknown[]) => mockAcpSearchSessions(...args),
}));

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  getVisibleSessions: (sessions: typeof mockSessions) =>
    sessions.filter((session) => session.messageCount > 0),
  useChatSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        sessions: mockSessions,
        hasMoreSessions: mockHasMoreSessions,
        isLoadingMoreSessions: mockIsLoadingMoreSessions,
        sessionPageCursor: mockSessionPageCursor,
        loadMoreSessions: mockLoadMoreSessions,
      }),
    {
      getState: () => ({
        sessions: mockSessions,
        hasMoreSessions: mockHasMoreSessions,
        isLoadingMoreSessions: mockIsLoadingMoreSessions,
        loadMoreSessions: mockLoadMoreSessions,
        sessionPageCursor: mockSessionPageCursor,
      }),
    },
  ),
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
    seedSessions();
    mockHasMoreSessions = false;
    mockIsLoadingMoreSessions = false;
    mockSessionPageCursor = null;
    mockLoadMoreSessions.mockReset();
    mockAcpSearchSessions.mockReset();
    mockAcpSearchSessions.mockResolvedValue([]);
    window.localStorage.clear();
    designSystemExplorer.isEnabled.mockReturnValue(false);
  });

  it("shows an empty state when there are no projects or chats", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();

    renderSidebar({ onCreateProject, onNewChat });

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
    seedSessions({
      id: "session-1",
      title: "Agents page UI redesign",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar();

    expect(
      screen.getByRole("button", { name: "Create a project" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Agents page UI redesign")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start a chat" }),
    ).not.toBeInTheDocument();
  });

  it("shows the chats empty state when only project chats exist", () => {
    seedSessions({
      id: "session-1",
      title: "Project Chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({ projects: [mockProject()] });

    expect(
      screen.queryByRole("button", { name: "Create a project" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start a chat" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Project One")).toBeInTheDocument();
  });

  it("expands loaded project chats from the view more chats control", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    seedProjectChats(13);
    renderSidebar({ onNavigate, projects: [mockProject()] });

    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(screen.getByText("Project Chat 13")).toBeInTheDocument();
    expect(screen.queryByText("Project Chat 8")).not.toBeInTheDocument();

    await clickViewMore(user);

    expect(screen.getByText("Project Chat 13")).toBeInTheDocument();
    expect(screen.getByText("Project Chat 8")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show less" }),
    ).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalledWith("projects");
  });

  it("links to session history after expanding loaded project chats", async () => {
    const user = userEvent.setup();
    mockHasMoreSessions = true;
    const onNavigate = vi.fn();
    mockLoadMoreSessions.mockImplementation(async () => {
      mockHasMoreSessions = false;
    });
    seedProjectChats(6);
    renderSidebar({ onNavigate, projects: [mockProject()] });

    await user.click(screen.getByRole("button", { name: "Project One" }));
    await clickViewMore(user);
    expect(mockLoadMoreSessions).not.toHaveBeenCalled();

    const historyLink = await screen.findByRole("button", {
      name: "View older chats in Session History",
    });
    await user.click(historyLink);
    expect(onNavigate).toHaveBeenCalledWith("session-history");
  });

  it("caps expanded project chats and links overflow to session history", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    seedProjectChats(21);
    renderSidebar({ onNavigate, projects: [mockProject()] });

    await user.click(screen.getByRole("button", { name: "Project One" }));
    await clickViewMore(user);

    expect(screen.getByText("Project Chat 21")).toBeInTheDocument();
    expect(screen.getByText("Project Chat 2")).toBeInTheDocument();
    expect(screen.queryByText("Project Chat 1")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "View older chats in Session History",
      }),
    );
    expect(onNavigate).toHaveBeenCalledWith("session-history");
  });

  it("does not render a project page load control while a global load is in flight", async () => {
    const user = userEvent.setup();
    mockHasMoreSessions = true;
    mockIsLoadingMoreSessions = true;
    seedSessions({
      id: "session-1",
      title: "Project Chat 1",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({ projects: [mockProject()] });

    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(
      screen.queryByRole("button", { name: "Loading chats..." }),
    ).not.toBeInTheDocument();
    expect(mockLoadMoreSessions).not.toHaveBeenCalled();
  });

  it("shows sessions in recents when their project is not loaded", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "missing-project",
    });

    renderSidebar();

    expect(screen.getByText("Recovered Session")).toBeInTheDocument();
  });

  it("groups project chats by project id even when the working directory differs", async () => {
    const user = userEvent.setup();
    seedSessions({
      id: "session-1",
      title: "Mismatched Directory Chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
      workingDir: "/tmp/not-a-project-working-dir",
    });

    renderSidebar({
      projects: [
        mockProject({
          workingDirs: ["/tmp/project-working-dir"],
        }),
      ],
    });

    expect(
      screen.queryByText("Mismatched Directory Chat"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(screen.getByText("Mismatched Directory Chat")).toBeInTheDocument();
  });

  it("hides zero-message sessions from recents", () => {
    seedSessions(
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

    renderSidebar();

    expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
    expect(screen.getByText("Recovered Session")).toBeInTheDocument();
  });

  it("renders a home button in the sidebar header and navigates home", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    renderSidebar({ onNavigate });

    await user.click(screen.getByRole("button", { name: /home/i }));

    expect(onNavigate).toHaveBeenCalledWith("home");
  });

  it("renders an automations button in main navigation", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    renderSidebar({ onNavigate });

    await user.click(screen.getByRole("button", { name: /automations/i }));

    expect(onNavigate).toHaveBeenCalledWith("automations");
  });

  it("renders the dev-only design system button after session history", () => {
    designSystemExplorer.isEnabled.mockReturnValue(true);

    renderSidebar();

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    const labels = within(mainNavigation)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => Boolean(label));

    expect(labels).toEqual(
      expect.arrayContaining([
        "Home",
        "Agents",
        "Skills",
        "Automations",
        "Session history",
        "Design system (dev only)",
      ]),
    );
  });

  it("still renders the nav when collapsed so the AppShell can animate it out", () => {
    renderSidebar({ collapsed: true });

    // The visibility/clipping lives on the AppShell wrapper (width + opacity
    // transition). Sidebar itself stays mounted so its content can fade with
    // the wrapper rather than vanishing instantly.
    expect(
      screen.getByRole("navigation", { name: /main navigation/i }),
    ).toBeInTheDocument();
  });

  it("collapses and expands the recents section", async () => {
    const user = userEvent.setup();
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar();

    const recentsHeader = screen.getByRole("button", { name: /chats/i });
    expect(screen.getByText("Recovered Session")).toBeInTheDocument();

    await user.click(recentsHeader);
    expect(screen.queryByText("Recovered Session")).not.toBeInTheDocument();

    await user.click(recentsHeader);
    expect(screen.getByText("Recovered Session")).toBeInTheDocument();
  });

  it("keeps the active chat in the selection while multi-selection is active", async () => {
    const user = userEvent.setup();
    seedSessions(
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

    renderSidebar({ activeSessionId: "active-session" });

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
    seedSessions(
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

    renderSidebar({ activeSessionId: "active-session" });

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
    seedSessions(
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

    renderSidebar({
      activeSessionId: "active-session",
      onArchiveChat,
    });

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

    renderSidebar({
      activeView: "settings",
      activeSettingsSection: "providers",
      onSettingsBack,
      onSettingsSectionChange,
    });

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
});
