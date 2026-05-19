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
import { SessionHistoryView } from "../SessionHistoryView";

const acpSearchSessions = vi.fn();

vi.mock("@/shared/api/acp", () => ({
  acpDuplicateSession: vi.fn(),
  acpExportSession: vi.fn(),
  acpImportSession: vi.fn(),
  acpSearchSessions: (...args: unknown[]) => acpSearchSessions(...args),
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
  SessionCard: ({ title }: { title: string }) => (
    <div data-testid="session-card">{title}</div>
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
    useChatStore.setState({ messagesBySession: {} });
    setSessionStoreState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      hasMoreSessions: false,
      isLoadingMoreSessions: false,
      loadMoreSessions: undefined,
    });
    acpSearchSessions.mockResolvedValue([]);
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
      expect(acpSearchSessions).toHaveBeenCalledWith("needle", ["session-1"]);
    });

    setHistoryScrollMetrics();
    scrollHistoryTo(400);

    await waitFor(() => {
      expect(loadMoreSessions).toHaveBeenCalledOnce();
      expect(acpSearchSessions).toHaveBeenCalledWith("needle", ["session-2"]);
      expect(screen.getByText("Second Needle Session")).toBeInTheDocument();
    });
  });
});
