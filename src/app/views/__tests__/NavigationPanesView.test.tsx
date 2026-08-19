import {
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
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
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { BUILDERBOT_SURFACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import { setSidebarGroupChatsByProjectEnabled } from "@/features/sidebar/lib/sidebarChatGroupingPreference";
import { SIDEBAR_GIT_BRANCH_SUBTITLE_STORAGE_KEY } from "@/features/sidebar/lib/sidebarBranchSubtitlePreference";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import { MAX_FLAT_SIDEBAR_CHATS } from "@/features/sidebar/lib/sidebarFlatChats";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "@/features/home/stores/homeWidgetStore";
import { NavigationPanesView } from "../NavigationPanesView";

const designSystemExplorer = vi.hoisted(() => ({
  isEnabled: vi.fn(() => false),
}));
const sidebarChatRowRender = vi.hoisted(() => vi.fn());

vi.mock("@/shared/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/features/providers/hooks/useAgentUpdatesAvailable", () => ({
  useAgentUpdatesAvailable: () => false,
}));

type MockSession = {
  id: string;
  title: string;
  updatedAt: string;
  lastMessageAt?: string | null;
  messageCount: number;
  projectId?: string;
  clientSessionId?: string | null;
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
let mockSessionStateById: Record<
  string,
  Partial<typeof INITIAL_SESSION_CHAT_RUNTIME>
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
    projectWorkspaces: [],
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

function setReadyRuntimeConfig(config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG) {
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
  await act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
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
  await user.click(await screen.findByRole("button", { name: "View more" }));
  await waitForAnimationFrame();
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
  setSidebarGroupChatsByProjectEnabled(false);
}

function mockSessionRuntimes() {
  return Object.fromEntries(
    Object.entries(mockSessionStateById).map(([sessionId, runtime]) => [
      sessionId,
      { ...INITIAL_SESSION_CHAT_RUNTIME, ...runtime },
    ]),
  );
}

vi.mock("@/features/sessions/ui/session-list/SidebarChatRow", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/sessions/ui/session-list/SidebarChatRow")
  >("@/features/sessions/ui/session-list/SidebarChatRow");
  return {
    ...actual,
    SidebarChatRow: (props: ComponentProps<typeof actual.SidebarChatRow>) => {
      sidebarChatRowRender(props);
      return <actual.SidebarChatRow {...props} />;
    },
  };
});

vi.mock("@/features/chat/stores/chatStore", () => ({
  useChatStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        messagesBySession: {},
        draftsBySession: mockDraftsBySession,
        nonEmptyDraftSessionIds: nonEmptyDraftSessionIds(),
        sessionStateById: mockSessionRuntimes(),
      }),
    {
      getState: () => ({
        messagesBySession: {},
        draftsBySession: mockDraftsBySession,
        nonEmptyDraftSessionIds: nonEmptyDraftSessionIds(),
        sessionStateById: mockSessionRuntimes(),
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
      hasFetchedProjects: true,
    }),
}));

vi.mock("@/features/design-system/lib/designSystemEnabled", () => ({
  isDesignSystemExplorerEnabled: () => designSystemExplorer.isEnabled(),
}));

describe("NavigationPanesView", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AUTOMATIONS", "1");
    vi.stubEnv("VITE_BUILDERBOT", "1");
    seedSessions();
    mockDraftsBySession = {};
    mockHasMoreSessions = false;
    mockIsLoadingMoreSessions = false;
    mockSessionPageCursor = null;
    mockActiveWorkspaceBySession = {};
    mockSessionStateById = {};
    mockLoadMoreSessions.mockReset();
    mockAcpSearchSessions.mockReset();
    mockAcpSearchSessions.mockResolvedValue([]);
    mockGetGitState.mockReset();
    sidebarChatRowRender.mockReset();
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
    setReadyRuntimeConfig({
      ...DEFAULT_RUNTIME_CONFIG,
      kgoose: { baseUrl: "https://kgoose.example.test" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("omits latest message snippets in chat rows by default", () => {
    seedSessions({
      id: "session-1",
      title: "Branchable chat",
      subtitle: "Latest message snippet",
      workingDir: "/repo",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar();

    expect(screen.getByText("Branchable chat")).toBeInTheDocument();
    expect(
      screen.queryByText("Latest message snippet"),
    ).not.toBeInTheDocument();
    expect(mockGetGitState).not.toHaveBeenCalled();
  });

  it("ignores the retired Git branch subtitle preference", async () => {
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
      screen.queryByText("feature/sidebar-branch"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Latest message snippet"),
    ).not.toBeInTheDocument();
    expect(mockGetGitState).not.toHaveBeenCalled();
  });

  it("omits Git branch toggles from sidebar display menus", async () => {
    const user = userEvent.setup();
    seedSessions({
      id: "project-chat",
      title: "Project Chat",
      workingDir: "/repo",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeSessionId: "project-chat",
      projects: [mockProject()],
    });

    await user.hover(screen.getByText("Projects"));
    await user.click(
      screen.getByRole("button", { name: "Project display options" }),
    );
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Show git branches" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.hover(screen.getByText("Chats"));
    await user.click(
      screen.getByRole("button", { name: "Chat display options" }),
    );
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Show git branches" }),
    ).not.toBeInTheDocument();
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
    expect(
      within(mainNavigation).queryByRole("button", { name: "Chats" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create a project" }));
    await user.click(screen.getByRole("button", { name: "Start a chat" }));

    expect(onCreateProject).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("expands Projects only for an explicit local project creation", () => {
    localStorage.setItem(
      "goose:sidebar:section-visibility",
      JSON.stringify({ pinned: true, projects: false, recents: true }),
    );
    const initialProps = sidebarProps({ projects: [mockProject()] });
    const { rerender } = renderWithQueryClient(
      <NavigationPanesView {...initialProps} />,
    );

    expect(screen.queryByRole("button", { name: "Project One" })).toBeNull();

    rerender(
      <NavigationPanesView
        {...initialProps}
        projects={[
          mockProject(),
          mockProject({ id: "project-2", name: "Project Two", order: 1 }),
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Project Two" })).toBeNull();

    rerender(
      <NavigationPanesView
        {...initialProps}
        projects={[
          mockProject(),
          mockProject({ id: "project-2", name: "Project Two", order: 1 }),
        ]}
        projectCreatedRevision={1}
      />,
    );
    expect(screen.getByRole("button", { name: "Project Two" })).toBeVisible();
  });

  it("handles project creation when the session list mounts after the signal", async () => {
    localStorage.setItem(
      "goose:sidebar:section-visibility",
      JSON.stringify({ pinned: true, projects: false, recents: true }),
    );
    const onProjectCreatedRevisionHandled = vi.fn();

    renderSidebar({
      projects: [mockProject()],
      projectCreatedRevision: 1,
      onProjectCreatedRevisionHandled,
    });

    expect(screen.getByRole("button", { name: "Project One" })).toBeVisible();
    await waitFor(() =>
      expect(onProjectCreatedRevisionHandled).toHaveBeenCalledWith(1),
    );
  });

  it("shows the projects info moment next to the header for a fresh user", async () => {
    const user = userEvent.setup();

    renderSidebar();

    const infoButton = screen.getByRole("button", { name: "About projects" });
    await user.click(infoButton);

    expect(
      screen.getByText(
        "Projects keep related chats together, and can share folders and instructions.",
      ),
    ).toBeInTheDocument();
  });

  it("hides the projects info moment when the user has projects", () => {
    renderSidebar({ projects: [mockProject()] });

    expect(
      screen.queryByRole("button", { name: "About projects" }),
    ).not.toBeInTheDocument();
  });

  it("omits the view-all-chats row from the grouped sidebar", () => {
    seedSessions(
      {
        id: "project-chat",
        title: "Project Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "standalone-chat",
        title: "Standalone Chat",
        updatedAt: "2026-04-09T11:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({ projects: [mockProject()] });

    expect(screen.getByText("Standalone Chat")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View all chats" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the view-all-chats row in the grouped sidebar when standalone chats overflow the recents cap", async () => {
    const user = userEvent.setup();
    seedSessions(
      ...Array.from({ length: MAX_FLAT_SIDEBAR_CHATS + 5 }, (_, index) => ({
        id: `standalone-chat-${index + 1}`,
        title: `Standalone Chat ${index + 1}`,
        updatedAt: `2026-04-09T12:00:${String(59 - index).padStart(2, "0")}.000Z`,
        messageCount: 3,
      })),
    );

    const onNavigate = vi.fn();
    const { container } = renderSidebar({
      onNavigate,
      projects: [mockProject()],
    });

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-chat-row]"),
    );
    expect(rows).toHaveLength(MAX_FLAT_SIDEBAR_CHATS);

    await user.click(screen.getByRole("button", { name: "View all chats" }));
    expect(onNavigate).toHaveBeenCalledWith("session-history");
  });

  it("keeps the view-all-chats row in the grouped sidebar when more sessions remain unloaded", () => {
    mockHasMoreSessions = true;
    seedSessions({
      id: "standalone-chat",
      title: "Standalone Chat",
      updatedAt: "2026-04-09T11:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({ projects: [mockProject()] });

    expect(
      screen.getByRole("button", { name: "View all chats" }),
    ).toBeInTheDocument();
  });

  it("keeps the view-all-chats row when all loaded chats belong to projects and more sessions remain", () => {
    // Grouped auto-loading stops at MAX_FLAT_SIDEBAR_CHATS * 2 chats. Seed
    // that bound split across two projects with zero standalone chats: the
    // Recents list is empty, but older sessions remain on the backend, so
    // the history route must stay visible.
    mockHasMoreSessions = true;
    seedSessions(
      ...Array.from({ length: MAX_FLAT_SIDEBAR_CHATS * 2 }, (_, index) => ({
        id: `project-chat-${index + 1}`,
        title: `Project Chat ${index + 1}`,
        updatedAt: `2026-04-09T${String(10 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
        messageCount: 3,
        projectId: index % 2 === 0 ? "project-1" : "project-2",
      })),
    );

    renderSidebar({
      projects: [
        mockProject(),
        mockProject({ id: "project-2", name: "Project Two" }),
      ],
    });

    expect(
      screen.getByRole("button", { name: "View all chats" }),
    ).toBeInTheDocument();
  });

  it("does not show a search field in the sidebar", () => {
    renderSidebar();

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Jump to a chat" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("nav-settings")).toHaveAccessibleName("Settings");
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

  it("fades the top of main navigation after scrolling below the header", async () => {
    renderSidebar();

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    Object.defineProperties(mainNavigation, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    fireEvent.scroll(mainNavigation);
    expect(mainNavigation.style.maskImage).toBe("");

    mainNavigation.scrollTop = 24;
    fireEvent.scroll(mainNavigation);
    await waitFor(() =>
      expect(mainNavigation.style.maskImage).toContain(
        "transparent 0, black 48px",
      ),
    );

    mainNavigation.scrollTop = 0;
    fireEvent.scroll(mainNavigation);
    await waitFor(() => expect(mainNavigation.style.maskImage).toBe(""));
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

    mainNavigation.scrollTop = 60;
    fireEvent.scroll(mainNavigation);
    await waitFor(() =>
      expect(mainNavigation.style.maskImage).toContain(
        "transparent 0, black 48px",
      ),
    );
  });

  it.skip("scrolls the active main nav item into view after navigating from the recents history link", async () => {
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
        name: "View all",
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
    // The disclosure row renders after the expand delay timer fires.
    expect(
      await screen.findByRole("button", { name: "Show less" }),
    ).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalledWith("projects");
  });

  it("does not link project overflow rows to session history", async () => {
    const user = userEvent.setup();
    mockHasMoreSessions = true;
    const onNavigate = vi.fn();
    seedProjectChats(6);
    renderSidebar({ onNavigate, projects: [mockProject()] });

    await user.click(screen.getByRole("button", { name: "Project One" }));
    await clickViewMore(user);

    expect(screen.getByText("Project Chat 6")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "View older chats in Session History",
      }),
    ).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalledWith("session-history");
  });

  it("caps expanded project chats without linking overflow to session history", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    seedProjectChats(21);
    renderSidebar({ onNavigate, projects: [mockProject()] });

    await user.click(screen.getByRole("button", { name: "Project One" }));
    await clickViewMore(user);

    expect(screen.getByText("Project Chat 21")).toBeInTheDocument();
    expect(screen.getByText("Project Chat 2")).toBeInTheDocument();
    expect(screen.queryByText("Project Chat 1")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "View older chats in Session History",
      }),
    ).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalledWith("session-history");
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
      within(mainNavigation).queryByRole("button", { name: "View all" }),
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
    expect(screen.queryByText(longProjectName)).not.toBeInTheDocument();

    await user.click(
      within(rows[0]).getByRole("button", {
        name: "Options for Newest Project Chat",
      }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Edit Project Two Project" }),
    );
    await waitFor(() =>
      expect(onEditProject).toHaveBeenCalledWith("project-2"),
    );
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(within(rows[1]).queryByRole("button", { name: /edit/i })).toBeNull();
  });

  it("preserves Home pin order in the global pinned section", () => {
    disableProjectGrouping();
    seedPinnedHomeChats("older-pin", "newer-pin");
    seedSessions(
      {
        id: "newer-pin",
        title: "Newer Pin",
        updatedAt: "2026-04-09T12:05:00.000Z",
        messageCount: 3,
      },
      {
        id: "older-pin",
        title: "Older Pin",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar();
    const pinnedSection = screen.getByTestId("sidebar-pinned-section");
    const rows = Array.from(
      pinnedSection.querySelectorAll<HTMLElement>("[data-sidebar-chat-row]"),
    );
    expect(rows.map((row) => row.dataset.sessionId)).toEqual([
      "older-pin",
      "newer-pin",
    ]);
  });

  it("moves pinned flat chats into the global pinned section", () => {
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
    expect(screen.getByRole("button", { name: "Unpin chat" })).toHaveAttribute(
      "tabindex",
      "-1",
    );

    const groups = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sidebar-flat-chat-group]"),
    );
    expect(groups.map((group) => group.dataset.sidebarFlatChatGroup)).toEqual([
      "last-hour",
    ]);
    expect(screen.getByTestId("sidebar-pinned-section")).toHaveTextContent(
      "Old Pinned Chat",
    );
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
    if (!row?.querySelector("[data-sidebar-flat-project-icon]")) {
      throw new Error("Flat project icon was not rendered");
    }

    await user.click(
      within(row).getByRole("button", {
        name: "Options for Unnamed Project Chat",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit Project" }));

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
      within(mainNavigation).queryByRole("button", { name: "View all" }),
    ).toBeNull();
    await waitFor(() => expect(mockLoadMoreSessions).toHaveBeenCalledOnce());
  });

  it("bounds grouped chat auto-loading when project chats dominate", async () => {
    mockHasMoreSessions = true;
    seedSessions(
      ...Array.from({ length: MAX_FLAT_SIDEBAR_CHATS * 2 }, (_, index) => ({
        id: `loaded-project-chat-${index + 1}`,
        title: `Loaded Project Chat ${index + 1}`,
        updatedAt: `2026-04-09T12:${String(index).padStart(2, "0")}:00.000Z`,
        messageCount: 3,
        projectId: "project-1",
      })),
    );

    renderSidebar({ projects: [mockProject()] });
    await waitForAnimationFrame();

    expect(mockLoadMoreSessions).not.toHaveBeenCalled();
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
  });

  it("keeps project grouping by default", async () => {
    const user = userEvent.setup();
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
    expect(groups[0]).not.toHaveClass("mt-1");
    expect(groups[1]).toHaveClass("mt-1", "pt-1");
    expect(groups[2]).toHaveClass("mt-1", "pt-1");
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

  it("caps the flat chat list to the most recent loaded sessions", async () => {
    const user = userEvent.setup();
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

    const onNavigate = vi.fn();
    const { container } = renderSidebar({
      onNavigate,
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
    const viewAll = screen.getByRole("button", { name: "View all chats" });
    await user.click(viewAll);
    expect(onNavigate).toHaveBeenCalledWith("session-history");
    await user.click(
      screen.getByRole("button", { name: "Chat display options" }),
    );
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Show chat icons" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "View session history" }),
    ).not.toBeInTheDocument();
  }, 15_000);
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
    expect(screen.getByText("Recent Chat 0")).toBeInTheDocument();
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

  it("renders settings in the sticky navigation footer", () => {
    renderSidebar();

    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });

    expect(
      within(mainNavigation).queryByRole("button", { name: "Session history" }),
    ).toBeNull();
    expect(screen.getByTestId("nav-settings")).toHaveAccessibleName("Settings");
  });

  it("hides Doctor settings navigation when runtime config disables it", () => {
    setReadyRuntimeConfig({
      ...DEFAULT_RUNTIME_CONFIG,
      doctor: { enabled: false },
    });

    renderSidebar({ activeView: "settings" });

    expect(screen.queryByRole("button", { name: /doctor/i })).toBeNull();
  });

  it("keeps the dev-only design system entry out of the navigation", () => {
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
      expect.arrayContaining(["Home", "Agents", "Skills", "Automations"]),
    );
    expect(screen.getByTestId("nav-settings")).toHaveAccessibleName("Settings");
    expect(labels).not.toContain("Design system");
    expect(labels).not.toContain("Design system (dev only)");

    unmount();

    renderSidebar({ activeView: "settings" });

    const settingsNavigation = screen.getByRole("navigation", {
      name: /settings navigation/i,
    });
    expect(
      within(settingsNavigation).queryByRole("button", {
        name: /design system/i,
      }),
    ).toBeNull();
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

    const recentsHeader = screen.getByRole("button", {
      name: "Chats",
      expanded: true,
    });
    expect(screen.getByText("Recovered Session")).toBeInTheDocument();

    await user.click(recentsHeader);
    expect(
      screen.getByText("Recovered Session").closest('[aria-hidden="true"]'),
    ).toBeInTheDocument();

    await user.click(recentsHeader);
    expect(
      screen.getByText("Recovered Session").closest('[aria-hidden="true"]'),
    ).not.toBeInTheDocument();
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
    const archive = createDeferredPromise<undefined>();
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
      expect(onArchiveChat).toHaveBeenCalledTimes(1);
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
      expect(onArchiveChat).toHaveBeenCalledTimes(2);
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

    const settingsNavigation = screen.getByRole("navigation", {
      name: /settings navigation/i,
    });
    expect(settingsNavigation).toHaveClass("px-1.5", "py-1");
    const backButton = screen.getByRole("button", { name: /^back$/i });
    expect(backButton.parentElement).toHaveClass("mt-1");
    expect(backButton).toHaveClass("h-7", "px-3");
    expect(
      within(settingsNavigation).getByRole("button", { name: /providers/i }),
    ).toHaveClass("h-7", "px-3");
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

    await user.click(screen.getByRole("button", { name: /appearance/i }));
    expect(onSettingsSectionChange).toHaveBeenCalledWith("appearance");
  });

  it("keeps the main navigation surface active on the design system view", () => {
    renderSidebar({ activeView: "design-system" });

    // The design system explorer is a full content takeover with its own
    // internal rail; the sidebar must not switch to a secondary surface.
    const mainNavigation = screen.getByRole("navigation", {
      name: /main navigation/i,
    });
    expect(mainNavigation).toBeInTheDocument();
    expect(mainNavigation.closest("[inert]")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Show inspector" }),
    ).not.toBeInTheDocument();
  });
});
