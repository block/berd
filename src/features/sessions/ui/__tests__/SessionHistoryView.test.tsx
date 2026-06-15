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
}));

vi.mock("@/shared/api/acp", () => ({
  acpExportSession: (...args: unknown[]) => mocks.acpExportSession(...args),
  acpImportSession: (...args: unknown[]) => mocks.acpImportSession(...args),
  acpSearchSessions: (...args: unknown[]) => mocks.acpSearchSessions(...args),
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
  saveExportedSessionFiles: vi.fn(),
}));

vi.mock("../SessionCard", () => ({
  SessionCard: ({
    id,
    title,
    onExport,
    onOpenInWindow,
    isOpenInWindow,
    snippet,
    snippetLineClamp,
  }: {
    id: string;
    title: string;
    onExport?: (id: string) => void;
    onOpenInWindow?: (id: string) => void;
    isOpenInWindow?: boolean;
    snippet?: string;
    snippetLineClamp?: 1 | 3;
  }) => (
    <div data-testid="session-card">
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
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    vi.clearAllMocks();
    vi.mocked(getSessionWindowSupport).mockResolvedValue({
      supported: true,
      reason: undefined,
    });
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

  it("does not expose open-in-window from history when session windows are unsupported", async () => {
    vi.mocked(getSessionWindowSupport).mockResolvedValue({
      supported: false,
      reason: "unsupported platform",
    });
    setSessionStoreState({
      sessions: [session()],
    });

    renderHistory();

    await waitFor(() => expect(getSessionWindowSupport).toHaveBeenCalled());
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

  it("renders the latest session text on history cards", () => {
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
