import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationBuilderStreamEvent } from "@/features/automations/api/automationBuilder";
import { getTextContent, type Message } from "@/shared/types/messages";
import { useAutomationBuilderSession } from "./useAutomationBuilderSession";

const mocks = vi.hoisted(() => ({
  acknowledgeAutomationTileDraft: vi.fn(),
  approveAutomationDraft: vi.fn(),
  cancelAutomationBuilderMessage: vi.fn(),
  createAutomationTileFromDraft: vi.fn(),
  getAutomationTile: vi.fn(),
  listenToAutomationBuilderStream: vi.fn(),
  pushAutomationBuilderUserMessage: vi.fn(),
  reviseAutomationDraft: vi.fn(),
  startAutomationBuilderStream: vi.fn(),
  stopAutomationBuilderStream: vi.fn(),
  updateAutomationTile: vi.fn(),
  streamHandler: undefined as
    | ((event: AutomationBuilderStreamEvent) => void)
    | undefined,
}));

vi.mock("@/features/automations/api/automationBuilder", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/automations/api/automationBuilder")
  >("@/features/automations/api/automationBuilder");
  return {
    ...actual,
    acknowledgeAutomationTileDraft: mocks.acknowledgeAutomationTileDraft,
    approveAutomationDraft: mocks.approveAutomationDraft,
    cancelAutomationBuilderMessage: mocks.cancelAutomationBuilderMessage,
    createAutomationTileFromDraft: mocks.createAutomationTileFromDraft,
    listenToAutomationBuilderStream:
      mocks.listenToAutomationBuilderStream.mockImplementation(
        async (handler: (event: AutomationBuilderStreamEvent) => void) => {
          mocks.streamHandler = handler;
          return vi.fn();
        },
      ),
    pushAutomationBuilderUserMessage: mocks.pushAutomationBuilderUserMessage,
    reviseAutomationDraft: mocks.reviseAutomationDraft,
    startAutomationBuilderStream: mocks.startAutomationBuilderStream,
    stopAutomationBuilderStream: mocks.stopAutomationBuilderStream,
  };
});

vi.mock("@/features/automations/api/kgooseAutomations", () => ({
  getAutomationTile: mocks.getAutomationTile,
  updateAutomationTile: mocks.updateAutomationTile,
}));

vi.stubGlobal("crypto", {
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
});

function emitStreamEvent(event: AutomationBuilderStreamEvent) {
  act(() => {
    mocks.streamHandler?.(event);
  });
}

describe("useAutomationBuilderSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.streamHandler = undefined;
    mocks.listenToAutomationBuilderStream.mockReset();
    mocks.listenToAutomationBuilderStream.mockImplementation(
      async (handler: (event: AutomationBuilderStreamEvent) => void) => {
        mocks.streamHandler = handler;
        return vi.fn();
      },
    );
    mocks.pushAutomationBuilderUserMessage.mockReset();
    mocks.pushAutomationBuilderUserMessage.mockResolvedValue({
      sessionId: "session-1",
    });
    mocks.reviseAutomationDraft.mockReset();
    mocks.reviseAutomationDraft.mockResolvedValue({
      sessionId: "session-1",
    });
    mocks.acknowledgeAutomationTileDraft.mockReset();
    mocks.acknowledgeAutomationTileDraft.mockResolvedValue({
      sessionId: "session-1",
    });
    mocks.approveAutomationDraft.mockReset();
    mocks.approveAutomationDraft.mockResolvedValue({
      sessionId: "session-1",
    });
    mocks.cancelAutomationBuilderMessage.mockReset();
    mocks.cancelAutomationBuilderMessage.mockResolvedValue({
      cancelled: true,
    });
    mocks.createAutomationTileFromDraft.mockReset();
    mocks.createAutomationTileFromDraft.mockResolvedValue({
      success: true,
      tileId: "automation-1",
    });
    mocks.getAutomationTile.mockReset();
    mocks.getAutomationTile.mockResolvedValue({
      tileInfo: {
        id: "automation-1",
        title: "Daily sales",
        schedule: "0 9 * * *",
        instructions: ["Send a sales digest."],
        humanReadableInstructions: ["Send a sales digest."],
        timeZone: "America/New_York",
      },
    });
    mocks.startAutomationBuilderStream.mockReset();
    mocks.startAutomationBuilderStream.mockResolvedValue(undefined);
    mocks.stopAutomationBuilderStream.mockReset();
    mocks.stopAutomationBuilderStream.mockResolvedValue(undefined);
    mocks.updateAutomationTile.mockReset();
    mocks.updateAutomationTile.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects after stream completion while a turn is pending", async () => {
    const { result } = renderHook(() => useAutomationBuilderSession());

    await act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });

    expect(mocks.startAutomationBuilderStream).toHaveBeenCalledTimes(1);
    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "completed",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mocks.startAutomationBuilderStream).toHaveBeenCalledTimes(2);
  });

  it("awaits listener registration before opening the stream", async () => {
    let resolveListen: (value: () => void) => void = () => {};
    mocks.listenToAutomationBuilderStream.mockImplementationOnce(
      async (handler: (event: AutomationBuilderStreamEvent) => void) => {
        mocks.streamHandler = handler;
        return new Promise((resolve) => {
          resolveListen = resolve;
        });
      },
    );
    const { result } = renderHook(() => useAutomationBuilderSession());

    const sendPromise = act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.startAutomationBuilderStream).not.toHaveBeenCalled();

    resolveListen(vi.fn());
    await sendPromise;

    expect(mocks.startAutomationBuilderStream).toHaveBeenCalledOnce();
  });

  it("clears streaming state for terminal stream errors but not warnings", async () => {
    const { result } = renderHook(() => useAutomationBuilderSession());

    await act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });
    expect(result.current.isStreaming).toBe(true);

    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "warning",
      error: "bad event",
    });
    expect(result.current.isStreaming).toBe(true);

    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "error",
      error: "stream failed",
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBe("stream failed");
  });

  it("rolls back the local user message when send fails", async () => {
    mocks.pushAutomationBuilderUserMessage.mockRejectedValueOnce(
      new Error("push failed"),
    );
    const { result } = renderHook(() => useAutomationBuilderSession());

    await act(async () => {
      const accepted = await result.current.sendMessage("create one");
      expect(accepted).toBe(false);
    });

    expect(result.current.messages[0].content[0]).toMatchObject({
      type: "systemNotification",
      text: "push failed",
    });
  });

  it("clears pending state when opening the stream after approval fails", async () => {
    mocks.startAutomationBuilderStream.mockRejectedValueOnce(
      new Error("open failed"),
    );
    const { result } = renderHook(() => useAutomationBuilderSession());

    await act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.status).toBe("idle");
  });

  it("ignores stale idle snapshots until kgoose acknowledges the new turn", async () => {
    const { result } = renderHook(() => useAutomationBuilderSession());

    await act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });
    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_IDLE",
          messages: [
            {
              id: "user-previous",
              role: "ROLE_USER",
              content: [
                {
                  type: "MESSAGE_TYPE_TEXT",
                  text: { text: "create a daily sales automation" },
                },
              ],
            },
            {
              id: "assistant-previous",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TEXT",
                  text: { text: "Previous response." },
                },
              ],
            },
          ],
        },
      },
    });
    expect(result.current.status).toBe("idle");

    await act(async () => {
      await result.current.sendMessage("change that automation");
    });
    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_IDLE",
          messages: [
            {
              id: "user-previous",
              role: "ROLE_USER",
              content: [
                {
                  type: "MESSAGE_TYPE_TEXT",
                  text: { text: "create a daily sales automation" },
                },
              ],
            },
            {
              id: "assistant-previous",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TEXT",
                  text: { text: "Previous response." },
                },
              ],
            },
          ],
        },
      },
    });

    expect(result.current.status).toBe("processing");

    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_PROCESSING",
          messages: [],
        },
      },
    });
    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_IDLE",
          messages: [
            {
              id: "assistant-1",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TEXT",
                  text: { text: "Automation created." },
                },
              ],
            },
          ],
        },
      },
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.messages.map(getMessageText)).toEqual([
      "create a daily sales automation",
      "Previous response.",
      "change that automation",
      "Automation created.",
    ]);
    expect(result.current.isStreaming).toBe(false);
  });

  it("accepts a fast idle response when it advances messages", async () => {
    const { result } = renderHook(() => useAutomationBuilderSession());

    await act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });

    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_IDLE",
          messages: [
            {
              id: "assistant-1",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TEXT",
                  text: { text: "Automation created." },
                },
              ],
            },
          ],
        },
      },
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.messages.map(getMessageText)).toEqual([
      "create a daily sales automation",
      "Automation created.",
    ]);
    expect(result.current.isStreaming).toBe(false);
  });

  it("persists render-tile automation drafts directly before acknowledging the tool", async () => {
    const onAutomationCreated = vi.fn();
    const { result } = renderHook(() =>
      useAutomationBuilderSession({ onAutomationCreated }),
    );

    await act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });
    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_NEED_CLIENT_INPUT",
          messages: [
            {
              id: "assistant-1",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TOOL_REQUEST",
                  toolRequest: {
                    id: "tool-1",
                    value: {
                      name: "tile__render_tile",
                      arguments: JSON.stringify({
                        render_type: "automation",
                        tile_type: "summary",
                        title: "Daily sales",
                        instructions: ["Send a daily sales digest."],
                      }),
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });

    await act(async () => {
      await result.current.approveDraft();
    });

    expect(mocks.createAutomationTileFromDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        toolRequestId: "tool-1",
        creationMode: "createTile",
      }),
    );
    expect(mocks.acknowledgeAutomationTileDraft).toHaveBeenCalledWith(
      "session-1",
      "tool-1",
    );
    expect(onAutomationCreated).toHaveBeenCalledWith("automation-1");
    expect(result.current.draftState.created).toBe(true);
  });

  it("persists edited legacy automation previews through the create endpoint", async () => {
    const { result } = renderHook(() => useAutomationBuilderSession());

    await act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });
    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_NEED_CLIENT_INPUT",
          messages: [
            {
              id: "assistant-1",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TOOL_REQUEST",
                  toolRequest: {
                    id: "preview-tool",
                    value: {
                      name: "tile__preview_automation",
                      arguments: JSON.stringify({
                        title: "Original title",
                        schedule: "0 9 * * *",
                        instructions: ["Original instructions."],
                      }),
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });

    act(() => {
      result.current.setDraftOverride({
        title: "Edited title",
        schedule: "30 16 * * 1-5",
        instructions: ["Edited instructions."],
        humanReadableInstructions: ["Edited instructions."],
        timeZone: "America/New_York",
        enableNotifications: true,
      });
    });
    await act(async () => {
      await result.current.approveDraft();
    });

    expect(mocks.createAutomationTileFromDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        toolRequestId: "preview-tool",
        creationMode: "approveTool",
        title: "Edited title",
        schedule: "30 16 * * 1-5",
        instructions: ["Edited instructions."],
        humanReadableInstructions: ["Edited instructions."],
        timeZone: "America/New_York",
        enableNotifications: true,
      }),
    );
    expect(mocks.approveAutomationDraft).not.toHaveBeenCalled();
    expect(mocks.acknowledgeAutomationTileDraft).toHaveBeenCalledWith(
      "session-1",
      "preview-tool",
    );
  });

  it("clears draft overrides when a new tool request arrives", async () => {
    const { result } = renderHook(() => useAutomationBuilderSession());

    await act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });
    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_NEED_CLIENT_INPUT",
          messages: [
            {
              id: "assistant-1",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TOOL_REQUEST",
                  toolRequest: {
                    id: "tool-1",
                    value: {
                      name: "tile__render_tile",
                      arguments: JSON.stringify({
                        render_type: "automation",
                        tile_type: "summary",
                        title: "First draft",
                      }),
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });
    act(() => {
      result.current.setDraftOverride({ title: "Edited first draft" });
    });

    expect(result.current.draftState.draft?.title).toBe("Edited first draft");

    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_NEED_CLIENT_INPUT",
          messages: [
            {
              id: "assistant-2",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TOOL_REQUEST",
                  toolRequest: {
                    id: "tool-2",
                    value: {
                      name: "tile__render_tile",
                      arguments: JSON.stringify({
                        render_type: "automation",
                        tile_type: "summary",
                        title: "Second draft",
                      }),
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });

    expect(result.current.draftState.draft?.title).toBe("Second draft");
  });

  it("sends draft revision feedback as the pending tool response", async () => {
    const { result } = renderHook(() => useAutomationBuilderSession());

    await act(async () => {
      await result.current.sendMessage("create a daily sales automation");
    });
    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_NEED_CLIENT_INPUT",
          messages: [
            {
              id: "assistant-1",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TOOL_REQUEST",
                  toolRequest: {
                    id: "tool-1",
                    value: {
                      name: "tile__render_tile",
                      arguments: JSON.stringify({
                        render_type: "automation",
                        tile_type: "summary",
                        title: "Daily sales",
                      }),
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });

    await act(async () => {
      const accepted = await result.current.sendMessage(
        "Actually make it 1 PM and include failures.",
      );
      expect(accepted).toBe(true);
    });

    expect(mocks.reviseAutomationDraft).toHaveBeenCalledWith(
      "session-1",
      "tool-1",
      "Actually make it 1 PM and include failures.",
    );
    expect(mocks.pushAutomationBuilderUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.startAutomationBuilderStream).toHaveBeenCalledTimes(2);
    expect(result.current.messages.map(getMessageText)).toContain(
      "Actually make it 1 PM and include failures.",
    );
  });

  it("acknowledges a saved edit draft so the session can keep iterating", async () => {
    const onAutomationUpdated = vi.fn();
    const { result } = renderHook(() =>
      useAutomationBuilderSession({
        automationId: "automation-1",
        onAutomationUpdated,
      }),
    );

    await act(async () => {
      await result.current.sendMessage("change the automation time");
    });
    emitStreamEvent({
      streamId: "automation-builder-00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      event: "messages",
      data: {
        get_messages_response: {
          status: "CHAT_SESSION_STATUS_NEED_CLIENT_INPUT",
          messages: [
            {
              id: "assistant-1",
              role: "ROLE_ASSISTANT",
              content: [
                {
                  type: "MESSAGE_TYPE_TOOL_REQUEST",
                  toolRequest: {
                    id: "edit-tool",
                    value: {
                      name: "tile__render_tile",
                      arguments: JSON.stringify({
                        render_type: "automation",
                        tile_type: "summary",
                        title: "Daily sales at noon",
                        schedule: "0 12 * * *",
                        instructions: ["Send a sales digest at noon."],
                      }),
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });

    await act(async () => {
      await result.current.approveDraft();
    });

    expect(mocks.updateAutomationTile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "automation-1",
        title: "Daily sales at noon",
        schedule: "0 12 * * *",
      }),
    );
    expect(mocks.acknowledgeAutomationTileDraft).toHaveBeenCalledWith(
      "session-1",
      "edit-tool",
    );
    expect(mocks.startAutomationBuilderStream).toHaveBeenCalledTimes(2);
    expect(onAutomationUpdated).toHaveBeenCalledWith("automation-1");
  });

  it("does not acknowledge the seed edit draft without a real tool request", async () => {
    const { result } = renderHook(() =>
      useAutomationBuilderSession({ automationId: "automation-1" }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.approveDraft();
    });

    expect(mocks.updateAutomationTile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "automation-1",
        title: "Daily sales",
      }),
    );
    expect(mocks.acknowledgeAutomationTileDraft).not.toHaveBeenCalled();
    expect(mocks.startAutomationBuilderStream).not.toHaveBeenCalled();
  });
});

function getMessageText(message: Message) {
  return getTextContent(message);
}
