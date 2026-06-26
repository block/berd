import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { applyChatSessionConfigOptionsSnapshot } from "../sessionConfigSnapshotAdapter";

function addSession() {
  useChatSessionStore.getState().addSession({
    id: "acp-session",
    title: "Chat",
    providerId: "goose",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    messageCount: 0,
  });
}

function createReasoningEffortConfigResponse(currentValue: string) {
  return {
    configOptions: [
      {
        id: "thinking_effort",
        name: "Thinking effort",
        category: "thought_level",
        kind: {
          type: "select",
          currentValue,
          options: {
            type: "ungrouped",
            values: [
              { value: "off", name: "off" },
              { value: "low", name: "low" },
              { value: "medium", name: "medium" },
              { value: "high", name: "high" },
            ],
          },
        },
      },
    ],
  };
}

describe("sessionConfigSnapshotAdapter", () => {
  beforeEach(() => {
    useChatSessionStore.setState({
      sessions: [],
      modelSelectionIntentBySession: {},
    });
  });

  it("accepts a matching setModel reasoning snapshot during a model intent", () => {
    addSession();
    useChatSessionStore.getState().beginModelSelectionIntent("acp-session", {
      requestId: "model-request-1",
      kind: "model",
      modelId: "gpt-5.5",
      previousModelId: "claude-opus-4-8",
      previousModelName: "Claude Opus 4.8",
    });

    applyChatSessionConfigOptionsSnapshot(
      "acp-session",
      createReasoningEffortConfigResponse("high"),
      {
        origin: "response",
        modelId: "gpt-5.5",
      },
    );

    expect(
      useChatSessionStore.getState().getSession("acp-session"),
    ).toMatchObject({
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "high",
      },
    });
  });

  it("rejects a mismatched setModel reasoning snapshot during a model intent", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSession();
    useChatSessionStore.getState().beginModelSelectionIntent("acp-session", {
      requestId: "model-request-1",
      kind: "model",
      modelId: "gpt-5.5",
      previousModelId: "claude-opus-4-8",
      previousModelName: "Claude Opus 4.8",
    });

    applyChatSessionConfigOptionsSnapshot(
      "acp-session",
      createReasoningEffortConfigResponse("high"),
      {
        origin: "response",
        modelId: "claude-opus-4-8",
      },
    );

    expect(
      useChatSessionStore.getState().getSession("acp-session")?.reasoningEffort,
    ).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "Dropped stale ACP reasoningEffort config snapshot",
      expect.objectContaining({
        intentKind: "model",
        origin: "response",
        modelId: "claude-opus-4-8",
      }),
    );
    warnSpy.mockRestore();
  });

  it("accepts a matching setProvider reasoning snapshot during a provider intent", () => {
    addSession();
    useChatSessionStore.getState().beginModelSelectionIntent("acp-session", {
      requestId: "provider-request-1",
      kind: "provider",
      providerId: "codex-acp",
      previousProviderId: "goose",
      previousModelId: "claude-opus-4-8",
      previousModelName: "Claude Opus 4.8",
    });

    applyChatSessionConfigOptionsSnapshot(
      "acp-session",
      createReasoningEffortConfigResponse("medium"),
      {
        origin: "response",
        providerId: "codex-acp",
      },
    );

    expect(
      useChatSessionStore.getState().getSession("acp-session"),
    ).toMatchObject({
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "medium",
      },
    });
  });
});
