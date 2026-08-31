import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionMessagesAndPrepare } from "@/features/chat/lib/sessionActivation";
import type { SessionHandoffSnapshotAvailable } from "@/features/chat/lib/sessionHandoffEvents";
import {
  joinSessionHandoff,
  listSessionWindows,
  readSessionHandoffSnapshot,
  recoverSessionHandoff,
  type SessionHandoffSnapshot,
} from "@/features/chat/lib/sessionWindowCommands";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

const handoffListeners = vi.hoisted(() => ({
  available: undefined as
    | ((payload: SessionHandoffSnapshotAvailable) => void)
    | undefined,
  searchTarget: undefined as
    | ((payload: {
        sessionId: string;
        messageId: string;
        query?: string;
      }) => void)
    | undefined,
}));

const mocks = vi.hoisted(() => ({
  buildFeatures: {
    securityMl: true,
  },
  remoteSessionsEnabled: true,
  setVoiceConversationForegroundSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/lib/chatRuntimeStartup", () => ({
  runChatRuntimeStartup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock(
  "@/features/chat/hooks/useRemoteSessionExperimentReconciliation",
  () => ({
    useRemoteSessionExperimentReconciliation: () => mocks.remoteSessionsEnabled,
  }),
);

vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => mocks.buildFeatures,
}));

vi.mock("@/features/chat/lib/sessionActivation", () => ({
  activateSession: vi.fn(),
  loadSessionMessages: vi.fn().mockResolvedValue(undefined),
  loadSessionMessagesAndPrepare: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/chat/lib/sessionHandoffEvents", () => ({
  listenSessionHandoffSnapshotAvailable: vi.fn((handler) => {
    handoffListeners.available = handler;
    return Promise.resolve(() => {
      handoffListeners.available = undefined;
    });
  }),
}));

vi.mock("@/features/chat/lib/sessionWindowSearchEvents", () => ({
  listenSessionWindowSearchTarget: vi.fn((handler) => {
    handoffListeners.searchTarget = handler;
    return Promise.resolve(() => {
      handoffListeners.searchTarget = undefined;
    });
  }),
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  joinSessionHandoff: vi.fn().mockResolvedValue({ mode: "owned" }),
  listSessionWindows: vi.fn().mockResolvedValue([]),
  readSessionHandoffSnapshot: vi.fn().mockResolvedValue(null),
  recoverSessionHandoff: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/chat/ui/ChatView", () => ({
  ChatView: ({
    readOnlyStatus,
    sessionId,
  }: {
    readOnlyStatus?: string;
    sessionId: string;
  }) => (
    <div data-read-only-status={readOnlyStatus ?? ""} data-testid="chat-view">
      chat:{sessionId}
    </div>
  ),
}));

vi.mock("@/features/voice-conversation/api/voiceConversation", () => ({
  setVoiceConversationForegroundSession:
    mocks.setVoiceConversationForegroundSession,
}));

import { SessionWindowApp } from "@/app/SessionWindowApp";

const session: ChatSession = {
  id: "session-1",
  title: "Session One",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
  messageCount: 1,
};

const handoffEntry = {
  sessionId: "session-1",
  windowLabel: "session:session-1",
  mode: {
    handoff: {
      fromLabel: "main",
      toLabel: "session:session-1",
      destinationReady: false,
      latestVersion: 0,
      finalVersion: null,
    },
  },
} as const;

const textMessage = (id: string, text: string): Message => ({
  id,
  role: "assistant",
  created: 1,
  content: [{ type: "text", text }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function seedSession() {
  useChatSessionStore.setState({
    sessions: [session],
    activeSessionId: null,
    hasHydratedSessions: true,
  });
}

function renderSessionWindow() {
  return render(
    <SessionWindowApp
      sessionId="session-1"
      currentWindowLabel="session:session-1"
    />,
  );
}

function handoffSnapshot(
  message?: Message,
  isFinal = false,
  queuedMessages: SessionHandoffSnapshot["payload"]["queuedMessages"] = [],
): SessionHandoffSnapshot {
  return {
    version: isFinal ? 2 : 1,
    isFinal,
    payload: {
      sessionId: "session-1",
      fromLabel: "main",
      toLabel: "session:session-1",
      messages: message ? [message] : [],
      queuedMessages,
      sessionState: {
        ...INITIAL_SESSION_CHAT_RUNTIME,
        chatState: isFinal ? "idle" : "streaming",
        streamingMessageId: isFinal ? null : "m1",
      },
    },
  };
}

async function renderMirrorSessionWindow() {
  vi.mocked(listSessionWindows).mockResolvedValue([handoffEntry]);
  vi.mocked(joinSessionHandoff).mockResolvedValue({
    mode: {
      handoff: {
        ...handoffEntry.mode.handoff,
        destinationReady: true,
      },
    },
  });
  renderSessionWindow();
  await screen.findByTestId("chat-view");
  await waitFor(() => expect(handoffListeners.available).toBeDefined());
}

describe("SessionWindowApp", () => {
  beforeEach(() => {
    vi.useRealTimers();
    handoffListeners.available = undefined;
    handoffListeners.searchTarget = undefined;
    mocks.remoteSessionsEnabled = true;
    useSessionWindowStore.getState().setSnapshot([]);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      activeSessionId: null,
      isViewingActiveSession: false,
      loadingSessionIds: new Set(),
      scrollTargetMessageBySession: {},
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      hasHydratedSessions: true,
      isRightRailOpen: false,
    });
    vi.mocked(loadSessionMessagesAndPrepare).mockClear();
    vi.mocked(listSessionWindows).mockReset();
    vi.mocked(listSessionWindows).mockResolvedValue([]);
    vi.mocked(joinSessionHandoff).mockReset();
    vi.mocked(joinSessionHandoff).mockResolvedValue({ mode: "owned" });
    vi.mocked(readSessionHandoffSnapshot).mockReset();
    vi.mocked(readSessionHandoffSnapshot).mockResolvedValue(null);
    vi.mocked(recoverSessionHandoff).mockClear();
    mocks.setVoiceConversationForegroundSession.mockClear();
  });

  it("renders an error state for an unknown session after hydration", async () => {
    render(<SessionWindowApp sessionId="missing" />);

    expect(
      await screen.findByText(/can.t find this session/i),
    ).toBeInTheDocument();
  });

  it("stops rendering a remote session when the experiment is disabled", async () => {
    useChatSessionStore.setState({
      sessions: [{ ...session, remoteHost: "devbox" }],
      activeSessionId: null,
      hasHydratedSessions: true,
    });
    const view = renderSessionWindow();
    await screen.findByTestId("chat-view");

    mocks.remoteSessionsEnabled = false;
    view.rerender(
      <SessionWindowApp
        sessionId="session-1"
        currentWindowLabel="session:session-1"
      />,
    );

    expect(
      await screen.findByText(/can.t find this session/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("chat-view")).not.toBeInTheDocument();
  });

  it("applies message search targets sent from the main window", async () => {
    seedSession();
    renderSessionWindow();
    await screen.findByTestId("chat-view");
    await waitFor(() =>
      expect(mocks.setVoiceConversationForegroundSession).toHaveBeenCalledWith(
        "session-1",
      ),
    );
    await waitFor(() => expect(handoffListeners.searchTarget).toBeDefined());

    act(() => {
      handoffListeners.searchTarget?.({
        sessionId: "session-1",
        messageId: "message-2",
        query: "matched text",
      });
    });

    expect(
      useChatStore.getState().scrollTargetMessageBySession["session-1"],
    ).toEqual({ messageId: "message-2", query: "matched text" });
  });

  it("renders handoff sessions in read-only mirror mode without loading ACP history", async () => {
    seedSession();
    await renderMirrorSessionWindow();

    expect(screen.getByTestId("chat-view")).toHaveAttribute(
      "data-read-only-status",
      "Finishing current response...",
    );
    expect(loadSessionMessagesAndPrepare).not.toHaveBeenCalled();
  });

  it("shows ordinary Context state in a read-only builder mirror", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          ...session,
          intent: "build-agent",
          agentBuilderOpen: true,
          agentBuilderContextState: "autoClosed",
        },
      ],
      activeSessionId: null,
      hasHydratedSessions: true,
      isRightRailOpen: true,
    });

    await renderMirrorSessionWindow();

    const toggle = screen.getByRole("button", { name: "Close right rail" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);

    expect(useChatSessionStore.getState().isRightRailOpen).toBe(false);
    expect(
      useChatSessionStore.getState().getSession("session-1")
        ?.agentBuilderContextState,
    ).toBe("autoClosed");
  });

  it("mounts owned chat windows while persisted history is still loading", async () => {
    seedSession();
    const historyLoad = deferred<boolean>();
    vi.mocked(loadSessionMessagesAndPrepare).mockReturnValueOnce(
      historyLoad.promise,
    );

    renderSessionWindow();

    expect(await screen.findByTestId("chat-view")).toHaveAttribute(
      "data-read-only-status",
      "",
    );
    expect(loadSessionMessagesAndPrepare).toHaveBeenCalledWith("session-1", {
      force: undefined,
    });

    act(() => {
      historyLoad.resolve(true);
    });
  });

  it("applies handoff snapshots pulled from rust", async () => {
    seedSession();
    await renderMirrorSessionWindow();
    const message = textMessage("m1", "live token");
    vi.mocked(readSessionHandoffSnapshot).mockResolvedValueOnce(
      handoffSnapshot(message),
    );

    act(() => {
      handoffListeners.available?.({
        sessionId: "session-1",
        toLabel: "session:session-1",
        version: 1,
        isFinal: false,
      });
    });

    await waitFor(() => {
      expect(useChatStore.getState().messagesBySession["session-1"]).toEqual([
        message,
      ]);
    });
    expect(
      useChatStore.getState().sessionStateById["session-1"]?.chatState,
    ).toBe("streaming");
  });

  it("applies queued records from the final ownership handoff", async () => {
    seedSession();
    await renderMirrorSessionWindow();
    vi.mocked(readSessionHandoffSnapshot).mockResolvedValueOnce(
      handoffSnapshot(undefined, true, [
        {
          kind: "transport-ready",
          recordId: "queued-during-detach",
          payload: {
            persona: { kind: "inherit" },
            text: "follow up",
            sendOptions: {
              userMessageMetadata: { origin: "berdctl_cross_session" },
            },
          },
        },
      ]),
    );

    act(() => {
      handoffListeners.available?.({
        sessionId: "session-1",
        toLabel: "session:session-1",
        version: 2,
        isFinal: true,
      });
    });

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toMatchObject([{ recordId: "queued-during-detach" }]);
    });
  });

  it("applies final snapshot and becomes writable without persisted reload", async () => {
    seedSession();
    await renderMirrorSessionWindow();
    vi.mocked(loadSessionMessagesAndPrepare).mockClear();
    const message = textMessage("m1", "done");
    vi.mocked(readSessionHandoffSnapshot).mockResolvedValueOnce(
      handoffSnapshot(message, true),
    );

    act(() => {
      handoffListeners.available?.({
        sessionId: "session-1",
        toLabel: "session:session-1",
        version: 2,
        isFinal: true,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-view")).toHaveAttribute(
        "data-read-only-status",
        "",
      );
    });
    expect(loadSessionMessagesAndPrepare).not.toHaveBeenCalled();
  });

  it("can open the context panel from the session window top bar", async () => {
    seedSession();
    renderSessionWindow();

    await screen.findByTestId("chat-view");

    fireEvent.click(screen.getByRole("button", { name: "Open right rail" }));

    expect(useChatSessionStore.getState().isRightRailOpen).toBe(true);
  });

  it("recovers a missed initial snapshot through join", async () => {
    seedSession();
    const message = textMessage("m1", "early");
    vi.mocked(listSessionWindows).mockResolvedValue([handoffEntry]);
    vi.mocked(joinSessionHandoff).mockResolvedValue({
      mode: {
        handoff: {
          ...handoffEntry.mode.handoff,
          destinationReady: true,
          latestVersion: 1,
        },
      },
      snapshot: handoffSnapshot(message),
    });

    renderSessionWindow();

    await waitFor(() => {
      expect(useChatStore.getState().messagesBySession["session-1"]).toEqual([
        message,
      ]);
    });
    expect(screen.getByTestId("chat-view")).toHaveAttribute(
      "data-read-only-status",
      "Finishing current response...",
    );
    await waitFor(() => {
      expect(readSessionHandoffSnapshot).toHaveBeenCalledWith("session-1", 1);
    });
  });

  it("does not reload persisted history when ownership changes before the final snapshot is pulled", async () => {
    seedSession();
    await renderMirrorSessionWindow();
    vi.mocked(loadSessionMessagesAndPrepare).mockClear();

    act(() => {
      useSessionWindowStore.getState().setSnapshot([
        {
          sessionId: "session-1",
          windowLabel: "session:session-1",
          mode: "owned",
        },
      ]);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByTestId("chat-view")).toHaveAttribute(
      "data-read-only-status",
      "Finishing current response...",
    );
    expect(loadSessionMessagesAndPrepare).not.toHaveBeenCalled();
  });

  it("shows a reload action when no handoff snapshot arrives", async () => {
    seedSession();
    await renderMirrorSessionWindow();

    expect(
      await screen.findByText("Session handoff paused", {}, { timeout: 5500 }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Reload session" }));

    await waitFor(() => {
      expect(recoverSessionHandoff).toHaveBeenCalledWith("session-1");
      expect(loadSessionMessagesAndPrepare).toHaveBeenCalledWith("session-1", {
        force: true,
      });
    });
  }, 7000);
});
