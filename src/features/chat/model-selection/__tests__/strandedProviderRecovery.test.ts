import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { useChatStore } from "../../stores/chatStore";
import {
  collectStrandedComposerText,
  isRecoverableStrandedSession,
  recoverStrandedProviderSession,
} from "../strandedProviderRecovery";

function userMessage(text: string, id = "user-1"): Message {
  return {
    id,
    role: "user",
    created: 0,
    content: [{ type: "text", text }],
  };
}

function assistantMessage(text: string, id = "assistant-1"): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
  };
}

function errorNotification(text: string, id = "system-1"): Message {
  return {
    id,
    role: "system",
    created: 1,
    content: [{ type: "systemNotification", notificationType: "error", text }],
  };
}

function seedSession(messageCount: number) {
  useChatSessionStore.setState({
    sessions: [
      {
        id: "session-1",
        title: "Chat",
        executionTarget: { harnessId: "goose" },
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
        messageCount,
      },
    ],
    activeSessionId: "session-1",
  });
}

const providerNotSet = new Error("Failed to get provider: Provider not set");

describe("isRecoverableStrandedSession", () => {
  beforeEach(() => {
    useChatSessionStore.setState({ sessions: [], activeSessionId: null });
    useChatStore.setState({ messagesBySession: {}, draftsBySession: {} });
  });

  it("recovers when there is no session", () => {
    expect(isRecoverableStrandedSession(null)).toBe(true);
  });

  it("recovers an empty session", () => {
    seedSession(0);
    expect(isRecoverableStrandedSession("session-1")).toBe(true);
  });

  it("recovers a session whose local history is a failed prompt and error bubble", () => {
    seedSession(0);
    useChatStore.setState({
      messagesBySession: {
        "session-1": [
          userMessage("hello"),
          errorNotification("Failed to get provider: Provider not set"),
        ],
      },
    });
    expect(isRecoverableStrandedSession("session-1")).toBe(true);
  });

  it("does not recover a session with committed backend turns", () => {
    seedSession(3);
    expect(isRecoverableStrandedSession("session-1")).toBe(false);
  });

  it("does not recover a session with local assistant content", () => {
    seedSession(0);
    useChatStore.setState({
      messagesBySession: {
        "session-1": [userMessage("hello"), assistantMessage("hi there")],
      },
    });
    expect(isRecoverableStrandedSession("session-1")).toBe(false);
  });
});

describe("collectStrandedComposerText", () => {
  beforeEach(() => {
    useChatStore.setState({ messagesBySession: {}, draftsBySession: {} });
  });

  it("returns empty for a session with nothing typed", () => {
    expect(collectStrandedComposerText("session-1")).toBe("");
  });

  it("collects failed prompt text and skips error notifications", () => {
    useChatStore.setState({
      messagesBySession: {
        "session-1": [
          userMessage("help me fix this bug"),
          errorNotification("Provider not set"),
        ],
      },
    });
    expect(collectStrandedComposerText("session-1")).toBe(
      "help me fix this bug",
    );
  });

  it("joins multiple failed prompts and the live draft", () => {
    useChatStore.setState({
      messagesBySession: {
        "session-1": [
          userMessage("first try", "user-1"),
          errorNotification("Provider not set", "system-1"),
          userMessage("second try", "user-2"),
          errorNotification("Provider not set", "system-2"),
        ],
      },
      draftsBySession: { "session-1": "  third try  " },
    });
    expect(collectStrandedComposerText("session-1")).toBe(
      "first try\n\nsecond try\n\nthird try",
    );
  });
});

describe("recoverStrandedProviderSession", () => {
  beforeEach(() => {
    useChatSessionStore.setState({ sessions: [], activeSessionId: null });
    useChatStore.setState({ messagesBySession: {}, draftsBySession: {} });
    seedSession(0);
  });

  it("returns false without a recreate callback", async () => {
    await expect(
      recoverStrandedProviderSession({
        error: providerNotSet,
        sessionId: "session-1",
        providerId: "anthropic",
      }),
    ).resolves.toBe(false);
  });

  it("returns false for unrelated errors", async () => {
    const recreateSessionForProvider = vi.fn();
    await expect(
      recoverStrandedProviderSession({
        error: new Error("network down"),
        sessionId: "session-1",
        providerId: "anthropic",
        recreateSessionForProvider,
      }),
    ).resolves.toBe(false);
    expect(recreateSessionForProvider).not.toHaveBeenCalled();
  });

  it("recreates and runs onRecovered when the recreate navigates", async () => {
    const recreateSessionForProvider = vi.fn().mockResolvedValue(true);
    const onRecovered = vi.fn();
    const isSelectionCurrent = () => true;

    await expect(
      recoverStrandedProviderSession({
        error: providerNotSet,
        sessionId: "session-1",
        providerId: "anthropic",
        modelSelection: {
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          modelProviderId: "anthropic",
          source: "explicit",
        },
        recreateSessionForProvider,
        isSelectionCurrent,
        onRecovered,
      }),
    ).resolves.toBe(true);

    expect(recreateSessionForProvider).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({ id: "claude-sonnet-4" }),
      isSelectionCurrent,
    );
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("claims the error but skips onRecovered when the recreate is superseded", async () => {
    const recreateSessionForProvider = vi.fn().mockResolvedValue(false);
    const onRecovered = vi.fn();

    await expect(
      recoverStrandedProviderSession({
        error: providerNotSet,
        sessionId: "session-1",
        providerId: "anthropic",
        recreateSessionForProvider,
        onRecovered,
      }),
    ).resolves.toBe(true);
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it("returns false when the recreate itself fails", async () => {
    const recreateSessionForProvider = vi
      .fn()
      .mockRejectedValue(new Error("create failed"));

    await expect(
      recoverStrandedProviderSession({
        error: providerNotSet,
        sessionId: "session-1",
        providerId: "anthropic",
        recreateSessionForProvider,
      }),
    ).resolves.toBe(false);
  });
});
