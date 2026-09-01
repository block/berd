import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import {
  focusSessionWindow,
  getSessionWindowSupport,
  openSessionWindow,
} from "@/features/chat/lib/sessionWindowCommands";
import { saveExportedSessionFile } from "@/shared/api/system";
import { SessionHistoryView } from "../SessionHistoryView";

const mocks = vi.hoisted(() => ({
  acpExportSession: vi.fn(),
  acpImportSession: vi.fn(),
  acpSearchSessions: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  virtualizerMeasure: vi.fn(),
  // Scroll position the fake virtualizer reports. Real `getVirtualItems()`
  // leads with overscan rows sitting above the viewport, so tests that care
  // which row is genuinely visible drive this instead of the item list.
  sessionWindowSupport: {
    supported: true,
    reason: undefined as string | undefined,
  },
  virtualizerState: { scrollOffset: 0 },
}));

vi.mock("@/shared/api/acp", () => ({
  acpExportSession: (...args: unknown[]) => mocks.acpExportSession(...args),
  acpImportSession: (...args: unknown[]) => mocks.acpImportSession(...args),
  acpSearchSessions: (...args: unknown[]) => mocks.acpSearchSessions(...args),
}));

vi.mock("@/features/chat/hooks/useSessionWindowSupport", () => ({
  useSessionWindowSupport: () => mocks.sessionWindowSupport,
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  focusSessionWindow: vi.fn().mockResolvedValue(undefined),
  getSessionWindowSupport: vi
    .fn()
    .mockResolvedValue({ supported: true, reason: undefined }),
  openSessionWindow: vi.fn().mockResolvedValue(undefined),
  releaseSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
  },
}));

vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: ({
    startIndex,
    endIndex,
  }: {
    startIndex: number;
    endIndex: number;
  }) =>
    Array.from(
      { length: endIndex - startIndex + 1 },
      (_, index) => startIndex + index,
    ),
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 128,
    // Every row is "rendered", mirroring a virtualizer whose overscan reaches
    // the top of the list: the first entry here is not the first visible row.
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 128,
        end: (index + 1) * 128,
      })),
    scrollOffset: mocks.virtualizerState.scrollOffset,
    measureElement: vi.fn(),
    measure: (...args: unknown[]) => mocks.virtualizerMeasure(...args),
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({
      getPersonaById: () => undefined,
    }),
  },
}));

const projectState: { projects: unknown[] } = { projects: [] };

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector(projectState),
}));

vi.mock("@/shared/api/system", () => ({
  saveExportedSessionFile: vi.fn(),
  saveExportedSessionFiles: vi.fn(),
}));

vi.mock("../SessionCard", () => ({
  SessionCard: ({
    id,
    title,
    onSelect,
    onExport,
    onOpenInWindow,
    isOpenInWindow,
    snippet,
    snippetLineClamp,
    onSelectionChange,
    onArchive,
    onArchiveSelected,
    onFork,
    onRename,
    onUnarchive,
    onUnarchiveSelected,
  }: {
    id: string;
    title: string;
    onSelect?: (id: string) => void;
    onExport?: (id: string) => void;
    onOpenInWindow?: (id: string) => void;
    isOpenInWindow?: boolean;
    snippet?: string;
    snippetLineClamp?: 1 | 3;
    onSelectionChange?: (id: string, selected: boolean) => void;
    onArchive?: (id: string) => void;
    onArchiveSelected?: () => void;
    onFork?: (id: string) => void;
    onRename?: (id: string, nextTitle: string) => void;
    onUnarchive?: (id: string) => void;
    onUnarchiveSelected?: () => void;
  }) => (
    <div data-testid="session-card" data-session-card>
      <span>{title}</span>
      {snippet ? (
        <span
          data-testid={`session-snippet-${id}`}
          data-line-clamp={snippetLineClamp ?? "default"}
        >
          {snippet}
        </span>
      ) : null}
      <button type="button" onClick={() => onExport?.(id)}>
        Export
      </button>
      <button type="button" onClick={() => onSelect?.(id)}>
        Open {title}
      </button>
      {onArchive ? (
        <button type="button" onClick={() => onArchive(id)}>
          Archive {title}
        </button>
      ) : null}
      {onFork ? (
        <button type="button" onClick={() => onFork(id)}>
          Fork {title}
        </button>
      ) : null}
      {onRename ? (
        <button type="button" onClick={() => onRename(id, "Renamed")}>
          Rename {title}
        </button>
      ) : null}
      <button type="button" onClick={() => onSelectionChange?.(id, true)}>
        Select {title}
      </button>
      <button type="button" onClick={onArchiveSelected}>
        Archive selected
      </button>
      {onUnarchiveSelected ? (
        <button type="button" onClick={onUnarchiveSelected}>
          Restore selected {title}
        </button>
      ) : null}
      {onUnarchive ? (
        <button type="button" onClick={() => onUnarchive(id)}>
          Restore {title}
        </button>
      ) : null}
      {onOpenInWindow ? (
        <button type="button" onClick={() => onOpenInWindow(id)}>
          {isOpenInWindow ? "Open window" : "Open in new window"} {title}
        </button>
      ) : null}
    </div>
  ),
}));

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Chat One",
    createdAt: "2026-04-09T12:00:00.000Z",
    updatedAt: "2026-04-09T12:00:00.000Z",
    messageCount: 1,
    ...overrides,
  };
}

function setSessionStoreState(
  state: Partial<ReturnType<typeof useChatSessionStore.getState>> &
    Record<string, unknown>,
) {
  useChatSessionStore.setState(
    state as Partial<ReturnType<typeof useChatSessionStore.getState>>,
  );
}

function renderHistory() {
  return render(<SessionHistoryView />);
}

function setScrollMetrics(
  scroller: HTMLElement,
  {
    scrollHeight = 1400,
    clientHeight = 600,
  }: {
    scrollHeight?: number;
    clientHeight?: number;
  } = {},
) {
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

function setHistoryScrollMetrics({
  scrollHeight = 1400,
  clientHeight = 600,
}: {
  scrollHeight?: number;
  clientHeight?: number;
} = {}) {
  const scroller = screen.getByTestId("session-history-scroll");
  setScrollMetrics(scroller, { scrollHeight, clientHeight });
  return scroller;
}

function scrollHistoryTo(scrollTop: number) {
  fireEvent.scroll(screen.getByTestId("session-history-scroll"), {
    target: { scrollTop },
  });
}

function historyMatchedInfo(sessionId: string) {
  return {
    sessionId,
    title: "Server match",
    updatedAt: "2026-04-12T12:00:00Z",
    createdAt: "2026-04-12T12:00:00Z",
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 3,
    subtitle: null,
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
  };
}

describe("SessionHistoryView", () => {
  beforeEach(() => {
    mocks.sessionWindowSupport.supported = true;
    mocks.sessionWindowSupport.reason = undefined;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    vi.clearAllMocks();
    projectState.projects = [];
    mocks.virtualizerState.scrollOffset = 0;
    // The view toggle persists here; without a reset one test's choice would
    // decide the next test's starting view.
    window.localStorage.removeItem("sessions.history.view");
    vi.mocked(getSessionWindowSupport).mockResolvedValue({
      supported: true,
      reason: undefined,
    });
    useChatStore.setState({
      messagesBySession: {},
      queuedMessageBySession: {},
    });
    useSessionWindowStore.getState().setSnapshot([]);
    setSessionStoreState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      hasMoreSessions: false,
      isLoadingMoreSessions: false,
      loadMoreSessions: undefined,
    });
    // Production shape: the server matches every target handed to it here, and
    // searchedIds ⊆ matchedInfos (only matched targets are export-enriched).
    mocks.acpSearchSessions.mockImplementation(
      async (_query: string, targets: { id: string }[]) => ({
        results: [],
        searchedIds: targets.map((target) => target.id),
        failedIds: [],
        matchedInfos: targets.map((target) => historyMatchedInfo(target.id)),
      }),
    );
  });

  it("does not expose open-in-window from history when session windows are unsupported", async () => {
    mocks.sessionWindowSupport.supported = false;
    mocks.sessionWindowSupport.reason = "unsupported platform";
    setSessionStoreState({
      sessions: [session()],
    });

    renderHistory();

    expect(
      screen.queryByRole("button", { name: /open in new window chat one/i }),
    ).not.toBeInTheDocument();
  });

  it("opens a session window from history when session windows are supported", async () => {
    const user = userEvent.setup();
    setSessionStoreState({
      sessions: [session()],
    });

    renderHistory();

    await user.click(
      await screen.findByRole("button", {
        name: /open in new window chat one/i,
      }),
    );

    expect(openSessionWindow).toHaveBeenCalledWith("session-1", {
      handoff: false,
    });
    expect(focusSessionWindow).not.toHaveBeenCalled();
  });

  it("previews the latest session text on browse rows", () => {
    setSessionStoreState({
      sessions: [
        session({
          subtitle: "Let's refactor the session list query",
        }),
      ],
    });

    renderHistory();

    expect(
      screen.getByText("Let's refactor the session list query"),
    ).toBeInTheDocument();
    // Browse rows preview at one line; only search results get the taller clamp.
    expect(screen.getByTestId("session-snippet-session-1")).toHaveAttribute(
      "data-line-clamp",
      "1",
    );
  });

  it("does not use the session preview as a metadata search snippet", async () => {
    const user = userEvent.setup();
    setSessionStoreState({
      sessions: [
        session({
          title: "Needle Chat",
          subtitle: "Latest session text",
        }),
      ],
    });
    // Title match only: the server finds nothing in the message content.
    mocks.acpSearchSessions.mockImplementation(async () => ({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [],
    }));

    renderHistory();

    await user.type(screen.getByRole("searchbox"), "Needle{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Needle Chat")).toBeInTheDocument();
      expect(screen.queryByText("Latest session text")).not.toBeInTheDocument();
    });
  });

  it("focuses an existing session window from history when session windows are supported", async () => {
    const user = userEvent.setup();
    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session:a" }]);
    setSessionStoreState({
      sessions: [session()],
    });

    renderHistory();

    await user.click(
      await screen.findByRole("button", { name: /open window chat one/i }),
    );

    expect(focusSessionWindow).toHaveBeenCalledWith("session-1");
    expect(openSessionWindow).not.toHaveBeenCalled();
  });

  it("loads the next session page near the bottom without immediately repeating", async () => {
    let scroller: HTMLElement | null = null;
    const secondPageSession = session({
      id: "session-2",
      title: "Chat Two",
      updatedAt: "2026-04-09T12:01:00.000Z",
    });
    const loadMoreSessions = vi.fn(async () => {
      useChatSessionStore.setState((state) => ({
        sessions: [...state.sessions, secondPageSession],
        hasMoreSessions: true,
        isLoadingMoreSessions: false,
        sessionPageCursor: "cursor-2",
      }));
      if (scroller) {
        setScrollMetrics(scroller, { scrollHeight: 2200, clientHeight: 600 });
      }
    });
    setSessionStoreState({
      sessions: [session()],
      hasMoreSessions: true,
      sessionPageCursor: "cursor-1",
      loadMoreSessions,
    });

    renderHistory();
    expect(screen.getByText("Chat One")).toBeInTheDocument();

    scroller = setHistoryScrollMetrics();

    scrollHistoryTo(200);
    expect(loadMoreSessions).not.toHaveBeenCalled();

    scrollHistoryTo(400);

    await waitFor(() => {
      expect(loadMoreSessions).toHaveBeenCalledOnce();
      expect(screen.getByText("Chat Two")).toBeInTheDocument();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(loadMoreSessions).toHaveBeenCalledOnce();
  });

  it("loads another page when the viewport is underfilled and exposes loading status", async () => {
    const loadMoreSessions = vi.fn().mockResolvedValue(undefined);
    setSessionStoreState({
      sessions: [session()],
      hasMoreSessions: true,
      sessionPageCursor: "cursor-1",
      loadMoreSessions,
    });

    renderHistory();
    setHistoryScrollMetrics({ scrollHeight: 500, clientHeight: 600 });

    fireEvent.resize(window);

    await waitFor(() => {
      expect(loadMoreSessions).toHaveBeenCalledOnce();
    });

    act(() => {
      setSessionStoreState({
        isLoadingMoreSessions: true,
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading more sessions...",
    );
    expect(
      screen.queryByRole("button", { name: /load more/i }),
    ).not.toBeInTheDocument();
  });

  it("loads one more page and searches only newly loaded sessions while scrolling search results", async () => {
    const secondPageSession = session({
      id: "session-2",
      title: "Second Needle Session",
      updatedAt: "2026-04-09T12:01:00.000Z",
    });
    const loadMoreSessions = vi.fn(async () => {
      useChatSessionStore.setState((state) => ({
        sessions: [...state.sessions, secondPageSession],
        hasMoreSessions: false,
        sessionPageCursor: null,
      }));
    });
    setSessionStoreState({
      sessions: [session()],
      hasMoreSessions: true,
      sessionPageCursor: "cursor-1",
      loadMoreSessions,
    });

    renderHistory();

    await userEvent.type(screen.getByRole("searchbox"), "needle{Enter}");

    await waitFor(() => {
      expect(mocks.acpSearchSessions).toHaveBeenCalledWith(
        "needle",
        [expect.objectContaining({ id: "session-1" })],
        expect.anything(),
      );
    });

    setHistoryScrollMetrics();
    scrollHistoryTo(400);

    await waitFor(() => {
      expect(loadMoreSessions).toHaveBeenCalledOnce();
      expect(mocks.acpSearchSessions).toHaveBeenCalledWith(
        "needle",
        [expect.objectContaining({ id: "session-2" })],
        expect.anything(),
      );
      expect(screen.getByText("Second Needle Session")).toBeInTheDocument();
    });
  });

  it("sweeps a page that lands after the scope changed mid-flight", async () => {
    const user = userEvent.setup();
    let releasePage = () => {};
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const loadMoreSessions = vi.fn(async () => {
      await pageGate;
      useChatSessionStore.setState((state) => ({
        sessions: [
          ...state.sessions,
          session({
            id: "session-3",
            title: "Late Archived Needle",
            archivedAt: "2026-04-09T12:06:00.000Z",
            updatedAt: "2026-04-09T12:02:00.000Z",
          }),
        ],
        hasMoreSessions: false,
        sessionPageCursor: null,
      }));
    });
    setSessionStoreState({
      sessions: [
        session({ id: "session-1", title: "Active Needle" }),
        session({
          id: "session-2",
          title: "Archived Needle",
          archivedAt: "2026-04-09T12:05:00.000Z",
          updatedAt: "2026-04-09T12:01:00.000Z",
        }),
      ],
      hasMoreSessions: true,
      sessionPageCursor: "cursor-1",
      loadMoreSessions,
    });

    renderHistory();

    await user.type(screen.getByRole("searchbox"), "needle{Enter}");
    await waitFor(() => {
      expect(mocks.acpSearchSessions).toHaveBeenCalledWith(
        "needle",
        [expect.objectContaining({ id: "session-1" })],
        expect.anything(),
      );
    });

    setHistoryScrollMetrics();
    scrollHistoryTo(400);
    await waitFor(() => expect(loadMoreSessions).toHaveBeenCalledOnce());

    // The scope flips while the page is still in flight, so the resweep that
    // follows owns the search the page will land under.
    await user.click(screen.getByRole("tab", { name: "Archived (1)" }));
    await waitFor(() => {
      expect(mocks.acpSearchSessions).toHaveBeenCalledWith(
        "needle",
        [expect.objectContaining({ id: "session-2" })],
        expect.anything(),
      );
    });

    await act(async () => {
      releasePage();
      await pageGate;
    });

    // The page must be swept for the archived search now on screen, not
    // discarded because it was requested under the active one.
    await waitFor(() => {
      expect(mocks.acpSearchSessions).toHaveBeenCalledWith(
        "needle",
        [expect.objectContaining({ id: "session-3" })],
        expect.anything(),
      );
    });
    expect(await screen.findByText("Late Archived Needle")).toBeInTheDocument();
  });

  it("submits the typed query after the debounce, without Enter", async () => {
    const user = userEvent.setup();
    setSessionStoreState({
      sessions: [session({ title: "Needle Chat" })],
    });

    renderHistory();

    await user.type(screen.getByRole("searchbox"), "needle");

    // Typing alone must not submit: the effect waits out the debounce window.
    expect(mocks.acpSearchSessions).not.toHaveBeenCalled();

    // ...and then submits on its own, with no Enter key.
    await waitFor(() => {
      expect(mocks.acpSearchSessions).toHaveBeenCalledWith(
        "needle",
        [expect.objectContaining({ id: "session-1" })],
        expect.anything(),
      );
    });
  });

  it("probes the grid column template even while in list view", () => {
    setSessionStoreState({ sessions: [session()] });

    renderHistory();

    // The probe must always measure the grid template, or the first grid
    // render would chunk rows with a stale column count.
    expect(screen.getByTestId("session-column-probe").className).toContain(
      "lg:grid-cols-3",
    );
  });

  it("switches between active and archived sessions from the scope tabs", async () => {
    const user = userEvent.setup();
    setSessionStoreState({
      sessions: [
        session({ id: "session-1", title: "Active Chat" }),
        session({
          id: "session-2",
          title: "Archived Chat",
          archivedAt: "2026-04-09T12:05:00.000Z",
        }),
      ],
    });

    renderHistory();

    expect(screen.getByText("Active Chat")).toBeInTheDocument();
    expect(screen.queryByText("Archived Chat")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Archived (1)" }));

    await waitFor(() => {
      expect(screen.getByText("Archived Chat")).toBeInTheDocument();
    });
    expect(screen.queryByText("Active Chat")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Active" }));

    await waitFor(() => {
      expect(screen.getByText("Active Chat")).toBeInTheDocument();
    });
    expect(screen.queryByText("Archived Chat")).not.toBeInTheDocument();
  });

  it("keeps the project filter applied to sessions from a later page", async () => {
    const user = userEvent.setup();
    projectState.projects = [
      { id: "project-a", name: "Project A", workingDirs: ["/a"] },
      { id: "project-b", name: "Project B", workingDirs: ["/b"] },
    ];
    const loadMoreSessions = vi.fn(async () => {
      useChatSessionStore.setState((state) => ({
        sessions: [
          ...state.sessions,
          session({
            id: "session-2",
            title: "Other Project Needle",
            projectId: "project-b",
            updatedAt: "2026-04-09T12:01:00.000Z",
          }),
        ],
        hasMoreSessions: false,
        sessionPageCursor: null,
      }));
    });
    setSessionStoreState({
      sessions: [
        session({
          id: "session-1",
          title: "Filtered Needle",
          projectId: "project-a",
        }),
      ],
      hasMoreSessions: true,
      sessionPageCursor: "cursor-1",
      loadMoreSessions,
    });

    renderHistory();

    await user.click(screen.getByRole("button", { name: "All projects" }));
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "Project A" }),
    );
    await user.keyboard("{Escape}");

    // Search, so the next page is swept as well as rendered: the load-more
    // sweep target is where the filter is easiest to drop.
    await user.type(screen.getByRole("searchbox"), "needle{Enter}");
    await waitFor(() => expect(mocks.acpSearchSessions).toHaveBeenCalled());

    setHistoryScrollMetrics();
    scrollHistoryTo(400);

    await waitFor(() => {
      expect(loadMoreSessions).toHaveBeenCalled();
    });

    // The project-B session must reach neither the sweep nor the screen.
    await waitFor(() => {
      expect(mocks.acpSearchSessions).not.toHaveBeenCalledWith(
        "needle",
        expect.arrayContaining([expect.objectContaining({ id: "session-2" })]),
        expect.anything(),
      );
    });
    expect(screen.queryByText("Other Project Needle")).not.toBeInTheDocument();
  });

  it("persists the view choice and restores it on the next mount", async () => {
    const user = userEvent.setup();
    setSessionStoreState({ sessions: [session()] });

    const first = renderHistory();

    await user.click(screen.getByRole("radio", { name: "Grid view" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("sessions.history.view")).toBe("grid");
    });

    first.unmount();
    renderHistory();

    expect(screen.getByRole("radio", { name: "Grid view" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("invalidates cached row heights when the view toggles", async () => {
    const user = userEvent.setup();
    setSessionStoreState({ sessions: [session()] });

    renderHistory();

    // Mount must not invalidate: nothing has been measured yet.
    expect(mocks.virtualizerMeasure).not.toHaveBeenCalled();

    // Row keys survive the re-chunk, so without an explicit invalidation the
    // heights measured for list rows would be applied to grid rows.
    await user.click(screen.getByRole("radio", { name: "Grid view" }));

    await waitFor(() => {
      expect(mocks.virtualizerMeasure).toHaveBeenCalled();
    });
  });

  it("sweeps newly loaded sessions visible only through a queued message", async () => {
    // messageCount 0 with a queued message: the row renders, because the list
    // counts queued messages as local activity. The load-more sweep must use
    // that same notion of visible, or a rendered row is never searched and
    // "n of m" narrates a total that disagrees with the screen.
    const queuedOnlySession = session({
      id: "session-queued",
      title: "Queued Needle",
      messageCount: 0,
      updatedAt: "2026-04-09T12:01:00.000Z",
    });
    const loadMoreSessions = vi.fn(async () => {
      useChatStore.setState({
        queuedMessageBySession: {
          "session-queued": [
            { kind: "transport-ready", recordId: "q1", payload: {} },
          ],
        },
      } as never);
      useChatSessionStore.setState((state) => ({
        sessions: [...state.sessions, queuedOnlySession],
        hasMoreSessions: false,
        sessionPageCursor: null,
      }));
    });
    setSessionStoreState({
      sessions: [session()],
      hasMoreSessions: true,
      sessionPageCursor: "cursor-1",
      loadMoreSessions,
    });

    renderHistory();

    await userEvent.type(screen.getByRole("searchbox"), "needle{Enter}");
    await waitFor(() => {
      expect(mocks.acpSearchSessions).toHaveBeenCalled();
    });

    setHistoryScrollMetrics();
    scrollHistoryTo(400);

    await waitFor(() => {
      expect(loadMoreSessions).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(mocks.acpSearchSessions).toHaveBeenCalledWith(
        "needle",
        [expect.objectContaining({ id: "session-queued" })],
        expect.anything(),
      );
    });
    // Swept, so its title match reaches the screen.
    expect(screen.getByText("Queued Needle")).toBeInTheDocument();
  });

  it("restores an archived session from the archived scope", async () => {
    const user = userEvent.setup();
    const unarchiveSession = vi.fn().mockResolvedValue(undefined);
    setSessionStoreState({
      sessions: [
        session({
          id: "session-1",
          title: "Archived Chat",
          archivedAt: "2026-04-09T12:05:00.000Z",
        }),
      ],
      unarchiveSession,
    });

    renderHistory();

    await user.click(screen.getByRole("tab", { name: "Archived (1)" }));

    // The archive is a real destination, so its rows need the way back out.
    await user.click(
      await screen.findByRole("button", { name: "Restore Archived Chat" }),
    );

    expect(unarchiveSession).toHaveBeenCalledWith("session-1");
  });

  it("drops a restored session from archived search results", async () => {
    const user = userEvent.setup();
    // Restore really clears archivedAt, so the session leaves the archived set
    // that the submitted query was swept against.
    const unarchiveSession = vi.fn(async (id: string) => {
      useChatSessionStore.setState((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === id
            ? { ...candidate, archivedAt: undefined }
            : candidate,
        ),
      }));
    });
    setSessionStoreState({
      sessions: [
        session({
          id: "session-1",
          title: "Archived Needle",
          archivedAt: "2026-04-09T12:05:00.000Z",
        }),
      ],
      unarchiveSession,
    });

    renderHistory();

    await user.click(screen.getByRole("tab", { name: "Archived (1)" }));
    await user.type(screen.getByRole("searchbox"), "needle{Enter}");

    expect(await screen.findByText("Archived Needle")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Restore Archived Needle" }),
    );

    // The row is no longer archived, so it must leave the archived results
    // instead of sitting there offering to be restored again.
    await waitFor(() => {
      expect(screen.queryByText("Archived Needle")).not.toBeInTheDocument();
    });
  });

  it("counts archived sessions through the active project filter", async () => {
    const user = userEvent.setup();
    projectState.projects = [
      { id: "project-a", name: "Project A", workingDirs: ["/a"] },
      { id: "project-b", name: "Project B", workingDirs: ["/b"] },
    ];
    setSessionStoreState({
      sessions: [
        session({ id: "session-1", title: "Active A", projectId: "project-a" }),
        session({
          id: "session-2",
          title: "Archived B",
          projectId: "project-b",
          archivedAt: "2026-04-09T12:05:00.000Z",
        }),
      ],
    });

    renderHistory();

    // Unfiltered, the one archived session counts.
    expect(
      screen.getByRole("tab", { name: "Archived (1)" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All projects" }));
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "Project A" }),
    );
    // The filter menu stays open on select; while it is, Radix marks the rest
    // of the page aria-hidden, so the tab is unreachable by role until it closes.
    await user.keyboard("{Escape}");

    // Only project B has an archived session, so filtering to A must read 0 —
    // the tab label must not promise rows the tab cannot show.
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "Archived (0)" }),
      ).toBeInTheDocument();
    });
  });

  it("re-runs the submitted search when the empty state switches to archived", async () => {
    const user = userEvent.setup();
    setSessionStoreState({
      sessions: [
        session({ id: "session-1", title: "Chat One" }),
        session({
          id: "session-2",
          title: "Archived Needle",
          archivedAt: "2026-04-09T12:05:00.000Z",
          updatedAt: "2026-04-09T12:05:00.000Z",
        }),
      ],
    });

    // "needle" matches nothing in content; only the archived session's title
    // matches, and it is outside the active scope.
    mocks.acpSearchSessions.mockImplementation(async () => ({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [],
    }));

    renderHistory();

    await user.type(screen.getByRole("searchbox"), "needle{Enter}");

    expect(
      await screen.findByText('No sessions match "needle"'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /search archived/i }));

    await waitFor(() => {
      expect(screen.getByText("Archived Needle")).toBeInTheDocument();
    });
    expect(
      screen.queryByText('No sessions match "needle"'),
    ).not.toBeInTheDocument();
  });

  // Regression: every keystroke used to reset the search hook, so for the
  // 300ms debounce window the page fell back to unfiltered browse history
  // under a non-empty search box — unrelated rows flashing in mid-typing.
  it("keeps the previous search context while an edited query is pending", async () => {
    const user = userEvent.setup();
    setSessionStoreState({
      sessions: [
        session({ id: "session-1", title: "Needle Chat" }),
        session({
          id: "session-2",
          title: "Unrelated Chat",
          updatedAt: "2026-04-09T12:05:00.000Z",
        }),
      ],
    });

    // Title match only, so the premise (a metadata hit with no content match
    // behind it) does not depend on the default match-everything sweep.
    mocks.acpSearchSessions.mockImplementation(async () => ({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [],
    }));

    renderHistory();

    await user.type(screen.getByRole("searchbox"), "needle{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Needle Chat")).toBeInTheDocument();
    });
    expect(screen.queryByText("Unrelated Chat")).not.toBeInTheDocument();

    // One more character: the next query has not been submitted yet.
    await user.type(screen.getByRole("searchbox"), "s");

    // The browse list must not reappear underneath the search box...
    expect(screen.queryByText("Unrelated Chat")).not.toBeInTheDocument();
    // ...and the matched row stays put rather than blinking out.
    expect(screen.getByText("Needle Chat")).toBeInTheDocument();
    // The status stops claiming the old count describes what is typed. (The
    // page also carries an sr-only pagination status, hence the text query.)
    expect(screen.getByText("Searching as you type…")).toBeInTheDocument();
    expect(screen.queryByText(/1 result/)).not.toBeInTheDocument();
  });

  it("restores a whole archived selection from one row's menu", async () => {
    const user = userEvent.setup();
    const unarchiveSession = vi.fn().mockResolvedValue(undefined);
    setSessionStoreState({
      sessions: [
        session({
          id: "session-1",
          title: "Archived One",
          archivedAt: "2026-04-09T12:05:00.000Z",
        }),
        session({
          id: "session-2",
          title: "Archived Two",
          archivedAt: "2026-04-09T12:06:00.000Z",
          updatedAt: "2026-04-09T12:06:00.000Z",
        }),
      ],
      unarchiveSession,
    });

    renderHistory();

    await user.click(screen.getByRole("tab", { name: "Archived (2)" }));

    await user.click(
      await screen.findByRole("button", { name: "Select Archived One" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Select Archived Two" }),
    );

    // A menu labelled with a selection count must act on the selection: it
    // used to restore only the row whose menu was open, leaving the rest
    // archived and still selected.
    await user.click(
      screen.getByRole("button", { name: "Restore selected Archived One" }),
    );

    await waitFor(() => {
      expect(unarchiveSession).toHaveBeenCalledWith("session-1");
      expect(unarchiveSession).toHaveBeenCalledWith("session-2");
    });
  });

  it("offers a clear-filters route when a filter empties the archived tab", async () => {
    const user = userEvent.setup();
    projectState.projects = [
      { id: "project-a", name: "Project A", workingDirs: ["/a"] },
      { id: "project-b", name: "Project B", workingDirs: ["/b"] },
    ];
    setSessionStoreState({
      sessions: [
        session({ id: "session-1", title: "Active A", projectId: "project-a" }),
        session({
          id: "session-2",
          title: "Archived B",
          projectId: "project-b",
          archivedAt: "2026-04-09T12:05:00.000Z",
        }),
      ],
    });

    renderHistory();

    await user.click(screen.getByRole("button", { name: "All projects" }));
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "Project A" }),
    );
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("tab", { name: "Archived (0)" }));

    // The archive is not empty — it holds Archived B, just outside the
    // filter. Saying "No archived sessions" would send the user away.
    expect(
      await screen.findByText("No sessions match these filters"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No archived chats are in the selected projects."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No archived sessions")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(screen.getByText("Archived B")).toBeInTheDocument();
    });
  });

  // Regression: the active date came from `getVirtualItems()[0]`, which is an
  // overscan row above the viewport, so the scrubber lagged a section behind.
  it("tracks the first genuinely visible date group, not the first rendered row", async () => {
    setSessionStoreState({
      sessions: [
        session({
          id: "session-1",
          title: "Newer Chat",
          updatedAt: "2026-04-09T12:00:00.000Z",
        }),
        session({
          id: "session-2",
          title: "Older Chat",
          updatedAt: "2026-04-01T12:00:00.000Z",
        }),
      ],
    });

    // Scrolled past the first date group entirely: rows 0-1 are rendered as
    // overscan but sit above the viewport.
    mocks.virtualizerState.scrollOffset = 320;

    renderHistory();

    const scrubber = await screen.findByRole("slider", {
      name: "Jump to date",
    });

    // The scrubber narrates the group the user is actually looking at.
    await waitFor(() => {
      expect(scrubber).toHaveAttribute("aria-valuetext", "April 1, 2026");
    });
  });

  it("reports failed archive outcomes from bulk history actions", async () => {
    const user = userEvent.setup();
    const onArchiveChat = vi.fn().mockResolvedValue({
      ok: false,
      reason: "blocked_unsaved_changes",
    });
    setSessionStoreState({ sessions: [session()] });

    render(<SessionHistoryView onArchiveChat={onArchiveChat} />);

    await user.click(screen.getByRole("button", { name: "Select Chat One" }));
    await user.click(screen.getByRole("button", { name: "Archive selected" }));
    await user.click(await screen.findByRole("button", { name: /^archive$/i }));

    await waitFor(() => {
      expect(onArchiveChat).toHaveBeenCalledWith("session-1");
      expect(mocks.toastError).toHaveBeenCalledWith("1 action failed");
    });
  });

  // The bulk helper can only hold its pending state and count failed rows if
  // the action it awaits resolves to the backend outcome. A fire-and-forget
  // restore completes synchronously, so every row would report success and a
  // late rejection would roll the row back with no failure surfaced at all.
  it("reports failed restore outcomes from bulk history actions", async () => {
    const user = userEvent.setup();
    const unarchiveSession = vi
      .fn()
      .mockRejectedValue(new Error("backend refused"));
    setSessionStoreState({
      sessions: [
        session({
          id: "session-1",
          title: "Archived One",
          archivedAt: "2026-04-09T12:05:00.000Z",
        }),
        session({
          id: "session-2",
          title: "Archived Two",
          archivedAt: "2026-04-09T12:06:00.000Z",
          updatedAt: "2026-04-09T12:06:00.000Z",
        }),
      ],
      unarchiveSession,
    });

    renderHistory();

    await user.click(screen.getByRole("tab", { name: "Archived (2)" }));
    await user.click(
      await screen.findByRole("button", { name: "Select Archived One" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Select Archived Two" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Restore selected Archived One" }),
    );

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("2 actions failed");
    });
  });

  it("shows progress and success feedback while importing a session", async () => {
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    let resolveImport!: (value: unknown) => void;
    mocks.acpImportSession.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    setSessionStoreState({
      sessions: [],
      loadSessions,
    });

    renderHistory();

    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error("Missing file input");

    const file = new File(['{"conversation":[]}'], "imported-session.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", {
      value: vi.fn().mockResolvedValue('{"conversation":[]}'),
    });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Importing session")).toBeInTheDocument();
    expect(screen.getByText(/imported-session\.json/)).toBeInTheDocument();

    resolveImport({
      sessionId: "imported-session",
      title: "Imported Session",
      updatedAt: "2026-04-09T12:02:00.000Z",
      createdAt: "2026-04-09T12:02:00.000Z",
      archivedAt: null,
      userSetName: true,
      messageCount: 3,
      subtitle: null,
      workingDir: null,
      projectId: null,
      providerId: null,
      modelId: null,
      personaId: null,
    });

    await waitFor(() => {
      expect(loadSessions).toHaveBeenCalledOnce();
      expect(screen.getByRole("alert")).toHaveTextContent("Import complete");
      expect(screen.getByText("Imported Session")).toBeInTheDocument();
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Imported Imported Session",
        expect.objectContaining({ action: undefined }),
      );
    });
  });

  it("shows import errors in the page and toast", async () => {
    mocks.acpImportSession.mockRejectedValue(new Error("invalid export"));
    setSessionStoreState({
      sessions: [],
      loadSessions: vi.fn(),
    });

    renderHistory();

    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error("Missing file input");

    const file = new File(["not-json"], "broken.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", {
      value: vi.fn().mockResolvedValue("not-json"),
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Import failed");
      expect(screen.getByRole("alert")).toHaveTextContent("invalid export");
      expect(mocks.toastError).toHaveBeenCalledWith("Import failed", {
        description: "invalid export",
      });
    });
  });

  it("reports the renamed file from the native export save path", async () => {
    mocks.acpExportSession.mockResolvedValue('{"messages":[]}');
    vi.mocked(saveExportedSessionFile).mockResolvedValue(
      "/Users/kalvin/Desktop/test.json",
    );
    setSessionStoreState({
      sessions: [session({ title: "Codebase Research" })],
    });

    renderHistory();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(saveExportedSessionFile).toHaveBeenCalledWith(
        "Codebase Research.json",
        '{"messages":[]}',
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Exported Codebase Research to test.json",
      );
    });
  });
});

describe("server-discovered matches", () => {
  function matchedInfo(sessionId: string, title: string) {
    return {
      sessionId,
      title,
      updatedAt: "2026-04-12T12:00:00Z",
      createdAt: "2026-04-12T12:00:00Z",
      lastMessageAt: null,
      archivedAt: null,
      userSetName: false,
      messageCount: 3,
      subtitle: null,
      workingDir: null,
      projectId: null,
      providerId: null,
      modelId: null,
      personaId: null,
    };
  }

  it("renders a content match for a session that is not loaded", async () => {
    const user = userEvent.setup();
    setSessionStoreState({ sessions: [session()] });
    mocks.acpSearchSessions.mockImplementation(async () => ({
      results: [],
      // Production searchedIds ⊆ matchedInfos: only server-matched targets
      // are export-enriched.
      searchedIds: [],
      failedIds: [],
      matchedInfos: [matchedInfo("old-1", "Old Needle Chat")],
    }));

    renderHistory();

    await user.type(screen.getByRole("searchbox"), "needle{Enter}");

    expect(await screen.findByText("Old Needle Chat")).toBeInTheDocument();
  });

  it("excludes a discovered match the project filter rules out", async () => {
    const user = userEvent.setup();
    projectState.projects = [
      { id: "project-a", name: "Project A", workingDirs: ["/a"] },
    ];
    setSessionStoreState({
      sessions: [session({ projectId: "project-a" })],
    });
    mocks.acpSearchSessions.mockImplementation(async () => ({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [
        // An admitted in-project discovery alongside the excluded one, so the
        // test proves the response was applied rather than ignored wholesale.
        { ...matchedInfo("old-2", "Project A Needle"), projectId: "project-a" },
        {
          ...matchedInfo("old-1", "Other Project Needle"),
          projectId: "other",
        },
      ],
    }));

    renderHistory();

    await user.click(screen.getByRole("button", { name: "All projects" }));
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "Project A" }),
    );
    await user.keyboard("{Escape}");

    await user.type(screen.getByRole("searchbox"), "needle{Enter}");

    expect(await screen.findByText("Project A Needle")).toBeInTheDocument();
    expect(screen.queryByText("Other Project Needle")).not.toBeInTheDocument();
  });

  it("routes a discovered row's selection through onSelectSearchResult with its session", async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();
    const onSelectSearchResult = vi.fn();
    setSessionStoreState({ sessions: [session()] });
    mocks.acpSearchSessions.mockImplementation(async () => ({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [matchedInfo("old-1", "Old Needle Chat")],
    }));

    render(
      <SessionHistoryView
        onSelectSession={onSelectSession}
        onSelectSearchResult={onSelectSearchResult}
      />,
    );

    await user.type(screen.getByRole("searchbox"), "needle{Enter}");
    await user.click(
      await screen.findByRole("button", { name: "Open Old Needle Chat" }),
    );

    // Discovered rows must not use plain session selection: the caller needs
    // the row's session to hydrate the store before activating.
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(onSelectSearchResult).toHaveBeenCalledWith(
      "old-1",
      undefined,
      "needle",
      expect.objectContaining({ id: "old-1", title: "Old Needle Chat" }),
    );
  });

  it("hides store-backed actions on a discovered row but keeps export and open", async () => {
    const user = userEvent.setup();
    setSessionStoreState({ sessions: [session()] });
    mocks.acpSearchSessions.mockImplementation(async () => ({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [matchedInfo("old-1", "Old Needle Chat")],
    }));

    renderHistory();

    await user.type(screen.getByRole("searchbox"), "needle{Enter}");
    await screen.findByText("Old Needle Chat");

    expect(
      screen.getByRole("button", { name: "Open Old Needle Chat" }),
    ).toBeInTheDocument();
    // Not in the store: rename/fork/archive would silently no-op, so the row
    // must not offer them.
    expect(
      screen.queryByRole("button", { name: "Rename Old Needle Chat" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Fork Old Needle Chat" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive Old Needle Chat" }),
    ).not.toBeInTheDocument();
  });
});
