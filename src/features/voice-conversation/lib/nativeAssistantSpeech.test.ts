import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";
import type { PocketVoiceStreamEvent } from "../api/pocketVoice";

const mocks = vi.hoisted(() => ({
  backend: "pocket" as "pocket" | "siri",
  start: vi.fn<(streamId: string) => Promise<void>>(),
  append: vi.fn<(streamId: string, text: string) => Promise<void>>(),
  flush: vi.fn<(streamId: string) => Promise<void>>(),
  finish: vi.fn<(streamId: string) => Promise<void>>(),
  stop: vi.fn<() => Promise<boolean>>(),
  streamHandler: null as ((event: PocketVoiceStreamEvent) => void) | null,
  siriStart: vi.fn<(streamId: string) => Promise<void>>(),
  siriAppend: vi.fn<(streamId: string, text: string) => Promise<void>>(),
  siriFlush: vi.fn<(streamId: string) => Promise<void>>(),
  siriFinish: vi.fn<(streamId: string) => Promise<void>>(),
  siriStop: vi.fn<() => Promise<boolean>>(),
  siriStreamHandler: null as ((event: PocketVoiceStreamEvent) => void) | null,
}));

vi.mock("../api/pocketVoice", () => ({
  startPocketVoiceStream: (streamId: string) => mocks.start(streamId),
  appendPocketVoiceStream: (streamId: string, text: string) =>
    mocks.append(streamId, text),
  flushPocketVoiceStream: (streamId: string) => mocks.flush(streamId),
  finishPocketVoiceStream: (streamId: string) => mocks.finish(streamId),
  stopPocketVoice: () => mocks.stop(),
  listenToPocketVoiceStream: async (
    handler: (event: PocketVoiceStreamEvent) => void,
  ) => {
    mocks.streamHandler = handler;
    return vi.fn();
  },
}));

vi.mock("../api/siriVoice", () => ({
  startSiriVoiceStream: (streamId: string) => mocks.siriStart(streamId),
  appendSiriVoiceStream: (streamId: string, text: string) =>
    mocks.siriAppend(streamId, text),
  flushSiriVoiceStream: (streamId: string) => mocks.siriFlush(streamId),
  finishSiriVoiceStream: (streamId: string) => mocks.siriFinish(streamId),
  stopSiriVoice: () => mocks.siriStop(),
  listenToSiriVoiceStream: async (
    handler: (event: PocketVoiceStreamEvent) => void,
  ) => {
    mocks.siriStreamHandler = handler;
    return vi.fn();
  },
}));

vi.mock("./voiceOutputPreference", () => ({
  getVoiceOutputBackend: () => mocks.backend,
}));

import {
  startNativeAssistantSpeech,
  stopNativeAssistantSpeech,
  takeVoicePlaybackNotices,
} from "./nativeAssistantSpeech";

function assistant(
  content: Message["content"],
  completionStatus: NonNullable<
    Message["metadata"]
  >["completionStatus"] = "inProgress",
  id = "assistant-1",
): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content,
    metadata: { completionStatus },
  };
}

function emit(
  state: PocketVoiceStreamEvent["state"],
  error: string | null = null,
) {
  const streamId = mocks.start.mock.calls[0]?.[0] as string;
  mocks.streamHandler?.({ streamId, state, error });
}

describe("native assistant speech stream", () => {
  beforeEach(() => {
    mocks.backend = "pocket";
    mocks.start.mockReset().mockResolvedValue();
    mocks.append.mockReset().mockResolvedValue();
    mocks.flush.mockReset().mockResolvedValue();
    mocks.finish.mockReset().mockResolvedValue();
    mocks.stop.mockReset().mockResolvedValue(true);
    mocks.streamHandler = null;
    mocks.siriStart.mockReset().mockResolvedValue();
    mocks.siriAppend.mockReset().mockResolvedValue();
    mocks.siriFlush.mockReset().mockResolvedValue();
    mocks.siriFinish.mockReset().mockResolvedValue();
    mocks.siriStop.mockReset().mockResolvedValue(true);
    mocks.siriStreamHandler = null;
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
    });
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 1,
      },
      uiState: "listening",
      userSpeaking: false,
      assistantSpeaking: false,
    });
  });

  afterEach(() => {
    stopNativeAssistantSpeech();
  });

  it("pushes raw assistant deltas without frontend sentence segmentation", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "First sentence. Later" }]),
      ]);

    await vi.waitFor(() => {
      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "First sentence. Later",
      );
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).not.toHaveProperty("speech");

    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " text.");
    await vi.waitFor(() => {
      expect(mocks.append).toHaveBeenNthCalledWith(
        2,
        mocks.start.mock.calls[0]?.[0],
        " text.",
      );
    });
  });

  it("routes the complete utterance stream through Siri when selected", async () => {
    mocks.backend = "siri";
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Hello from Siri." }], "completed"),
      ]);

    await vi.waitFor(() => {
      expect(mocks.siriStart).toHaveBeenCalledTimes(1);
      expect(mocks.siriAppend).toHaveBeenCalledWith(
        mocks.siriStart.mock.calls[0]?.[0],
        "Hello from Siri.",
      );
      expect(mocks.siriFinish).toHaveBeenCalledTimes(1);
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("preserves the first live reply while speech is arming", async () => {
    const history = assistant(
      [{ type: "text", text: "Historical response." }],
      "completed",
      "assistant-history",
    );
    useChatStore.getState().setMessages("session-1", [history]);
    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "stopped",
        sessionId: null,
        ownerWindowLabel: null,
        revision: 0,
      },
      uiState: "off",
    }));

    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        history,
        assistant([{ type: "text", text: "First live reply." }]),
      ]);
    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        revision: 1,
      },
      uiState: "listening",
    }));

    await vi.waitFor(() =>
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "First live reply.",
      ),
    );
    expect(mocks.append).not.toHaveBeenCalledWith(
      expect.any(String),
      "Historical response.",
    );
  });

  it("derives speaking and completion state from backend playback events", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "First sentence." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());

    emit("started");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "speaking" } });

    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " Second sentence.");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "speaking" } });

    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant(
          [{ type: "text", text: "First sentence. Second sentence." }],
          "completed",
        ),
      ]);
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledTimes(1));
    emit("completed");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "spoken" } });
  });

  it("flushes buffered text at a tool boundary without ending the stream", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Before the tool" }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(1));

    useChatStore.getState().setMessages("session-1", [
      assistant([
        {
          type: "toolRequest",
          id: "tool-1",
          name: "Read",
          arguments: {},
          status: "completed",
        },
        { type: "text", text: "Before the tool" },
      ]),
    ]);

    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledTimes(1));
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("updates every text block around a tool with the utterance status", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Before the tool." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(1));
    emit("started");

    useChatStore.getState().setMessages("session-1", [
      assistant([
        { type: "text", text: "Before the tool." },
        {
          type: "toolRequest",
          id: "tool-1",
          name: "Read",
          arguments: {},
          status: "completed",
        },
        { type: "text", text: "After the tool." },
      ]),
    ]);

    await vi.waitFor(() => {
      expect(mocks.flush).toHaveBeenCalledTimes(1);
      expect(mocks.append).toHaveBeenLastCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "After the tool.",
      );
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[2],
    ).toMatchObject({ speech: { status: "speaking" } });

    useChatStore.getState().setMessages("session-1", [
      assistant(
        [
          { type: "text", text: "Before the tool." },
          {
            type: "toolRequest",
            id: "tool-1",
            name: "Read",
            arguments: {},
            status: "completed",
          },
          { type: "text", text: "After the tool." },
        ],
        "completed",
      ),
    ]);
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledTimes(1));
    emit("completed");

    const content =
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content;
    expect(content?.[0]).toMatchObject({ speech: { status: "spoken" } });
    expect(content?.[2]).toMatchObject({ speech: { status: "spoken" } });
  });

  it("queues the next reply until the finishing stream completes", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant(
          [{ type: "text", text: "First reply." }],
          "completed",
          "assistant-1",
        ),
      ]);
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledTimes(1));
    const firstStreamId = mocks.start.mock.calls[0]?.[0] as string;

    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant(
          [{ type: "text", text: "First reply." }],
          "completed",
          "assistant-1",
        ),
        assistant(
          [{ type: "text", text: "Second reply." }],
          "completed",
          "assistant-2",
        ),
      ]);
    await Promise.resolve();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.append).not.toHaveBeenCalledWith(
      expect.any(String),
      "Second reply.",
    );

    mocks.streamHandler?.({
      streamId: firstStreamId,
      state: "completed",
      error: null,
    });

    await vi.waitFor(() => {
      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[1]?.[0],
        "Second reply.",
      );
      expect(mocks.finish).toHaveBeenCalledTimes(2);
    });
  });

  it("interrupts one utterance status even when many deltas are queued", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "One. Two. Three." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    emit("started");

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "interrupted" } });
    expect(takeVoicePlaybackNotices("session-1")).toContain(
      "Original text: One. Two. Three.",
    );
    expect(takeVoicePlaybackNotices("session-1")).toBeNull();
  });
});
