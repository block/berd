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
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { BUILDERBOT_SURFACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import { setSidebarGroupChatsByProjectEnabled } from "@/features/sidebar/lib/sidebarChatGroupingPreference";
import {
  SIDEBAR_CHAT_LIST_MAX_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
  SIDEBAR_PRIMARY_NAV_EXPANDED_WIDTH_PX,
} from "@/app/layout/panes/paneSizeRules";
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
import {
  NAV_PROTOTYPE_PANEL_GAP_PX,
  NAV_PROTOTYPE_PANEL_OVERLAP_PX,
  NavigationPanesView,
} from "../NavigationPanesView";

const designSystemExplorer = vi.hoisted(() => ({
  isEnabled: vi.fn(() => false),
}));
const sidebarChatRowRender = vi.hoisted(() => vi.fn());

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

function dispatchPointerEvent(
  target: Element | Window | Document,
  type: string,
  props: {
    pointerId?: number;
    button?: number;
    clientX: number;
    clientY: number;
  },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: props.button ?? 0,
    clientX: props.clientX,
    clientY: props.clientY,
  });
  Object.defineProperty(event, "pointerId", {
    configurable: true,
    value: props.pointerId ?? 1,
  });
  fireEvent(target, event);
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

function PrototypeNavigationHarness({
  onSettingsClick,
  onPaneResizeBegin,
  onPaneResizeEnd,
  onPrototypePrimaryHoverChange,
  onPrototypePrimaryWidthResize,
  onPrototypeSecondaryPreviewChange,
  onPrototypeSecondaryTargetChange,
  onPrototypeSecondarySelect,
  onPrototypeSecondaryWidthResize,
  prototypeChatsUnderProjects = false,
}: {
  onSettingsClick?: () => void;
  onPaneResizeBegin?: () => void;
  onPaneResizeEnd?: () => void;
  onPrototypePrimaryHoverChange?: (hovered: boolean) => void;
  onPrototypePrimaryWidthResize?: (width: number) => void;
  onPrototypeSecondaryPreviewChange?: (preview: boolean) => void;
  onPrototypeSecondaryTargetChange?: (
    target: NavigationPanesViewProps["prototypeSecondaryTarget"],
  ) => void;
  onPrototypeSecondarySelect?: () => void;
  onPrototypeSecondaryWidthResize?: (width: number) => void;
  prototypeChatsUnderProjects?: boolean;
}) {
  const [prototypeSecondaryTarget, setPrototypeSecondaryTarget] =
    useState<NavigationPanesViewProps["prototypeSecondaryTarget"]>(null);

  return (
    <NavigationPanesView
      {...sidebarProps({
        activeView: "home",
        projects: [mockProject({ name: "Project One" })],
        prototypeMode: "hybrid-push-overlay",
        prototypeChatsUnderProjects,
        prototypeSecondaryPush: true,
        prototypeSecondaryTarget,
        onSettingsClick,
        onPaneResizeBegin,
        onPaneResizeEnd,
        onPrototypePrimaryHoverChange,
        onPrototypePrimaryWidthResize,
        onPrototypeSecondaryPreviewChange,
        onPrototypeSecondarySelect,
        onPrototypeSecondaryWidthResize,
        onPrototypeSecondaryTargetChange: (target) => {
          setPrototypeSecondaryTarget(target);
          onPrototypeSecondaryTargetChange?.(target);
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
    setReadyRuntimeConfig();
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

  it("replaces the settings footer while sidebar search is active", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "Jump to a chat" }));

    expect(
      screen.getByRole("searchbox", { name: "Jump to a chat" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("nav-settings")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close chat search" }));
    expect(screen.getByTestId("nav-settings")).toHaveAccessibleName("Settings");
  });

  it("keeps Settings visible when compact sidebar search cannot expand", async () => {
    const user = userEvent.setup();
    renderSidebar({
      detachableSessionListEnabled: true,
      paneSizes: {
        primaryNav: SIDEBAR_PRIMARY_NAV_COMPACT_WIDTH_PX,
        chatList: 240,
      },
      sessionListDock: "side",
    });

    await user.click(screen.getByRole("button", { name: "Jump to a chat" }));

    expect(
      screen.queryByRole("searchbox", { name: "Jump to a chat" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("nav-settings")).toHaveAccessibleName("Settings");
  });

  it("selects a filtered chat before search collapses on blur", async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();
    seedSessions({
      id: "profile-chat",
      title: "Profile polish",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({ onSelectSession });

    await user.click(screen.getByRole("button", { name: "Jump to a chat" }));
    const search = screen.getByRole("searchbox", { name: "Jump to a chat" });
    await user.type(search, "profile");
    await user.click(screen.getByRole("button", { name: "Profile polish" }));

    expect(onSelectSession).toHaveBeenCalledWith("profile-chat");
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

  it("renders custom project image icons in the prototype project rows", () => {
    const customIcon = "data:image/png;base64,abc123";
    renderSidebar({
      projects: [mockProject({ icon: customIcon })],
      prototypeMode: "hybrid-push-overlay",
    });

    const projectRow = screen.getByRole("button", { name: "Project One" });
    const iconImage = projectRow.querySelector("img");
    if (!iconImage) {
      throw new Error(
        "Custom project icon image was not rendered in the prototype nav row",
      );
    }
    expect(iconImage).toHaveAttribute("src", customIcon);
    // The default cube glyph should not render when a custom icon is set.
    expect(
      projectRow.querySelector('[data-project-color-swatch="project-1"]'),
    ).toBeNull();
  });

  it("falls back to the default project glyph when no custom icon is set", () => {
    renderSidebar({
      projects: [mockProject({ color: "sage", icon: "" })],
      prototypeMode: "hybrid-push-overlay",
    });

    const projectRow = screen.getByRole("button", { name: "Project One" });
    const icon = projectRow.querySelector(
      '[data-project-color-swatch="project-1"]',
    );
    expect(icon).not.toBeNull();
    expect(icon).not.toHaveAttribute("style", "color: currentcolor;");
    expect(projectRow.querySelector("img")).toBeNull();
  });

  it("preserves project color for default prototype project row icons", () => {
    renderSidebar({
      projects: [mockProject({ color: "sage", icon: "tabler:rocket" })],
      prototypeMode: "hybrid-push-overlay",
    });

    const projectRow = screen.getByRole("button", { name: "Project One" });
    const icon = projectRow.querySelector(
      '[data-project-color-swatch="project-1"]',
    );
    if (!icon) {
      throw new Error("Default project icon was not rendered");
    }
    expect(icon.getAttribute("style")).toContain("--color-pill-sage");
    expect(icon.getAttribute("style")).not.toContain("currentColor");
    expect(projectRow.querySelector("img")).toBeNull();
  });

  it("applies opacity hover state classes to prototype core and project rows", () => {
    renderSidebar({
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    const homeRow = within(mainNavigation).getByRole("button", {
      name: "Home",
    });
    const projectRow = within(mainNavigation).getByRole("button", {
      name: "Project One",
    });

    expect(homeRow.className).toContain("sidebar-prototype-nav-row-hover");
    expect(projectRow.className).toContain("sidebar-prototype-nav-row-hover");
    expect(homeRow.className).toContain("pl-2");
    expect(projectRow.className).toContain("pl-2");
    expect(homeRow.className).not.toContain("pl-[10px]");
    expect(projectRow.className).not.toContain("pl-[10px]");
    expect(homeRow.className).not.toContain(
      "hover:bg-[var(--sidebar-prototype-nav-row-hover)]",
    );
    expect(projectRow.className).not.toContain(
      "hover:bg-[var(--sidebar-prototype-nav-row-hover)]",
    );
  });

  it("does not change prototype secondary navigation on top-level hover", () => {
    const onPrototypeSecondaryTargetChange = vi.fn();
    const { container } = renderSidebar({
      projects: [mockProject({ color: "sage" })],
      prototypeMode: "hybrid-push-overlay",
      onPrototypeSecondaryTargetChange,
    });

    const projectIcon = container.querySelector(
      '[data-project-color-swatch="project-1"]',
    );
    expect(projectIcon).not.toHaveAttribute("style", "color: currentcolor;");

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Project One" }));

    expect(onPrototypeSecondaryTargetChange).not.toHaveBeenCalled();
  });

  it("previews prototype project secondary navigation on click without changing the active primary item", async () => {
    const user = userEvent.setup();
    const onPrototypeSecondaryTargetChange = vi.fn();
    const onPrototypeSecondaryPreviewChange = vi.fn();
    const onPrototypeSecondarySelect = vi.fn();

    renderSidebar({
      activeView: "home",
      projects: [mockProject()],
      prototypeMode: "hybrid-push-overlay",
      onPrototypeSecondaryPreviewChange,
      onPrototypeSecondaryTargetChange,
      onPrototypeSecondarySelect,
    });

    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(onPrototypeSecondaryTargetChange).toHaveBeenCalledWith({
      kind: "project",
      projectId: "project-1",
    });
    expect(onPrototypeSecondaryPreviewChange).toHaveBeenCalledWith(true);
    expect(onPrototypeSecondarySelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("button", { name: "Project One" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("commits the project secondary panel when clicked from a blank new chat", async () => {
    const user = userEvent.setup();
    const onPrototypeSecondaryTargetChange = vi.fn();
    const onPrototypeSecondaryPreviewChange = vi.fn();
    const onPrototypeSecondarySelect = vi.fn();

    // A brand new chat has no messages and no secondary target of its own, so
    // there is no docked context to keep a project hover-preview pinned.
    renderSidebar({
      activeView: "chat",
      activeSessionId: undefined,
      projects: [mockProject()],
      prototypeMode: "hybrid-push-overlay",
      onPrototypeSecondaryPreviewChange,
      onPrototypeSecondaryTargetChange,
      onPrototypeSecondarySelect,
    });

    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(onPrototypeSecondaryTargetChange).toHaveBeenCalledWith({
      kind: "project",
      projectId: "project-1",
    });
    // The click commits (selects) so the panel stays open instead of closing
    // when the pointer leaves the primary nav.
    expect(onPrototypeSecondarySelect).toHaveBeenCalled();
    expect(onPrototypeSecondaryPreviewChange).toHaveBeenLastCalledWith(false);
  });

  it("collapses an untouched prototype secondary panel when its opener is clicked again", async () => {
    const user = userEvent.setup();
    const onPrototypeSecondaryTargetChange = vi.fn();
    const onPrototypeSecondaryPreviewChange = vi.fn();
    const onPrototypeSecondarySelect = vi.fn();

    renderWithQueryClient(
      <PrototypeNavigationHarness
        onPrototypeSecondaryPreviewChange={onPrototypeSecondaryPreviewChange}
        onPrototypeSecondarySelect={onPrototypeSecondarySelect}
        onPrototypeSecondaryTargetChange={onPrototypeSecondaryTargetChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project One" }));
    expect(
      await screen.findByRole("navigation", {
        name: "Project One project chats",
      }),
    ).toBeInTheDocument();

    onPrototypeSecondaryTargetChange.mockClear();
    onPrototypeSecondaryPreviewChange.mockClear();
    onPrototypeSecondarySelect.mockClear();

    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(onPrototypeSecondaryTargetChange).toHaveBeenCalledWith(null);
    expect(onPrototypeSecondaryPreviewChange).toHaveBeenCalledWith(false);
    expect(onPrototypeSecondarySelect).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.queryByRole("navigation", {
          name: "Project One project chats",
        }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps a touched prototype secondary panel open when its opener is clicked again", async () => {
    const user = userEvent.setup();
    const onPrototypeSecondaryTargetChange = vi.fn();

    renderWithQueryClient(
      <PrototypeNavigationHarness
        onPrototypeSecondaryTargetChange={onPrototypeSecondaryTargetChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project One" }));
    const projectNavigation = await screen.findByRole("navigation", {
      name: "Project One project chats",
    });
    await user.click(projectNavigation);

    onPrototypeSecondaryTargetChange.mockClear();

    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(onPrototypeSecondaryTargetChange).not.toHaveBeenCalledWith(null);
    expect(
      screen.getByRole("navigation", {
        name: "Project One project chats",
      }),
    ).toBeInTheDocument();
  });

  it("opens prototype settings in the secondary panel without navigating to settings", async () => {
    const user = userEvent.setup();
    const onSettingsClick = vi.fn();
    const onPrototypeSecondaryTargetChange = vi.fn();
    const onPrototypeSecondarySelect = vi.fn();

    renderWithQueryClient(
      <PrototypeNavigationHarness
        onSettingsClick={onSettingsClick}
        onPrototypeSecondarySelect={onPrototypeSecondarySelect}
        onPrototypeSecondaryTargetChange={onPrototypeSecondaryTargetChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(onPrototypeSecondaryTargetChange).toHaveBeenCalledWith({
      kind: "settings",
    });
    expect(onPrototypeSecondarySelect).toHaveBeenCalledTimes(1);
    expect(onSettingsClick).not.toHaveBeenCalled();
    const settingsNavigation = screen.getByRole("navigation", {
      name: "Settings navigation",
    });
    expect(settingsNavigation).toBeInTheDocument();
    expect(
      within(settingsNavigation).getByRole("button", { name: "General" })
        .className,
    ).toContain("sidebar-prototype-nav-row-active");
    expect(
      within(settingsNavigation).getByRole("button", {
        name: "AI providers",
      }).className,
    ).toContain("text-[var(--sidebar-prototype-nav-default-fg)]");
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    onPrototypeSecondaryTargetChange.mockClear();
    onPrototypeSecondarySelect.mockClear();

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(onPrototypeSecondaryTargetChange).toHaveBeenCalledWith(null);
    expect(onPrototypeSecondarySelect).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.queryByRole("navigation", { name: "Settings navigation" }),
      ).not.toBeInTheDocument();
    });
  });

  it("places the prototype project new chat action to the right of its menu", async () => {
    const user = userEvent.setup();

    renderSidebar({
      projects: [mockProject()],
      prototypeMode: "hybrid-push-overlay",
    });

    const projectButton = screen.getByRole("button", { name: "Project One" });
    const projectRow = projectButton.parentElement;
    if (!projectRow) throw new Error("Project row was not rendered");

    await user.hover(projectButton);

    const projectMenu = within(projectRow).getByRole("button", {
      name: "Options for Project One",
    });
    const newChat = within(projectRow).getByRole("button", {
      name: "New chat in Project One",
    });

    expect(
      projectMenu.compareDocumentPosition(newChat) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("starts a project chat from the prototype project row action", async () => {
    const user = userEvent.setup();
    const onNewChatInProject = vi.fn();
    const onPrototypeSecondaryTargetChange = vi.fn();

    renderSidebar({
      onNewChatInProject,
      onPrototypeSecondaryTargetChange,
      projects: [mockProject()],
      prototypeMode: "hybrid-push-overlay",
    });

    await user.hover(screen.getByRole("button", { name: "Project One" }));
    await user.click(
      screen.getByRole("button", { name: "New chat in Project One" }),
    );

    expect(onPrototypeSecondaryTargetChange).toHaveBeenCalledWith({
      kind: "project",
      projectId: "project-1",
    });
    expect(onNewChatInProject).toHaveBeenCalledWith("project-1", {
      reuseExistingDraft: true,
    });
  });

  it("navigates prototype top-level items on click, not hover", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    renderSidebar({
      prototypeMode: "hybrid-push-overlay",
      onNavigate,
    });

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Agents" }));
    expect(onNavigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Agents" }));

    expect(onNavigate).toHaveBeenCalledWith("agents");
  });

  it("does not show the prototype navigation announcement", () => {
    renderSidebar({ prototypeMode: "hybrid-push-overlay" });

    expect(
      screen.queryByText("Try the updated navigation"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Dismiss updated navigation announcement",
      }),
    ).not.toBeInTheDocument();
  });

  it("removes the prototype nav underlay shadow when primary nav is collapsed", () => {
    const { rerender } = renderSidebar({
      prototypeMode: "hybrid-push-overlay",
      prototypePrimaryCollapsed: true,
      prototypeSecondaryTarget: { kind: "chats" },
    });

    expect(
      screen.getByTestId("sidebar-prototype-glass-underlay"),
    ).not.toHaveClass("shadow-sidebar-panel-elevated");

    rerender(
      <NavigationPanesView
        {...sidebarProps({
          prototypeMode: "hybrid-push-overlay",
          prototypePrimaryCollapsed: false,
          prototypeSecondaryTarget: { kind: "chats" },
        })}
      />,
    );

    expect(screen.getByTestId("sidebar-prototype-glass-underlay")).toHaveClass(
      "shadow-sidebar-panel-elevated",
    );
  });

  it("anchors an overlaid prototype secondary panel to the visible primary width", () => {
    const prototypePrimaryWidth = 230;

    renderSidebar({
      prototypeMode: "hybrid-push-overlay",
      prototypePrimaryCollapsed: false,
      prototypePrimaryWidth,
      prototypePrimaryOverlaysContent: true,
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "chats" },
    });

    const expectedSecondaryOffset =
      prototypePrimaryWidth +
      NAV_PROTOTYPE_PANEL_GAP_PX -
      NAV_PROTOTYPE_PANEL_OVERLAP_PX;

    expect(
      screen.getByTestId("sidebar-prototype-secondary-overlay"),
    ).toHaveAttribute(
      "style",
      expect.stringContaining(
        `transform: translate3d(${expectedSecondaryOffset}px, 0, 0)`,
      ),
    );
  });

  it("collapses the prototype primary nav when clicking outside navigation", () => {
    const onPrototypePrimaryHoverChange = vi.fn();

    renderSidebar({
      prototypeMode: "hybrid-push-overlay",
      onPrototypePrimaryHoverChange,
    });

    fireEvent.pointerEnter(screen.getByTestId("sidebar-primary-nav-panel"));
    expect(onPrototypePrimaryHoverChange).toHaveBeenCalledWith(true);

    fireEvent.pointerDown(document.body);

    expect(onPrototypePrimaryHoverChange).toHaveBeenCalledWith(false);
  });

  it("collapses the prototype primary nav when clicking in secondary navigation", async () => {
    const user = userEvent.setup();
    const onPrototypePrimaryHoverChange = vi.fn();
    seedSessions({
      id: "session-1",
      title: "Recovered Session",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryTarget: { kind: "chats" },
      onPrototypePrimaryHoverChange,
    });

    fireEvent.pointerEnter(screen.getByTestId("sidebar-primary-nav-panel"));
    expect(onPrototypePrimaryHoverChange).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Recovered Session" }));

    expect(onPrototypePrimaryHoverChange).toHaveBeenCalledWith(false);
  });

  it("keeps primary nav state unchanged when entering secondary and collapses when leaving all nav", () => {
    const onPrototypePrimaryHoverChange = vi.fn();

    renderSidebar({
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryTarget: { kind: "chats" },
      onPrototypePrimaryHoverChange,
    });

    const primaryPanel = screen.getByTestId("sidebar-primary-nav-panel");
    const secondaryPanel = screen.getByTestId(
      "sidebar-prototype-secondary-panel",
    ).parentElement?.parentElement;

    if (!secondaryPanel) {
      throw new Error("Prototype secondary nav wrapper was not rendered");
    }

    fireEvent.pointerEnter(secondaryPanel);
    expect(onPrototypePrimaryHoverChange).not.toHaveBeenCalledWith(true);

    fireEvent.pointerEnter(primaryPanel);
    expect(onPrototypePrimaryHoverChange).toHaveBeenCalledWith(true);
    onPrototypePrimaryHoverChange.mockClear();

    fireEvent.pointerLeave(primaryPanel, { relatedTarget: secondaryPanel });
    onPrototypePrimaryHoverChange.mockClear();

    fireEvent.pointerLeave(secondaryPanel, { relatedTarget: document.body });
    expect(onPrototypePrimaryHoverChange).toHaveBeenCalledWith(false);
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

  it("emits prototype panel resize changes from the primary and secondary rails", () => {
    const onPaneResizeBegin = vi.fn();
    const onPaneResizeEnd = vi.fn();
    const onPrototypePrimaryWidthResize = vi.fn();
    const onPrototypeSecondaryWidthResize = vi.fn();

    renderSidebar({
      prototypeMode: "hybrid-push-overlay",
      prototypePrimaryWidth: 230,
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "chats" },
      prototypeSecondaryWidth: 230,
      onPaneResizeBegin,
      onPaneResizeEnd,
      onPrototypePrimaryWidthResize,
      onPrototypeSecondaryWidthResize,
    });

    const primaryResizeRail = screen.getByTestId(
      "sidebar-prototype-resize-primary",
    );
    expect(primaryResizeRail).toHaveClass("top-2", "bottom-2");
    expect(primaryResizeRail.firstElementChild).toHaveClass("h-full");

    fireEvent.mouseDown(primaryResizeRail, {
      button: 0,
      clientX: 230,
    });
    fireEvent.mouseMove(document, { clientX: 280 });
    fireEvent.mouseUp(document, { clientX: 280 });

    expect(onPrototypePrimaryWidthResize).toHaveBeenLastCalledWith(280);
    expect(onPaneResizeBegin).toHaveBeenCalledTimes(1);
    expect(onPaneResizeEnd).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-prototype-resize-secondary"),
      {
        button: 0,
        clientX: 230,
      },
    );
    fireEvent.mouseMove(document, { clientX: 300 });
    fireEvent.mouseUp(document, { clientX: 300 });

    expect(onPrototypeSecondaryWidthResize).toHaveBeenLastCalledWith(300);
    expect(onPaneResizeBegin).toHaveBeenCalledTimes(2);
    expect(onPaneResizeEnd).toHaveBeenCalledTimes(2);
  });

  it("disables prototype width transitions while resizing", () => {
    function Harness() {
      const [isResizing, setIsResizing] = useState(false);
      const [width, setWidth] = useState(230);

      return (
        <NavigationPanesView
          {...sidebarProps({
            isResizing,
            prototypeMode: "hybrid-push-overlay",
            prototypePrimaryWidth: width,
            onPaneResizeBegin: () => setIsResizing(true),
            onPaneResizeEnd: () => setIsResizing(false),
            onPrototypePrimaryWidthResize: setWidth,
          })}
        />
      );
    }

    renderWithQueryClient(<Harness />);

    const sidebarRoot = screen.getByTestId("sidebar-root");
    const primaryPanel = screen.getByTestId("sidebar-primary-nav-panel");
    const glassUnderlay = screen.getByTestId(
      "sidebar-prototype-glass-underlay",
    );

    expect(sidebarRoot).toHaveClass("transition-[width,left,transform]");
    expect(primaryPanel).toHaveClass("transition-[width,left,transform]");
    expect(glassUnderlay).toHaveClass("transition-[width,left,transform]");

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-prototype-resize-primary"),
      { button: 0, clientX: 230 },
    );
    fireEvent.mouseMove(document, { clientX: 280 });

    expect(sidebarRoot).not.toHaveClass("transition-[width,left,transform]");
    expect(primaryPanel).not.toHaveClass("transition-[width,left,transform]");
    expect(glassUnderlay).not.toHaveClass("transition-[width,left,transform]");

    fireEvent.mouseUp(document, { clientX: 280 });

    expect(sidebarRoot).toHaveClass("transition-[width,left,transform]");
    expect(primaryPanel).toHaveClass("transition-[width,left,transform]");
    expect(glassUnderlay).toHaveClass("transition-[width,left,transform]");
  });

  it("commits a prototype secondary preview before resizing it", () => {
    const onPrototypeSecondaryPreviewChange = vi.fn();
    const onPrototypeSecondarySelect = vi.fn();
    const onPrototypeSecondaryTargetChange = vi.fn();
    const onPrototypeSecondaryWidthResize = vi.fn();

    renderWithQueryClient(
      <PrototypeNavigationHarness
        onPrototypeSecondaryPreviewChange={onPrototypeSecondaryPreviewChange}
        onPrototypeSecondarySelect={onPrototypeSecondarySelect}
        onPrototypeSecondaryTargetChange={onPrototypeSecondaryTargetChange}
        onPrototypeSecondaryWidthResize={onPrototypeSecondaryWidthResize}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project One" }));
    expect(onPrototypeSecondaryPreviewChange).toHaveBeenLastCalledWith(true);

    onPrototypeSecondaryPreviewChange.mockClear();
    onPrototypeSecondarySelect.mockClear();
    onPrototypeSecondaryTargetChange.mockClear();
    vi.useFakeTimers();

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-prototype-resize-secondary"),
      {
        button: 0,
        clientX: 230,
      },
    );

    expect(onPrototypeSecondaryPreviewChange).toHaveBeenCalledWith(false);
    expect(onPrototypeSecondarySelect).toHaveBeenCalledTimes(1);

    const secondaryWrapper = screen.getByTestId(
      "sidebar-prototype-secondary-panel",
    ).parentElement?.parentElement;
    if (!secondaryWrapper) {
      throw new Error("Prototype secondary nav wrapper was not rendered");
    }

    fireEvent.pointerLeave(secondaryWrapper, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(onPrototypeSecondaryTargetChange).not.toHaveBeenCalledWith(null);
    fireEvent.mouseUp(document, { clientX: 260 });
  });

  it("keeps the prototype primary nav open while resizing it", () => {
    const onPrototypePrimaryHoverChange = vi.fn();
    const onPrototypePrimaryWidthResize = vi.fn();

    renderSidebar({
      prototypeMode: "hybrid-push-overlay",
      prototypePrimaryCollapsed: false,
      prototypePrimaryWidth: 230,
      onPrototypePrimaryHoverChange,
      onPrototypePrimaryWidthResize,
    });

    const primaryPanel = screen.getByTestId("sidebar-primary-nav-panel");

    fireEvent.pointerEnter(primaryPanel);
    expect(onPrototypePrimaryHoverChange).toHaveBeenCalledWith(true);
    onPrototypePrimaryHoverChange.mockClear();

    fireEvent.mouseDown(
      screen.getByTestId("sidebar-prototype-resize-primary"),
      {
        button: 0,
        clientX: 230,
      },
    );
    fireEvent.pointerLeave(primaryPanel, { relatedTarget: document.body });

    expect(onPrototypePrimaryHoverChange).not.toHaveBeenCalledWith(false);

    fireEvent.mouseMove(document, { clientX: 260 });
    fireEvent.mouseUp(document, { clientX: 260 });

    expect(onPrototypePrimaryWidthResize).toHaveBeenLastCalledWith(260);
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

  it("creates a prototype project chat group from the chat row actions menu", async () => {
    const user = userEvent.setup();
    const onPrototypeSecondaryPreviewChange = vi.fn();
    seedSessions({
      id: "project-seed-chat",
      title: "Project seed chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPreview: true,
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
      onPrototypeSecondaryPreviewChange,
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "Project seed chat",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", {
        name: "Options for Project seed chat",
      }),
    );
    expect(onPrototypeSecondaryPreviewChange).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-slot="dropdown-menu-separator"]'),
    ).toHaveClass("mx-2", "opacity-40");
    await user.click(screen.getByRole("menuitem", { name: "Create group" }));

    const dialog = screen.getByRole("dialog", { name: "Set group name" });
    await user.type(within(dialog).getByLabelText("Group name"), "new group");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      within(projectNavigation).getByRole("button", { name: "new group" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.queryByRole("dialog", { name: "Set group name" }),
    ).not.toBeInTheDocument();
  });

  it("nests the chat under the new group after creating it", async () => {
    const user = userEvent.setup();
    seedSessions({
      id: "project-seed-chat",
      title: "Project seed chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    function StatefulHarness() {
      const [chatGroups, setChatGroups] = useState<NonNullable<
        ProjectInfo["chatGroups"]
      > | null>(null);
      return (
        <NavigationPanesView
          {...sidebarProps({
            activeView: "home",
            onUpdateProjectChatGroups: (_projectId, next) =>
              setChatGroups(next),
            projects: [
              mockProject({
                name: "Project One",
                chatGroups: chatGroups ?? undefined,
              }),
            ],
            prototypeMode: "hybrid-push-overlay",
            prototypeSecondaryPush: true,
            prototypeSecondaryTarget: {
              kind: "project",
              projectId: "project-1",
            },
          })}
        />
      );
    }

    renderWithQueryClient(<StatefulHarness />);

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "Project seed chat",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", { name: "Options for Project seed chat" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Create group" }));

    const dialog = screen.getByRole("dialog", { name: "Set group name" });
    await user.type(within(dialog).getByLabelText("Group name"), "Launch");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    // The group renders...
    const groupRow = await within(projectNavigation).findByRole("button", {
      name: "Launch",
    });
    expect(groupRow).toHaveAttribute("aria-expanded", "true");
    expect(groupRow).toHaveClass("pl-3");

    // ...and the chat is nested under the group, NOT left in the ungrouped
    // (top-level) section.
    const chatAfterGrouping = within(projectNavigation).getByRole("button", {
      name: "Project seed chat",
    });
    expect(chatAfterGrouping).toBeInTheDocument();
    expect(chatAfterGrouping).toHaveClass("pl-9");
    expect(
      chatAfterGrouping.closest("[data-sidebar-chat-row]"),
    ).not.toHaveClass("ml-6");

    const ungroupedSection = projectNavigation.querySelector(
      '[aria-label="Ungrouped project chats"]',
    );
    expect(ungroupedSection).not.toBeNull();
    expect(ungroupedSection).not.toContainElement(chatAfterGrouping);
  });

  it("nests the chat under the new group even when the session has a client id", async () => {
    const user = userEvent.setup();
    // Session whose live id differs from the persisted-friendly id, exercising
    // the placement fallback in create-group.
    seedSessions({
      id: "server-session-id",
      clientSessionId: "client-session-id",
      title: "Client id chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    function StatefulHarness() {
      const [chatGroups, setChatGroups] = useState<NonNullable<
        ProjectInfo["chatGroups"]
      > | null>(null);
      return (
        <NavigationPanesView
          {...sidebarProps({
            activeView: "home",
            onUpdateProjectChatGroups: (_projectId, next) =>
              setChatGroups(next),
            projects: [
              mockProject({
                name: "Project One",
                chatGroups: chatGroups ?? undefined,
              }),
            ],
            prototypeMode: "hybrid-push-overlay",
            prototypeSecondaryPush: true,
            prototypeSecondaryTarget: {
              kind: "project",
              projectId: "project-1",
            },
          })}
        />
      );
    }

    renderWithQueryClient(<StatefulHarness />);

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "Client id chat",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", { name: "Options for Client id chat" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Create group" }));

    const dialog = screen.getByRole("dialog", { name: "Set group name" });
    await user.type(within(dialog).getByLabelText("Group name"), "Launch");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await within(projectNavigation).findByRole("button", { name: "Launch" });

    const chatAfterGrouping = within(projectNavigation).getByRole("button", {
      name: "Client id chat",
    });
    const ungroupedSection = projectNavigation.querySelector(
      '[aria-label="Ungrouped project chats"]',
    );
    expect(ungroupedSection).not.toContainElement(chatAfterGrouping);
    // Exactly one row — no duplicate between the group and ungrouped sections.
    expect(
      within(projectNavigation).getAllByRole("button", {
        name: "Client id chat",
      }),
    ).toHaveLength(1);
  });

  it("persists project chat groups through project metadata", async () => {
    const user = userEvent.setup();
    const onUpdateProjectChatGroups = vi.fn();
    seedSessions({
      id: "project-seed-chat",
      title: "Project seed chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "home",
      onUpdateProjectChatGroups,
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "Project seed chat",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", {
        name: "Options for Project seed chat",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Create group" }));

    const dialog = screen.getByRole("dialog", { name: "Set group name" });
    await user.type(within(dialog).getByLabelText("Group name"), "new group");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onUpdateProjectChatGroups).toHaveBeenCalledWith("project-1", {
      groups: [
        expect.objectContaining({
          name: "new group",
          chatIds: ["project-seed-chat"],
        }),
      ],
    });
  });

  it("renders persisted project chat groups from project metadata", () => {
    seedSessions({
      id: "project-seed-chat",
      title: "Project seed chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "home",
      projects: [
        mockProject({
          name: "Project One",
          chatGroups: {
            groups: [
              {
                id: "project-1:chat-group:launch",
                name: "launch",
                chatIds: ["project-seed-chat"],
              },
            ],
          },
        }),
      ],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });

    expect(
      within(projectNavigation).getByRole("button", { name: "launch" }),
    ).toBeInTheDocument();
    expect(
      within(projectNavigation).getAllByRole("button", {
        name: "Project seed chat",
      }),
    ).toHaveLength(1);
  });

  it("removes a group but keeps its chats ungrouped", async () => {
    const user = userEvent.setup();
    seedSessions(
      {
        id: "chat-a",
        title: "Chat A",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "chat-b",
        title: "Chat B",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
    );

    function StatefulHarness() {
      const [chatGroups, setChatGroups] = useState<NonNullable<
        ProjectInfo["chatGroups"]
      > | null>({
        groups: [
          {
            id: "project-1:chat-group:launch",
            name: "launch",
            chatIds: ["chat-a", "chat-b"],
          },
        ],
      });
      return (
        <NavigationPanesView
          {...sidebarProps({
            activeView: "home",
            onUpdateProjectChatGroups: (_projectId, next) =>
              setChatGroups(next),
            projects: [
              mockProject({
                name: "Project One",
                chatGroups: chatGroups ?? undefined,
              }),
            ],
            prototypeMode: "hybrid-push-overlay",
            prototypeSecondaryPush: true,
            prototypeSecondaryTarget: {
              kind: "project",
              projectId: "project-1",
            },
          })}
        />
      );
    }

    renderWithQueryClient(<StatefulHarness />);

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    await user.click(
      within(projectNavigation).getByRole("button", {
        name: "Open actions for launch",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove group" }));

    // The group is gone...
    await waitFor(() => {
      expect(
        within(projectNavigation).queryByRole("button", { name: "launch" }),
      ).not.toBeInTheDocument();
    });

    // ...but both chats survive, now in the ungrouped section.
    const ungroupedSection = projectNavigation.querySelector(
      '[aria-label="Ungrouped project chats"]',
    );
    expect(ungroupedSection).not.toBeNull();
    const chatA = within(projectNavigation).getByRole("button", {
      name: "Chat A",
    });
    const chatB = within(projectNavigation).getByRole("button", {
      name: "Chat B",
    });
    expect(ungroupedSection).toContainElement(chatA);
    expect(ungroupedSection).toContainElement(chatB);
  });

  it("keeps the chat when removing a group that was just created from it", async () => {
    const user = userEvent.setup();
    seedSessions({
      id: "seed-chat",
      title: "Seed chat",
      updatedAt: "2026-04-10T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    function StatefulHarness() {
      const [chatGroups, setChatGroups] = useState<NonNullable<
        ProjectInfo["chatGroups"]
      > | null>(null);
      return (
        <NavigationPanesView
          {...sidebarProps({
            activeView: "home",
            onUpdateProjectChatGroups: (_projectId, next) =>
              setChatGroups(next),
            projects: [
              mockProject({
                name: "Project One",
                chatGroups: chatGroups ?? undefined,
              }),
            ],
            prototypeMode: "hybrid-push-overlay",
            prototypeSecondaryPush: true,
            prototypeSecondaryTarget: {
              kind: "project",
              projectId: "project-1",
            },
          })}
        />
      );
    }

    renderWithQueryClient(<StatefulHarness />);

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });

    // Create a group from the chat (this establishes a local placement).
    await user.hover(
      within(projectNavigation).getByRole("button", { name: "Seed chat" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Options for Seed chat" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Create group" }));
    const dialog = screen.getByRole("dialog", { name: "Set group name" });
    await user.type(within(dialog).getByLabelText("Group name"), "Launch");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const groupRow = await within(projectNavigation).findByRole("button", {
      name: "Launch",
    });

    // Now remove that group.
    await user.click(
      within(projectNavigation).getByRole("button", {
        name: "Open actions for Launch",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove group" }));

    // The group disappears...
    await waitFor(() => {
      expect(
        within(projectNavigation).queryByRole("button", { name: "Launch" }),
      ).not.toBeInTheDocument();
    });
    void groupRow;

    // ...and the chat is NOT lost — it survives, ungrouped, exactly once.
    const rows = within(projectNavigation).getAllByRole("button", {
      name: "Seed chat",
    });
    expect(rows).toHaveLength(1);
    const ungroupedSection = projectNavigation.querySelector(
      '[aria-label="Ungrouped project chats"]',
    );
    expect(ungroupedSection).toContainElement(rows[0]);
  });

  it("dissolves the group in the UI when its last chat is removed", async () => {
    const user = userEvent.setup();
    seedSessions({
      id: "grouped-chat",
      title: "Grouped chat",
      updatedAt: "2026-04-10T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    // Feed chat-group mutations back into the project prop, mirroring how the
    // app persists and re-renders. Without this, a callback firing does not
    // prove the group actually leaves the sidebar.
    function StatefulHarness() {
      const [chatGroups, setChatGroups] = useState<NonNullable<
        ProjectInfo["chatGroups"]
      > | null>({
        groups: [
          {
            id: "project-1:chat-group:launch",
            name: "launch",
            chatIds: ["grouped-chat"],
          },
        ],
      });
      return (
        <NavigationPanesView
          {...sidebarProps({
            activeView: "home",
            onUpdateProjectChatGroups: (_projectId, next) =>
              setChatGroups(next),
            projects: [
              mockProject({
                name: "Project One",
                chatGroups: chatGroups ?? undefined,
              }),
            ],
            prototypeMode: "hybrid-push-overlay",
            prototypeSecondaryPush: true,
            prototypeSecondaryTarget: {
              kind: "project",
              projectId: "project-1",
            },
          })}
        />
      );
    }

    renderWithQueryClient(<StatefulHarness />);

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    expect(
      within(projectNavigation).getByRole("button", { name: "launch" }),
    ).toBeInTheDocument();

    const chatRow = within(projectNavigation).getByRole("button", {
      name: "Grouped chat",
    });
    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", { name: "Options for Grouped chat" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from group" }),
    );

    await waitFor(() => {
      expect(
        within(projectNavigation).queryByRole("button", { name: "launch" }),
      ).not.toBeInTheDocument();
    });
    expect(
      within(projectNavigation).getByRole("button", { name: "Grouped chat" }),
    ).toBeInTheDocument();
  });

  it("moves a chat into a group via Add to group and re-renders", async () => {
    const user = userEvent.setup();
    seedSessions(
      {
        id: "grouped-chat",
        title: "Grouped chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "loose-chat",
        title: "Loose chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
    );

    const updates: Array<NonNullable<ProjectInfo["chatGroups"]> | null> = [];

    function StatefulHarness() {
      const [chatGroups, setChatGroups] = useState<NonNullable<
        ProjectInfo["chatGroups"]
      > | null>({
        groups: [
          {
            id: "project-1:chat-group:launch",
            name: "launch",
            chatIds: ["grouped-chat"],
          },
        ],
      });
      return (
        <NavigationPanesView
          {...sidebarProps({
            activeView: "home",
            onUpdateProjectChatGroups: (_projectId, next) => {
              updates.push(next);
              setChatGroups(next);
            },
            projects: [
              mockProject({
                name: "Project One",
                chatGroups: chatGroups ?? undefined,
              }),
            ],
            prototypeMode: "hybrid-push-overlay",
            prototypeSecondaryPush: true,
            prototypeSecondaryTarget: {
              kind: "project",
              projectId: "project-1",
            },
          })}
        />
      );
    }

    renderWithQueryClient(<StatefulHarness />);

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const looseRow = within(projectNavigation).getByRole("button", {
      name: "Loose chat",
    });

    await user.hover(looseRow);
    await user.click(
      screen.getByRole("button", { name: "Options for Loose chat" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Add to group" }));
    // Select the group with a real mouse click, matching how users pick it.
    await user.click(await screen.findByRole("menuitem", { name: "launch" }));

    await waitFor(() => {
      expect(updates.at(-1)).toEqual({
        groups: [
          expect.objectContaining({
            id: "project-1:chat-group:launch",
            chatIds: expect.arrayContaining(["grouped-chat", "loose-chat"]),
          }),
        ],
      });
    });

    // The group must survive the add, and the selected chat must move under
    // it immediately rather than waiting for the persistence round trip.
    const groupRow = within(projectNavigation).getByRole("button", {
      name: "launch",
    });
    expect(groupRow).toBeInTheDocument();
    const movedButton = within(projectNavigation).getByRole("button", {
      name: "Loose chat",
    });
    const movedRow = movedButton.closest<HTMLElement>(
      "[data-sidebar-chat-row]",
    );
    expect(movedButton).toHaveClass("pl-9");
    expect(movedRow).not.toHaveClass("ml-6");
    expect(
      projectNavigation.querySelector('[aria-label="Ungrouped project chats"]'),
    ).not.toContainElement(movedRow);
  });

  it("drags an ungrouped chat into an existing project group", async () => {
    seedSessions(
      {
        id: "grouped-chat",
        title: "Grouped chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "loose-chat",
        title: "Loose chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
    );

    const updates: Array<NonNullable<ProjectInfo["chatGroups"]> | null> = [];

    function StatefulHarness() {
      const [chatGroups, setChatGroups] = useState<NonNullable<
        ProjectInfo["chatGroups"]
      > | null>({
        groups: [
          {
            id: "project-1:chat-group:launch",
            name: "launch",
            chatIds: ["grouped-chat"],
          },
        ],
      });
      return (
        <NavigationPanesView
          {...sidebarProps({
            activeView: "home",
            onUpdateProjectChatGroups: (_projectId, next) => {
              updates.push(next);
              setChatGroups(next);
            },
            projects: [
              mockProject({
                name: "Project One",
                chatGroups: chatGroups ?? undefined,
              }),
            ],
            prototypeMode: "hybrid-push-overlay",
            prototypeSecondaryPush: true,
            prototypeSecondaryTarget: {
              kind: "project",
              projectId: "project-1",
            },
          })}
        />
      );
    }

    renderWithQueryClient(<StatefulHarness />);

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const looseRow = within(projectNavigation)
      .getByRole("button", { name: "Loose chat" })
      .closest("[data-sidebar-chat-draggable]");
    const groupTarget = projectNavigation.querySelector(
      '[data-sidebar-session-drop-target="project-group"]' +
        '[data-project-group-id="project-1:chat-group:launch"]',
    );
    expect(looseRow).not.toBeNull();
    expect(groupTarget).not.toBeNull();
    mockRect(groupTarget as Element, { top: 100, bottom: 132 });

    dispatchPointerEvent(looseRow as Element, "pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientX: 20,
      clientY: 116,
    });
    expect(groupTarget).toHaveClass("bg-sidebar-accent");
    dispatchPointerEvent(window, "pointerup", {
      pointerId: 1,
      clientX: 20,
      clientY: 116,
    });

    await waitFor(() => {
      expect(updates.at(-1)).toEqual({
        groups: [
          expect.objectContaining({
            id: "project-1:chat-group:launch",
            chatIds: ["grouped-chat", "loose-chat"],
          }),
        ],
      });
    });
    const movedButton = within(projectNavigation).getByRole("button", {
      name: "Loose chat",
    });
    expect(movedButton).toHaveClass("pl-9");
    expect(
      projectNavigation.querySelector('[aria-label="Ungrouped project chats"]'),
    ).not.toContainElement(movedButton);
  });

  it("does not accept dragging a chat onto its current group", () => {
    const onUpdateProjectChatGroups = vi.fn();
    seedSessions({
      id: "grouped-chat",
      title: "Grouped chat",
      updatedAt: "2026-04-10T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "home",
      onUpdateProjectChatGroups,
      projects: [
        mockProject({
          name: "Project One",
          chatGroups: {
            groups: [
              {
                id: "project-1:chat-group:launch",
                name: "launch",
                chatIds: ["grouped-chat"],
              },
            ],
          },
        }),
      ],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: {
        kind: "project",
        projectId: "project-1",
      },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation)
      .getByRole("button", { name: "Grouped chat" })
      .closest("[data-sidebar-chat-draggable]");
    const groupTarget = projectNavigation.querySelector(
      '[data-sidebar-session-drop-target="project-group"]',
    );
    expect(chatRow).not.toBeNull();
    expect(groupTarget).not.toBeNull();
    mockRect(groupTarget as Element, { top: 100, bottom: 132 });

    dispatchPointerEvent(chatRow as Element, "pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientX: 20,
      clientY: 116,
    });
    dispatchPointerEvent(window, "pointerup", {
      pointerId: 1,
      clientX: 20,
      clientY: 116,
    });

    expect(onUpdateProjectChatGroups).not.toHaveBeenCalled();
    expect(groupTarget).not.toHaveClass("bg-sidebar-accent");
  });

  it("rolls back Add to group when persistence fails", async () => {
    const user = userEvent.setup();
    let rejectPersist!: (reason?: unknown) => void;
    const persistPromise = new Promise<void>((_resolve, reject) => {
      rejectPersist = reject;
    });
    seedSessions(
      {
        id: "grouped-chat",
        title: "Grouped chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "loose-chat",
        title: "Loose chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
    );

    renderSidebar({
      activeView: "home",
      onUpdateProjectChatGroups: vi.fn(() => persistPromise),
      projects: [
        mockProject({
          name: "Project One",
          chatGroups: {
            groups: [
              {
                id: "project-1:chat-group:launch",
                name: "launch",
                chatIds: ["grouped-chat"],
              },
            ],
          },
        }),
      ],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: {
        kind: "project",
        projectId: "project-1",
      },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const looseButton = within(projectNavigation).getByRole("button", {
      name: "Loose chat",
    });
    await user.hover(looseButton);
    await user.click(
      screen.getByRole("button", { name: "Options for Loose chat" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Add to group" }));
    await user.click(await screen.findByRole("menuitem", { name: "launch" }));

    await waitFor(() => {
      expect(
        within(projectNavigation).getByRole("button", { name: "Loose chat" }),
      ).toHaveClass("pl-9");
    });
    rejectPersist(new Error("save failed"));

    await waitFor(() => {
      expect(
        within(projectNavigation).getByRole("button", { name: "Loose chat" }),
      ).toHaveClass("pl-8");
    });
    expect(
      projectNavigation.querySelector('[aria-label="Ungrouped project chats"]'),
    ).toContainElement(
      within(projectNavigation)
        .getByRole("button", { name: "Loose chat" })
        .closest("[data-sidebar-chat-row]"),
    );
  });

  it("lets persisted metadata replace a successful optimistic placement", async () => {
    const user = userEvent.setup();
    seedSessions(
      {
        id: "grouped-chat",
        title: "Grouped chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "loose-chat",
        title: "Loose chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
    );
    const initialGroups: NonNullable<ProjectInfo["chatGroups"]> = {
      groups: [
        {
          id: "project-1:chat-group:launch",
          name: "launch",
          chatIds: ["grouped-chat"],
        },
      ],
    };

    function StatefulHarness() {
      const [chatGroups, setChatGroups] = useState(initialGroups);
      return (
        <>
          <button type="button" onClick={() => setChatGroups(initialGroups)}>
            Restore server groups
          </button>
          <NavigationPanesView
            {...sidebarProps({
              activeView: "home",
              onUpdateProjectChatGroups: (_projectId, next) => {
                setChatGroups(next ?? { groups: [] });
              },
              projects: [mockProject({ name: "Project One", chatGroups })],
              prototypeMode: "hybrid-push-overlay",
              prototypeSecondaryPush: true,
              prototypeSecondaryTarget: {
                kind: "project",
                projectId: "project-1",
              },
            })}
          />
        </>
      );
    }

    renderWithQueryClient(<StatefulHarness />);
    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const looseButton = within(projectNavigation).getByRole("button", {
      name: "Loose chat",
    });
    await user.hover(looseButton);
    await user.click(
      screen.getByRole("button", { name: "Options for Loose chat" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Add to group" }));
    await user.click(await screen.findByRole("menuitem", { name: "launch" }));

    await waitFor(() => {
      expect(
        within(projectNavigation).getByRole("button", { name: "Loose chat" }),
      ).toHaveClass("pl-9");
    });
    await user.click(
      screen.getByRole("button", { name: "Restore server groups" }),
    );
    await waitFor(() => {
      expect(
        within(projectNavigation).getByRole("button", { name: "Loose chat" }),
      ).toHaveClass("pl-8");
    });
  });

  it("offers a single Add to group entry that expands into the group list", async () => {
    const user = userEvent.setup();
    seedSessions(
      {
        id: "grouped-chat",
        title: "Grouped chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "loose-chat",
        title: "Loose chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
    );

    renderSidebar({
      activeView: "home",
      onUpdateProjectChatGroups: vi.fn(),
      projects: [
        mockProject({
          name: "Project One",
          chatGroups: {
            groups: [
              {
                id: "project-1:chat-group:launch",
                name: "launch",
                chatIds: ["grouped-chat"],
              },
            ],
          },
        }),
      ],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const looseRow = within(projectNavigation).getByRole("button", {
      name: "Loose chat",
    });

    await user.hover(looseRow);
    await user.click(
      screen.getByRole("button", { name: "Options for Loose chat" }),
    );

    // A single "Add to group" entry (not one item per group) that opens a
    // submenu listing the groups.
    const addToGroup = screen.getByRole("menuitem", { name: "Add to group" });
    expect(
      screen.queryByRole("menuitem", { name: "Add to launch" }),
    ).not.toBeInTheDocument();

    // Hovering must NOT open the submenu — it only opens on an explicit click.
    await user.hover(addToGroup);
    expect(
      screen.queryByRole("menuitem", { name: "launch" }),
    ).not.toBeInTheDocument();

    await user.click(addToGroup);
    expect(
      await screen.findByRole("menuitem", { name: "launch" }),
    ).toBeInTheDocument();
  });

  it("dissolves a group when its last chat is removed", async () => {
    const user = userEvent.setup();
    const onUpdateProjectChatGroups = vi.fn();
    seedSessions({
      id: "project-seed-chat",
      title: "Project seed chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "home",
      onUpdateProjectChatGroups,
      projects: [
        mockProject({
          name: "Project One",
          chatGroups: {
            groups: [
              {
                id: "project-1:chat-group:launch",
                name: "launch",
                chatIds: ["project-seed-chat"],
              },
            ],
          },
        }),
      ],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "Project seed chat",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", {
        name: "Options for Project seed chat",
      }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from group" }),
    );

    // The group had a single chat, so removing it clears the group entirely
    // (null when no groups remain).
    expect(onUpdateProjectChatGroups).toHaveBeenCalledWith("project-1", null);
  });

  it("starts a real project chat when clicking the empty project placeholder", async () => {
    const user = userEvent.setup();
    const onNewChatInProject = vi.fn();
    const onSelectSession = vi.fn();

    renderSidebar({
      activeView: "home",
      onNewChatInProject,
      onSelectSession,
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const newChatAction = within(projectNavigation).getByRole("button", {
      name: "Start new chat in Project One",
    });
    expect(newChatAction).toHaveAttribute("data-sidebar-drag-ignore");
    expect(
      within(projectNavigation).getByTestId(
        "prototype-project-secondary-header",
      ),
    ).toContainElement(newChatAction);
    await user.click(newChatAction);

    expect(onNewChatInProject).toHaveBeenCalledTimes(1);
    expect(onNewChatInProject).toHaveBeenCalledWith("project-1", {
      reuseExistingDraft: true,
    });
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("does not show row actions on the empty project new chat placeholder", async () => {
    const user = userEvent.setup();

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    await user.hover(
      within(projectNavigation).getByRole("button", {
        name: "Start new chat in Project One",
      }),
    );

    expect(
      screen.queryByRole("button", { name: "Open actions for New chat" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the real project draft visible instead of adding fake placeholder chats", async () => {
    const user = userEvent.setup();
    const onNewChatInProject = vi.fn();
    const onSelectSession = vi.fn();

    seedSessions({
      id: "project-draft",
      title: "New chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 0,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "chat",
      onNewChatInProject,
      onSelectSession,
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    expect(
      within(projectNavigation).getByTestId("prototype-project-new-chat-icon"),
    ).toBeInTheDocument();

    const draftRow = within(projectNavigation).getByRole("button", {
      name: "New chat",
    });
    expect(within(draftRow).getByText("New chat")).toHaveClass(
      "text-muted-foreground",
    );
    await user.click(draftRow);

    expect(onSelectSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).toHaveBeenCalledWith("project-draft", {
      preservePrototypeSecondary: true,
    });
    expect(onNewChatInProject).not.toHaveBeenCalled();
  });

  it("does not add a top-level placeholder when adding a group-level draft chat", async () => {
    const user = userEvent.setup();
    const createdSession: MockSession = {
      id: "group-draft",
      title: "New chat",
      updatedAt: "2026-04-09T12:01:00.000Z",
      messageCount: 0,
      projectId: "project-1",
    };
    const onNewChatInProject = vi.fn(async () => {
      seedSessions(...mockSessions, createdSession);
      return createdSession as unknown as ChatSession;
    });

    seedSessions({
      id: "project-seed-chat",
      title: "Project seed chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "chat",
      onNewChatInProject,
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "Project seed chat",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", {
        name: "Options for Project seed chat",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Create group" }));

    const dialog = screen.getByRole("dialog", { name: "Set group name" });
    await user.type(within(dialog).getByLabelText("Group name"), "launch");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const groupRow = within(projectNavigation).getByRole("button", {
      name: "launch",
    });
    await user.hover(groupRow);
    await user.click(screen.getByRole("button", { name: "New chat in group" }));

    expect(onNewChatInProject).toHaveBeenCalledWith("project-1", {
      reuseExistingDraft: false,
    });
    expect(
      await within(projectNavigation).findAllByRole("button", {
        name: "New chat",
      }),
    ).toHaveLength(1);
    expect(
      within(projectNavigation).getByRole("button", {
        name: "Start new chat in Project One",
      }),
    ).toBeInTheDocument();
    expect(
      within(projectNavigation).queryByTestId(
        "prototype-project-new-chat-icon",
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps the new chat action in the project secondary header", () => {
    const onNewChatInProject = vi.fn();

    seedSessions({
      id: "project-titled-chat",
      title: "Draft launch plan",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 2,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "chat",
      onNewChatInProject,
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });

    expect(
      within(projectNavigation).getByRole("button", {
        name: "Draft launch plan",
      }),
    ).toBeInTheDocument();
    const newChatAction = within(projectNavigation).getByRole("button", {
      name: "Start new chat in Project One",
    });
    expect(
      within(projectNavigation).getByTestId(
        "prototype-project-secondary-header",
      ),
    ).toContainElement(newChatAction);
    expect(
      projectNavigation.querySelector(
        'button[aria-label="Start new chat in Project One"] ~ [data-sidebar-chat-row]',
      ),
    ).not.toBeInTheDocument();
    expect(onNewChatInProject).not.toHaveBeenCalled();
  });

  it("hides an inactive project draft when the project already has saved chats", () => {
    seedSessions(
      {
        id: "project-draft",
        title: "New chat",
        updatedAt: "2026-04-09T12:01:00.000Z",
        messageCount: 0,
        projectId: "project-1",
      },
      {
        id: "project-titled-chat",
        title: "Draft launch plan",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 2,
        projectId: "project-1",
      },
    );

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });

    expect(
      within(projectNavigation).queryByRole("button", { name: "New chat" }),
    ).not.toBeInTheDocument();
    expect(
      within(projectNavigation).getByRole("button", {
        name: "Start new chat in Project One",
      }),
    ).toBeInTheDocument();
  });

  it("deduplicates multiple unsent project draft rows", () => {
    seedSessions(
      {
        id: "project-draft-1",
        title: "New chat",
        updatedAt: "2026-04-09T12:01:00.000Z",
        messageCount: 0,
        projectId: "project-1",
      },
      {
        id: "project-draft-2",
        title: "New chat",
        updatedAt: "2026-04-09T12:02:00.000Z",
        messageCount: 0,
        projectId: "project-1",
      },
    );

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });

    expect(
      within(projectNavigation).getAllByRole("button", { name: "New chat" }),
    ).toHaveLength(1);
    expect(
      within(projectNavigation).getByRole("button", {
        name: "Start new chat in Project One",
      }),
    ).toBeInTheDocument();
    expect(
      within(projectNavigation).getByTestId("prototype-project-new-chat-icon"),
    ).toBeInTheDocument();
  });

  it("replaces the project placeholder row with a real draft when composing from a project row", async () => {
    const user = userEvent.setup();
    const createdSession: MockSession = {
      id: "project-draft",
      title: "New chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 0,
      projectId: "project-1",
    };
    const onNewChatInProject = vi.fn(async () => {
      seedSessions(...mockSessions, createdSession);
      return createdSession as unknown as ChatSession;
    });

    const renderProps = {
      activeView: "chat",
      onNewChatInProject,
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    } satisfies Partial<NavigationPanesViewProps>;
    const { rerender } = renderSidebar(renderProps);

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });

    expect(
      within(projectNavigation).getByTestId(
        "prototype-project-secondary-header",
      ),
    ).toContainElement(
      within(projectNavigation).getByRole("button", {
        name: "Start new chat in Project One",
      }),
    );

    await user.hover(screen.getByRole("button", { name: "Project One" }));
    await user.click(
      screen.getByRole("button", { name: "New chat in Project One" }),
    );

    await waitFor(() => {
      expect(onNewChatInProject).toHaveBeenCalledWith("project-1", {
        reuseExistingDraft: true,
      });
    });
    rerender(<NavigationPanesView {...sidebarProps(renderProps)} />);

    expect(
      await within(projectNavigation).findAllByRole("button", {
        name: "New chat",
      }),
    ).toHaveLength(1);
    expect(
      within(projectNavigation).getByRole("button", {
        name: "Start new chat in Project One",
      }),
    ).toBeInTheDocument();
    expect(
      within(projectNavigation).getByTestId("prototype-project-new-chat-icon"),
    ).toBeInTheDocument();
  });

  it("switches the prototype chats secondary panel between latest, week, unread, and archived", async () => {
    const user = userEvent.setup();
    const onPrototypeCycleRowsChange = vi.fn();
    const now = new Date();
    const currentWeekStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const day = currentWeekStart.getDay();
    currentWeekStart.setDate(
      currentWeekStart.getDate() + (day === 0 ? -6 : 1 - day),
    );
    const currentWeekLabel = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(currentWeekStart);

    mockSessionStateById = {
      "unread-chat": { hasUnread: true },
    };
    seedPinnedHomeChats("older-chat");
    seedSessions(
      {
        id: "latest-chat",
        title: "Latest Chat",
        updatedAt: now.toISOString(),
        messageCount: 3,
      },
      {
        id: "unread-chat",
        title: "Unread Chat",
        updatedAt: now.toISOString(),
        messageCount: 3,
      },
      {
        id: "older-chat",
        title: "Older Chat",
        updatedAt: "2026-01-08T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "archived-chat",
        title: "Archived Chat",
        updatedAt: now.toISOString(),
        archivedAt: now.toISOString(),
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "home",
      onPrototypeCycleRowsChange,
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "chats" },
    });

    const chatsNavigation = screen.getByRole("navigation", { name: "Chats" });
    expect(
      within(chatsNavigation).getByRole("button", { name: "Latest Chat" }),
    ).toBeInTheDocument();
    expect(
      within(chatsNavigation).queryByRole("button", { name: "Archived Chat" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(chatsNavigation).getByRole("button", {
        name: "Filter chats: Latest",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Week" }));
    expect(
      screen.queryByRole("menuitem", { name: "Week" }),
    ).not.toBeInTheDocument();

    expect(
      within(chatsNavigation).getByText(currentWeekLabel),
    ).toBeInTheDocument();
    expect(
      within(chatsNavigation).getByRole("button", { name: "Latest Chat" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const latestRows = onPrototypeCycleRowsChange.mock.calls.at(-1)?.[1];
      expect(latestRows?.map((row: { id: string }) => row.id)).toEqual([
        "latest-chat",
        "unread-chat",
        "older-chat",
      ]);
    });

    await user.click(
      within(chatsNavigation).getByRole("button", {
        name: "Filter chats: Week",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Unread" }));

    expect(
      within(chatsNavigation).getByRole("button", { name: "Unread Chat" }),
    ).toBeInTheDocument();
    expect(
      within(chatsNavigation).queryByRole("button", { name: "Latest Chat" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(chatsNavigation).getByRole("button", {
        name: "Filter chats: Unread",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Archived" }));

    expect(
      within(chatsNavigation).getByRole("button", { name: "Archived Chat" }),
    ).toBeInTheDocument();
    expect(
      within(chatsNavigation).queryByRole("button", { name: "Unread Chat" }),
    ).not.toBeInTheDocument();
  });

  it("toggles chat icons in the prototype chats filter menu", async () => {
    const user = userEvent.setup();

    seedSessions(
      {
        id: "project-chat",
        title: "Project Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "home-chat",
        title: "Home Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `loose-chat-${index + 1}`,
        title: `Loose Chat ${index + 1}`,
        updatedAt: `2026-04-${String(8 - index).padStart(2, "0")}T12:00:00.000Z`,
        messageCount: 3,
      })),
    );

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ color: "sage" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "chats" },
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    const chatsNavigation = screen.getByRole("navigation", { name: "Chats" });
    expect(
      within(chatsNavigation).queryByRole("button", { name: "Project Chat" }),
    ).not.toBeInTheDocument();
    expect(
      within(mainNavigation).queryByRole("button", { name: "Project Chat" }),
    ).not.toBeInTheDocument();
    expect(
      within(chatsNavigation).queryByRole("button", { name: "Home Chat" }),
    ).not.toBeInTheDocument();
    expect(
      within(chatsNavigation).getByRole("button", { name: "Loose Chat 5" }),
    ).toBeInTheDocument();
    expect(
      within(chatsNavigation).getAllByTestId("prototype-session-row-icon"),
    ).toHaveLength(3);
    expect(
      within(mainNavigation).getAllByTestId("prototype-primary-chat-row-icon"),
    ).toHaveLength(5);
    const secondaryChatWithIcon = chatsNavigation.querySelector<HTMLElement>(
      '[data-session-id="loose-chat-5"]',
    );
    if (!secondaryChatWithIcon) {
      throw new Error("Prototype secondary chat row was not rendered");
    }
    expect(
      within(secondaryChatWithIcon).getByRole("button", { name: "Pin chat" }),
    ).toBeInTheDocument();

    await user.click(
      within(chatsNavigation).getByRole("button", {
        name: "Filter chats: Latest",
      }),
    );
    expect(screen.getByText("Sort by")).toBeInTheDocument();
    expect(screen.getByText("View")).toBeInTheDocument();
    const chatIconsItem = screen.getByRole("menuitem", { name: "Chat icons" });
    expect(chatIconsItem).toHaveStyle({
      fontSize: "14px",
      lineHeight: "18px",
    });
    expect(chatIconsItem.className).toContain("focus:!bg-transparent");
    await user.click(chatIconsItem);

    const rowWithoutChatIcon = chatsNavigation.querySelector<HTMLElement>(
      '[data-session-id="loose-chat-5"]',
    );
    if (!rowWithoutChatIcon) {
      throw new Error("Prototype secondary chat row was not rendered");
    }
    expect(
      within(chatsNavigation).queryAllByTestId("prototype-session-row-icon"),
    ).toHaveLength(0);
    expect(
      within(mainNavigation).queryAllByTestId(
        "prototype-primary-chat-row-icon",
      ),
    ).toHaveLength(0);
    expect(
      within(rowWithoutChatIcon).queryByRole("button", { name: "Pin chat" }),
    ).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Chat icons" })).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: "Chat icons" }));

    expect(screen.getByRole("menuitem", { name: "Chat icons" })).toBeVisible();
    expect(
      within(chatsNavigation).getAllByTestId("prototype-session-row-icon"),
    ).toHaveLength(3);
    expect(
      within(mainNavigation).getAllByTestId("prototype-primary-chat-row-icon"),
    ).toHaveLength(5);
    expect(
      chatsNavigation.querySelector('[data-session-id="loose-chat-5"]'),
    ).toBeInTheDocument();
  });

  it("shows editable project icons on mixed prototype chat rows", async () => {
    const user = userEvent.setup();
    const onEditProject = vi.fn();
    const onSelectSession = vi.fn();

    seedSessions(
      {
        id: "project-chat",
        title: "Project Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "home-chat",
        title: "Home Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "home",
      onEditProject,
      onSelectSession,
      projects: [mockProject({ color: "sage" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "chats" },
    });

    const chatsNavigation = screen.getByRole("navigation", { name: "Chats" });
    const projectChatRow = chatsNavigation.querySelector(
      '[data-session-id="project-chat"]',
    );
    if (!(projectChatRow instanceof HTMLElement)) {
      throw new Error("Project chat row was not rendered");
    }
    const projectIcon = projectChatRow.querySelector(
      '[data-project-color-swatch="project-1"]',
    );
    if (!projectIcon) {
      throw new Error("Project chat row did not render the project icon");
    }
    expect(projectIcon.getAttribute("style")).toContain("--color-pill-sage");
    await user.click(
      within(projectChatRow).getByRole("button", {
        name: "Options for Project Chat",
      }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Edit Project One Project" }),
    );
    await waitFor(() =>
      expect(onEditProject).toHaveBeenCalledWith("project-1"),
    );
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(
      within(chatsNavigation).getByRole("button", { name: "Home Chat" }),
    ).toBeInTheDocument();
  });

  it("toggles activity timestamps from the prototype chats filter menu", async () => {
    const user = userEvent.setup();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();

    seedSessions(
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `timestamped-chat-${index + 1}`,
        title: `Timestamped Chat ${index + 1}`,
        lastMessageAt: fiveMinutesAgo,
        updatedAt: `2026-04-10T11:${String(55 - index).padStart(
          2,
          "0",
        )}:00.000Z`,
        messageCount: 3,
      })),
    );

    renderSidebar({
      activeView: "home",
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "chats" },
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    const primaryChatRow = mainNavigation.querySelector(
      '[data-session-id="timestamped-chat-1"]',
    );
    expect(primaryChatRow).toBeInTheDocument();
    expect(
      primaryChatRow?.querySelector("[data-sidebar-chat-timestamp]"),
    ).toHaveTextContent("5m");

    const chatsNavigation = screen.getByRole("navigation", { name: "Chats" });
    const secondaryChatRow = chatsNavigation.querySelector(
      '[data-session-id="timestamped-chat-5"]',
    );
    expect(secondaryChatRow).toBeInTheDocument();
    expect(
      secondaryChatRow?.querySelector("[data-sidebar-chat-timestamp]"),
    ).toHaveTextContent("5m");

    await user.click(
      within(chatsNavigation).getByRole("button", {
        name: "Filter chats: Latest",
      }),
    );
    const timestampsItem = screen.getByRole("menuitem", {
      name: "Timestamps",
    });
    expect(timestampsItem).toBeVisible();

    await user.click(timestampsItem);

    expect(screen.getByRole("menuitem", { name: "Timestamps" })).toBeVisible();
    expect(
      primaryChatRow?.querySelector("[data-sidebar-chat-timestamp]"),
    ).not.toBeInTheDocument();
    expect(
      secondaryChatRow?.querySelector("[data-sidebar-chat-timestamp]"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Timestamps" }));

    expect(
      primaryChatRow?.querySelector("[data-sidebar-chat-timestamp]"),
    ).toHaveTextContent("5m");
    expect(
      secondaryChatRow?.querySelector("[data-sidebar-chat-timestamp]"),
    ).toHaveTextContent("5m");
  });

  it("keeps pinned prototype primary chats above newer loose chats", () => {
    seedPinnedHomeChats("old-pinned-chat");
    seedSessions(
      {
        id: "new-unpinned-chat",
        title: "New Unpinned Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "old-pinned-chat",
        title: "Old Pinned Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "home",
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
      prototypeSecondaryPush: true,
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    expect(
      Array.from(mainNavigation.querySelectorAll("[data-session-id]")).map(
        (element) => element.getAttribute("data-session-id"),
      ),
    ).toEqual(["old-pinned-chat", "new-unpinned-chat"]);
    expect(
      within(mainNavigation).getByRole("button", { name: "Unpin chat" }),
    ).toBeVisible();
  });

  it("keeps pinned prototype secondary chats above newer loose chats", () => {
    seedPinnedHomeChats("old-pinned-chat");
    seedSessions(
      {
        id: "new-unpinned-chat",
        title: "New Unpinned Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "old-pinned-chat",
        title: "Old Pinned Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "home",
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "chats" },
    });

    const chatsNavigation = screen.getByRole("navigation", { name: "Chats" });
    expect(
      Array.from(chatsNavigation.querySelectorAll("[data-session-id]")).map(
        (element) => element.getAttribute("data-session-id"),
      ),
    ).toEqual(["old-pinned-chat", "new-unpinned-chat"]);
    expect(
      within(chatsNavigation).getByRole("button", { name: "Unpin chat" }),
    ).toBeVisible();
  });

  it("does not rerender prototype sidebar rows for subtitle-only session updates", () => {
    seedSessions(
      {
        id: "primary-chat",
        title: "Primary Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "project-chat",
        title: "Project Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
    );
    const props = sidebarProps({
      activeView: "home",
      projects: [mockProject()],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: {
        kind: "project",
        projectId: "project-1",
      },
    });

    const { rerender } = renderWithQueryClient(
      <NavigationPanesView {...props} />,
    );
    sidebarChatRowRender.mockClear();

    seedSessions(
      {
        id: "primary-chat",
        title: "Primary Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        subtitle: "New primary metadata",
      },
      {
        id: "project-chat",
        title: "Project Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
        subtitle: "New project metadata",
      },
    );
    rerender(<NavigationPanesView {...props} />);

    expect(sidebarChatRowRender).not.toHaveBeenCalled();
  });

  it("uses prototype menu typography and hover treatment for chat row menus", async () => {
    const user = userEvent.setup();

    seedSessions({
      id: "prototype-menu-chat",
      title: "Prototype Menu Chat",
      updatedAt: "2026-04-10T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      activeView: "home",
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
      prototypeSecondaryPush: true,
    });

    const chatRow = screen.getByRole("button", {
      name: "Prototype Menu Chat",
    });
    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", {
        name: "Options for Prototype Menu Chat",
      }),
    );

    const renameItem = screen.getByRole("menuitem", { name: "Rename" });
    expect(renameItem.closest('[role="menu"]')?.className).toContain("w-56");
    expect(renameItem).toHaveStyle({
      fontSize: "14px",
      lineHeight: "18px",
    });
    expect(renameItem.className).toContain("whitespace-nowrap");
    expect(renameItem.className).toContain("focus:!bg-transparent");
    expect(renameItem.className).toContain("opacity-[0.85]");
  });

  it("keeps at least two expanded prototype primary chats visible in a cramped default layout", async () => {
    seedSessions(
      {
        id: "newest-default-chat",
        title: "Newest Default Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "older-default-chat",
        title: "Older Default Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "hidden-default-chat",
        title: "Hidden Default Chat",
        updatedAt: "2026-04-08T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    mockRect(screen.getByTestId("sidebar-prototype-primary-scroll"), {
      top: 0,
      bottom: 260,
    });
    mockRect(screen.getByTestId("sidebar-prototype-primary-nav-group"), {
      top: 0,
      bottom: 96,
    });
    mockRect(screen.getByTestId("sidebar-prototype-projects-group"), {
      top: 0,
      bottom: 86,
    });
    mockRect(screen.getByTestId("sidebar-prototype-chats-group"), {
      top: 238,
      bottom: 250,
    });
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(
        within(mainNavigation).getByRole("button", {
          name: "Newest Default Chat",
        }),
      ).toBeInTheDocument();
      expect(
        within(mainNavigation).getByRole("button", {
          name: "Older Default Chat",
        }),
      ).toBeInTheDocument();
    });
    expect(
      within(mainNavigation).queryByRole("button", {
        name: "Hidden Default Chat",
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps display options on the Chats section and removes them from Projects", async () => {
    const user = userEvent.setup();
    seedSessions({
      id: "display-options-chat",
      title: "Display Options Chat",
      updatedAt: "2026-04-10T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
    });

    expect(
      screen.queryByRole("button", { name: "Project display options" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Chat display options" }),
    );
    const showIcons = screen.getByRole("menuitemcheckbox", {
      name: "Show chat icons",
    });
    expect(showIcons).toHaveAttribute("data-state", "checked");
    await user.click(showIcons);

    expect(
      screen.queryByTestId("prototype-primary-chat-row-icon"),
    ).not.toBeInTheDocument();
  });

  it("preserves refreshed chat activity states when idle icons are hidden", async () => {
    const user = userEvent.setup();
    mockSessionStateById = {
      "running-chat": { chatState: "thinking", hasUnread: true },
      "unread-chat": { hasUnread: true },
    };
    seedSessions(
      {
        id: "idle-chat",
        title: "Idle Chat",
        updatedAt: "2026-04-10T12:03:00.000Z",
        messageCount: 3,
      },
      {
        id: "running-chat",
        title: "Running Chat",
        updatedAt: "2026-04-10T12:02:00.000Z",
        messageCount: 3,
      },
      {
        id: "unread-chat",
        title: "Unread Chat",
        updatedAt: "2026-04-10T12:01:00.000Z",
        messageCount: 3,
      },
      {
        id: "pinned-chat",
        title: "Pinned Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
      },
    );
    seedPinnedHomeChats("pinned-chat");

    renderSidebar({
      activeView: "home",
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
    });

    await user.click(
      screen.getByRole("button", { name: "Chat display options" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "Show chat icons" }),
    );

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    const getRow = (sessionId: string) => {
      const row = mainNavigation.querySelector<HTMLElement>(
        `[data-session-id="${sessionId}"]`,
      );
      if (!row) throw new Error(`${sessionId} row was not rendered`);
      return within(row);
    };

    expect(
      getRow("idle-chat").queryByTestId("prototype-primary-chat-row-icon"),
    ).not.toBeInTheDocument();
    expect(
      getRow("running-chat").getByRole("status", { name: /chat active/i }),
    ).toBeInTheDocument();
    expect(
      getRow("unread-chat").getByRole("status", {
        name: /unread messages/i,
      }),
    ).toBeInTheDocument();
    expect(
      getRow("running-chat").queryByRole("status", {
        name: /unread messages/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      getRow("pinned-chat").getByRole("button", { name: "Unpin chat" }),
    ).toBeVisible();
  });

  it("shows project chat display options in the project secondary header", async () => {
    const user = userEvent.setup();
    const onPrototypeSecondaryPreviewChange = vi.fn();
    seedSessions(
      {
        id: "project-display-chat",
        title: "Project Display Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "regular-display-chat",
        title: "Regular Display Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
      prototypeSecondaryPreview: true,
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
      onPrototypeSecondaryPreviewChange,
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    expect(
      within(projectNavigation).getByTestId(
        "prototype-project-secondary-header",
      ),
    ).toHaveClass(
      "text-[var(--sidebar-prototype-nav-muted-fg)]",
      "pl-[10px]",
      "pr-3",
    );
    const projectChatButton = within(projectNavigation).getByRole("button", {
      name: "Project Display Chat",
    });
    expect(projectChatButton).toHaveClass("pl-8");
    const projectChatRow = projectChatButton.closest<HTMLElement>(
      "[data-sidebar-chat-row]",
    );
    expect(projectChatRow).not.toBeNull();
    if (!projectChatRow) throw new Error("project chat row missing");
    expect(
      within(projectChatRow)
        .getByTestId("sidebar-chat-menu-icon")
        .closest("span.absolute"),
    ).toHaveClass("left-2");
    await user.click(
      within(projectNavigation).getByRole("button", {
        name: "Project One chat display options",
      }),
    );
    const showIcons = screen.getByRole("menuitemcheckbox", {
      name: "Show chat icons",
    });
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Show timestamps" }),
    ).toBeInTheDocument();
    await user.click(showIcons);
    expect(onPrototypeSecondaryPreviewChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        within(projectNavigation).getByRole("button", {
          name: "Project Display Chat",
        }),
      ).toHaveClass("pl-[10px]");
      expect(
        within(projectNavigation).queryByTestId("sidebar-chat-icon"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen
        .getAllByTestId("prototype-primary-chat-row-icon")
        .some((icon) =>
          icon.closest('[data-session-id="regular-display-chat"]'),
        ),
    ).toBe(true);
  });

  it("keeps pinned project chats visible when refreshed chat icons are hidden", async () => {
    const user = userEvent.setup();
    seedSessions({
      id: "pinned-project-chat",
      title: "Pinned Project Chat",
      updatedAt: "2026-04-10T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });
    seedPinnedHomeChats("pinned-project-chat");

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    await user.click(
      within(projectNavigation).getByRole("button", {
        name: "Project One chat display options",
      }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "Show chat icons" }),
    );

    const pinnedRow = projectNavigation.querySelector<HTMLElement>(
      '[data-session-id="pinned-project-chat"]',
    );
    if (!pinnedRow) throw new Error("Pinned project chat row was not rendered");

    expect(
      within(pinnedRow).getByRole("button", { name: "Unpin chat" }),
    ).toBeVisible();
  });

  it("keeps expanded prototype primary chat icons in the shared leading rail", async () => {
    seedSessions({
      id: "aligned-chat",
      title: "Aligned Chat",
      updatedAt: "2026-04-10T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    await waitFor(() =>
      expect(
        within(mainNavigation).getByRole("button", { name: "Aligned Chat" }),
      ).toBeInTheDocument(),
    );
    const chatRow = mainNavigation.querySelector(
      '[data-session-id="aligned-chat"]',
    );
    if (!(chatRow instanceof HTMLElement)) {
      throw new Error("Prototype primary chat row was not rendered");
    }

    const chatButton = within(chatRow).getByRole("button", {
      name: "Aligned Chat",
    });
    expect(chatButton).toHaveClass("pl-8");
    expect(
      within(chatRow).getByTestId("prototype-primary-chat-row-icon"),
    ).toHaveClass("absolute", "left-2");
    expect(chatButton.querySelector("button")).toBeNull();
  });

  it("fills the available prototype primary height with recent chats", async () => {
    seedSessions(
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `chat-${index + 1}`,
        title: `Chat ${index + 1}`,
        updatedAt: `2026-04-${String(10 - index).padStart(2, "0")}T12:00:00.000Z`,
        messageCount: 3,
      })),
      {
        id: "archived-chat",
        title: "Archived Chat",
        updatedAt: "2026-04-11T12:00:00.000Z",
        archivedAt: "2026-04-11T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    const primaryScrollRect = mockRect(
      screen.getByTestId("sidebar-prototype-primary-scroll"),
      {
        top: 0,
        bottom: 462,
      },
    );
    mockRect(screen.getByTestId("sidebar-prototype-primary-nav-group"), {
      top: 0,
      bottom: 86,
    });
    mockRect(screen.getByTestId("sidebar-prototype-projects-group"), {
      top: 0,
      bottom: 57,
    });
    const primaryChatsGroupRect = mockRect(
      screen.getByTestId("sidebar-prototype-chats-group"),
      {
        top: 183,
        bottom: 443,
      },
    );
    fireEvent(window, new Event("resize"));

    expect(
      screen.getByTestId("sidebar-prototype-primary-scroll").style.maskImage,
    ).toBe("");
    expect(within(mainNavigation).getByText("Chats")).toBeInTheDocument();
    expect(
      within(mainNavigation).queryByRole("button", { name: "Chats" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(mainNavigation).getByRole("button", { name: "Chat 6" }),
      ).toBeInTheDocument();
    });
    expect(
      within(mainNavigation).queryByRole("button", { name: "Chat 7" }),
    ).not.toBeInTheDocument();
    expect(
      within(mainNavigation).queryByRole("button", { name: "Archived Chat" }),
    ).not.toBeInTheDocument();
    expect(
      within(mainNavigation).getByRole("button", { name: "View more" }),
    ).toBeInTheDocument();
    expect(
      Array.from(mainNavigation.querySelectorAll("[data-session-id]")).map(
        (element) => element.getAttribute("data-session-id"),
      ),
    ).toEqual(["chat-1", "chat-2", "chat-3", "chat-4", "chat-5", "chat-6"]);

    primaryScrollRect.mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      bottom: 346,
      left: 0,
      right: 300,
      width: 300,
      height: 346,
      toJSON: () => ({}),
    } as DOMRect);
    primaryChatsGroupRect.mockReturnValue({
      x: 0,
      y: 183,
      top: 183,
      bottom: 327,
      left: 0,
      right: 300,
      width: 300,
      height: 144,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(
        within(mainNavigation).queryByRole("button", { name: "Chat 4" }),
      ).not.toBeInTheDocument();
    });
    expect(
      Array.from(mainNavigation.querySelectorAll("[data-session-id]")).map(
        (element) => element.getAttribute("data-session-id"),
      ),
    ).toEqual(["chat-1", "chat-2"]);
  });

  it("selects prototype primary chat rows without requesting the secondary panel", async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();

    seedSessions({
      id: "primary-list-chat",
      title: "Primary List Chat",
      updatedAt: "2026-04-10T12:00:00.000Z",
      messageCount: 3,
    });

    renderSidebar({
      activeView: "home",
      onSelectSession,
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });

    await user.click(
      within(mainNavigation).getByRole("button", {
        name: "Primary List Chat",
      }),
    );

    expect(onSelectSession).toHaveBeenCalledWith("primary-list-chat", {
      suppressPrototypeSecondary: true,
    });
  });

  it("shows chat section label actions for history and new chat", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onNewChat = vi.fn();

    renderSidebar({
      activeView: "home",
      onNavigate,
      onNewChat,
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    await user.hover(within(mainNavigation).getByText("Chats"));

    await user.click(
      within(mainNavigation).getByRole("button", {
        name: "View chat history",
      }),
    );
    expect(onNavigate).toHaveBeenCalledWith("session-history");

    await user.click(
      within(mainNavigation).getByRole("button", { name: "New chat" }),
    );
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("keeps the collapsed prototype primary chat section compact", () => {
    seedSessions(
      {
        id: "newest-collapsed-chat",
        title: "Newest Collapsed Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "older-collapsed-chat",
        title: "Older Collapsed Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "third-collapsed-chat",
        title: "Third Collapsed Chat",
        updatedAt: "2026-04-08T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "fourth-collapsed-chat",
        title: "Fourth Collapsed Chat",
        updatedAt: "2026-04-07T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "fifth-collapsed-chat",
        title: "Fifth Collapsed Chat",
        updatedAt: "2026-04-06T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypePrimaryCollapsed: true,
      prototypeChatsUnderProjects: true,
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    mockRect(screen.getByTestId("sidebar-prototype-primary-scroll"), {
      top: 0,
      bottom: 346,
    });
    mockRect(screen.getByTestId("sidebar-prototype-chats-group"), {
      top: 183,
      bottom: 327,
    });
    fireEvent(window, new Event("resize"));

    expect(
      within(mainNavigation).queryByRole("button", { name: "Chats" }),
    ).not.toBeInTheDocument();
    expect(
      within(mainNavigation).queryByRole("button", {
        name: "Newest Collapsed Chat",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(mainNavigation).queryByRole("button", {
        name: "Older Collapsed Chat",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(mainNavigation).getByRole("button", { name: "View more" }),
    ).toBeInTheDocument();
    expect(
      within(mainNavigation).getAllByTestId("prototype-primary-chat-row-icon"),
    ).toHaveLength(1);
    expect(
      Array.from(mainNavigation.querySelectorAll("[data-session-id]")).map(
        (element) => element.getAttribute("data-session-id"),
      ),
    ).toEqual([]);
  });

  it("keeps collapsed prototype primary icons on a fixed rail inset during width animation", () => {
    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypePrimaryCollapsed: true,
      prototypeChatsUnderProjects: true,
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    const homeRow = within(mainNavigation).getByRole("button", {
      name: "Home",
    });
    const viewMoreRow = within(mainNavigation).getByRole("button", {
      name: "View more",
    });

    expect(homeRow.className).toContain("justify-start");
    expect(homeRow.className).toContain("pl-2");
    expect(homeRow.className).not.toContain("pl-[10px]");
    expect(homeRow.className).toContain("gap-2");
    expect(homeRow.querySelectorAll("span")[1]?.className).toContain(
      "opacity-0",
    );
    expect(homeRow.querySelectorAll("span")[1]?.className).toContain(
      "translate-x-0",
    );
    expect(homeRow.querySelectorAll("span")[1]?.className).toContain(
      "max-w-[180px]",
    );
    expect(homeRow.querySelectorAll("span")[1]?.className).not.toContain(
      "max-w-0",
    );
    expect(homeRow.querySelectorAll("span")[1]?.className).not.toContain(
      "-translate-x-1",
    );
    expect(viewMoreRow.className).toContain("justify-start");
    expect(viewMoreRow.className).toContain("pl-2");
    expect(viewMoreRow.className).not.toContain("pl-[10px]");
    expect(viewMoreRow.className).toContain("gap-2");
    expect(viewMoreRow.querySelectorAll("span")[1]?.className).toContain(
      "opacity-0",
    );
    expect(viewMoreRow.querySelectorAll("span")[1]?.className).toContain(
      "translate-x-0",
    );
    expect(viewMoreRow.querySelectorAll("span")[1]?.className).not.toContain(
      "max-w-0",
    );
  });

  it("cross-fades prototype primary project and chat section headers", () => {
    vi.useFakeTimers();
    const props = sidebarProps({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
    });

    const { rerender } = renderWithQueryClient(
      <NavigationPanesView {...props} />,
    );

    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-icon")
        .className,
    ).toContain("opacity-0");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-icon")
        .className,
    ).toContain("transition-opacity");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-icon")
        .className,
    ).toContain("duration-250");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-icon")
        .className,
    ).not.toContain("transition-[left,opacity,transform]");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-label")
        .className,
    ).toContain("opacity-100");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-label")
        .className,
    ).toContain("transition-opacity");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-label")
        .className,
    ).toContain("duration-250");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-label")
        .className,
    ).not.toContain("transition-[opacity,transform]");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header-icon")
        .className,
    ).toContain("opacity-0");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header-label")
        .className,
    ).toContain("opacity-100");

    rerender(<NavigationPanesView {...props} prototypePrimaryCollapsed />);

    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header").className,
    ).toContain("pl-2");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-icon")
        .className,
    ).toContain("opacity-100");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-icon")
        .className,
    ).toContain("left-2");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-icon")
        .className,
    ).not.toContain("left-1/2");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-label")
        .className,
    ).toContain("opacity-0");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-label")
        .className,
    ).toContain("translate-x-0");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-label")
        .className,
    ).not.toContain("max-w-0");
    expect(
      screen.getByTestId("sidebar-prototype-projects-section-header-label")
        .className,
    ).not.toContain("translate-x-1");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header").className,
    ).toContain("pl-2");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header-icon")
        .className,
    ).toContain("opacity-100");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header-icon")
        .className,
    ).toContain("left-2");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header-icon")
        .className,
    ).not.toContain("left-1/2");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header-label")
        .className,
    ).toContain("opacity-0");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header-label")
        .className,
    ).toContain("translate-x-0");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header-label")
        .className,
    ).not.toContain("max-w-0");
    expect(
      screen.getByTestId("sidebar-prototype-chats-section-header-label")
        .className,
    ).not.toContain("translate-x-1");
  });

  it("collapses expanded prototype primary content immediately with the rail", () => {
    seedSessions({
      id: "transition-chat",
      title: "Transition Chat",
      updatedAt: "2026-04-10T12:00:00.000Z",
      messageCount: 3,
    });
    const props = sidebarProps({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
    });

    const { rerender } = renderWithQueryClient(
      <NavigationPanesView {...props} />,
    );
    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    expect(
      within(mainNavigation).getByRole("button", { name: "Transition Chat" }),
    ).toBeInTheDocument();

    rerender(<NavigationPanesView {...props} prototypePrimaryCollapsed />);

    expect(
      within(mainNavigation).queryByRole("button", {
        name: "Transition Chat",
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps the collapsed View more affordance visible when chat icons are hidden", async () => {
    const user = userEvent.setup();

    seedSessions(
      {
        id: "newest-collapsed-chat",
        title: "Newest Collapsed Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
      },
      {
        id: "older-collapsed-chat",
        title: "Older Collapsed Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "chat",
      activeSessionId: "newest-collapsed-chat",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypePrimaryCollapsed: true,
      prototypeChatsUnderProjects: true,
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "chats" },
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    expect(
      within(mainNavigation).queryByRole("button", {
        name: "Newest Collapsed Chat",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(mainNavigation).getAllByTestId("prototype-primary-chat-row-icon"),
    ).toHaveLength(1);
    expect(
      within(mainNavigation).getByRole("button", { name: "View more" }),
    ).toBeInTheDocument();
    expect(
      Array.from(mainNavigation.querySelectorAll("[data-session-id]")).map(
        (element) => element.getAttribute("data-session-id"),
      ),
    ).toEqual([]);

    const viewMoreRow = within(mainNavigation).getByRole("button", {
      name: "View more",
    });
    expect(viewMoreRow.className).toContain("sidebar-prototype-nav-row-hover");
    expect(viewMoreRow.className).not.toContain(
      "hover:bg-[var(--sidebar-prototype-nav-row-hover)]",
    );
    expect(viewMoreRow.className).not.toContain("opacity-80");

    const chatsNavigation = screen.getByRole("navigation", { name: "Chats" });
    await user.click(
      within(chatsNavigation).getByRole("button", {
        name: "Filter chats: Latest",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Chat icons" }));

    expect(
      within(mainNavigation).getAllByTestId("prototype-primary-chat-row-icon"),
    ).toHaveLength(1);
    expect(
      Array.from(mainNavigation.querySelectorAll("[data-session-id]")).map(
        (element) => element.getAttribute("data-session-id"),
      ),
    ).toEqual([]);
    expect(viewMoreRow.className).not.toContain(
      "sidebar-prototype-nav-row-active",
    );
  });

  it("highlights the project row when a project chat is active", () => {
    seedSessions(
      {
        id: "project-chat",
        title: "Project Chat",
        updatedAt: "2026-04-10T12:00:00.000Z",
        messageCount: 3,
        projectId: "project-1",
      },
      {
        id: "loose-chat",
        title: "Loose Chat",
        updatedAt: "2026-04-09T12:00:00.000Z",
        messageCount: 3,
      },
    );

    renderSidebar({
      activeView: "chat",
      activeSessionId: "project-chat",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeChatsUnderProjects: true,
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    const projectRow = within(mainNavigation).getByRole("button", {
      name: "Project One",
    });

    expect(projectRow.className).toContain("sidebar-prototype-nav-row-active");
    expect(
      within(mainNavigation).queryByRole("button", { name: "Project Chat" }),
    ).not.toBeInTheDocument();
    expect(
      within(mainNavigation).getByRole("button", { name: "Loose Chat" }),
    ).toBeInTheDocument();
  });

  it("reorders projects in the refreshed primary nav", () => {
    const onReorderProject = vi.fn();

    renderSidebar({
      activeView: "home",
      onReorderProject,
      projects: [
        mockProject({ id: "alpha", name: "Alpha" }),
        mockProject({ id: "bravo", name: "Bravo" }),
        mockProject({ id: "charlie", name: "Charlie" }),
      ],
      prototypeMode: "hybrid-push-overlay",
    });

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    const alphaRow = within(mainNavigation)
      .getByRole("button", { name: "Alpha" })
      .closest("[data-sidebar-project-draggable]");
    const bravoRow = within(mainNavigation)
      .getByRole("button", { name: "Bravo" })
      .closest("[data-sidebar-project-draggable]");
    const charlieButton = within(mainNavigation).getByRole("button", {
      name: "Charlie",
    });
    const charlieRow = charlieButton.closest(
      "[data-sidebar-project-draggable]",
    );
    if (!alphaRow || !bravoRow || !charlieRow) {
      throw new Error("Prototype project rows were not rendered");
    }

    mockRect(alphaRow, { top: 0, bottom: 40 });
    mockRect(bravoRow, { top: 40, bottom: 80 });
    mockRect(charlieRow, { top: 80, bottom: 120 });

    dispatchPointerEvent(charlieButton, "pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 90,
    });
    dispatchPointerEvent(window, "pointermove", {
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });
    dispatchPointerEvent(window, "pointerup", {
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });

    expect(onReorderProject).toHaveBeenCalledWith("charlie", "alpha", "before");
  });

  it("opens more prototype chats from the nested View more row", async () => {
    const user = userEvent.setup();
    const onPrototypeSecondaryTargetChange = vi.fn();
    const onPrototypeSecondarySelect = vi.fn();

    seedSessions(
      ...Array.from({ length: 5 }, (_, index) => {
        const chatNumber = index + 1;
        return {
          id: `more-chat-${chatNumber}`,
          title: `More Chat ${chatNumber}`,
          updatedAt: `2026-04-${String(10 - index).padStart(
            2,
            "0",
          )}T12:00:00.000Z`,
          messageCount: 3,
        };
      }),
    );

    renderWithQueryClient(
      <PrototypeNavigationHarness
        prototypeChatsUnderProjects
        onPrototypeSecondaryTargetChange={onPrototypeSecondaryTargetChange}
        onPrototypeSecondarySelect={onPrototypeSecondarySelect}
      />,
    );

    const mainNavigation = screen.getByRole("navigation", {
      name: "Main navigation",
    });
    await waitFor(() => {
      expect(
        within(mainNavigation).getByRole("button", { name: "More Chat 4" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "View more" }));

    expect(onPrototypeSecondaryTargetChange).toHaveBeenCalledWith({
      kind: "chats",
      variant: "more",
    });
    expect(onPrototypeSecondarySelect).toHaveBeenCalled();
    const chatsNavigation = await screen.findByRole("navigation", {
      name: "Chats",
    });
    expect(
      within(chatsNavigation).queryByRole("button", { name: "More Chat 1" }),
    ).not.toBeInTheDocument();
    expect(
      within(chatsNavigation).queryByRole("button", { name: "More Chat 4" }),
    ).not.toBeInTheDocument();
    expect(
      within(chatsNavigation).getByRole("button", { name: "More Chat 5" }),
    ).toBeInTheDocument();

    onPrototypeSecondaryTargetChange.mockClear();
    onPrototypeSecondarySelect.mockClear();

    await user.click(screen.getByRole("button", { name: "View more" }));

    expect(onPrototypeSecondaryTargetChange).toHaveBeenCalledWith(null);
    expect(onPrototypeSecondarySelect).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.queryByRole("navigation", { name: "Chats" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps more prototype chats open after the secondary panel is clicked", async () => {
    const user = userEvent.setup();
    const onPrototypeSecondaryTargetChange = vi.fn();
    const onPrototypeSecondarySelect = vi.fn();

    seedSessions(
      ...Array.from({ length: 5 }, (_, index) => {
        const chatNumber = index + 1;
        return {
          id: `more-chat-${chatNumber}`,
          title: `More Chat ${chatNumber}`,
          updatedAt: `2026-04-${String(10 - index).padStart(
            2,
            "0",
          )}T12:00:00.000Z`,
          messageCount: 3,
        };
      }),
    );

    renderWithQueryClient(
      <PrototypeNavigationHarness
        prototypeChatsUnderProjects
        onPrototypeSecondaryTargetChange={onPrototypeSecondaryTargetChange}
        onPrototypeSecondarySelect={onPrototypeSecondarySelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: "View more" }));

    const chatsNavigation = await screen.findByRole("navigation", {
      name: "Chats",
    });
    await user.click(chatsNavigation);

    onPrototypeSecondaryTargetChange.mockClear();
    onPrototypeSecondarySelect.mockClear();

    await user.click(screen.getByRole("button", { name: "View more" }));

    expect(onPrototypeSecondaryTargetChange).not.toHaveBeenCalledWith(null);
    expect(onPrototypeSecondaryTargetChange).toHaveBeenCalledWith({
      kind: "chats",
      variant: "more",
    });
    expect(onPrototypeSecondarySelect).toHaveBeenCalled();
    expect(
      screen.getByRole("navigation", { name: "Chats" }),
    ).toBeInTheDocument();
  });

  it("keeps the project pane actionable after archiving its last chat", async () => {
    const user = userEvent.setup();
    const onArchiveChat = vi.fn().mockResolvedValue(undefined);

    seedSessions({
      id: "project-seed-chat",
      title: "audit type scale",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
      onArchiveChat,
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "audit type scale",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", {
        name: "Options for audit type scale",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(onArchiveChat).toHaveBeenCalledWith("project-seed-chat");
    await waitFor(() => {
      expect(
        within(projectNavigation).queryByRole("button", {
          name: "audit type scale",
        }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole("navigation", {
        name: "Project One project chats",
      }),
    ).toBeInTheDocument();
    expect(
      within(projectNavigation).getByRole("button", {
        name: "Start new chat in Project One",
      }),
    ).toBeInTheDocument();
  });

  it("keeps real prototype project chats visible when delete archive fails", async () => {
    const user = userEvent.setup();
    const onArchiveChat = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "backend_archive_failed" });

    seedSessions({
      id: "project-seed-chat",
      title: "audit type scale",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
      onArchiveChat,
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "audit type scale",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", {
        name: "Options for audit type scale",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(onArchiveChat).toHaveBeenCalledWith("project-seed-chat");
    });
    expect(
      within(projectNavigation).getByRole("button", {
        name: "audit type scale",
      }),
    ).toBeInTheDocument();
  });

  it("removes project chat placement when archive succeeds but cleanup is incomplete", async () => {
    const user = userEvent.setup();
    const onArchiveChat = vi.fn().mockResolvedValue({
      ok: true,
      cleanupIncomplete: "workspace_cleanup_failed",
    });

    seedSessions({
      id: "project-seed-chat",
      title: "audit type scale",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderSidebar({
      activeView: "home",
      projects: [mockProject({ name: "Project One" })],
      prototypeMode: "hybrid-push-overlay",
      prototypeSecondaryPush: true,
      prototypeSecondaryTarget: { kind: "project", projectId: "project-1" },
      onArchiveChat,
    });

    const projectNavigation = screen.getByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "audit type scale",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", {
        name: "Options for audit type scale",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(
        within(projectNavigation).queryByRole("button", {
          name: "audit type scale",
        }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps a previewed prototype secondary panel open when the chat row menu opens", async () => {
    const user = userEvent.setup();
    const onPrototypeSecondaryTargetChange = vi.fn();
    seedSessions({
      id: "project-seed-chat",
      title: "Project seed chat",
      updatedAt: "2026-04-09T12:00:00.000Z",
      messageCount: 3,
      projectId: "project-1",
    });

    renderWithQueryClient(
      <PrototypeNavigationHarness
        onPrototypeSecondaryTargetChange={onPrototypeSecondaryTargetChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project One" }));

    const projectNavigation = await screen.findByRole("navigation", {
      name: "Project One project chats",
    });
    const chatRow = within(projectNavigation).getByRole("button", {
      name: "Project seed chat",
    });

    await user.hover(chatRow);
    await user.click(
      screen.getByRole("button", {
        name: "Options for Project seed chat",
      }),
    );
    await screen.findByRole("menuitem", { name: "Create group" });

    const secondaryWrapper = screen.getByTestId(
      "sidebar-prototype-secondary-panel",
    ).parentElement?.parentElement;
    if (!(secondaryWrapper instanceof HTMLElement)) {
      throw new Error("Prototype secondary panel wrapper was not rendered");
    }

    fireEvent.pointerLeave(secondaryWrapper, { relatedTarget: document.body });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });

    expect(onPrototypeSecondaryTargetChange).not.toHaveBeenCalledWith(null);
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
    expect(screen.getByRole("button", { name: /^back$/i })).toHaveClass(
      "h-7",
      "px-3",
    );
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

    await user.click(screen.getByRole("button", { name: /general/i }));
    expect(onSettingsSectionChange).toHaveBeenCalledWith("general");
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
