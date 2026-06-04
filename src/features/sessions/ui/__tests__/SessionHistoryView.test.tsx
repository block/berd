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
  openSessionWindow,
} from "@/features/chat/lib/sessionWindowCommands";
import { MULTI_WINDOW_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import { SessionHistoryView } from "../SessionHistoryView";

const mocks = vi.hoisted(() => ({
  acpDuplicateSession: vi.fn(),
  acpExportSession: vi.fn(),
  acpImportSession: vi.fn(),
  acpSearchSessions: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpDuplicateSession: (...args: unknown[]) =>
    mocks.acpDuplicateSession(...args),
  acpExportSession: (...args: unknown[]) => mocks.acpExportSession(...args),
  acpImportSession: (...args: unknown[]) => mocks.acpImportSession(...args),
  acpSearchSessions: (...args: unknown[]) => mocks.acpSearchSessions(...args),
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  focusSessionWindow: vi.fn().mockResolvedValue(undefined),
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
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 128,
      })),
    measureElement: vi.fn(),
  }),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({
      getPersonaById: () => undefined,
    }),
  },
}));

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ projects: [] }),
}));

vi.mock("@/shared/api/system", () => ({
  saveExportedSessionFile: vi.fn(),
}));

vi.mock("../SessionCard", () => ({
  SessionCard: ({
    id,
    title,
    onDuplicate,
    onOpenInWindow,
    isOpenInWindow,
  }: {
    id: string;
    title: string;
    onDuplicate?: (id: string) => void;
    onOpenInWindow?: (id: string) => void;
    isOpenInWindow?: boolean;
  }) => (
    <div data-testid="session-card">
      <span>{title}</span>
      <button type="button" onClick={() => onDuplicate?.(id)}>
        Duplicate
      </button>
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

describe("SessionHistoryView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
    useChatStore.setState({ messagesBySession: {} });
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
    mocks.acpSearchSessions.mockResolvedValue([]);
  });

  it("does not expose open-in-window from history while the experiment is off", () => {
    setSessionStoreState({
      sessions: [session()],
    });

    renderHistory();

    expect(
      screen.queryByRole("button", { name: /open in new window chat one/i }),
    ).not.toBeInTheDocument();
  });

  it("opens a session window from history while the experiment is on", async () => {
    const user = userEvent.setup();
    setExperimentEnabled(MULTI_WINDOW_EXPERIMENT_ID, true);
    setSessionStoreState({
      sessions: [session()],
    });

    renderHistory();

    await user.click(
      screen.getByRole("button", { name: /open in new window chat one/i }),
    );

    expect(openSessionWindow).toHaveBeenCalledWith("session-1");
    expect(focusSessionWindow).not.toHaveBeenCalled();
  });

  it("focuses an existing session window from history while the experiment is on", async () => {
    const user = userEvent.setup();
    setExperimentEnabled(MULTI_WINDOW_EXPERIMENT_ID, true);
    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session:a" }]);
    setSessionStoreState({
      sessions: [session()],
    });

    renderHistory();

    await user.click(
      screen.getByRole("button", { name: /open window chat one/i }),
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
      expect(mocks.acpSearchSessions).toHaveBeenCalledWith("needle", [
        "session-1",
      ]);
    });

    setHistoryScrollMetrics();
    scrollHistoryTo(400);

    await waitFor(() => {
      expect(loadMoreSessions).toHaveBeenCalledOnce();
      expect(mocks.acpSearchSessions).toHaveBeenCalledWith("needle", [
        "session-2",
      ]);
      expect(screen.getByText("Second Needle Session")).toBeInTheDocument();
    });
  });

  it("duplicates a session with its stored working dir and reloads sessions", async () => {
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    mocks.acpDuplicateSession.mockResolvedValue({ sessionId: "session-2" });
    setSessionStoreState({
      sessions: [session({ workingDir: "/tmp/project" })],
      loadSessions,
    });

    renderHistory();

    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));

    await waitFor(() => {
      expect(mocks.acpDuplicateSession).toHaveBeenCalledWith(
        "session-1",
        "/tmp/project",
        "Copy of Chat One",
      );
      expect(loadSessions).toHaveBeenCalledOnce();
    });
  });

  it("ignores duplicate requests while the same session is already duplicating", async () => {
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    let resolveDuplicate: (value: { sessionId: string }) => void = () => {};
    mocks.acpDuplicateSession.mockReturnValue(
      new Promise((resolve) => {
        resolveDuplicate = resolve;
      }),
    );
    setSessionStoreState({
      sessions: [session({ workingDir: "/tmp/project" })],
      loadSessions,
    });

    renderHistory();

    const duplicateButton = screen.getByRole("button", { name: "Duplicate" });
    await userEvent.click(duplicateButton);
    await userEvent.click(duplicateButton);

    expect(mocks.acpDuplicateSession).toHaveBeenCalledOnce();

    act(() => {
      resolveDuplicate({ sessionId: "session-2" });
    });

    await waitFor(() => {
      expect(loadSessions).toHaveBeenCalledOnce();
    });
  });

  it("does not duplicate a session without a working dir", async () => {
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    setSessionStoreState({
      sessions: [session({ workingDir: null })],
      loadSessions,
    });

    renderHistory();

    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));

    expect(mocks.acpDuplicateSession).not.toHaveBeenCalled();
    expect(loadSessions).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This session has no working directory and can't be duplicated.",
    );
  });
});
