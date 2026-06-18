import { useState, type ComponentProps } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { BUILDERBOT_SURFACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import { Sidebar } from "../Sidebar";

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
    width: 300,
    onNavigate: vi.fn(),
    onSelectSession: vi.fn(),
    projects: [],
    ...props,
  };
}

function renderSidebar(props: Partial<SidebarProps> = {}) {
  return render(<Sidebar {...sidebarProps(props)} />);
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

function SidebarSelectionHarness({
  onSelectSession,
}: {
  onSelectSession?: (sessionId: string) => void;
}) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  return (
    <Sidebar
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

    let activeView: SidebarProps["activeView"] = "home";
    let rerenderSidebar: ReturnType<typeof render>["rerender"];
    const onNavigate = vi.fn(
      (view: NonNullable<SidebarProps["activeView"]>) => {
        activeView = view;
        rerenderSidebar(
          <Sidebar {...sidebarProps({ activeView, onNavigate })} />,
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
      <Sidebar
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

    render(<SidebarSelectionHarness onSelectSession={onSelectSession} />);
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
