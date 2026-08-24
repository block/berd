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
  setAssistantSpeaking:
    vi.fn<
      (
        sessionId: string,
        expectedRevision: number,
        speaking: boolean,
      ) => Promise<void>
    >(),
  streamHandler: null as ((event: PocketVoiceStreamEvent) => void) | null,
  siriStart: vi.fn<(streamId: string) => Promise<void>>(),
  siriAppend: vi.fn<(streamId: string, text: string) => Promise<void>>(),
  siriFlush: vi.fn<(streamId: string) => Promise<void>>(),
  siriFinish: vi.fn<(streamId: string) => Promise<void>>(),
  siriStop: vi.fn<() => Promise<boolean>>(),
  siriStreamHandler: null as ((event: PocketVoiceStreamEvent) => void) | null,
}));
vi.mock("../api/voiceConversation", () => ({
  setVoiceConversationAssistantSpeaking: mocks.setAssistantSpeaking,
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
    takeVoicePlaybackNotices("session-1");
    mocks.backend = "pocket";
    mocks.start.mockReset().mockResolvedValue();
    mocks.append.mockReset().mockResolvedValue();
    mocks.flush.mockReset().mockResolvedValue();
    mocks.finish.mockReset().mockResolvedValue();
    mocks.stop.mockReset().mockResolvedValue(true);
    mocks.setAssistantSpeaking.mockReset().mockResolvedValue(undefined);
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

  it.each([
    "pocket",
    "siri",
  ] as const)("preserves partial delivery when a %s stream fails", async (backend) => {
    mocks.backend = backend;
    const onFailure = vi.fn();
    startNativeAssistantSpeech("session-1", onFailure);
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "One. Two. Three." }]),
      ]);
    const append = backend === "pocket" ? mocks.append : mocks.siriAppend;
    await vi.waitFor(() => expect(append).toHaveBeenCalled());
    const start = backend === "pocket" ? mocks.start : mocks.siriStart;
    const handler =
      backend === "pocket" ? mocks.streamHandler : mocks.siriStreamHandler;
    const streamId = start.mock.calls[0]?.[0] as string;

    handler?.({
      streamId,
      state: "failed",
      error: "later synthesis failure",
      delivery: {
        sampleRate: 24_000,
        segments: [
          {
            text: "One. Two. Three.",
            playedFrames: 600,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({
      speech: {
        status: "failed",
        spokenThrough: "One. Two".length,
        confidence: "medium",
      },
    });
    expect(onFailure).toHaveBeenCalledWith(
      "One. Two. Three.",
      "later synthesis failure",
    );
    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " Four.");
    await vi.waitFor(() => {
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        text: "One. Two. Three. Four.",
        speech: {
          status: "failed",
          spokenThrough: "One. Two".length,
          confidence: "medium",
        },
      });
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice).toContain("Native TTS could not deliver");
    expect(notice).toContain('"spokenText":"One. Two"');
    expect(notice).toContain('"unspokenText":". Three. Four."');
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
    emit("started");
    await vi.waitFor(() =>
      expect(mocks.setAssistantSpeaking).toHaveBeenCalledWith(
        "session-1",
        1,
        true,
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
    await vi.waitFor(() =>
      expect(mocks.setAssistantSpeaking).toHaveBeenCalledWith(
        "session-1",
        1,
        true,
      ),
    );
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
    await vi.waitFor(() =>
      expect(mocks.setAssistantSpeaking).toHaveBeenCalledWith(
        "session-1",
        1,
        false,
      ),
    );
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "spoken" } });
  });

  it("serializes terminal idle behind the speaking activity report", async () => {
    let finishSpeakingReport: (() => void) | undefined;
    mocks.setAssistantSpeaking.mockImplementation(
      (_sessionId, _revision, speaking) =>
        speaking
          ? new Promise<void>((resolve) => {
              finishSpeakingReport = resolve;
            })
          : Promise.resolve(),
    );
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Brief reply." }], "completed"),
      ]);
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledOnce());

    emit("started");
    emit("completed");
    await vi.waitFor(() =>
      expect(mocks.setAssistantSpeaking).toHaveBeenCalledWith(
        "session-1",
        1,
        true,
      ),
    );
    expect(mocks.setAssistantSpeaking).not.toHaveBeenCalledWith(
      "session-1",
      1,
      false,
    );

    finishSpeakingReport?.();
    await vi.waitFor(() =>
      expect(mocks.setAssistantSpeaking).toHaveBeenCalledWith(
        "session-1",
        1,
        false,
      ),
    );
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

  it("replaces the interrupted tool-suffix notice when more text arrives", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
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
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(2));
    const streamId = mocks.start.mock.calls[0]?.[0] as string;
    emit("started");

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "Before the tool.",
            playedFrames: 1_000,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
          {
            text: "After the tool.",
            playedFrames: 500,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });

    useVoiceConversationStore.setState({ userSpeaking: false });
    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " More.");
    await vi.waitFor(() => {
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[2],
      ).toMatchObject({
        text: "After the tool. More.",
        speech: { status: "interrupted", spokenThrough: "After".length },
      });
    });

    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice.match(/\[voice: tts-delivery-failed\]/g)).toHaveLength(1);
    expect(notice).toContain('"spokenText":"After"');
    expect(notice).toContain('"unspokenText":" the tool. More."');
    expect(notice).not.toContain("Before the tool.");
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
    emit("interrupted");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "interrupted" } });
    expect(takeVoicePlaybackNotices("session-1")).toContain(
      "Original text: One. Two. Three.",
    );
    expect(takeVoicePlaybackNotices("session-1")).toBeNull();
  });

  it("finalizes an interruption before native playback starts", async () => {
    let resolveStart: (() => void) | undefined;
    mocks.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Queued reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled());

    mocks.stop.mockResolvedValueOnce(false).mockResolvedValue(true);
    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({
      speech: {
        status: "interrupted",
        spokenThrough: 0,
        confidence: "low",
      },
    });
    expect(takeVoicePlaybackNotices("session-1")).toContain('"spokenText":""');
    resolveStart?.();
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(2));

    useVoiceConversationStore.setState({ userSpeaking: false });
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant(
          [{ type: "text", text: "Queued reply." }],
          "completed",
          "assistant-1",
        ),
        assistant(
          [{ type: "text", text: "Next reply." }],
          "completed",
          "assistant-2",
        ),
      ]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  });

  it("ignores a late started event after interruption is requested", async () => {
    let resolveStop: ((stopped: boolean) => void) | undefined;
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Native reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());

    mocks.stop.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStop = resolve;
        }),
    );
    useVoiceConversationStore.setState({ userSpeaking: true });
    emit("started");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).not.toMatchObject({ speech: { status: "speaking" } });
    expect(mocks.setAssistantSpeaking).not.toHaveBeenCalledWith(
      "session-1",
      1,
      true,
    );
    resolveStop?.(true);
    emit("interrupted");
  });

  it("waits for terminal delivery once the native stream exists", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Native reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).not.toHaveProperty("speech");

    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "Native reply.",
            playedFrames: 400,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "interrupted" } });
  });

  it.each([
    ["returns false", () => mocks.stop.mockResolvedValue(false)],
    ["rejects", () => mocks.stop.mockRejectedValue(new Error("stop failed"))],
  ])("finalizes immediately when native stop %s", async (_label, setStop) => {
    setStop();
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "First reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => {
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        speech: { status: "interrupted", spokenThrough: 0 },
      });
    });

    useVoiceConversationStore.setState({ userSpeaking: false });
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
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  });

  it("bounds a missing native terminal event and allows the next reply", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "First reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());

    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      await Promise.resolve();
      expect(mocks.stop).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        speech: { status: "interrupted", spokenThrough: 0 },
      });
    } finally {
      vi.useRealTimers();
    }

    useVoiceConversationStore.setState({ userSpeaking: false });
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
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  });

  it("finalizes only once when a terminal event races the fallback", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "First reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;
    const stopCallsBeforeInterruption = mocks.stop.mock.calls.length;

    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      mocks.streamHandler?.({
        streamId,
        state: "interrupted",
        error: null,
        delivery: {
          segments: [
            {
              text: "First reply.",
              playedFrames: 500,
              totalFrames: 1_000,
              synthesisComplete: true,
            },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }

    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice.match(/\[voice: tts-delivery-failed\]/g)).toHaveLength(1);
    expect(mocks.stop).toHaveBeenCalledTimes(stopCallsBeforeInterruption + 1);
  });

  it("describes a hang-up as stopping the voice conversation", async () => {
    takeVoicePlaybackNotices("session-1");
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "One. Two. Three." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    emit("started");
    const streamId = mocks.start.mock.calls[0]?.[0] as string;
    mocks.streamHandler?.({
      streamId,
      state: "progress",
      error: null,
      delivery: {
        segments: [
          {
            text: "One. Two. Three.",
            playedFrames: 200,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });

    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "stopped",
        sessionId: null,
        ownerWindowLabel: null,
        revision: voice.status.revision + 1,
      },
      uiState: "off",
    }));
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    expect(takeVoicePlaybackNotices("session-1")).toBeNull();
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "One. Two. Three.",
            playedFrames: 600,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });

    const notice = takeVoicePlaybackNotices("session-1");
    expect(notice).toContain("because the voice conversation stopped");
    expect(notice).not.toContain("because the user started speaking");
    expect(notice).toContain('"spokenText":"One. Two"');
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({
      speech: { status: "interrupted", spokenThrough: "One. Two".length },
    });
    expect(useVoiceConversationStore.getState()).toMatchObject({
      status: { lifecycle: "stopped" },
      uiState: "off",
    });
  });

  it("bounds the terminal delivery wait during hang-up", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Goodbye." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());

    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState((voice) => ({
        status: {
          ...voice.status,
          lifecycle: "stopped",
          sessionId: null,
          ownerWindowLabel: null,
          revision: voice.status.revision + 1,
        },
        uiState: "off",
      }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        speech: { status: "interrupted", spokenThrough: 0 },
      });
      expect(useVoiceConversationStore.getState()).toMatchObject({
        status: { lifecycle: "stopped" },
        uiState: "off",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "completed",
    "failed",
  ] as const)("keeps voice off when a late %s event races hang-up", async (state) => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Goodbye." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "stopped",
        sessionId: null,
        ownerWindowLabel: null,
        revision: voice.status.revision + 1,
      },
      uiState: "off",
    }));
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    mocks.streamHandler?.({
      streamId,
      state,
      error: state === "failed" ? "native failure" : null,
    });

    expect(useVoiceConversationStore.getState()).toMatchObject({
      status: { lifecycle: "stopped" },
      uiState: "off",
    });
  });

  it("does not let an old terminal overwrite a restarted same-session run", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Old reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "stopped",
        sessionId: null,
        ownerWindowLabel: null,
        revision: voice.status.revision + 1,
      },
      uiState: "off",
    }));
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "running",
        sessionId: "session-1",
        revision: voice.status.revision + 1,
      },
      uiState: "user-speaking",
    }));
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: { segments: [] },
    });

    expect(useVoiceConversationStore.getState()).toMatchObject({
      status: { lifecycle: "running", sessionId: "session-1" },
      uiState: "user-speaking",
    });
  });

  it("uses playback progress to report and decorate only the unspoken suffix", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "One. Two. Three." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    emit("started");
    const streamId = mocks.start.mock.calls[0]?.[0] as string;
    mocks.streamHandler?.({
      streamId,
      state: "progress",
      error: null,
      delivery: {
        segments: [
          {
            text: "One. Two. Three.",
            playedFrames: 300,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "speaking" } });
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "One. Two. Three.",
            playedFrames: 600,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({
      speech: {
        status: "interrupted",
        spokenThrough: "One. Two".length,
        confidence: "medium",
      },
    });
    useVoiceConversationStore.setState({ userSpeaking: false });
    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " Four.");
    await vi.waitFor(() => {
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        speech: {
          status: "interrupted",
          spokenThrough: "One. Two".length,
        },
      });
    });
    expect(mocks.append).toHaveBeenCalledTimes(1);
    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice.match(/\[voice: tts-delivery-failed\]/g)).toHaveLength(1);
    expect(notice).toContain('"spokenText":"One. Two"');
    expect(notice).toContain('"unspokenText":". Three. Four."');
    expect(notice).toContain('"confidence":"medium"');
  });

  it("uses a duration-bounded estimate for incomplete synthesis", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "One. Two. Three." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        sampleRate: 24_000,
        segments: [
          {
            text: "One. Two. Three.",
            playedFrames: 24_000,
            totalFrames: 24_000,
            synthesisComplete: false,
          },
        ],
      },
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({
      speech: {
        status: "interrupted",
        spokenThrough: "One".length,
        confidence: "low",
      },
    });
    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice).toContain('"spokenText":"One"');
    expect(notice).toContain('"unspokenText":". Two. Three."');
    expect(notice).toContain('"confidence":"low"');
  });

  it("never marks a short incomplete segment fully spoken", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [assistant([{ type: "text", text: "Yes" }])]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        sampleRate: 24_000,
        segments: [
          {
            text: "Yes",
            playedFrames: 12_000,
            totalFrames: 12_000,
            synthesisComplete: false,
          },
        ],
      },
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({
      speech: { status: "interrupted", spokenThrough: 0, confidence: "low" },
    });
    expect(takeVoicePlaybackNotices("session-1")).toContain(
      '"unspokenText":"Yes"',
    );
  });

  it("sums only each target's interleaved delivered spans", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore.getState().setMessages("session-1", [
      assistant([
        { type: "text", text: "Alpha. " },
        { type: "text", text: "" },
      ]),
    ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(1));
    useChatStore.getState().setMessages("session-1", [
      assistant([
        { type: "text", text: "Alpha. " },
        { type: "text", text: "Beta. " },
      ]),
    ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(2));
    useChatStore.getState().setMessages("session-1", [
      assistant([
        { type: "text", text: "Alpha. Gamma." },
        { type: "text", text: "Beta. " },
      ]),
    ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(3));
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState({ userSpeaking: true });
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "Alpha. Beta. Gamma.",
            playedFrames: 1_800,
            totalFrames: 1_900,
            synthesisComplete: true,
          },
        ],
      },
    });

    const content =
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content;
    expect(content?.[0]).toMatchObject({
      speech: { status: "interrupted", spokenThrough: "Alpha. Gamma".length },
    });
    expect(content?.[1]).toMatchObject({
      speech: { status: "spoken", spokenThrough: "Beta. ".length },
    });
    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice).toContain('"spokenText":"Alpha. Gamma"');
    expect(notice).toContain('"unspokenText":"."');
    expect(notice).not.toContain("Beta.");
  });

  it("preserves a fully spoken prefix when text arrives after interruption", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "One. Two." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "One. Two.",
            playedFrames: 1_000,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });

    useVoiceConversationStore.setState({ userSpeaking: false });
    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " Three.");
    await vi.waitFor(() => {
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        speech: {
          status: "interrupted",
          spokenThrough: "One. Two.".length,
        },
      });
    });

    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice.match(/\[voice: tts-delivery-failed\]/g)).toHaveLength(1);
    expect(notice).toContain('"spokenText":"One. Two."');
    expect(notice).toContain('"unspokenText":" Three."');
  });

  it("does not reuse an interrupted cutoff after a non-prefix rewrite", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Original reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState({ userSpeaking: true });
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "Original reply.",
            playedFrames: 700,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });
    useVoiceConversationStore.setState({ userSpeaking: false });
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Replacement text." }]),
      ]);

    await vi.waitFor(() => {
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({ speech: { status: "notSpoken" } });
    });
    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice).toContain('"spokenText":""');
    expect(notice).toContain('"unspokenText":"Replacement text."');
  });

  it("bounds spoken and unspoken excerpts in the model delivery notice", async () => {
    const text = `${"spoken ".repeat(100)}${"unspoken ".repeat(100)}`;
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [assistant([{ type: "text", text }])]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    emit("started");
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text,
            playedFrames: 1_000,
            totalFrames: 2_000,
            synthesisComplete: true,
          },
        ],
      },
    });

    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    const estimate = JSON.parse(
      notice.match(/Delivery estimate: (\{.*\})/)?.[1] ?? "{}",
    ) as {
      spokenText: string;
      unspokenText: string;
      spokenTextTruncated: boolean;
      unspokenTextTruncated: boolean;
    };
    expect(estimate.spokenText.length).toBeLessThanOrEqual(250);
    expect(estimate.unspokenText.length).toBeLessThanOrEqual(250);
    expect(estimate.spokenTextTruncated).toBe(true);
    expect(estimate.unspokenTextTruncated).toBe(true);
  });
});
