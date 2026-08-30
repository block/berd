import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";
import type { PocketVoiceStreamEvent } from "../api/pocketVoice";

const mocks = vi.hoisted(() => ({
  backend: "pocket" as "pocket" | "siri" | "openai",
  interruptionMode: "automatic" as
    | "automatic"
    | "allowInterruptions"
    | "preventFeedback",
  start:
    vi.fn<
      (
        streamId: string,
        interruptionMode:
          | "automatic"
          | "allowInterruptions"
          | "preventFeedback",
        interruptionSensitivity: "less" | "balanced" | "more",
      ) => Promise<void>
    >(),
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
  siriStart:
    vi.fn<
      (
        streamId: string,
        voice: { name: string; language: string },
        interruptionMode:
          | "automatic"
          | "allowInterruptions"
          | "preventFeedback",
        interruptionSensitivity: "less" | "balanced" | "more",
      ) => Promise<void>
    >(),
  siriAppend: vi.fn<(streamId: string, text: string) => Promise<void>>(),
  siriFlush: vi.fn<(streamId: string) => Promise<void>>(),
  siriFinish: vi.fn<(streamId: string) => Promise<void>>(),
  siriStop: vi.fn<() => Promise<boolean>>(),
  siriStreamHandler: null as ((event: PocketVoiceStreamEvent) => void) | null,
  openAiStart:
    vi.fn<
      (
        streamId: string,
        interruptionMode:
          | "automatic"
          | "allowInterruptions"
          | "preventFeedback",
        interruptionSensitivity: "less" | "balanced" | "more",
      ) => Promise<void>
    >(),
  openAiAppend: vi.fn<(streamId: string, text: string) => Promise<void>>(),
  openAiFlush: vi.fn<(streamId: string) => Promise<void>>(),
  openAiFinish: vi.fn<(streamId: string) => Promise<void>>(),
  openAiStop: vi.fn<() => Promise<boolean>>(),
  openAiStreamHandler: null as ((event: PocketVoiceStreamEvent) => void) | null,
}));
vi.mock("../api/voiceConversation", () => ({
  setVoiceConversationAssistantSpeaking: mocks.setAssistantSpeaking,
}));

vi.mock("../api/pocketVoice", () => ({
  startPocketVoiceStream: (
    streamId: string,
    interruptionMode: typeof mocks.interruptionMode,
    interruptionSensitivity: "less" | "balanced" | "more",
  ) => mocks.start(streamId, interruptionMode, interruptionSensitivity),
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

vi.mock("../api/openAiVoice", () => ({
  startOpenAiVoiceStream: (
    streamId: string,
    interruptionMode: typeof mocks.interruptionMode,
    interruptionSensitivity: "less" | "balanced" | "more",
  ) => mocks.openAiStart(streamId, interruptionMode, interruptionSensitivity),
  appendOpenAiVoiceStream: (streamId: string, text: string) =>
    mocks.openAiAppend(streamId, text),
  flushOpenAiVoiceStream: (streamId: string) => mocks.openAiFlush(streamId),
  finishOpenAiVoiceStream: (streamId: string) => mocks.openAiFinish(streamId),
  stopOpenAiVoice: () => mocks.openAiStop(),
  listenToOpenAiVoiceStream: async (
    handler: (event: PocketVoiceStreamEvent) => void,
  ) => {
    mocks.openAiStreamHandler = handler;
    return vi.fn();
  },
}));

vi.mock("../api/siriVoice", () => ({
  startSiriVoiceStream: (
    streamId: string,
    voice: { name: string; language: string },
    interruptionMode: typeof mocks.interruptionMode,
    interruptionSensitivity: "less" | "balanced" | "more",
  ) =>
    mocks.siriStart(streamId, voice, interruptionMode, interruptionSensitivity),
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
vi.mock("./voiceInterruptionPreference", () => ({
  FIXED_INTERRUPTION_SENSITIVITY: "less",
  getVoiceInterruptionPreference: () => ({
    mode: mocks.interruptionMode,
  }),
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

function voiceUser(
  id: string,
  metadata: Partial<NonNullable<Message["metadata"]>> = {},
): Message {
  return {
    id: `user-${id}`,
    role: "user",
    created: 1,
    content: [{ type: "text", text: `User ${id}` }],
    metadata: {
      origin: "voice_conversation",
      voiceConversationLifecycleId: "lifecycle-1",
      voiceConversationRevision: 1,
      voiceUtteranceId: id,
      ...metadata,
    },
  };
}

function finalizeVoiceTranscript(id = "voice-user-1") {
  useVoiceConversationStore.setState({
    latestFinalizedTranscriptKey: ["session-1", "lifecycle-1", "1", id].join(
      "\0",
    ),
  });
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
    mocks.interruptionMode = "automatic";
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
    mocks.openAiStart.mockReset().mockResolvedValue();
    mocks.openAiAppend.mockReset().mockResolvedValue();
    mocks.openAiFlush.mockReset().mockResolvedValue();
    mocks.openAiFinish.mockReset().mockResolvedValue();
    mocks.openAiStop.mockReset().mockResolvedValue(true);
    mocks.openAiStreamHandler = null;
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
      microphoneMuted: false,
      latestFinalizedTranscriptKey: null,
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
      expect(mocks.start).toHaveBeenCalledWith(
        expect.any(String),
        "automatic",
        "less",
      );
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

  it("routes ordering and cancellation through OpenAI when selected", async () => {
    mocks.backend = "openai";
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Hello from OpenAI." }], "completed"),
      ]);

    await vi.waitFor(() => {
      expect(mocks.openAiStart).toHaveBeenCalledWith(
        expect.any(String),
        "automatic",
        "less",
      );
      expect(mocks.openAiAppend).toHaveBeenCalledWith(
        mocks.openAiStart.mock.calls[0]?.[0],
        "Hello from OpenAI.",
      );
      expect(mocks.openAiFinish).toHaveBeenCalledTimes(1);
    });
    expect(mocks.openAiStart.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openAiAppend.mock.invocationCallOrder[0] ?? 0,
    );
    stopNativeAssistantSpeech();
    await vi.waitFor(() => expect(mocks.openAiStop).toHaveBeenCalled());
  });

  it("routes the complete utterance stream through Siri when selected", async () => {
    mocks.backend = "siri";
    mocks.interruptionMode = "allowInterruptions";
    const siriVoice = { name: "Samantha", language: "en-US" };
    startNativeAssistantSpeech("session-1", vi.fn(), undefined, siriVoice);
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Hello from Siri." }], "completed"),
      ]);

    await vi.waitFor(() => {
      expect(mocks.siriStart).toHaveBeenCalledWith(
        expect.any(String),
        siriVoice,
        "allowInterruptions",
        "less",
      );
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
    startNativeAssistantSpeech(
      "session-1",
      onFailure,
      undefined,
      backend === "siri" ? { name: "Samantha", language: "en-US" } : undefined,
    );
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

  it("resumes a tool suffix from its incomplete synthesis segment", async () => {
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
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    const resumedStreamId = mocks.start.mock.calls[1]?.[0] as string;
    expect(mocks.append).toHaveBeenCalledWith(
      resumedStreamId,
      "After the tool. More.",
    );
    expect(mocks.append).not.toHaveBeenCalledWith(
      resumedStreamId,
      "Before the tool.",
    );
    expect(takeVoicePlaybackNotices("session-1")).toBeNull();
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
    finalizeVoiceTranscript("voice-genuine-interruption");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "interrupted" } });
    expect(takeVoicePlaybackNotices("session-1")).toContain(
      "Original text: One. Two. Three.",
    );
    expect(takeVoicePlaybackNotices("session-1")).toBeNull();
  });

  it("waits for terminal ownership when interruption races native startup", async () => {
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
    finalizeVoiceTranscript("voice-after-queued-reply");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).not.toMatchObject({ speech: { status: "interrupted" } });
    const streamId = mocks.start.mock.calls[0]?.[0] as string;
    resolveStart?.();
    await vi.waitFor(() =>
      expect(mocks.stop.mock.calls.length).toBeGreaterThan(1),
    );
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: { segments: [] },
    });
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

    useVoiceConversationStore.setState({ userSpeaking: false });
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant(
          [{ type: "text", text: "Queued reply." }],
          "completed",
          "assistant-1",
        ),
        voiceUser("voice-after-queued-reply"),
        assistant(
          [{ type: "text", text: "Next reply." }],
          "completed",
          "assistant-2",
        ),
      ]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  });

  it("resumes a false-positive interruption before native startup is invoked", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Queued false positive." }],
            "completed",
          ),
        ]);
      useVoiceConversationStore.setState({ userSpeaking: true });
      await vi.runAllTimersAsync();
      expect(mocks.start).not.toHaveBeenCalled();

      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(250);
      await vi.runAllTimersAsync();

      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "Queued false positive.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds an interruption past VAD idle until delayed final transcript arrives", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant([{ type: "text", text: "Interrupted reply." }]),
        ]);
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
      const firstStreamId = mocks.start.mock.calls[0]?.[0] as string;
      emit("started");

      useVoiceConversationStore.setState({ userSpeaking: true });
      await vi.runAllTimersAsync();
      expect(mocks.stop).toHaveBeenCalled();
      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "interrupted",
        error: null,
        delivery: { segments: [] },
      });

      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.start).toHaveBeenCalledTimes(1);

      finalizeVoiceTranscript("delayed-final");
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Interrupted reply." }],
            "completed",
            "assistant-1",
          ),
          voiceUser("delayed-final"),
        ]);
      await vi.runAllTimersAsync();

      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(takeVoicePlaybackNotices("session-1")).toContain(
        "Original text: Interrupted reply.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a no-result interruption after the recognition segment timeout", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "False alarm reply." }],
            "completed",
          ),
        ]);
      useVoiceConversationStore.setState({ userSpeaking: true });
      await vi.runAllTimersAsync();
      expect(mocks.start).not.toHaveBeenCalled();

      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.start).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      await vi.runAllTimersAsync();
      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "False alarm reply.",
      );
      expect(takeVoicePlaybackNotices("session-1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it("preserves terminal delivery before activating a replacement session", async () => {
    mocks.backend = "siri";
    const initialVoice = { name: "Samantha", language: "en-US" };
    const replacementVoice = { name: "Eddy", language: "en-GB" };
    startNativeAssistantSpeech("session-1", vi.fn(), undefined, initialVoice);
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "One. Two. Three." }]),
      ]);
    await vi.waitFor(() => expect(mocks.siriAppend).toHaveBeenCalled());
    const firstStreamId = mocks.siriStart.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "running",
        sessionId: "session-2",
        revision: voice.status.revision + 1,
      },
    }));
    await vi.waitFor(() => expect(mocks.siriStop).toHaveBeenCalled());

    startNativeAssistantSpeech(
      "session-2",
      vi.fn(),
      undefined,
      replacementVoice,
    );
    expect(mocks.siriStart).toHaveBeenCalledTimes(1);

    mocks.siriStreamHandler?.({
      streamId: firstStreamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "One. Two. Three.",
            playedFrames: 650,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({
      speech: { status: "interrupted", spokenThrough: 8 },
    });
    expect(useVoiceConversationStore.getState().status).toMatchObject({
      lifecycle: "running",
      sessionId: "session-2",
    });

    useChatStore
      .getState()
      .setMessages("session-2", [
        assistant(
          [{ type: "text", text: "Replacement reply." }],
          "inProgress",
          "assistant-2",
        ),
      ]);
    await vi.waitFor(() => expect(mocks.siriStart).toHaveBeenCalledTimes(2));
    expect(mocks.siriStart.mock.calls[1]?.[1]).toEqual(replacementVoice);
  });

  it("cancels a deferred replacement when its voice lifecycle stops", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "First reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const firstStreamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "running",
        sessionId: "session-2",
        revision: voice.status.revision + 1,
      },
    }));
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    startNativeAssistantSpeech("session-2", vi.fn());

    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "stopped",
        sessionId: null,
        revision: voice.status.revision + 1,
      },
    }));
    mocks.streamHandler?.({
      streamId: firstStreamId,
      state: "interrupted",
      error: null,
      delivery: { segments: [] },
    });
    await Promise.resolve();

    useChatStore
      .getState()
      .setMessages("session-2", [
        assistant(
          [{ type: "text", text: "Created while voice was off." }],
          "completed",
          "assistant-2",
        ),
      ]);
    useVoiceConversationStore.setState((voice) => ({
      status: {
        ...voice.status,
        lifecycle: "running",
        sessionId: "session-2",
        revision: voice.status.revision + 1,
      },
    }));
    startNativeAssistantSpeech("session-2", vi.fn());
    await Promise.resolve();

    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["returns false", () => mocks.stop.mockResolvedValue(false)],
    ["rejects", () => mocks.stop.mockRejectedValue(new Error("stop failed"))],
  ])("bounds a native stop that %s", async (_label, setStop) => {
    vi.useFakeTimers();
    try {
      setStop();
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant([{ type: "text", text: "First reply." }]),
        ]);
      await vi.runAllTimersAsync();

      useVoiceConversationStore.setState({ userSpeaking: true });
      await Promise.resolve();
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).not.toMatchObject({ speech: { status: "interrupted" } });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        speech: { status: "interrupted", spokenThrough: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a completed event after native stop returns false", async () => {
    mocks.stop.mockResolvedValue(false);
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Already completed." }], "completed"),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());

    useVoiceConversationStore.setState({ userSpeaking: true });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    emit("completed");
    useVoiceConversationStore.setState({ userSpeaking: false });
    await new Promise((resolve) => window.setTimeout(resolve, 300));

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "spoken" } });
  });

  it("resumes after a missing terminal event releases native ownership", async () => {
    mocks.stop
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "First reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const firstStreamId = mocks.start.mock.calls[0]?.[0] as string;

    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      await Promise.resolve();
      expect(mocks.stop).toHaveBeenCalled();
      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[1]?.[0],
        "First reply.",
      );
      expect(takeVoicePlaybackNotices("session-1")).toBeNull();

      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "interrupted",
        error: null,
        delivery: { segments: [] },
      });
      await vi.runAllTimersAsync();

      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(takeVoicePlaybackNotices("session-1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume after a terminal timeout while playback remains active", async () => {
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
      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(mocks.stop).toHaveBeenCalledTimes(3);
      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        speech: { status: "interrupted", spokenThrough: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
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
      finalizeVoiceTranscript("voice-terminal-race");
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }

    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice.match(/\[voice: tts-delivery-failed\]/g)).toHaveLength(1);
    expect(mocks.stop).toHaveBeenCalledTimes(stopCallsBeforeInterruption + 1);
  });

  it("records one notice when held text overlaps a resumable interruption", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "First reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    emit("started");

    useVoiceConversationStore.setState({ userSpeaking: true });
    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " Later suffix.");
    emit("interrupted");
    stopNativeAssistantSpeech();

    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice.match(/\[voice: tts-delivery-failed\]/g)).toHaveLength(1);
    expect(notice).toContain("TTS delivery was interrupted");
    expect(notice).not.toContain("TTS delivery was blocked");
  });

  it("keeps a held suffix unspoken when mute wins the completion race", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Spoken prefix." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    emit("started");

    useVoiceConversationStore.setState({ userSpeaking: true });
    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " Held suffix.");
    useVoiceConversationStore.setState({
      microphoneMuted: true,
      status: {
        ...useVoiceConversationStore.getState().status,
        microphoneMuted: true,
      },
    });
    emit("completed");

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({
      speech: {
        status: "interrupted",
        spokenThrough: "Spoken prefix.".length,
      },
    });
    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice.match(/\[voice: tts-delivery-failed\]/g)).toHaveLength(1);
    expect(notice).toContain('"unspokenText":" Held suffix."');
  });

  it("preserves a spoken prefix when completion wins the mute race", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Spoken prefix." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    emit("started");

    useVoiceConversationStore.setState({ userSpeaking: true });
    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " Held suffix.");
    emit("completed");
    useVoiceConversationStore.setState({
      microphoneMuted: true,
      status: {
        ...useVoiceConversationStore.getState().status,
        microphoneMuted: true,
      },
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({
      speech: {
        status: "interrupted",
        spokenThrough: "Spoken prefix.".length,
      },
    });
    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice.match(/\[voice: tts-delivery-failed\]/g)).toHaveLength(1);
    expect(notice).toContain('"spokenText":"Spoken prefix."');
    expect(notice).toContain('"unspokenText":" Held suffix."');
  });

  it("does not mark a held suffix spoken after an interrupted terminal", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Spoken prefix." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;
    emit("started");

    useVoiceConversationStore.setState({ userSpeaking: true });
    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-1", " Held suffix.");
    useVoiceConversationStore.setState({
      microphoneMuted: true,
      status: {
        ...useVoiceConversationStore.getState().status,
        microphoneMuted: true,
      },
    });
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "Spoken prefix.",
            playedFrames: 1_000,
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
        spokenThrough: "Spoken prefix.".length,
      },
    });
    const notice = takeVoicePlaybackNotices("session-1") ?? "";
    expect(notice.match(/\[voice: tts-delivery-failed\]/g)).toHaveLength(1);
    expect(notice).toContain('"unspokenText":" Held suffix."');
  });

  it("does not apply a completed terminal to a held rewrite", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Original reply." }]),
      ]);
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalled());
    const streamId = mocks.start.mock.calls[0]?.[0] as string;
    emit("started");

    useVoiceConversationStore.setState({ userSpeaking: true });
    useChatStore
      .getState()
      .setMessages("session-1", [assistant([{ type: "text", text: "New." }])]);
    useVoiceConversationStore.setState({
      microphoneMuted: true,
      status: {
        ...useVoiceConversationStore.getState().status,
        microphoneMuted: true,
      },
    });
    mocks.streamHandler?.({
      streamId,
      state: "completed",
      error: null,
      delivery: null,
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "notSpoken" } });
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
    finalizeVoiceTranscript("voice-delivery-estimate");
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
    await new Promise((resolve) => window.setTimeout(resolve, 300));
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
    finalizeVoiceTranscript("voice-incomplete-estimate");
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
    finalizeVoiceTranscript("voice-short-incomplete");
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
    finalizeVoiceTranscript("voice-interleaved-estimate");
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

    finalizeVoiceTranscript("voice-after-spoken-prefix");
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
    finalizeVoiceTranscript("voice-after-rewrite");
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

    finalizeVoiceTranscript("voice-bounded-notice");
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

  it("plays a reply held during user speech after idle when no transcript arrives", async () => {
    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant([{ type: "text", text: "Held reply." }], "completed"),
        ]);

      await Promise.resolve();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();

      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(249);
      expect(mocks.start).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTimersAsync();
      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "Held reply.",
      );
      expect(mocks.finish).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release held speech when final STT follows VAD idle", async () => {
    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Obsolete reply." }],
            "completed",
            "assistant-delayed-final",
          ),
        ]);

      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(50);
      expect(mocks.start).not.toHaveBeenCalled();

      finalizeVoiceTranscript("voice-k1");
      await vi.advanceTimersByTimeAsync(250);

      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({ speech: { status: "notSpoken" } });
      expect(takeVoicePlaybackNotices("session-1")).toContain(
        "Original text: Obsolete reply.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("plays a K1 continuation held while the same utterance remains active", async () => {
    finalizeVoiceTranscript("voice-k1");
    useVoiceConversationStore.setState({ userSpeaking: true });
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        voiceUser("voice-k1"),
        assistant(
          [{ type: "text", text: "Continuation for K1." }],
          "completed",
          "assistant-k1",
        ),
      ]);

    await Promise.resolve();
    expect(mocks.start).not.toHaveBeenCalled();
    useVoiceConversationStore.setState({ userSpeaking: false });

    await vi.waitFor(() => {
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "Continuation for K1.",
      );
    });
  });

  it("discards held K0 output while allowing a distinct K1 continuation", async () => {
    useVoiceConversationStore.setState({ userSpeaking: true });
    startNativeAssistantSpeech("session-1", vi.fn());
    const oldReply = assistant(
      [{ type: "text", text: "Obsolete K0." }],
      "completed",
      "assistant-k0",
    );
    useChatStore.getState().setMessages("session-1", [oldReply]);

    finalizeVoiceTranscript("voice-k1");
    useChatStore
      .getState()
      .setMessages("session-1", [
        oldReply,
        voiceUser("voice-k1"),
        assistant(
          [{ type: "text", text: "Current K1." }],
          "completed",
          "assistant-k1",
        ),
      ]);
    useVoiceConversationStore.setState({ userSpeaking: false });

    await vi.waitFor(() => {
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "Current K1.",
      );
    });
    expect(mocks.append).not.toHaveBeenCalledWith(
      expect.any(String),
      "Obsolete K0.",
    );
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "notSpoken" } });
  });

  it("keeps an invalidated K0 slot suppressed while a new K1 slot plays", async () => {
    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      startNativeAssistantSpeech("session-1", vi.fn());
      const oldReply = assistant(
        [{ type: "text", text: "Old" }],
        "inProgress",
        "assistant-k0",
      );
      useChatStore.getState().setMessages("session-1", [oldReply]);
      finalizeVoiceTranscript("voice-k1");
      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.runAllTimersAsync();

      useChatStore
        .getState()
        .appendStreamingText("session-1", "assistant-k0", " suffix");
      const withSuffix = useChatStore.getState().messagesBySession[
        "session-1"
      ]?.[0] as Message;
      useChatStore
        .getState()
        .setMessages("session-1", [
          withSuffix,
          voiceUser("voice-k1"),
          assistant(
            [{ type: "text", text: "Eligible K1." }],
            "inProgress",
            "assistant-k1",
          ),
        ]);
      await vi.runAllTimersAsync();

      expect(mocks.append).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("suffix"),
      );
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "Eligible K1.",
      );
      useChatStore
        .getState()
        .updateMessage("session-1", "assistant-k0", (message) => ({
          ...message,
          metadata: { ...message.metadata, completionStatus: "completed" },
        }));
      await vi.runAllTimersAsync();
      expect(mocks.finish).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        text: "Old suffix",
        speech: { status: "notSpoken" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps every later block of an invalidated response suppressed after causal rollback", async () => {
    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      startNativeAssistantSpeech("session-1", vi.fn());
      const oldReply = assistant(
        [{ type: "text", text: "Old block." }],
        "inProgress",
        "assistant-k0",
      );
      useChatStore.getState().setMessages("session-1", [oldReply]);

      finalizeVoiceTranscript("voice-k1");
      useVoiceConversationStore.setState({
        latestFinalizedTranscriptKey: null,
      });
      useChatStore.getState().setMessages("session-1", [
        {
          ...oldReply,
          content: [
            ...oldReply.content,
            { type: "text", text: "New block after rollback." },
          ],
        },
      ]);
      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.runAllTimersAsync();

      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[1],
      ).toMatchObject({ speech: { status: "notSpoken" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains completion until a replacement response can own a stream", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    const oldReply = assistant(
      [{ type: "text", text: "Interrupted K0." }],
      "inProgress",
      "assistant-k0",
    );
    useChatStore.getState().setMessages("session-1", [oldReply]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    emit("started");

    finalizeVoiceTranscript("voice-k1");
    useChatStore
      .getState()
      .setMessages("session-1", [
        oldReply,
        voiceUser("voice-k1"),
        assistant(
          [{ type: "text", text: "Completed K1." }],
          "completed",
          "assistant-k1",
        ),
      ]);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    expect(mocks.finish).not.toHaveBeenCalled();

    emit("interrupted");
    await vi.waitFor(() => {
      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[1]?.[0],
        "Completed K1.",
      );
      expect(mocks.finish).toHaveBeenCalledWith(mocks.start.mock.calls[1]?.[0]);
    });
  });

  it("preserves partial interruption status for suffixes arriving during speech", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant(
          [{ type: "text", text: "Partially spoken." }],
          "inProgress",
          "assistant-k0",
        ),
      ]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    emit("started");
    const streamId = mocks.start.mock.calls[0]?.[0] as string;

    useVoiceConversationStore.setState({ userSpeaking: true });
    mocks.streamHandler?.({
      streamId,
      state: "interrupted",
      error: null,
      delivery: {
        segments: [
          {
            text: "Partially spoken.",
            playedFrames: 500,
            totalFrames: 1_000,
            synthesisComplete: true,
          },
        ],
      },
    });
    useChatStore
      .getState()
      .appendStreamingText("session-1", "assistant-k0", " Later suffix.");
    finalizeVoiceTranscript("voice-k1");
    useVoiceConversationStore.setState({ userSpeaking: false });

    await vi.waitFor(() => {
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({ speech: { status: "interrupted" } });
    });
    expect(mocks.append).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Later suffix"),
    );
  });

  it("cancels active K0 playback and then speaks new K1 output", async () => {
    startNativeAssistantSpeech("session-1", vi.fn());
    const oldReply = assistant(
      [{ type: "text", text: "Active K0." }],
      "inProgress",
      "assistant-k0",
    );
    useChatStore.getState().setMessages("session-1", [oldReply]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    emit("started");

    finalizeVoiceTranscript("voice-k1");
    useChatStore
      .getState()
      .setMessages("session-1", [
        oldReply,
        voiceUser("voice-k1"),
        assistant(
          [{ type: "text", text: "Fresh K1." }],
          "completed",
          "assistant-k1",
        ),
      ]);

    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    emit("interrupted");
    await vi.waitFor(() => {
      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[1]?.[0],
        "Fresh K1.",
      );
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "interrupted" } });
  });

  it("resumes an interrupted reply at the first incomplete synthesis segment when no STT arrives", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "First sentence. Second sentence." }],
            "completed",
            "assistant-resume",
          ),
        ]);
      await vi.runAllTimersAsync();
      const firstStreamId = mocks.start.mock.calls[0]?.[0] as string;
      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "started",
        error: null,
      });

      const stopCallsBeforeInterruption = mocks.stop.mock.calls.length;
      useVoiceConversationStore.setState({ userSpeaking: true });
      await Promise.resolve();
      expect(mocks.stop).toHaveBeenCalledTimes(stopCallsBeforeInterruption + 1);
      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "interrupted",
        error: null,
        delivery: {
          segments: [
            {
              text: "First sentence. ",
              playedFrames: 1_000,
              totalFrames: 1_000,
              synthesisComplete: true,
            },
            {
              text: "Second sentence.",
              playedFrames: 500,
              totalFrames: 1_000,
              synthesisComplete: true,
            },
          ],
        },
      });
      expect(takeVoicePlaybackNotices("session-1")).toBeNull();

      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(249);
      expect(mocks.start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTimersAsync();

      expect(mocks.start).toHaveBeenCalledTimes(2);
      const resumedStreamId = mocks.start.mock.calls[1]?.[0] as string;
      expect(mocks.append).toHaveBeenCalledWith(
        resumedStreamId,
        "Second sentence.",
      );
      expect(mocks.append).not.toHaveBeenCalledWith(
        resumedStreamId,
        "First sentence. ",
      );
      expect(mocks.finish).toHaveBeenCalledWith(resumedStreamId);

      mocks.streamHandler?.({
        streamId: resumedStreamId,
        state: "completed",
        error: null,
      });
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({ speech: { status: "spoken" } });
      expect(takeVoicePlaybackNotices("session-1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a delayed native interruption event before resuming", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Delayed terminal." }],
            "completed",
            "assistant-delayed-resume",
          ),
        ]);
      await vi.runAllTimersAsync();
      const firstStreamId = mocks.start.mock.calls[0]?.[0] as string;
      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "started",
        error: null,
      });

      useVoiceConversationStore.setState({ userSpeaking: true });
      useVoiceConversationStore.setState({ userSpeaking: false });
      useChatStore
        .getState()
        .appendStreamingText(
          "session-1",
          "assistant-delayed-resume",
          " Later suffix.",
        );
      await vi.advanceTimersByTimeAsync(250);
      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(mocks.append).not.toHaveBeenCalledWith(
        firstStreamId,
        " Later suffix.",
      );

      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "interrupted",
        error: null,
        delivery: { segments: [] },
      });
      await vi.runAllTimersAsync();
      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[1]?.[0],
        "Delayed terminal. Later suffix.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rewind across repeated false-positive interruptions", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore.getState().setMessages("session-1", [
        assistant(
          [
            {
              type: "text",
              text: "First sentence. Second sentence. Third sentence.",
            },
          ],
          "completed",
          "assistant-repeated-resume",
        ),
      ]);
      await vi.runAllTimersAsync();
      const firstStreamId = mocks.start.mock.calls[0]?.[0] as string;
      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "started",
        error: null,
      });
      useVoiceConversationStore.setState({ userSpeaking: true });
      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "interrupted",
        error: null,
        delivery: {
          segments: [
            {
              text: "First sentence. ",
              playedFrames: 1_000,
              totalFrames: 1_000,
              synthesisComplete: true,
            },
            {
              text: "Second sentence. ",
              playedFrames: 500,
              totalFrames: 1_000,
              synthesisComplete: true,
            },
          ],
        },
      });
      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(500);
      await vi.runAllTimersAsync();

      const secondStreamId = mocks.start.mock.calls[1]?.[0] as string;
      expect(mocks.append).toHaveBeenCalledWith(
        secondStreamId,
        "Second sentence. Third sentence.",
      );
      mocks.streamHandler?.({
        streamId: secondStreamId,
        state: "started",
        error: null,
      });
      useVoiceConversationStore.setState({ userSpeaking: true });
      mocks.streamHandler?.({
        streamId: secondStreamId,
        state: "interrupted",
        error: null,
        delivery: {
          segments: [
            {
              text: "Second sentence. ",
              playedFrames: 1_000,
              totalFrames: 1_000,
              synthesisComplete: true,
            },
            {
              text: "Third sentence.",
              playedFrames: 500,
              totalFrames: 1_000,
              synthesisComplete: true,
            },
          ],
        },
      });
      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(500);
      await vi.runAllTimersAsync();

      const thirdStreamId = mocks.start.mock.calls[2]?.[0] as string;
      expect(mocks.append).toHaveBeenCalledWith(
        thirdStreamId,
        "Third sentence.",
      );
      expect(mocks.append).not.toHaveBeenCalledWith(
        thirdStreamId,
        "First sentence. Second sentence. Third sentence.",
      );
      expect(mocks.append).not.toHaveBeenCalledWith(
        thirdStreamId,
        "Second sentence. Third sentence.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts rewritten text from the beginning after a false interruption", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Original reply." }],
            "completed",
            "assistant-rewritten-resume",
          ),
        ]);
      await vi.runAllTimersAsync();
      const firstStreamId = mocks.start.mock.calls[0]?.[0] as string;
      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "started",
        error: null,
      });
      useVoiceConversationStore.setState({ userSpeaking: true });
      mocks.streamHandler?.({
        streamId: firstStreamId,
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
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Replacement text." }],
            "completed",
            "assistant-rewritten-resume",
          ),
        ]);

      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(500);
      await vi.runAllTimersAsync();

      const resumedStreamId = mocks.start.mock.calls[1]?.[0] as string;
      expect(mocks.append).toHaveBeenCalledWith(
        resumedStreamId,
        "Replacement text.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards resumable speech when the microphone is explicitly muted", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Do not resume me." }],
            "completed",
            "assistant-muted",
          ),
        ]);
      await vi.runAllTimersAsync();
      const streamId = mocks.start.mock.calls[0]?.[0] as string;
      mocks.streamHandler?.({
        streamId,
        state: "started",
        error: null,
      });
      useVoiceConversationStore.setState({ userSpeaking: true });
      mocks.streamHandler?.({
        streamId,
        state: "interrupted",
        error: null,
        delivery: { segments: [] },
      });

      useVoiceConversationStore.setState({
        userSpeaking: false,
        microphoneMuted: true,
        status: {
          ...useVoiceConversationStore.getState().status,
          microphoneMuted: true,
        },
      });
      await vi.runAllTimersAsync();

      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(takeVoicePlaybackNotices("session-1")).toContain(
        "Original text: Do not resume me.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards resumable speech when native assistant speech stops", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Stopped remainder." }],
            "completed",
            "assistant-stopped",
          ),
        ]);
      await vi.runAllTimersAsync();
      const streamId = mocks.start.mock.calls[0]?.[0] as string;
      mocks.streamHandler?.({
        streamId,
        state: "started",
        error: null,
      });
      useVoiceConversationStore.setState({ userSpeaking: true });
      mocks.streamHandler?.({
        streamId,
        state: "interrupted",
        error: null,
        delivery: { segments: [] },
      });

      stopNativeAssistantSpeech();
      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.runAllTimersAsync();

      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(takeVoicePlaybackNotices("session-1")).toContain(
        "Original text: Stopped remainder.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same resumption path for Siri playback", async () => {
    vi.useFakeTimers();
    try {
      mocks.backend = "siri";
      const initialSiriVoice = {
        name: "Samantha",
        language: "en-US",
      };
      startNativeAssistantSpeech(
        "session-1",
        vi.fn(),
        undefined,
        initialSiriVoice,
      );
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Siri resumes." }],
            "completed",
            "assistant-siri-resume",
          ),
        ]);
      await vi.runAllTimersAsync();
      const streamId = mocks.siriStart.mock.calls[0]?.[0] as string;
      mocks.siriStreamHandler?.({
        streamId,
        state: "started",
        error: null,
      });
      useVoiceConversationStore.setState({ userSpeaking: true });
      mocks.siriStreamHandler?.({
        streamId,
        state: "interrupted",
        error: null,
        delivery: { segments: [] },
      });
      const refreshedSiriVoice = { name: "Eddy", language: "en-GB" };
      startNativeAssistantSpeech(
        "session-1",
        vi.fn(),
        undefined,
        refreshedSiriVoice,
      );
      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(500);
      await vi.runAllTimersAsync();

      expect(mocks.siriStart).toHaveBeenCalledTimes(2);
      expect(mocks.siriStart.mock.calls[1]?.[1]).toEqual(refreshedSiriVoice);
      expect(mocks.siriAppend).toHaveBeenCalledWith(
        mocks.siriStart.mock.calls[1]?.[0],
        "Siri resumes.",
      );
      expect(mocks.siriFinish).toHaveBeenCalledWith(
        mocks.siriStart.mock.calls[1]?.[0],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when voice-origin metadata cannot establish ownership", async () => {
    finalizeVoiceTranscript("voice-k1");
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        voiceUser("voice-k1", { voiceUtteranceId: undefined }),
        assistant(
          [{ type: "text", text: "Unowned output." }],
          "completed",
          "assistant-malformed",
        ),
      ]);

    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.content[0],
    ).toMatchObject({ speech: { status: "notSpoken" } });
  });

  it("speaks a typed turn after finalized voice input", async () => {
    finalizeVoiceTranscript("voice-k1");
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore.getState().setMessages("session-1", [
      voiceUser("voice-k1"),
      {
        id: "typed-user",
        role: "user",
        created: 2,
        content: [{ type: "text", text: "Typed follow-up" }],
      },
      assistant(
        [{ type: "text", text: "Typed-turn reply." }],
        "completed",
        "assistant-typed",
      ),
    ]);

    await vi.waitFor(() =>
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "Typed-turn reply.",
      ),
    );
  });

  it("hydrates causal ownership from an existing voice transcript", async () => {
    useChatStore.getState().setMessages("session-1", [voiceUser("voice-k1")]);
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        voiceUser("voice-k1"),
        assistant(
          [{ type: "text", text: "Recovered-turn reply." }],
          "completed",
          "assistant-recovered",
        ),
      ]);

    await vi.waitFor(() =>
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "Recovered-turn reply.",
      ),
    );
    expect(
      useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe(["session-1", "lifecycle-1", "1", "voice-k1"].join("\0"));
  });

  it("plays each completed reply held during user speech in its own stream", async () => {
    useVoiceConversationStore.setState({ userSpeaking: true });
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant(
          [{ type: "text", text: "First held reply." }],
          "completed",
          "assistant-1",
        ),
        assistant(
          [{ type: "text", text: "Second held reply." }],
          "completed",
          "assistant-2",
        ),
      ]);

    useVoiceConversationStore.setState({ userSpeaking: false });
    await vi.waitFor(() => {
      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "First held reply.",
      );
      expect(mocks.finish).toHaveBeenCalledTimes(1);
    });
    expect(mocks.append).not.toHaveBeenCalledWith(
      expect.any(String),
      "Second held reply.",
    );

    mocks.streamHandler?.({
      streamId: mocks.start.mock.calls[0]?.[0] as string,
      state: "completed",
      error: null,
    });

    await vi.waitFor(() => {
      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[1]?.[0],
        "Second held reply.",
      );
      expect(mocks.finish).toHaveBeenCalledTimes(2);
    });
  });

  it("discards every pending held reply when a transcript interrupts the first", async () => {
    useVoiceConversationStore.setState({ userSpeaking: true });
    startNativeAssistantSpeech("session-1", vi.fn());
    const first = assistant(
      [{ type: "text", text: "First obsolete reply." }],
      "completed",
      "assistant-held-first",
    );
    const second = assistant(
      [{ type: "text", text: "Second obsolete reply." }],
      "completed",
      "assistant-held-second",
    );
    useChatStore.getState().setMessages("session-1", [first, second]);

    useVoiceConversationStore.setState({ userSpeaking: false });
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    emit("started");
    finalizeVoiceTranscript("voice-after-first");

    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.append).not.toHaveBeenCalledWith(
      expect.any(String),
      "Second obsolete reply.",
    );
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.content[0],
    ).toMatchObject({ speech: { status: "notSpoken" } });
  });

  it("does not release held speech when user speech resumes before the idle timer", async () => {
    useVoiceConversationStore.setState({ userSpeaking: true });
    startNativeAssistantSpeech("session-1", vi.fn());
    useChatStore
      .getState()
      .setMessages("session-1", [
        assistant([{ type: "text", text: "Still held." }], "completed"),
      ]);

    useVoiceConversationStore.setState({ userSpeaking: false });
    useVoiceConversationStore.setState({ userSpeaking: true });
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(mocks.start).not.toHaveBeenCalled();

    useVoiceConversationStore.setState({ userSpeaking: false });
    await vi.waitFor(() => {
      expect(mocks.append).toHaveBeenCalledWith(
        mocks.start.mock.calls[0]?.[0],
        "Still held.",
      );
    });
  });

  it("preserves the recognition deadline across repeated VAD edges", async () => {
    vi.useFakeTimers();
    try {
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant([{ type: "text", text: "Interrupted reply." }]),
        ]);
      await vi.runAllTimersAsync();
      const firstStreamId = mocks.start.mock.calls[0]?.[0] as string;

      useVoiceConversationStore.setState({ userSpeaking: true });
      mocks.streamHandler?.({
        streamId: firstStreamId,
        state: "interrupted",
        error: null,
        delivery: { segments: [] },
      });
      useVoiceConversationStore.setState({ userSpeaking: false });

      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.start).toHaveBeenCalledTimes(1);

      useVoiceConversationStore.setState({ userSpeaking: true });
      useVoiceConversationStore.setState({ userSpeaking: false });
      await vi.advanceTimersByTimeAsync(199);
      expect(mocks.start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.start).toHaveBeenCalledTimes(2);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never starts a held reply when a newer finalized voice transcript arrives", async () => {
    useVoiceConversationStore.setState({ userSpeaking: true });
    startNativeAssistantSpeech("session-1", vi.fn());
    const heldReply = assistant(
      [{ type: "text", text: "Obsolete held reply." }],
      "completed",
    );
    useChatStore.getState().setMessages("session-1", [heldReply]);
    await Promise.resolve();

    finalizeVoiceTranscript();
    useVoiceConversationStore.setState({ userSpeaking: false });

    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "notSpoken" } });
    expect(takeVoicePlaybackNotices("session-1")).toContain(
      "Original text: Obsolete held reply.",
    );
  });

  it("discards text appended during idle settling when a voice transcript arrives", async () => {
    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      startNativeAssistantSpeech("session-1", vi.fn());
      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Hello" }],
            "completed",
            "assistant-idle-suffix",
          ),
        ]);

      useVoiceConversationStore.setState({ userSpeaking: false });
      useChatStore
        .getState()
        .appendStreamingText("session-1", "assistant-idle-suffix", " world");
      finalizeVoiceTranscript();

      await vi.runAllTimersAsync();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({
        text: "Hello world",
        speech: { status: "notSpoken" },
      });
      expect(takeVoicePlaybackNotices("session-1")).toContain(
        "Original text: Hello world",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds assistant text first arriving during the idle settling task", async () => {
    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      startNativeAssistantSpeech("session-1", vi.fn());
      useVoiceConversationStore.setState({ userSpeaking: false });

      const lateReply = assistant(
        [{ type: "text", text: "Late obsolete reply." }],
        "completed",
        "assistant-after-idle",
      );
      useChatStore.getState().setMessages("session-1", [lateReply]);
      finalizeVoiceTranscript("voice-during-idle-settlement");

      await vi.runAllTimersAsync();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({ speech: { status: "notSpoken" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards stale assistant text that arrives after finalized STT during the hold", async () => {
    vi.useFakeTimers();
    try {
      useVoiceConversationStore.setState({ userSpeaking: true });
      startNativeAssistantSpeech("session-1", vi.fn());
      finalizeVoiceTranscript("voice-before-stale-reply");

      useChatStore
        .getState()
        .setMessages("session-1", [
          assistant(
            [{ type: "text", text: "Stale reply after final STT." }],
            "completed",
            "assistant-after-final-stt",
          ),
        ]);
      useVoiceConversationStore.setState({ userSpeaking: false });

      await vi.runAllTimersAsync();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(
        useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
      ).toMatchObject({ speech: { status: "notSpoken" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels held playback when the finalized voice transcript lands after playback starts", async () => {
    useVoiceConversationStore.setState({ userSpeaking: true });
    startNativeAssistantSpeech("session-1", vi.fn());
    const heldReply = assistant(
      [{ type: "text", text: "Reply released after idle." }],
      "completed",
    );
    useChatStore.getState().setMessages("session-1", [heldReply]);
    useVoiceConversationStore.setState({ userSpeaking: false });

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    emit("started");
    finalizeVoiceTranscript("voice-user-late");

    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    emit("interrupted");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.content[0],
    ).toMatchObject({ speech: { status: "interrupted" } });
  });
});
