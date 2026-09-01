import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { SessionChatRuntime } from "@/shared/types/chat";
import { QueuedMessageOwnershipLostError } from "./preCommitSendRejection";
import { dispatchPrompt } from "./sendCore";

const mocks = vi.hoisted(() => ({
  acpSendMessage: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
}));

describe("dispatchPrompt pre-commit rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
    useChatSessionStore.setState({ sessions: [], activeSessionId: null });
  });

  it("preserves the complete newer-owner runtime on ownership loss", async () => {
    let newerOwnerRuntime: SessionChatRuntime | undefined;
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        const store = useChatStore.getState();
        store.setError("session-1", "newer owner error");
        store.setChatState("session-1", "streaming");
        store.setPendingAssistantProvider("session-1", "newer-provider");
        store.setActiveRunId("session-1", "newer-run");
        store.setRunCancellationPending("session-1", true);
        newerOwnerRuntime = structuredClone(
          store.getSessionRuntime("session-1"),
        );
        options.onPromptDispatching();
        return Promise.resolve();
      },
    );

    await expect(
      dispatchPrompt("session-1", "stale queued turn", {
        beforeUserMessageCommitted: () => {
          throw new QueuedMessageOwnershipLostError();
        },
      }),
    ).rejects.toBeInstanceOf(QueuedMessageOwnershipLostError);

    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
    expect(useChatStore.getState().getSessionRuntime("session-1")).toEqual(
      newerOwnerRuntime,
    );
  });

  it("never sends local attachment paths to a remote session", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Remote chat",
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
          messageCount: 0,
          remoteHost: "devbox",
        },
      ],
      activeSessionId: "session-1",
    });
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "review", {
      attachments: [
        {
          id: "file",
          kind: "file",
          name: "notes.md",
          path: "/Users/me/notes.md",
        },
        {
          id: "image",
          kind: "image",
          name: "diagram.png",
          path: "/Users/me/diagram.png",
          mimeType: "image/png",
          base64: "abc",
          previewUrl: "asset://diagram.png",
        },
      ],
    });

    expect(mocks.acpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "review",
      expect.objectContaining({ images: [["abc", "image/png"]] }),
    );
  });
});
