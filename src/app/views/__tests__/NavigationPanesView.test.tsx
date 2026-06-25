import { useState, type ComponentProps, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import {
  BUILDERBOT_SURFACE_EXPERIMENT_ID,
  SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
  SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
} from "@/features/experiments/experimentDefinitions";
import {
  setExperimentConfigValue,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import {
  SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
} from "@/app/layout/panes/paneSizeRules";
import { SIDEBAR_GIT_BRANCH_SUBTITLE_STORAGE_KEY } from "@/features/sidebar/lib/sidebarBranchSubtitlePreference";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";
import { MAX_FLAT_SIDEBAR_CHATS } from "@/features/sidebar/lib/sidebarFlatChats";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "@/features/home/stores/homeWidgetStore";
import { NavigationPanesView } from "../NavigationPanesView";

const designSystemExplorer = vi.hoisted(() => ({
  isEnabled: vi.fn(() => false),
}));

vi.mock("@/features/providers/hooks/useAgentUpdatesAvailable", () => ({
  useAgentUpdatesAvailable: () => false,
}));

type MockSession = {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  projectId?: string;
  workingDir?: string | null;
  subtitle?: string | null;
  archivedAt?: string;
};

type NavigationPanesViewProps = ComponentProps<typeof NavigationPanesView>;
const mockSessions: MockSession[] = [];
let mockDraftsBySession: Record<string, string> = {};
let mockHasMoreSessions = false;
let mockIsLoadingMoreSessions = false;
let mockSessionPageCursor: string | null = null;
let mockActiveWorkspaceBySession: Record<
  string,
  { path: string; branch: string | null }
> = {};
const mockLoadMoreSessions = vi.fn();
const mockAcpSearchSessions = vi.fn();
const mockGetGitState = vi.fn();

function mockProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    path: "/tmp/project-1",
    name: "Project One",
    description: "",
    prompt: "",
    icon: "",
    color: "",
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

function sidebarProps(
  props: Partial<NavigationPanesViewProps> = {},
): NavigationPanesViewProps {
  return {
    collapsed: false,
    width: 300,
    onNavigate: vi.fn(),
    onSelectSession: vi.fn(),
    projects: [],
    ...props,
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderWithQueryClient(element: ReactElement) {
  const queryClient = createQueryClient();
  return render(element, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

function renderSidebar(props: Partial<NavigationPanesViewProps> = {}) {
  return renderWithQueryClient(
    <NavigationPanesView {...sidebarProps(props)} />,
  );
}

function setReadyRuntimeConfig(config: RuntimeConfig = { schemaVersion: 1 }) {
  useRuntimeConfigStore.setState({
    loaded: true,
    result: {
      status: "ready",
      source: "fakeEndpoint",
      config,
    },
    config,
  });
}

function mockRect(element: Element, rect: Pick<DOMRect, "top" | "bottom">) {
  const height = rect.bottom - rect.top;
  return vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: rect.top,
    top: rect.top,
    bottom: rect.bottom,
    left: 0,
    right: 300,
    width: 300,
    height,
    toJSON: () => ({}),
  } as DOMRect);
}

function NavigationPanesSelectionHarness({
  onSelectSession,
}: {
  onSelectSession?: (sessionId: string) => void;
}) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  return (
    <NavigationPanesView
      {...sidebarProps({
        activeView: "chat",
        activeSessionId,
        onSelectSession: (sessionId) => {
          setActiveSessionId(sessionId);
          onSelectSession?.(sessionId);
        },
      })}
    />
  );
}

function mockElementRect(element: Element, top: number, bottom: number) {
  return mockRect(element, { top, bottom });
}

async function waitForAnimationFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function attachScrollTo(element: HTMLElement) {
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (typeof options.top === "number") {
      element.scrollTop = options.top;
    }
  });
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return scrollTo;
}

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function clickViewMore(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "View more chats" }));
}

function renderedSessionIds() {
  return Array.from(document.querySelectorAll("[data-session-id]")).map(
    (element) => element.getAttribute("data-session-id"),
  );
}

function seedPinnedHomeChats(...sessionIds: string[]) {
  useHomeWidgetStore.setState({
    instances: sessionIds.map((sessionId, index) => ({
      id: `chat-pin-${sessionId}`,
      type: "chatPin",
      x: 0,
      y: index * 80,
      z: index + 1,
      state: { sessionId },
    })),
  });
}

function nonEmptyDraftSessionIds() {
  return new Set(
    Object.entries(mockDraftsBySession)
      .filter(([, draft]) => draft.length > 0)
      .map(([sessionId]) => sessionId),
  );
}

function disableProjectGrouping() {
  setExperimentEnabled(SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID, true);
  setExperimentConfigValue(
    SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
    SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
    false,
  );
}

vi.mock("@/features/chat/stores/chatStore", () => ({
  useChatStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        messagesBySession: {},
        draftsBySession: mockDraftsBySession,
        nonEmptyDraftSessionIds: nonEmptyDraftSessionIds(),
        sessionStateById: {},
      }),
    {
      getState: () => ({
        messagesBySession: {},
        draftsBySession: mockDraftsBySession,
        nonEmptyDraftSessionIds: nonEmptyDraftSessionIds(),
        sessionStateById: {},
      }),
    },
  ),
}));

vi.mock("@/shared/api/acp", () => ({
  acpSearchSessions: (...args: unknown[]) => mockAcpSearchSessions(...args),
}));

vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mockGetGitState(...args),
}));

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  getVisibleSessions: (sessions: typeof mockSessions) =>
    sessions.filter((session) => session.messageCount > 0),
  useChatSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        sessions: mockSessions,
        activeWorkspaceBySession: mockActiveWorkspaceBySession,
        hasMoreSessions: mockHasMoreSessions,
        isLoadingMoreSessions: mockIsLoadingMoreSessions,
        sessionPageCursor: mockSessionPageCursor,
        loadMoreSessions: mockLoadMoreSessions,
      }),
    {
      getState: () => ({
        sessions: mockSessions,
        activeWorkspaceBySession: mockActiveWorkspaceBySession,
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

describe("NavigationPanesView", () => {
  beforeEach(() => {
    seedSessions();
    mockDraftsBySession = {};
    mockHasMoreSessions = false;
    mockIsLoadingMoreSessions = false;
    mockSessionPageCursor = null;
    mockActiveWorkspaceBySession = {};
    mockLoadMoreSessions.mockReset();
    mockAcpSearchSessions.mockReset();
    mockAcpSearchSessions.mockResolvedValue([]);
    mockGetGitState.mockReset();
    mockGetGitState.mockResolvedValue({
      isGitRepo: false,
      currentBranch: null,
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: [],
    });
    resetHomeWidgetStoreForTests();
    window.localStorage.clear();
    designSystemExplorer.isEnabled.mockReturnValue(false);
    setReadyRuntimeConfig();
  });

  it("keeps latest message snippets in chat rows by default", () => {
    seedSessions({
      id: "session-1",
      title: "Branchable chat",
      subtitle: "Latest message snippet",
      workingDir: "/repo",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar();

    expect(screen.getByText("Latest message snippet")).toBeInTheDocument();
    expect(mockGetGitState).not.toHaveBeenCalled();
  });

  it("replaces latest message snippets with Git branches when enabled", async () => {
    localStorage.setItem(SIDEBAR_GIT_BRANCH_SUBTITLE_STORAGE_KEY, "true");
    mockGetGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "feature/sidebar-branch",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: ["feature/sidebar-branch"],
    });
    seedSessions({
      id: "session-1",
      title: "Branchable chat",
      subtitle: "Latest message snippet",
      workingDir: "/repo",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar();

    expect(
      await screen.findByText("feature/sidebar-branch"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Latest message snippet"),
    ).not.toBeInTheDocument();
    expect(mockGetGitState).toHaveBeenCalledWith("/repo");
  });

  it("uses the selected workspace branch before reading Git state", () => {
    localStorage.setItem(SIDEBAR_GIT_BRANCH_SUBTITLE_STORAGE_KEY, "true");
    mockActiveWorkspaceBySession = {
      "session-1": { path: "/repo", branch: "selected-workspace-branch" },
    };
    seedSessions({
      id: "session-1",
      title: "Workspace chat",
      subtitle: "Latest message snippet",
      workingDir: "/repo",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar();

    expect(screen.getByText("selected-workspace-branch")).toBeInTheDocument();
    expect(mockGetGitState).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("moves roving focus through main sidebar rows", () => {
    renderSidebar();

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    const home = within(mainNavigation).getByRole("button", { name: "Home" });
    const agents = within(mainNavigation).getByRole("button", {
      name: "Agents",
    });
    const skills = within(mainNavigation).getByRole("button", {
      name: "Skills",
    });

    home.focus();
    fireEvent.keyDown(home, { key: "ArrowDown" });
    expect(agents).toHaveFocus();
    fireEvent.keyDown(agents, { key: "ArrowDown" });
    expect(skills).toHaveFocus();
    fireEvent.keyDown(skills, { key: "ArrowUp" });
    expect(agents).toHaveFocus();
  });

  it("expands and collapses a focused project row with horizontal arrows", () => {
    seedProjectChats(1);
    renderSidebar({ projects: [mockProject()] });

    const project = screen.getByRole("button", { name: "Project One" });
    expect(project).toHaveAttribute("aria-expanded", "false");

    project.focus();
    fireEvent.keyDown(project, { key: "ArrowRight" });
    expect(project).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(project, { key: "ArrowLeft" });
    expect(project).toHaveAttribute("aria-expanded", "false");
  });

  it("only fades the bottom of the main navigation when more content is below", async () => {
    renderSidebar();

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });

    Object.defineProperties(mainNavigation, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    fireEvent.scroll(mainNavigation);
    await waitFor(() =>
      expect(mainNavigation.style.maskImage).toContain("linear-gradient"),
    );

    mainNavigation.scrollTop = 100;
    fireEvent.scroll(mainNavigation);
    await waitFor(() => expect(mainNavigation.style.maskImage).toBe(""));
  });

  it("scrolls the active main nav item into view after navigating from the recents history link", async () => {
    const user = userEvent.setup();
    seedSessions({
      id: "session-1",
      title: "Recent Chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    let activeView: NavigationPanesViewProps["activeView"] = "home";
    let rerenderSidebar: ReturnType<typeof render>["rerender"];
    const onNavigate = vi.fn(
      (view: NonNullable<NavigationPanesViewProps["activeView"]>) => {
        activeView = view;
        rerenderSidebar(
          <NavigationPanesView {...sidebarProps({ activeView, onNavigate })} />,
        );
      },
    );
    const rendered = renderSidebar({ activeView, onNavigate });
    rerenderSidebar = rendered.rerender;
    await waitForAnimationFrame();

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    const sessionHistoryNavItem = mainNavigation.querySelector<HTMLElement>(
      '[data-sidebar-nav-id="session-history"]',
    );
    if (!sessionHistoryNavItem) {
      throw new Error("Session history nav item not found");
    }
    mainNavigation.scrollTop = 120;
    mockElementRect(mainNavigation, 0, 100);
    mockElementRect(sessionHistoryNavItem, -36, -4);
    const scrollTo = attachScrollTo(mainNavigation);

    await user.click(
      screen.getByRole("button", {
        name: "Show all",
      }),
    );

    expect(onNavigate).toHaveBeenCalledWith("session-history");
    expect(sessionHistoryNavItem).toHaveAttribute("aria-current", "page");
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: 44, behavior: "smooth" }),
    );
    await waitFor(() => expect(mainNavigation.scrollTop).toBe(44));
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

    const { container } = renderSidebar({
      projects: [mockProject({ color: "sage" })],
    });

    expect(
      screen.queryByRole("button", { name: "Create a project" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start a chat" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Project One")).toBeInTheDocument();
    const projectIcon = container.querySelector(
      '[data-project-color-swatch="project-1"]',
    );
    expect(projectIcon).toBeInTheDocument();
    expect(projectIcon).toHaveAttribute(
      "style",
      expect.stringContaining("--color-pill-sage"),
    );
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

  it("shows a recency-sorted flat chat list when project grouping is disabled", async () => {
    const user = userEvent.setup();
    disableProjectGrouping();
    const longProjectName = "A Very Long Project Name That Needs Truncation";
    const onCreateProject = vi.fn();
    const onNewChat = vi.fn();
    const onEditProject = vi.fn();
    const onSelectSession = vi.fn();
    seedSessions(
      {
        id: "old-project-chat",
        title: "Old Project Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "general-chat",
        title: "General Chat",
        updatedAt: "2026-04-09T12:02:00.000Z",
        messageCount: 3,
      },
      {
        id: "new-project-chat",
        title: "Newest Project Chat",
        updatedAt: "2026-04-09T12:04:00.000Z",
        messageCount: 3,
        projectId: "project-2",
      },
    );

    const { container } = renderSidebar({
      onCreateProject,
      onNewChat,
      onEditProject,
      onSelectSession,
      projects: [
        mockProject({ id: "project-1", name: longProjectName }),
        mockProject({
          id: "project-2",
          name: "Project Two",
          path: "/tmp/project-2",
          order: 1,
        }),
      ],
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    expect(within(mainNavigation).queryByText("Projects")).toBeNull();
    await user.click(
      within(mainNavigation).getByRole("button", { name: "New project" }),
    );
    expect(onCreateProject).toHaveBeenCalledOnce();
    await user.click(
      within(mainNavigation).getByRole("button", { name: "New chat" }),
    );
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(
      within(mainNavigation).queryByRole("button", { name: "Show all" }),
    ).toBeNull();
    expect(screen.getByText("Newest Project Chat")).toBeInTheDocument();
    expect(screen.getByText("General Chat")).toBeInTheDocument();
    expect(screen.getByText("Old Project Chat")).toBeInTheDocument();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-chat-row]"),
    );
    expect(rows.map((row) => row.dataset.sessionId)).toEqual([
      "new-project-chat",
      "general-chat",
      "old-project-chat",
    ]);
    expect(rows.map((row) => row.dataset.sidebarChatDensity)).toEqual([
      "dense",
      "dense",
      "dense",
    ]);

    const projectIcons = rows.map((row) =>
      row.querySelector<HTMLElement>("[data-sidebar-flat-project-icon]"),
    );
    expect(projectIcons).toHaveLength(3);
    expect(
      rows[0].querySelector('[data-project-color-swatch="project-2"]'),
    ).toBeInTheDocument();
    expect(
      rows[1].querySelector("[data-project-color-swatch]"),
    ).not.toBeInTheDocument();
    expect(
      rows[2].querySelector('[data-project-color-swatch="project-1"]'),
    ).toBeInTheDocument();
    expect(screen.queryByText(longProjectName)).not.toBeInTheDocument();

    if (!projectIcons[2]) {
      throw new Error("Long-name project icon was not rendered");
    }
    await user.hover(projectIcons[2]);
    expect(await screen.findAllByText(longProjectName)).not.toHaveLength(0);

    await user.click(
      within(rows[0]).getByRole("button", { name: "Edit Project Two" }),
    );
    await waitFor(() =>
      expect(onEditProject).toHaveBeenCalledWith("project-2"),
    );
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(within(rows[1]).queryByRole("button", { name: /edit/i })).toBeNull();
  });

  it("keeps pinned flat chats above recent flat chats", () => {
    disableProjectGrouping();
    seedPinnedHomeChats("old-pinned-chat");
    seedSessions(
      {
        id: "new-unpinned-chat",
        title: "New Unpinned Chat",
        updatedAt: new Date().toISOString(),
        messageCount: 3,
      },
      {
        id: "old-pinned-chat",
        title: "Old Pinned Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
    );

    const { container } = renderSidebar();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-chat-row]"),
    );
    expect(rows.map((row) => row.dataset.sessionId)).toEqual([
      "old-pinned-chat",
      "new-unpinned-chat",
    ]);
    expect(screen.getByLabelText("Pinned chat")).toBeInTheDocument();

    const groups = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-flat-chat-group]"),
    );
    expect(groups.map((group) => group.dataset.sidebarFlatChatGroup)).toEqual([
      "pinned",
      "last-hour",
    ]);
  });

  it("skips Git branch subtitle lookups in flat chat mode", async () => {
    disableProjectGrouping();
    localStorage.setItem(SIDEBAR_GIT_BRANCH_SUBTITLE_STORAGE_KEY, "true");
    seedSessions({
      id: "branch-chat",
      title: "Branch Chat",
      subtitle: "Latest message snippet",
      workingDir: "/repo",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({ projects: [mockProject()] });

    expect(screen.getByText("Branch Chat")).toBeInTheDocument();
    expect(
      screen.queryByText("Latest message snippet"),
    ).not.toBeInTheDocument();

    await waitForAnimationFrame();

    expect(mockGetGitState).not.toHaveBeenCalled();
  });

  it("does not make stale flat project icons clickable", () => {
    const onEditProject = vi.fn();
    disableProjectGrouping();
    seedSessions({
      id: "missing-project-chat",
      title: "Missing Project Chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "missing-project",
    });

    const { container } = renderSidebar({ onEditProject });

    const row = container.querySelector<HTMLElement>(
      "[data-session-id='missing-project-chat']",
    );
    if (!row) {
      throw new Error("Missing project chat row was not rendered");
    }
    expect(
      row.querySelector("[data-sidebar-flat-project-icon]"),
    ).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Edit No project" }),
    ).toBeNull();
    expect(onEditProject).not.toHaveBeenCalled();
  });

  it("keeps flat project icons editable when the project name is empty", async () => {
    const user = userEvent.setup();
    const onEditProject = vi.fn();
    disableProjectGrouping();
    seedSessions({
      id: "unnamed-project-chat",
      title: "Unnamed Project Chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    const { container } = renderSidebar({
      onEditProject,
      projects: [mockProject({ name: "" })],
    });

    const row = container.querySelector<HTMLElement>(
      "[data-session-id='unnamed-project-chat']",
    );
    const projectIcon = row?.querySelector<HTMLButtonElement>(
      "[data-sidebar-flat-project-icon]",
    );
    if (!projectIcon) {
      throw new Error("Flat project icon was not rendered as editable");
    }

    await user.click(projectIcon);

    await waitFor(() =>
      expect(onEditProject).toHaveBeenCalledWith("project-1"),
    );
  });

  it("loads more flat chats before showing the history overflow link", async () => {
    disableProjectGrouping();
    mockHasMoreSessions = true;
    seedSessions(
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `loaded-flat-chat-${index + 1}`,
        title: `Loaded Flat Chat ${index + 1}`,
        updatedAt: `2026-04-09T12:${String(index).padStart(2, "0")}:00.000Z`,
        messageCount: 3,
      })),
    );

    renderSidebar();

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    expect(
      within(mainNavigation).queryByRole("button", { name: "Show all" }),
    ).toBeNull();
    await waitFor(() => expect(mockLoadMoreSessions).toHaveBeenCalledOnce());
  });

  it("does not retry flat chat auto-load for the same pagination cursor", async () => {
    disableProjectGrouping();
    mockHasMoreSessions = true;
    mockSessionPageCursor = "cursor-1";
    seedSessions(
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `loaded-flat-chat-${index + 1}`,
        title: `Loaded Flat Chat ${index + 1}`,
        updatedAt: `2026-04-09T12:${String(index).padStart(2, "0")}:00.000Z`,
        messageCount: 3,
      })),
    );
    const props = sidebarProps();

    const { rerender } = renderWithQueryClient(
      <NavigationPanesView {...props} />,
    );

    await waitFor(() => expect(mockLoadMoreSessions).toHaveBeenCalledOnce());

    mockIsLoadingMoreSessions = true;
    rerender(<NavigationPanesView {...props} />);
    mockIsLoadingMoreSessions = false;
    rerender(<NavigationPanesView {...props} />);

    await waitForAnimationFrame();

    expect(mockLoadMoreSessions).toHaveBeenCalledOnce();

    mockSessionPageCursor = "cursor-2";
    rerender(<NavigationPanesView {...props} />);

    await waitFor(() => expect(mockLoadMoreSessions).toHaveBeenCalledTimes(2));
  });

  it("keeps pinned project chats at the top of their project", async () => {
    const user = userEvent.setup();
    seedPinnedHomeChats("old-pinned-project-chat");
    seedSessions(
      {
        id: "new-project-chat",
        title: "New Project Chat",
        updatedAt: "2026-04-09T12:04:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "old-pinned-project-chat",
        title: "Old Pinned Project Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
    );

    const { container } = renderSidebar({
      projects: [mockProject()],
    });

    await user.click(screen.getByRole("button", { name: "Project One" }));

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-chat-row]"),
    );
    expect(rows.map((row) => row.dataset.sessionId)).toEqual([
      "old-pinned-project-chat",
      "new-project-chat",
    ]);
    expect(screen.getByLabelText("Pinned chat")).toBeInTheDocument();
  });

  it("keeps project grouping when the flat chat list experiment is disabled", async () => {
    const user = userEvent.setup();
    setExperimentEnabled(SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID, false);
    seedSessions({
      id: "project-chat",
      title: "Project Chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    const { container } = renderSidebar({
      projects: [mockProject()],
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    expect(within(mainNavigation).getByText("Projects")).toBeInTheDocument();
    expect(
      container.querySelector("[data-sidebar-flat-project-icon]"),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(screen.getByText("Project Chat")).toBeInTheDocument();
  });

  it("separates flat chats into unlabeled activity-age groups", () => {
    disableProjectGrouping();
    const now = Date.now();
    const minutesAgo = (minutes: number) =>
      new Date(now - minutes * 60 * 1000).toISOString();
    seedSessions(
      {
        id: "recent-chat",
        title: "Recent Chat",
        updatedAt: minutesAgo(30),
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "today-chat",
        title: "Today Chat",
        updatedAt: minutesAgo(3 * 60),
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "older-chat",
        title: "Older Chat",
        updatedAt: minutesAgo(30 * 60),
        messageCount: 3,
        projectId: "project-1",
      },
    );

    const { container } = renderSidebar({
      projects: [mockProject()],
    });

    const groups = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-flat-chat-group]"),
    );
    expect(groups.map((group) => group.dataset.sidebarFlatChatGroup)).toEqual([
      "last-hour",
      "last-day",
      "older",
    ]);
    expect(
      groups.map((group) =>
        Array.from(
          group.querySelectorAll<HTMLElement>("[data-sidebar-chat-row]"),
        ).map((row) => row.dataset.sessionId),
      ),
    ).toEqual([["recent-chat"], ["today-chat"], ["older-chat"]]);
    expect(groups[0]).not.toHaveClass("mt-2");
    expect(groups[1]).toHaveClass("mt-2", "pt-2");
    expect(groups[2]).toHaveClass("mt-2", "pt-2");
    expect(screen.queryByText("last-hour")).not.toBeInTheDocument();
    expect(screen.queryByText("last-day")).not.toBeInTheDocument();
    expect(screen.queryByText("older")).not.toBeInTheDocument();
  });

  it("refreshes flat chat activity-age groups while flat mode is visible", () => {
    const baseMs = Date.parse("2026-04-09T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(baseMs);
    disableProjectGrouping();
    seedSessions({
      id: "almost-hour-old-chat",
      title: "Almost Hour Old Chat",
      updatedAt: new Date(baseMs - 59 * 60 * 1000).toISOString(),
      messageCount: 3,
      projectId: "project-1",
    });

    const { container } = renderSidebar({
      projects: [mockProject()],
    });

    const getFlatGroupIds = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          "[data-sidebar-flat-chat-group]",
        ),
      ).map((group) => group.dataset.sidebarFlatChatGroup);

    expect(getFlatGroupIds()).toEqual(["last-hour"]);

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });

    expect(getFlatGroupIds()).toEqual(["last-day"]);
  });

  it("caps the flat chat list to the most recent loaded sessions", () => {
    disableProjectGrouping();
    const baseMs = Date.parse("2026-04-09T12:00:00.000Z");
    const loadedChatCount = MAX_FLAT_SIDEBAR_CHATS + 3;

    seedSessions(
      ...Array.from({ length: loadedChatCount }, (_, index) => ({
        id: `flat-chat-${index + 1}`,
        title: `Flat Chat ${index + 1}`,
        updatedAt: new Date(baseMs - index * 60 * 1000).toISOString(),
        messageCount: 3,
        projectId: "project-1",
      })),
    );

    const { container } = renderSidebar({
      projects: [mockProject()],
    });

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-chat-row]"),
    );
    expect(rows).toHaveLength(MAX_FLAT_SIDEBAR_CHATS);
    expect(rows.map((row) => row.dataset.sessionId)).toEqual(
      Array.from(
        { length: MAX_FLAT_SIDEBAR_CHATS },
        (_, index) => `flat-chat-${index + 1}`,
      ),
    );
    expect(
      screen.queryByText(`Flat Chat ${MAX_FLAT_SIDEBAR_CHATS + 1}`),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show all" }),
    ).toBeInTheDocument();
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

  it("shows the active zero-message chat in recents", () => {
    seedSessions(
      {
        id: "active-new-chat",
        title: "New chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 0,
      },
      {
        id: "abandoned-new-chat",
        title: "Abandoned chat",
        updatedAt: "2026-04-09T11:00:00.000Z",
        messageCount: 0,
      },
    );

    renderSidebar({ activeSessionId: "active-new-chat" });

    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.queryByText("Abandoned chat")).not.toBeInTheDocument();
  });

  it("shows the active zero-message chat under its project", async () => {
    seedSessions({
      id: "active-project-chat",
      title: "New chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 0,
      projectId: "project-1",
    });

    renderSidebar({
      activeSessionId: "active-project-chat",
      projects: [mockProject()],
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Project One" }),
      ).toHaveAttribute("aria-expanded", "true");
    });
    expect(screen.getByText("New chat")).toBeInTheDocument();
  });

  it("keeps a zero-message chat visible when it has a composer draft", async () => {
    seedSessions(
      {
        id: "project-one-draft",
        title: "New chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 0,
        projectId: "project-1",
      },
      {
        id: "project-two-active",
        title: "New chat",
        updatedAt: "2026-04-09T12:01:00.000Z",
        messageCount: 0,
        projectId: "project-2",
      },
    );
    mockDraftsBySession = {
      "project-one-draft": "unsent thought",
    };

    renderSidebar({
      activeSessionId: "project-two-active",
      projects: [
        mockProject(),
        mockProject({
          id: "project-2",
          path: "/tmp/project-2",
          name: "Project Two",
        }),
      ],
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Project Two" }),
      ).toHaveAttribute("aria-expanded", "true");
    });

    await userEvent.click(screen.getByRole("button", { name: "Project One" }));

    expect(screen.getAllByText("New chat")).toHaveLength(2);
  });

  it("keeps a drafted zero-message chat visible past the recents cap", () => {
    seedSessions(
      {
        id: "old-draft",
        title: "New chat",
        updatedAt: "2026-04-09T10:00:00.000Z",
        messageCount: 0,
      },
      ...Array.from({ length: 21 }, (_, index) => ({
        id: `recent-${index}`,
        title: `Recent Chat ${index}`,
        updatedAt: `2026-04-09T12:${String(index).padStart(2, "0")}:00.000Z`,
        messageCount: 3,
      })),
    );
    mockDraftsBySession = {
      "old-draft": "saved but unsent",
    };

    renderSidebar();

    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.getByText("Recent Chat 20")).toBeInTheDocument();
    expect(screen.queryByText("Recent Chat 0")).not.toBeInTheDocument();
    expect(renderedSessionIds()[0]).toBe("old-draft");
  });

  it("keeps an active zero-message chat above newer standalone chats", () => {
    seedSessions(
      {
        id: "active-new-chat",
        title: "New chat",
        updatedAt: "2026-04-09T10:00:00.000Z",
        messageCount: 0,
      },
      {
        id: "newer-chat",
        title: "Newer Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({ activeSessionId: "active-new-chat" });

    expect(renderedSessionIds()).toEqual(["active-new-chat", "newer-chat"]);
  });

  it("keeps a project draft visible past the collapsed project chat limit", async () => {
    seedSessions(
      {
        id: "old-project-draft",
        title: "New chat",
        updatedAt: "2026-04-09T10:00:00.000Z",
        messageCount: 0,
        projectId: "project-1",
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `project-recent-${index}`,
        title: `Project Recent ${index}`,
        updatedAt: `2026-04-09T12:${String(index).padStart(2, "0")}:00.000Z`,
        messageCount: 3,
        projectId: "project-1",
      })),
    );
    mockDraftsBySession = {
      "old-project-draft": "saved project thought",
    };

    renderSidebar({ projects: [mockProject()] });

    await userEvent.click(screen.getByRole("button", { name: "Project One" }));

    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.getByText("Project Recent 5")).toBeInTheDocument();
    expect(screen.queryByText("Project Recent 0")).not.toBeInTheDocument();
    expect(renderedSessionIds()[0]).toBe("old-project-draft");
  });

  it("renders an automations button in main navigation", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    renderSidebar({ onNavigate });

    await user.click(screen.getByRole("button", { name: /automations/i }));

    expect(onNavigate).toHaveBeenCalledWith("automations");
  });

  it("hides Builderbot from main navigation until the experiment is enabled", () => {
    setExperimentEnabled(BUILDERBOT_SURFACE_EXPERIMENT_ID, false);

    renderSidebar();

    expect(screen.queryByRole("button", { name: /builderbot/i })).toBeNull();
  });

  it("renders Builderbot in main navigation when the experiment is enabled", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    setExperimentEnabled(BUILDERBOT_SURFACE_EXPERIMENT_ID, true);

    renderSidebar({ onNavigate });

    await user.click(screen.getByRole("button", { name: /builderbot/i }));

    expect(onNavigate).toHaveBeenCalledWith("builderbot");
  });

  it("renders settings after session history in main navigation", () => {
    renderSidebar();

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    const labels = within(mainNavigation)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => Boolean(label));

    const sessionHistoryIndex = labels.indexOf("Session history");
    const settingsIndex = labels.indexOf("Settings");

    expect(sessionHistoryIndex).toBeGreaterThanOrEqual(0);
    expect(settingsIndex).toBe(sessionHistoryIndex + 1);
  });

  it("hides Doctor settings navigation when runtime config disables it", () => {
    setReadyRuntimeConfig({
      schemaVersion: 1,
      doctor: { enabled: false },
    });

    renderSidebar({ activeView: "settings" });

    expect(screen.queryByRole("button", { name: /doctor/i })).toBeNull();
  });

  it("moves the dev-only design system entry into settings navigation", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    designSystemExplorer.isEnabled.mockReturnValue(true);

    const { unmount } = renderSidebar();

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
        "Settings",
      ]),
    );
    expect(labels).not.toContain("Design system");
    expect(labels).not.toContain("Design system (dev only)");

    unmount();

    renderSidebar({
      activeView: "settings",
      onNavigate,
    });

    const settingsNavigation = screen.getByRole("navigation", {
      name: /settings navigation/i,
    });
    const designSystemButton = within(settingsNavigation).getByRole("button", {
      name: "Design system (dev only)",
    });

    await user.click(designSystemButton);
    expect(onNavigate).toHaveBeenCalledWith("design-system");
  });

  it("still renders the nav when collapsed so the AppShell can animate it out", () => {
    renderSidebar({ collapsed: true });

    // Visibility/clipping lives on the AppShell wrapper (width + slide
    // transition). Sidebar stays mounted so the panel can animate off-screen.
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

  it("keeps the session list stacked when detachable chats are disabled", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({ detachableSessionListEnabled: false });

    expect(
      screen.queryByTestId("sidebar-session-list-drag-handle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Projects and chats" }),
    ).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("navigation", { name: /main navigation/i }),
      ).getByText("Recovered Session"),
    ).toBeInTheDocument();
  });

  it("renders the nav and chats as separate stacked panels when detachable chats are enabled", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({ detachableSessionListEnabled: true });

    expect(screen.getByTestId("sidebar-primary-nav-panel")).toBeInTheDocument();
    expect(
      screen.getByTestId("sidebar-session-list-panel"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-root")).toHaveAttribute(
      "style",
      expect.stringContaining(
        "height: calc(100vh - var(--spacing-app-top-bar) - var(--spacing-app-panel-gutter-top) - var(--spacing-app-panel-gutter-bottom))",
      ),
    );
    expect(screen.getByTestId("sidebar-root")).not.toHaveClass(
      "transition-[width]",
    );
    expect(screen.getByTestId("sidebar-primary-nav-panel")).not.toHaveClass(
      "h-full",
    );
    expect(
      screen.getByTestId("sidebar-session-list-panel").parentElement,
    ).toHaveClass("flex-1");
    expect(
      screen
        .getByTestId("sidebar-session-list-drag-handle")
        .querySelector("svg"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("sidebar-session-list-drag-handle"),
    ).toBeEmptyDOMElement();
    expect(screen.getByTestId("sidebar-session-list-drag-handle")).toHaveClass(
      "h-2",
    );
    expect(
      screen.getByTestId("sidebar-session-list-drag-handle"),
    ).not.toHaveTextContent("Projects and chats");
    expect(
      screen.getByTestId("sidebar-pane-resize-navigationStack"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("sidebar-pane-resize-navigationStack"),
    ).toHaveAttribute("title", "Resize sidebar panels");
    expect(
      screen.queryByTestId("sidebar-pane-resize-primaryNav"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-pane-resize-chatList"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-primary-nav-width-toggle"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-primary-nav-panel")).toHaveClass(
      "hover:shadow-sidebar-panel-elevated",
    );
    expect(screen.getByTestId("sidebar-session-list-panel")).toHaveClass(
      "hover:shadow-sidebar-panel-elevated",
    );
    expect(
      within(
        screen.getByRole("navigation", { name: "Projects and chats" }),
      ).getByText("Recovered Session"),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("navigation", { name: /main navigation/i }),
      ).queryByText("Recovered Session"),
    ).not.toBeInTheDocument();
  });

  it("uses the combined stacked width rule instead of collapsing nav to icons", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      paneSizes: {
        primaryNav: SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
        chatList: 160,
      },
      sessionListDock: "stacked",
    });

    expect(screen.getByTestId("sidebar-root")).toHaveStyle({
      width: "200px",
    });
    expect(screen.getByTestId("sidebar-primary-nav-panel")).toHaveStyle({
      width: "200px",
    });
    expect(
      screen.getByTestId("sidebar-session-list-panel").parentElement,
    ).toHaveStyle({
      width: "200px",
    });
    expect(screen.getByTestId("nav-home")).not.toHaveAttribute("title");
    expect(screen.getByTestId("nav-home")).toHaveClass("gap-2");
  });

  it("applies independent widths as soon as a stacked chat pane previews side docking", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      getSessionListDragPreviewDock: () => "side",
      paneSizes: {
        primaryNav: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
        chatList: SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
      },
      sessionListDock: "stacked",
    });

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-session-list-drag-handle"),
      {
        button: 0,
        clientX: 20,
        clientY: 80,
      },
    );
    fireEvent.mouseMove(document, { clientX: 260, clientY: 86 });

    expect(
      screen.getByTestId("sidebar-session-list-drop-side"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-primary-nav-panel")).toHaveStyle({
      width: `${SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX}px`,
    });
    expect(
      screen.getByTestId("sidebar-session-list-panel").parentElement,
    ).toHaveStyle({
      width: `${SIDEBAR_CHAT_LIST_MAX_WIDTH_PX}px`,
    });

    fireEvent.mouseUp(document, { clientX: 260, clientY: 86 });
  });

  it("does not move or offer a snap target until drag movement qualifies", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      getSessionListDragPreviewDock: () => null,
      width: 200,
    });

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-session-list-drag-handle"),
      {
        button: 0,
        clientX: 20,
        clientY: 80,
      },
    );

    expect(
      screen.queryByTestId("sidebar-session-list-preview"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-session-list-drop-side"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-session-list-drop-stacked"),
    ).not.toBeInTheDocument();

    fireEvent.mouseMove(document, { clientX: 100, clientY: 86 });

    expect(
      screen.getByTestId("sidebar-session-list-preview"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-session-list-drop-side"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-session-list-drop-stacked"),
    ).not.toBeInTheDocument();

    fireEvent.mouseUp(document, { clientX: 100, clientY: 86 });
  });

  it("expands both panels to the app panel height when side docked", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      sessionListDock: "side",
      width: 200,
    });

    expect(screen.getByTestId("sidebar-root")).toHaveAttribute(
      "style",
      expect.stringContaining(
        "height: calc(100vh - var(--spacing-app-top-bar) - var(--spacing-app-panel-gutter-top) - var(--spacing-app-panel-gutter-bottom))",
      ),
    );
    expect(screen.getByTestId("sidebar-primary-nav-panel")).toHaveClass(
      "h-full",
    );
    expect(screen.getByTestId("sidebar-session-list-panel")).toHaveClass(
      "h-full",
    );
    expect(
      screen.getByTestId("sidebar-primary-nav-width-toggle"),
    ).toBeInTheDocument();
  });

  it("applies independent panel widths", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      paneSizes: {
        primaryNav: 200,
        chatList: 260,
      },
      sessionListDock: "side",
    });

    expect(screen.getByTestId("sidebar-primary-nav-panel")).toHaveStyle({
      width: "200px",
    });
    expect(
      screen.getByTestId("sidebar-session-list-panel").parentElement,
    ).toHaveStyle({
      width: "260px",
    });
  });

  it("toggles the full-height nav panel between expanded and compact widths", () => {
    const onPaneResize = vi.fn();
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    const { rerender } = renderSidebar({
      detachableSessionListEnabled: true,
      onPaneResize,
      paneSizes: {
        primaryNav: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
        chatList: 260,
      },
      sessionListDock: "side",
    });

    expect(
      within(screen.getByTestId("sidebar-primary-nav-width-toggle")).getByText(
        "Collapse",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sidebar-primary-nav-width-toggle"));

    expect(onPaneResize).toHaveBeenLastCalledWith(
      "primaryNav",
      SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
    );

    rerender(
      <NavigationPanesView
        {...sidebarProps({
          detachableSessionListEnabled: true,
          onPaneResize,
          paneSizes: {
            primaryNav: SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
            chatList: 260,
          },
          sessionListDock: "side",
        })}
      />,
    );

    expect(screen.getByTestId("sidebar-primary-nav-width-toggle")).toHaveClass(
      "justify-center",
    );
    expect(
      screen.getByTestId("sidebar-primary-nav-width-toggle"),
    ).toHaveAttribute("title", "Expand");

    fireEvent.click(screen.getByTestId("sidebar-primary-nav-width-toggle"));

    expect(onPaneResize).toHaveBeenLastCalledWith(
      "primaryNav",
      SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
    );
  });

  it("renders the constrained compact nav width as icon-only", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      paneSizes: {
        primaryNav: SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
        chatList: 260,
      },
      sessionListDock: "side",
    });

    expect(screen.getByTestId("sidebar-primary-nav-panel")).toHaveStyle({
      width: `${SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX}px`,
    });
    expect(screen.getByTestId("nav-home")).toHaveAttribute("title", "Home");
    expect(screen.getByTestId("nav-home")).toHaveClass("justify-center");
    expect(screen.getByTestId("nav-home")).not.toHaveClass("gap-2");
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("sidebar-session-list-panel").parentElement,
    ).toHaveStyle({
      width: "260px",
    });
  });

  it("emits independent resize changes from each panel rail", () => {
    const onPaneResizeBegin = vi.fn();
    const onPaneResizeEnd = vi.fn();
    const onPaneResize = vi.fn();
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      onPaneResizeBegin,
      onPaneResizeEnd,
      onPaneResize,
      paneSizes: {
        primaryNav: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
        chatList: 260,
      },
      sessionListDock: "side",
    });

    fireEvent.mouseDown(screen.getByTestId("sidebar-pane-resize-primaryNav"), {
      button: 0,
      clientX: SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
    });
    fireEvent.mouseMove(document, { clientX: 210 });
    fireEvent.mouseUp(document, { clientX: 210 });

    expect(onPaneResizeBegin).toHaveBeenCalledTimes(1);
    expect(onPaneResize).toHaveBeenLastCalledWith("primaryNav", 210);
    expect(onPaneResizeEnd).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId("sidebar-pane-resize-chatList"), {
      button: 0,
      clientX: 260,
    });
    fireEvent.mouseMove(document, { clientX: 230 });
    fireEvent.mouseUp(document, { clientX: 230 });

    expect(onPaneResizeBegin).toHaveBeenCalledTimes(2);
    expect(onPaneResize).toHaveBeenLastCalledWith("chatList", 230);
    expect(onPaneResizeEnd).toHaveBeenCalledTimes(2);
  });

  it("emits a combined resize change from the stacked sidebar rail", () => {
    const onPaneResizeBegin = vi.fn();
    const onPaneResizeEnd = vi.fn();
    const onPaneResize = vi.fn();
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      onPaneResizeBegin,
      onPaneResizeEnd,
      onPaneResize,
      paneSizes: {
        primaryNav: SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
        chatList: 160,
      },
      sessionListDock: "stacked",
    });

    expect(
      screen.queryByTestId("sidebar-pane-resize-primaryNav"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-pane-resize-chatList"),
    ).not.toBeInTheDocument();

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-pane-resize-navigationStack"),
      {
        button: 0,
        clientX: 200,
      },
    );
    fireEvent.mouseMove(document, { clientX: 240 });
    fireEvent.mouseUp(document, { clientX: 240 });

    expect(onPaneResizeBegin).toHaveBeenCalledTimes(1);
    expect(onPaneResize).toHaveBeenLastCalledWith("navigationStack", 240);
    expect(onPaneResizeEnd).toHaveBeenCalledTimes(1);
  });

  it("emits a chat list pane drag intent when dragged right", () => {
    const onSessionListDragRelease = vi.fn();
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      getSessionListDragPreviewDock: () => "side",
      onSessionListDragRelease,
      width: 200,
    });

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-session-list-drag-handle"),
      {
        button: 0,
        clientX: 20,
        clientY: 80,
      },
    );
    fireEvent.mouseMove(document, { clientX: 100, clientY: 86 });

    expect(
      screen.getByTestId("sidebar-session-list-preview"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("sidebar-session-list-drop-side"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-root")).toHaveAttribute(
      "style",
      expect.stringContaining(
        "height: calc(100vh - var(--spacing-app-top-bar) - var(--spacing-app-panel-gutter-top) - var(--spacing-app-panel-gutter-bottom))",
      ),
    );

    fireEvent.mouseUp(document, { clientX: 100, clientY: 86 });

    expect(onSessionListDragRelease).toHaveBeenCalledWith({
      paneId: "chatList",
      startClientX: 20,
      startClientY: 80,
      currentClientX: 100,
      currentClientY: 86,
      surfaceWidth: 200,
      hasSeparated: true,
    });
    expect(
      screen.queryByTestId("sidebar-session-list-preview"),
    ).not.toBeInTheDocument();
  });

  it("offers a keyboard path to dock the chat list beside navigation", () => {
    const onSessionListDragRelease = vi.fn();
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      onSessionListDragRelease,
      width: 200,
    });

    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "Move projects and chats beside navigation",
      }),
      { key: "Enter" },
    );

    expect(onSessionListDragRelease).toHaveBeenCalledWith({
      paneId: "chatList",
      startClientX: 0,
      startClientY: 0,
      currentClientX: 201,
      currentClientY: 0,
      surfaceWidth: 200,
      hasSeparated: true,
    });
  });

  it("moves the drag preview from the original panel position with the pointer delta", () => {
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      getSessionListDragPreviewDock: () => "side",
      width: 200,
    });

    vi.spyOn(
      screen.getByTestId("sidebar-session-list-panel"),
      "getBoundingClientRect",
    ).mockReturnValue({
      x: 14,
      y: 260,
      top: 260,
      bottom: 640,
      left: 14,
      right: 214,
      width: 200,
      height: 380,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-session-list-drag-handle"),
      {
        button: 0,
        clientX: 20,
        clientY: 280,
      },
    );
    fireEvent.mouseMove(document, { clientX: 90, clientY: 312 });

    const preview = screen.getByTestId("sidebar-session-list-preview");
    expect(preview.parentElement).toHaveStyle({
      left: "14px",
      top: "260px",
      width: "200px",
      height: "380px",
      transform: "translate(70px, 32px)",
    });

    fireEvent.mouseUp(document, { clientX: 90, clientY: 312 });
  });

  it("emits a chat list pane drag intent from a side-docked session list", () => {
    const onSessionListDragRelease = vi.fn();
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      sessionListDock: "side",
      getSessionListDragPreviewDock: () => "stacked",
      onSessionListDragRelease,
      width: 200,
    });

    expect(
      within(
        screen.getByRole("navigation", { name: "Projects and chats" }),
      ).getByText("Recovered Session"),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("navigation", { name: /main navigation/i }),
      ).queryByText("Recovered Session"),
    ).not.toBeInTheDocument();

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-session-list-drag-handle"),
      {
        button: 0,
        clientX: 220,
        clientY: 80,
      },
    );
    fireEvent.mouseMove(document, { clientX: 150, clientY: 86 });

    expect(
      screen.getByTestId("sidebar-session-list-drop-stacked"),
    ).toBeInTheDocument();

    fireEvent.mouseUp(document, { clientX: 150, clientY: 86 });

    expect(onSessionListDragRelease).toHaveBeenCalledWith({
      paneId: "chatList",
      startClientX: 220,
      startClientY: 80,
      currentClientX: 150,
      currentClientY: 86,
      surfaceWidth: 200,
      hasSeparated: true,
    });
  });

  it("offers a keyboard path to dock the chat list below navigation", () => {
    const onSessionListDragRelease = vi.fn();
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      detachableSessionListEnabled: true,
      sessionListDock: "side",
      onSessionListDragRelease,
      width: 200,
    });

    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "Move projects and chats below navigation",
      }),
      { key: " " },
    );

    expect(onSessionListDragRelease).toHaveBeenCalledWith({
      paneId: "chatList",
      startClientX: 0,
      startClientY: 0,
      currentClientX: -201,
      currentClientY: 0,
      surfaceWidth: 200,
      hasSeparated: true,
    });
  });

  it("keeps stacked secondary navigation scrollable", () => {
    renderSidebar({
      activeView: "settings",
      detachableSessionListEnabled: true,
      width: 200,
    });

    expect(screen.getByTestId("sidebar-primary-nav-panel")).toHaveClass(
      "max-h-full",
    );
    expect(
      screen.getByRole("navigation", { name: "Settings navigation" }),
    ).toHaveClass("overflow-y-auto");
  });

  it("scrolls externally activated chats into view", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});

    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    const { rerender } = renderSidebar({ activeView: "chat" });
    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    const row = document.querySelector('[data-session-id="session-1"]');
    expect(row).toBeInstanceOf(HTMLElement);

    mainNavigation.scrollTop = 0;
    const navRectSpy = mockRect(mainNavigation, { top: 0, bottom: 100 });
    const rowRectSpy = mockRect(row as HTMLElement, { top: 80, bottom: 90 });
    const scrollTo = attachScrollTo(mainNavigation);

    rerender(
      <NavigationPanesView
        {...sidebarProps({ activeView: "chat", activeSessionId: "session-1" })}
      />,
    );

    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: 38, behavior: "smooth" }),
    );
    expect(mainNavigation.scrollTop).toBe(38);

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    navRectSpy.mockRestore();
    rowRectSpy.mockRestore();
  });

  it("does not scroll the sidebar when the active chat came from a sidebar click", async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();

    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderWithQueryClient(
      <NavigationPanesSelectionHarness onSelectSession={onSelectSession} />,
    );
    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    const row = document.querySelector('[data-session-id="session-1"]');
    expect(row).toBeInstanceOf(HTMLElement);

    mainNavigation.scrollTop = 0;
    const navRectSpy = mockRect(mainNavigation, { top: 0, bottom: 100 });
    const rowRectSpy = mockRect(row as HTMLElement, { top: 80, bottom: 90 });
    const scrollTo = attachScrollTo(mainNavigation);

    await user.click(screen.getByRole("button", { name: "Recovered Session" }));
    await waitForAnimationFrame();

    expect(onSelectSession).toHaveBeenCalledWith("session-1");
    expect(scrollTo).not.toHaveBeenCalled();
    expect(mainNavigation.scrollTop).toBe(0);

    navRectSpy.mockRestore();
    rowRectSpy.mockRestore();
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
      screen.getByRole("dialog", { name: /archive \d+ chats/i }),
    ).toBeInTheDocument();
    expect(onArchiveChat).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^archive$/i }));

    await waitFor(() => {
      expect(onArchiveChat).toHaveBeenCalledWith("active-session");
      expect(onArchiveChat).toHaveBeenCalledWith("session-2");
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /archive \d+ chats/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps bulk archive actions disabled until archive callbacks settle", async () => {
    const user = userEvent.setup();
    const archive = createDeferredPromise<void>();
    const onArchiveChat = vi.fn(() => archive.promise);
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
    await user.click(screen.getByRole("button", { name: /^archive$/i }));

    await waitFor(() => {
      expect(onArchiveChat).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /archive \d+ chats/i }),
      ).not.toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /options for second chat/i }),
    );
    expect(
      screen.getByRole("menuitem", { name: /^archive$/i }),
    ).toHaveAttribute("data-disabled");

    await act(async () => {
      archive.resolve(undefined);
      await archive.promise;
    });

    await waitFor(() => {
      expect(
        screen.getByRole("menuitem", { name: /^archive$/i }),
      ).not.toHaveAttribute("data-disabled");
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

  it("defaults the design system inspector toggle off", () => {
    renderSidebar({ activeView: "design-system" });

    expect(
      screen.getByRole("switch", { name: "Show inspector" }),
    ).toHaveAttribute("aria-checked", "false");
  });
});
