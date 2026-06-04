import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";
import type {
  SessionHandoffComplete,
  SessionHandoffFailed,
  SessionHandoffSnapshot,
} from "@/features/chat/lib/sessionHandoffEvents";
import { listSessionWindows } from "@/features/chat/lib/sessionWindowCommands";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

const handoffListeners = vi.hoisted(() => ({
  complete: undefined as
    | ((payload: SessionHandoffComplete) => void)
    | undefined,
  failed: undefined as ((payload: SessionHandoffFailed) => void) | undefined,
  snapshot: undefined as
    | ((payload: SessionHandoffSnapshot) => void)
    | undefined,
}));

vi.mock("@/app/lib/chatRuntimeStartup", () => ({
  runChatRuntimeStartup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/chat/lib/sessionActivation", () => ({
  activateSession: vi.fn(),
  loadSessionMessages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/chat/lib/sessionHandoffEvents", () => ({
  listenSessionHandoffComplete: vi.fn((handler) => {
    handoffListeners.complete = handler;
    return Promise.resolve(() => {
      handoffListeners.complete = undefined;
    });
  }),
  listenSessionHandoffFailed: vi.fn((handler) => {
    handoffListeners.failed = handler;
    return Promise.resolve(() => {
      handoffListeners.failed = undefined;
    });
  }),
  listenSessionHandoffSnapshots: vi.fn((handler) => {
    handoffListeners.snapshot = handler;
    return Promise.resolve(() => {
      handoffListeners.snapshot = undefined;
    });
  }),
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  listSessionWindows: vi.fn().mockResolvedValue([]),
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
    },
  },
} as const;

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

async function renderMirrorSessionWindow() {
  vi.mocked(listSessionWindows).mockResolvedValue([handoffEntry]);
  renderSessionWindow();
  await screen.findByTestId("chat-view");
  await waitFor(() => expect(handoffListeners.snapshot).toBeDefined());
}

function handoffPayload() {
  return {
    sessionId: "session-1",
    fromLabel: "main",
    toLabel: "session:session-1",
  };
}

describe("SessionWindowApp", () => {
  beforeEach(() => {
    handoffListeners.complete = undefined;
    handoffListeners.failed = undefined;
    handoffListeners.snapshot = undefined;
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
      isContextPanelOpen: false,
    });
    vi.mocked(loadSessionMessages).mockClear();
    vi.mocked(listSessionWindows).mockReset();
    vi.mocked(listSessionWindows).mockResolvedValue([]);
  });

  it("renders an error state for an unknown session after hydration", async () => {
    render(<SessionWindowApp sessionId="missing" />);

    expect(
      await screen.findByText(/can.t find this session/i),
    ).toBeInTheDocument();
  });

  it("renders handoff sessions in read-only mirror mode without loading ACP history", async () => {
    seedSession();
    await renderMirrorSessionWindow();

    expect(screen.getByTestId("chat-view")).toHaveAttribute(
      "data-read-only-status",
      "Finishing current response...",
    );
    expect(loadSessionMessages).not.toHaveBeenCalled();
  });

  it("applies handoff snapshots to the chat store", async () => {
    seedSession();
    await renderMirrorSessionWindow();
    const message: Message = {
      id: "m1",
      role: "assistant",
      created: 1,
      content: [{ type: "text", text: "live token" }],
    };

    act(() => {
      handoffListeners.snapshot?.({
        ...handoffPayload(),
        messages: [message],
        sessionState: {
          ...INITIAL_SESSION_CHAT_RUNTIME,
          chatState: "streaming",
          streamingMessageId: "m1",
        },
      });
    });

    expect(useChatStore.getState().messagesBySession["session-1"]).toEqual([
      message,
    ]);
    expect(
      useChatStore.getState().sessionStateById["session-1"]?.chatState,
    ).toBe("streaming");
  });

  it("force reloads through the destination ACP socket after handoff completion", async () => {
    seedSession();
    await renderMirrorSessionWindow();

    act(() => {
      handoffListeners.complete?.(handoffPayload());
    });

    await waitFor(() => {
      expect(loadSessionMessages).toHaveBeenCalledWith("session-1", {
        force: true,
      });
      expect(screen.getByTestId("chat-view")).toHaveAttribute(
        "data-read-only-status",
        "",
      );
    });
  });

  it("can open the context panel from the session window top bar", async () => {
    seedSession();
    renderSessionWindow();

    await screen.findByTestId("chat-view");

    fireEvent.click(screen.getByRole("button", { name: "Open context panel" }));

    expect(useChatSessionStore.getState().isContextPanelOpen).toBe(true);
  });

  it("recovers when the registry completes handoff before the complete event is heard", async () => {
    seedSession();
    await renderMirrorSessionWindow();

    vi.mocked(loadSessionMessages).mockClear();

    act(() => {
      useSessionWindowStore
        .getState()
        .setSnapshot([
          { sessionId: "session-1", windowLabel: "session:session-1" },
        ]);
    });

    await waitFor(() => {
      expect(loadSessionMessages).toHaveBeenCalledWith("session-1", {
        force: true,
      });
      expect(screen.getByTestId("chat-view")).toHaveAttribute(
        "data-read-only-status",
        "",
      );
    });
  });

  it("shows a reload action when the handoff bridge fails", async () => {
    seedSession();
    await renderMirrorSessionWindow();

    act(() => {
      handoffListeners.failed?.({
        ...handoffPayload(),
        reason: "source closed",
      });
    });

    expect(await screen.findByText("Session handoff paused")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Reload session" }));

    await waitFor(() => {
      expect(loadSessionMessages).toHaveBeenCalledWith("session-1", {
        force: true,
      });
    });
  });
});
