import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  createRealtimeTranscriptReplayEvents,
  requestOpenAiRealtimeConversationStart,
  resetOpenAiRealtimeConversationRuntimeForTests,
  stopOpenAiRealtimeConversation,
  useOpenAiRealtimeConversation,
} from "./useOpenAiRealtimeConversation";

const mocks = vi.hoisted(() => ({
  appendSessionSystemPrompt: vi.fn(),
  claimMicrophone: vi.fn(),
  connectPeer: vi.fn(),
  createHandoffToolOutput: vi.fn(),
  createInvalidToolCallOutput: vi.fn(),
  createPeer: vi.fn(),
  createSession: vi.fn(),
  createResponse: true,
  completeExpertTurn: vi.fn(),
  dismissHandoffs: vi.fn(),
  enqueueSpokespersonMessage: vi.fn(),
  getExpertPipeCursor: vi.fn(),
  listenControls: vi.fn(),
  publishActivity: vi.fn(),
  publishMuted: vi.fn(),
  reduceProtocol: vi.fn(
    async (_sessionId: string, event: { type?: string }) => {
      const userFinals: Record<string, [string, string]> = {
        "test.transcript": ["user-item-1", "hello master"],
        "test.transcript_repository": [
          "user-item-repository",
          "how many repos are in my development folder?",
        ],
        "test.transcript_followup": [
          "user-item-2",
          "are any of them symbolic links?",
        ],
        "test.transcript_corrected": ["user-item-1", "hello master"],
      };
      const spokespersonFinals: Record<string, [string, string, boolean?]> = {
        "test.emissary": ["emissary-item-1", "hello user"],
        "test.emissary_result": [
          "emissary-item-2",
          "You have 21 repositories.",
        ],
        "test.emissary_followup_ack": ["emissary-item-3", "I'll verify that."],
        "test.emissary_symlink_result": [
          "emissary-item-4",
          "None of those repositories are symbolic links.",
        ],
        "test.emissary_interrupted": [
          "emissary-item-interrupted",
          "partially heard",
          true,
        ],
      };
      const user = event.type ? userFinals[event.type] : undefined;
      if (user)
        return [
          {
            evidence: "provider_final",
            id: 1,
            interrupted: false,
            itemId: user[0],
            speaker: "user",
            text: user[1],
            type: "transcript.finalized",
          },
        ];
      const spokesperson = event.type
        ? spokespersonFinals[event.type]
        : undefined;
      if (spokesperson)
        return [
          {
            evidence: spokesperson[2] ? "provider_delta" : "provider_final",
            id: 1,
            interrupted: spokesperson[2] ?? false,
            itemId: spokesperson[0],
            speaker: "spokesperson",
            text: spokesperson[1],
            type: "transcript.finalized",
          },
        ];
      if (event.type === "test.transcript_partial")
        return [
          {
            itemId: "user-item-1",
            speaker: "user",
            text: "hello",
            type: "transcript.updated",
          },
        ];
      if (event.type === "test.emissary_partial_first")
        return [
          {
            itemId: "emissary-item-multi",
            speaker: "spokesperson",
            text: "Let me think about that.",
            type: "transcript.updated",
          },
        ];
      if (event.type === "test.emissary_partial_second")
        return [
          {
            itemId: "emissary-item-multi",
            speaker: "spokesperson",
            text: "Let me think about that. I received a compact transcript.",
            type: "transcript.updated",
          },
        ];
      if (event.type === "test.handoff")
        return [
          {
            callId: "call-1",
            message: "Please inspect the disk.",
            type: "handoff",
          },
        ];
      if (event.type === "test.handoff_followup")
        return [
          {
            callId: "call-2",
            message: "Please verify whether those repositories are symlinks.",
            type: "handoff",
          },
        ];
      if (event.type === "test.invalid_tool_call")
        return [
          {
            callId: "call-broken",
            error: "JSON Parse error: Unterminated string",
            toolName: "handoff",
            type: "tool_call.invalid",
          },
        ];
      return [];
    },
  ),
  pipeInitialCursors: [] as number[],
  pipeNextId: 1,
  pipePending: [] as Array<{
    id: number;
    sender: "master" | "emissary";
    recipient: "master" | "emissary";
    senderCursor: number;
    message: string;
  }>,
  pipeConsumed: { master: 0, emissary: 0 },
  openHandoffs: new Map<
    string,
    { message: string; reminderAttempts: number; resolving: boolean }
  >(),
  rebindControls: vi.fn(),
  registerHandoff: vi.fn(),
  registerEmissary: vi.fn(),
  recordToolOutput: vi.fn(),
  activeEmissary: null as null | {
    sessionId: string;
    completeMasterTurn(completion: { reminderHandoffIds: string[] }): void;
    dismissHandoffs(
      cursor: number,
      handoffIds: string[],
      reason: string,
    ): Promise<unknown>;
    sendMasterMessage(
      message: string,
      cursor: number,
      mode: "context" | "say",
      resolves: string[],
    ): Promise<unknown>;
  },
  releaseBridge: vi.fn(),
  releaseMicrophone: vi.fn(),
  setControlsSuppressed: vi.fn(),
  startControls: vi.fn(),
  startProtocol: vi.fn(),
  stopControls: vi.fn(),
  stopProtocol: vi.fn(),
  waitForBridgeReady: vi.fn(),
  sendRealtimeEvents: vi.fn(),
  sendExpertPipeMessage: vi.fn(),
  markHandoffsResolving: vi.fn(),
  steerPrompt: vi.fn(),
  requestToolOutput: vi.fn(),
  requestMasterMessage: vi.fn(),
  requestTypedUserMessage: vi.fn(),
  unknownHandoffIds: vi.fn(),
}));

vi.mock("@/shared/api/acpApi", () => ({
  appendSessionSystemPrompt: mocks.appendSessionSystemPrompt,
}));

vi.mock("@/shared/api/openaiRealtime", () => ({
  claimVoiceDictationMicrophone: mocks.claimMicrophone,
  completeOpenAiRealtimeExpertTurn: mocks.completeExpertTurn,
  createOpenAiRealtimeVoiceSession: mocks.createSession,
  dismissOpenAiRealtimeHandoffs: mocks.dismissHandoffs,
  enqueueOpenAiRealtimeSpokespersonMessage: mocks.enqueueSpokespersonMessage,
  getOpenAiRealtimeExpertPipeCursor: mocks.getExpertPipeCursor,
  listenToOpenAiRealtimeVoiceControls: mocks.listenControls,
  markOpenAiRealtimeHandoffsResolving: mocks.markHandoffsResolving,
  publishOpenAiRealtimeVoiceActivity: mocks.publishActivity,
  publishOpenAiRealtimeVoiceMicrophoneMuted: mocks.publishMuted,
  rebindOpenAiRealtimeVoiceControls: mocks.rebindControls,
  registerOpenAiRealtimeHandoff: mocks.registerHandoff,
  reduceOpenAiRealtimeSpokespersonEvent: async (
    sessionId: string,
    event: { type?: string },
  ) => ({
    protocolEvents: await mocks.reduceProtocol(sessionId, event),
    clientEvents: [],
    completedHandoffIds: [],
    failedHandoffIds: [],
  }),
  requestOpenAiRealtimeExpertMessage: (_sessionId: string, message: unknown) =>
    Promise.resolve(mocks.requestMasterMessage(message)),
  requestOpenAiRealtimeToolOutput: (
    _sessionId: string,
    event: unknown,
    requestResponse: boolean,
  ) =>
    Promise.resolve(
      requestResponse
        ? mocks.requestToolOutput(event)
        : mocks.recordToolOutput(event),
    ),
  requestOpenAiRealtimeTypedUserMessage: (_sessionId: string, text: string) =>
    Promise.resolve(mocks.requestTypedUserMessage(text)),
  sendOpenAiRealtimeExpertPipeMessage: mocks.sendExpertPipeMessage,
  releaseVoiceDictationMicrophone: mocks.releaseMicrophone,
  setOpenAiRealtimeVoiceControlsSuppressed: mocks.setControlsSuppressed,
  startOpenAiRealtimeVoiceControls: mocks.startControls,
  startOpenAiRealtimeSpokespersonProtocol: mocks.startProtocol,
  stopOpenAiRealtimeVoiceControls: mocks.stopControls,
  stopOpenAiRealtimeSpokespersonProtocol: mocks.stopProtocol,
  unknownOpenAiRealtimeHandoffIds: mocks.unknownHandoffIds,
}));

vi.mock("@/features/chat/lib/openaiRealtimeAudio", () => ({
  connectOpenAiRealtimePeerConnection: mocks.connectPeer,
  createOpenAiRealtimePeerConnection: mocks.createPeer,
}));

vi.mock("@/features/chat/lib/steerCore", () => ({
  steerPromptInSession: mocks.steerPrompt,
}));

vi.mock("../lib/realtimeEmissaryBridge", () => ({
  registerRealtimeEmissary: (emissary: typeof mocks.activeEmissary) => {
    mocks.activeEmissary = emissary;
    return mocks.registerEmissary();
  },
  waitForRealtimeEmissaryBridgeReady: mocks.waitForBridgeReady,
}));

vi.mock("../lib/realtimeVoicePreference", () => ({
  getRealtimeVoicePreference: () => ({
    model: "gpt-realtime-2.1",
    speed: 1,
    transcriptionModel: "gpt-realtime-whisper",
    voice: "marin",
    turnDetection: "server_vad",
    eagerness: "auto",
    interruptResponse: true,
    createResponse: mocks.createResponse,
    vadThreshold: 0.5,
    prefixPaddingMs: 300,
    silenceDurationMs: 500,
    idleTimeoutMs: null,
    noiseReduction: "off",
    transcriptionLanguage: "",
    transcriptionPrompt: "",
    reasoningEffort: "default",
    maxOutputTokens: null,
  }),
}));

vi.mock("../lib/realtimeEmissaryProtocol", () => ({
  configureRealtimeEmissarySession: vi.fn(),
  createInvalidToolCallOutput: mocks.createInvalidToolCallOutput,
  createHandoffToolOutput: mocks.createHandoffToolOutput,
  REALTIME_EXPERT_INSTRUCTIONS: "Expert instructions",
  sendRealtimeEvents: mocks.sendRealtimeEvents,
}));

class FakeDataChannel extends EventTarget {
  readonly close = vi.fn();
  readyState: RTCDataChannelState = "open";
  readonly send = vi.fn();
}

class FakePeer extends EventTarget {
  readonly addTrack = vi.fn();
  readonly close = vi.fn();
  readonly createDataChannel = vi.fn();
  connectionState: RTCPeerConnectionState = "connected";
  iceConnectionState: RTCIceConnectionState = "connected";

  constructor(channel: FakeDataChannel) {
    super();
    this.createDataChannel.mockReturnValue(channel);
  }
}

class FakeAudio extends EventTarget {
  autoplay = false;
  readonly pause = vi.fn();
  readonly play = vi.fn().mockResolvedValue(undefined);
  srcObject: MediaStream | null = null;
}

const originalAudio = globalThis.Audio;
const originalMediaDevices = navigator.mediaDevices;
let channel: FakeDataChannel;
let peer: FakePeer;
let track: MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
let realtimeControlListener:
  | ((control: {
      sessionId: string;
      revision: number;
      action: "stop" | "mute";
      muted?: boolean;
    }) => void)
  | undefined;

function renderConversation(sessionId: string, onSend = vi.fn()) {
  return renderHook(() =>
    useOpenAiRealtimeConversation({ enabled: true, onSend, sessionId }),
  );
}

function acceptedHandoffId(callId: string): string {
  const call = mocks.createHandoffToolOutput.mock.calls.find(
    ([candidate]) => candidate === callId,
  );
  const handoffId = call?.[1]?.handoff_id;
  if (typeof handoffId !== "string") {
    throw new Error(`No accepted handoff for ${callId}`);
  }
  return handoffId;
}

describe("createRealtimeTranscriptReplayEvents", () => {
  it("reconstructs a compact ordinary transcript without realtime state", () => {
    expect(
      createRealtimeTranscriptReplayEvents([
        {
          id: "u1",
          role: "user",
          created: 1,
          content: [{ type: "text", text: "What is in this folder?" }],
        },
        {
          id: "progress",
          role: "assistant",
          created: 2,
          content: [{ type: "text", text: "I am checking." }],
          metadata: { completionStatus: "completed" },
        },
        {
          id: "final",
          role: "assistant",
          created: 3,
          content: [{ type: "text", text: "There are 25 directories." }],
          metadata: { completionStatus: "completed" },
        },
        {
          id: "coordination",
          role: "assistant",
          created: 4,
          content: [{ type: "text", text: "Private coordination" }],
          metadata: {
            completionStatus: "completed",
            personaName: "Expert → Spokesperson",
          },
        },
        {
          id: "u2",
          role: "user",
          created: 5,
          content: [{ type: "text", text: "Are any symlinks?" }],
        },
      ]),
    ).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is in this folder?" }],
        },
      },
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "There are 25 directories." }],
        },
      },
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Are any symlinks?" }],
        },
      },
    ]);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeEmissary = null;
  mocks.createResponse = true;
  useChatStore.setState({
    loadingSessionIds: new Set(),
    messagesBySession: {},
    queuedMessageBySession: {},
    sessionStateById: {},
  });
  useChatSessionStore.setState({ sessions: [] });
  channel = new FakeDataChannel();
  realtimeControlListener = undefined;
  peer = new FakePeer(channel);
  track = {
    enabled: true,
    stop: vi.fn(),
  } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
  mocks.appendSessionSystemPrompt.mockResolvedValue(undefined);
  mocks.claimMicrophone.mockResolvedValue(undefined);
  mocks.connectPeer.mockResolvedValue(undefined);
  mocks.createHandoffToolOutput.mockReturnValue({
    type: "conversation.item.create",
    item: { type: "function_call_output" },
  });
  mocks.createInvalidToolCallOutput.mockReturnValue({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call-broken",
      output: '{"accepted":false,"reason":"invalid_arguments"}',
    },
  });
  mocks.createPeer.mockReturnValue(peer);
  mocks.createSession.mockResolvedValue({ clientSecret: "test-secret" });
  mocks.listenControls.mockImplementation(async (listener) => {
    realtimeControlListener = listener;
    return vi.fn();
  });
  mocks.publishActivity.mockResolvedValue(undefined);
  mocks.publishMuted.mockResolvedValue(undefined);
  mocks.pipeInitialCursors.length = 0;
  mocks.openHandoffs.clear();
  mocks.registerHandoff.mockImplementation(
    async (_sessionId: string, handoffId: string, message: string) => {
      mocks.openHandoffs.set(handoffId, {
        message,
        reminderAttempts: 0,
        resolving: false,
      });
    },
  );
  mocks.unknownHandoffIds.mockImplementation(
    async (_sessionId: string, handoffIds: string[]) =>
      handoffIds.filter((handoffId) => !mocks.openHandoffs.has(handoffId)),
  );
  mocks.markHandoffsResolving.mockImplementation(
    async (_sessionId: string, handoffIds: string[]) => {
      for (const handoffId of handoffIds) {
        const handoff = mocks.openHandoffs.get(handoffId);
        if (handoff) handoff.resolving = true;
      }
    },
  );
  mocks.dismissHandoffs.mockImplementation(
    async (_sessionId: string, handoffIds: string[]) => {
      for (const handoffId of handoffIds) mocks.openHandoffs.delete(handoffId);
    },
  );
  mocks.completeExpertTurn.mockImplementation(
    async (
      _sessionId: string,
      retryingHandoffIds: string[],
      maxAttempts: number,
    ) => {
      const retrying = new Set(retryingHandoffIds);
      const pending = [...mocks.openHandoffs.entries()].filter(
        ([handoffId, handoff]) =>
          !handoff.resolving &&
          (handoff.reminderAttempts === 0 || retrying.has(handoffId)),
      );
      if (pending.length === 0) return { status: "none" };
      const exhausted = pending.filter(
        ([, handoff]) => handoff.reminderAttempts >= maxAttempts,
      );
      if (exhausted.length > 0) {
        const handoffIds = exhausted.map(([handoffId]) => handoffId);
        return {
          status: "exhausted",
          handoffIds,
          message: `The Expert left required ${handoffIds.join(", ")} unresolved after ${maxAttempts} reminder attempts.`,
        };
      }
      for (const [, handoff] of pending) handoff.reminderAttempts += 1;
      const handoffIds = pending.map(([handoffId]) => handoffId);
      const requests = pending
        .map(([handoffId, handoff]) => `- ${handoffId}: ${handoff.message}`)
        .join("\n");
      const attempt = Math.max(
        ...pending.map(([, handoff]) => handoff.reminderAttempts),
      );
      return {
        status: "reminder",
        handoffIds,
        attempt,
        requests,
        message: `[Private handoff reminder]\nYou ended your turn without resolving the required handoffs below. Resolve them now with one or more send-to-spokesperson --mode say calls that name every answered handoff in --resolves, or dismiss obsolete handoffs explicitly. Berd will retry this reminder up to ${maxAttempts} times. Do not redo completed work.\n${requests}`,
      };
    },
  );
  const sendPipeMessage = (
    sender: "master" | "emissary",
    cursor: number,
    message: string,
  ) => {
    const active = mocks.pipePending[0];
    if (active && active.sender !== sender) {
      const latest = mocks.pipePending.at(-1);
      if (!latest || cursor !== latest.id) {
        return {
          accepted: false as const,
          reason: "pipe_busy" as const,
          cursor: mocks.pipeConsumed[sender],
        };
      }
      mocks.pipeConsumed[sender] = latest.id;
      mocks.pipePending = [];
    }
    if (cursor !== mocks.pipeConsumed[sender]) {
      return {
        accepted: false as const,
        reason: "stale_cursor" as const,
        cursor: mocks.pipeConsumed[sender],
      };
    }
    const outbound = {
      id: mocks.pipeNextId++,
      sender,
      recipient: sender === "master" ? "emissary" : "master",
      senderCursor: cursor,
      message,
    } as const;
    mocks.pipePending.push(outbound);
    return { accepted: true as const, outbound, cursor };
  };
  mocks.rebindControls.mockResolvedValue({
    available: true,
    unavailableReason: null,
    lifecycle: "running",
    sessionId: "promoted-session",
    ownerWindowLabel: "main",
    microphoneMuted: false,
    revision: 8,
  });
  mocks.registerEmissary.mockReturnValue(mocks.releaseBridge);
  mocks.releaseMicrophone.mockResolvedValue(undefined);
  mocks.setControlsSuppressed.mockResolvedValue(undefined);
  mocks.startControls.mockImplementation(async (sessionId: string) => ({
    available: true,
    unavailableReason: null,
    lifecycle: "running",
    sessionId,
    ownerWindowLabel: "main",
    microphoneMuted: false,
    revision: 7,
  }));
  mocks.startProtocol.mockImplementation(
    async (_sessionId: string, initialCursor: number) => {
      mocks.pipeInitialCursors.push(initialCursor);
      // Keep existing hook assertions independent of the randomized call
      // namespace. The Rust pipe tests cover nonzero initial cursors directly.
      mocks.pipeNextId = 1;
      mocks.pipePending = [];
      mocks.pipeConsumed = { master: 0, emissary: 0 };
    },
  );
  mocks.enqueueSpokespersonMessage.mockImplementation(
    async (_sessionId: string, message: string) => {
      const latest = mocks.pipePending.at(-1);
      const cursor =
        latest?.recipient === "emissary"
          ? latest.id
          : mocks.pipeConsumed.emissary;
      return sendPipeMessage("emissary", cursor, message);
    },
  );
  mocks.sendExpertPipeMessage.mockImplementation(
    async (_sessionId: string, cursor: number, message: string) =>
      sendPipeMessage("master", cursor, message),
  );
  mocks.getExpertPipeCursor.mockImplementation(
    async () => mocks.pipeConsumed.master,
  );
  mocks.stopControls.mockResolvedValue(undefined);
  mocks.stopProtocol.mockResolvedValue(undefined);
  mocks.waitForBridgeReady.mockResolvedValue(undefined);
  mocks.requestToolOutput.mockImplementation((event) => ({
    status: "queued",
    events: [event],
  }));
  mocks.recordToolOutput.mockImplementation((event) => ({
    status: "sent",
    events: [event],
  }));
  mocks.requestMasterMessage.mockImplementation((message) => ({
    status: "sent",
    events: [{ type: "conversation.item.create", message }],
  }));
  mocks.requestTypedUserMessage.mockReturnValue({
    status: "interrupting",
    events: [{ type: "response.cancel" }, { type: "conversation.item.create" }],
  });
});

afterEach(async () => {
  await resetOpenAiRealtimeConversationRuntimeForTests();
  globalThis.Audio = originalAudio;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
});

describe("useOpenAiRealtimeConversation lifecycle", () => {
  it("starts after a newly created session mounts from a deferred call request", async () => {
    act(() => requestOpenAiRealtimeConversationStart("session-a"));
    const owner = renderConversation("session-a");

    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    expect(mocks.createSession).toHaveBeenCalledOnce();

    await act(async () => owner.result.current.onToggle());
  });

  it("stops the active realtime call when its voice mode is disabled", async () => {
    const onSend = vi.fn();
    const owner = renderHook(
      ({ enabled }) =>
        useOpenAiRealtimeConversation({
          enabled,
          onSend,
          sessionId: "session-a",
        }),
      { initialProps: { enabled: true } },
    );

    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    owner.rerender({ enabled: false });

    await waitFor(() => expect(owner.result.current.state).toBe("off"));
    expect(mocks.stopControls).toHaveBeenCalledWith("session-a", 7);
  });

  it("keeps hang-up and mute enabled for the active call during a composer block", async () => {
    const owner = renderHook(
      ({ disabled }) =>
        useOpenAiRealtimeConversation({
          disabled,
          enabled: true,
          onSend: vi.fn(),
          sessionId: "session-a",
        }),
      { initialProps: { disabled: false } },
    );
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    owner.rerender({ disabled: true });

    expect(owner.result.current.disabled).toBe(false);
    await act(async () => owner.result.current.onMicrophoneMuteToggle?.());
    expect(track.enabled).toBe(false);
    await act(async () => owner.result.current.onToggle());
    expect(owner.result.current.state).toBe("off");
  });

  it("uses a new bridge cursor namespace for every Realtime call", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    await act(async () => owner.result.current.onToggle());
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    expect(mocks.pipeInitialCursors).toHaveLength(2);
    expect(mocks.pipeInitialCursors[0]).not.toBe(mocks.pipeInitialCursors[1]);

    await act(async () => owner.result.current.onToggle());
  });

  it("starts a promoted session from a deferred request for its client id", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "backend-session",
          clientSessionId: "draft-session",
          title: "New chat",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          intent: null,
        },
      ],
    });
    act(() => requestOpenAiRealtimeConversationStart("draft-session"));
    const owner = renderConversation("backend-session");

    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    expect(mocks.createSession).toHaveBeenCalledOnce();

    await act(async () => owner.result.current.onToggle());
  });

  it("starts on an optimistic draft and defers the master prompt until promotion", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          clientSessionId: "draft-session",
          title: "New chat",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          creationState: "pending",
          intent: null,
        },
      ],
    });
    mocks.appendSessionSystemPrompt.mockImplementation(
      async (sessionId: string) => {
        if (sessionId === "draft-session")
          throw new Error("Resource not found");
      },
    );
    act(() => requestOpenAiRealtimeConversationStart("draft-session"));
    const owner = renderHook(
      ({ sessionId }) =>
        useOpenAiRealtimeConversation({
          enabled: true,
          onSend: vi.fn(),
          sessionId,
        }),
      { initialProps: { sessionId: "draft-session" } },
    );

    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    expect(mocks.appendSessionSystemPrompt).not.toHaveBeenCalledWith(
      "draft-session",
      expect.anything(),
      expect.anything(),
    );

    act(() => {
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-session", "backend-session");
      useChatStore
        .getState()
        .promoteSessionId("draft-session", "backend-session");
      owner.rerender({ sessionId: "backend-session" });
    });

    await waitFor(() =>
      expect(mocks.appendSessionSystemPrompt).toHaveBeenCalledWith(
        "backend-session",
        expect.any(String),
        expect.stringContaining(
          'send-to-spokesperson --session-id "backend-session"',
        ),
      ),
    );
    expect(mocks.appendSessionSystemPrompt).toHaveBeenCalledWith(
      "backend-session",
      expect.any(String),
      expect.stringContaining("--mode <context|say>"),
    );
    expect(owner.result.current.state).toBe("listening");
    expect(owner.result.current.boundSessionId).toBe("backend-session");

    await act(async () => owner.result.current.onToggle());
  });

  it("registers the active call before microphone setup finishes", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const delayedStream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(
      new Promise<MediaStream>((resolve) => {
        resolveStream = resolve;
      }),
    );
    const owner = renderConversation("session-a");

    act(() => {
      void owner.result.current.onToggle();
    });

    await waitFor(() =>
      expect(mocks.startControls).toHaveBeenCalledWith("session-a"),
    );
    expect(owner.result.current.state).toBe("starting");
    expect(mocks.activeEmissary?.sessionId).toBe("session-a");
    expect(() =>
      mocks.activeEmissary?.completeMasterTurn({ reminderHandoffIds: [] }),
    ).not.toThrow();
    act(() => {
      realtimeControlListener?.({
        sessionId: "session-a",
        revision: 7,
        action: "mute",
        muted: true,
      });
    });

    act(() => resolveStream(delayedStream));
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    expect(track.enabled).toBe(false);
    await act(async () => owner.result.current.onToggle());
  });

  it("publishes running controls only after the cross-renderer bridge is ready", async () => {
    let resolveBridge!: () => void;
    mocks.waitForBridgeReady.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveBridge = resolve;
      }),
    );
    const owner = renderConversation("session-a");

    act(() => {
      void owner.result.current.onToggle();
    });

    await waitFor(() => expect(mocks.activeEmissary).not.toBeNull());
    expect(mocks.startControls).not.toHaveBeenCalled();

    act(() => resolveBridge());
    await waitFor(() =>
      expect(mocks.startControls).toHaveBeenCalledWith("session-a"),
    );
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    await act(async () => owner.result.current.onToggle());
  });

  it("stops a captured microphone stream when parallel startup fails", async () => {
    mocks.createSession.mockRejectedValueOnce(new Error("token failed"));
    const owner = renderConversation("session-a");

    await act(async () => owner.result.current.onToggle());

    await waitFor(() => expect(owner.result.current.state).toBe("error"));
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each([
    "close",
    "error",
  ] as const)("cleans up when the open Realtime data channel emits %s", async (eventType) => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    await act(async () => {
      channel.dispatchEvent(new Event(eventType));
    });

    await waitFor(() => expect(owner.result.current.state).toBe("error"));
    expect(peer.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mocks.stopControls).toHaveBeenCalledWith("session-a", 7);
  });

  it.each([
    ["connectionstatechange", "connectionState"],
    ["iceconnectionstatechange", "iceConnectionState"],
  ] as const)("cleans up when Realtime emits terminal %s failure", async (eventType, stateProperty) => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    peer[stateProperty] = "failed";
    await act(async () => {
      peer.dispatchEvent(new Event(eventType));
    });

    await waitFor(() => expect(owner.result.current.state).toBe("error"));
    expect(channel.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mocks.stopControls).toHaveBeenCalledWith("session-a", 7);
  });

  it("keeps the process-wide conversation alive across owner unmount and remount", async () => {
    const originalOnSend = vi.fn().mockResolvedValue(true);
    const remountedOnSend = vi.fn().mockResolvedValue(true);
    const first = renderConversation("session-a", originalOnSend);

    await act(async () => first.result.current.onToggle());
    await waitFor(() => expect(first.result.current.state).toBe("listening"));
    expect(mocks.startControls).toHaveBeenCalledWith("session-a");
    expect(first.result.current.ownsActiveConversation).toBe(true);

    first.unmount();

    expect(channel.close).not.toHaveBeenCalled();
    expect(peer.close).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    expect(mocks.releaseBridge).not.toHaveBeenCalled();
    expect(mocks.releaseMicrophone).not.toHaveBeenCalled();

    const remounted = renderConversation("session-a", remountedOnSend);
    expect(remounted.result.current.state).toBe("listening");
    expect(remounted.result.current.ownsActiveConversation).toBe(true);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });
    await waitFor(() => expect(remountedOnSend).toHaveBeenCalledOnce());
    expect(originalOnSend).not.toHaveBeenCalled();

    await act(async () => remounted.result.current.onToggle());
    await waitFor(() => expect(remounted.result.current.state).toBe("off"));
    expect(channel.close).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mocks.releaseBridge).toHaveBeenCalledOnce();
    expect(mocks.releaseMicrophone).toHaveBeenCalledOnce();
    expect(mocks.stopControls).toHaveBeenCalledWith("session-a", 7);
  });

  it("routes floating Realtime mute controls back to the owning media track", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      realtimeControlListener?.({
        sessionId: "session-a",
        revision: 7,
        action: "mute",
        muted: true,
      });
    });

    expect(track.enabled).toBe(false);
    expect(owner.result.current.microphoneMuted).toBe(true);
    expect(mocks.publishMuted).toHaveBeenCalledWith("session-a", 7, true);

    await act(async () => owner.result.current.onToggle());
  });

  it("routes floating Realtime hang-up controls to the active call", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      realtimeControlListener?.({
        sessionId: "session-a",
        revision: 7,
        action: "stop",
      });
    });

    await waitFor(() => expect(owner.result.current.state).toBe("off"));
    expect(peer.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mocks.stopControls).toHaveBeenCalledWith("session-a", 7);
  });

  it("does not let another session steal the active conversation", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    const other = renderConversation("session-b");
    expect(other.result.current.boundSessionId).toBe("session-a");
    expect(other.result.current.ownsActiveConversation).toBe(false);
    expect(other.result.current.disabled).toBe(true);

    await act(async () => other.result.current.onToggle());
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(owner.result.current.state).toBe("listening");

    await act(async () => owner.result.current.onToggle());
  });

  it("moves the realtime owner and bridge when a draft session is promoted", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          clientSessionId: "draft-session",
          title: "New chat",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          creationState: "pending",
          intent: null,
        },
      ],
    });
    const owner = renderHook(
      ({ sessionId }) =>
        useOpenAiRealtimeConversation({
          enabled: true,
          onSend,
          sessionId,
        }),
      { initialProps: { sessionId: "draft-session" } },
    );
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-session", "backend-session");
      useChatStore
        .getState()
        .promoteSessionId("draft-session", "backend-session");
      owner.rerender({ sessionId: "backend-session" });
    });

    await waitFor(() =>
      expect(owner.result.current.boundSessionId).toBe("backend-session"),
    );
    expect(owner.result.current.disabled).toBe(false);
    expect(mocks.activeEmissary?.sessionId).toBe("backend-session");
    expect(mocks.rebindControls).toHaveBeenCalledWith(
      "draft-session",
      "backend-session",
      7,
    );
    await waitFor(() =>
      expect(mocks.appendSessionSystemPrompt).toHaveBeenCalledWith(
        "backend-session",
        expect.any(String),
        expect.stringContaining(
          'send-to-spokesperson --session-id "backend-session"',
        ),
      ),
    );
    expect(mocks.appendSessionSystemPrompt).toHaveBeenCalledWith(
      "backend-session",
      expect.any(String),
      expect.stringContaining("--mode <context|say>"),
    );

    await act(async () => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith(
      "[Voice transcript; cursor 1] Spokesperson said: hello user",
      undefined,
      undefined,
      expect.objectContaining({
        displayText: "hello user",
        userMessageMetadata: expect.objectContaining({ userVisible: false }),
      }),
    );
    expect(
      useChatStore.getState().messagesBySession["backend-session"]?.[0],
    ).toMatchObject({
      metadata: { voiceConversationDebugEvent: "emissarySpeech" },
    });
    expect(useChatStore.getState().messagesBySession["draft-session"]).toBe(
      undefined,
    );

    await act(async () => owner.result.current.onToggle());
  });

  it("waits for owner promotion before stopping native controls", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          clientSessionId: "draft-session",
          title: "New chat",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          creationState: "pending",
          intent: null,
        },
      ],
    });
    let finishRebind!: (status: {
      available: boolean;
      unavailableReason: null;
      lifecycle: string;
      sessionId: string;
      ownerWindowLabel: string;
      microphoneMuted: boolean;
      revision: number;
    }) => void;
    mocks.rebindControls.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRebind = resolve;
      }),
    );
    const owner = renderHook(
      ({ sessionId }) =>
        useOpenAiRealtimeConversation({
          enabled: true,
          onSend: vi.fn(),
          sessionId,
        }),
      { initialProps: { sessionId: "draft-session" } },
    );
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-session", "backend-session");
      useChatStore
        .getState()
        .promoteSessionId("draft-session", "backend-session");
      owner.rerender({ sessionId: "backend-session" });
    });
    await waitFor(() => expect(mocks.rebindControls).toHaveBeenCalledOnce());
    let stopPromise!: Promise<void>;
    act(() => {
      stopPromise = Promise.resolve(owner.result.current.onToggle());
    });
    expect(mocks.stopControls).not.toHaveBeenCalled();

    finishRebind({
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "backend-session",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 8,
    });
    await act(async () => stopPromise);
    expect(mocks.stopControls).toHaveBeenCalledWith("backend-session", 8);
  });

  it("steers realtime deliveries while the master is running without using the composer queue", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    mocks.steerPrompt.mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    useChatStore.getState().setChatState("session-a", "thinking");
    useChatStore.getState().setActiveRunId("session-a", "run-1");

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });

    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => owner.result.current.onToggle());
  });

  it("does not let realtime delivery overtake an accepted composer message", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    mocks.steerPrompt.mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    act(() => {
      useChatStore.getState().setChatState("session-a", "thinking");
      useChatStore.getState().setActiveRunId("session-a", "run-1");
      useChatStore.getState().enqueueTransportReadyMessage("session-a", {
        persona: { kind: "inherit" },
        text: "accepted first",
      });
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });

    await Promise.resolve();
    expect(mocks.steerPrompt).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    act(() => useChatStore.setState({ queuedMessageBySession: {} }));
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());

    await act(async () => owner.result.current.onToggle());
  });

  it("does not let a master message overtake a queued transcript steer", async () => {
    let acceptSteer: (() => void) | undefined;
    mocks.steerPrompt.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          acceptSteer = () => resolve(true);
        }),
    );
    const owner = renderConversation(
      "session-a",
      vi.fn().mockResolvedValue(true),
    );
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    act(() => {
      useChatStore.getState().setChatState("session-a", "thinking");
      useChatStore.getState().setActiveRunId("session-a", "run-1");
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());

    await expect(
      mocks.activeEmissary?.sendMasterMessage("This must wait.", 0, "say", []),
    ).resolves.toEqual({
      accepted: false,
      reason: "pipe_busy",
      cursor: 0,
    });
    expect(mocks.requestMasterMessage).not.toHaveBeenCalled();

    await act(async () => acceptSteer?.());
    await expect(
      mocks.activeEmissary?.sendMasterMessage(
        "This follows the transcript.",
        1,
        "say",
        [],
      ),
    ).resolves.toMatchObject({ accepted: true, cursor: 1 });
    expect(mocks.requestMasterMessage).toHaveBeenCalledOnce();

    await act(async () => owner.result.current.onToggle());
  });

  it("retries as a normal prompt when the master finishes before steer admission", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    mocks.steerPrompt.mockRejectedValueOnce(
      new Error("no active run to steer"),
    );
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    useChatStore.getState().setChatState("session-a", "thinking");
    useChatStore.getState().setActiveRunId("session-a", "run-1");

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });

    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    act(() => {
      useChatStore.getState().setActiveRunId("session-a", null);
      useChatStore.getState().setChatState("session-a", "idle");
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith(
      "[Voice transcript; cursor 1] Spokesperson said: hello user",
      undefined,
      undefined,
      expect.objectContaining({ displayText: "hello user" }),
    );
    expect(mocks.steerPrompt).toHaveBeenCalledWith(
      "session-a",
      "[Voice transcript; cursor 1] Spokesperson said: hello user",
      undefined,
      expect.anything(),
      {
        throwOnError: true,
        reportErrorInTranscript: false,
      },
    );

    expect(
      (useChatStore.getState().messagesBySession["session-a"] ?? []).some(
        (message) =>
          message.role === "system" &&
          message.content.some(
            (content) =>
              content.type === "text" &&
              content.text.includes("no active run to steer"),
          ),
      ),
    ).toBe(false);

    await act(async () => owner.result.current.onToggle());
  });

  it("waits for a real run id instead of steering from chat state alone", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    mocks.steerPrompt.mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    useChatStore.getState().setChatState("session-a", "thinking");

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.steerPrompt).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().setChatState("session-a", "idle");
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(mocks.steerPrompt).not.toHaveBeenCalled();

    await act(async () => owner.result.current.onToggle());
  });

  it("adds one explicit debug bubble for a master routing command", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    await act(async () => {
      await mocks.activeEmissary?.sendMasterMessage(
        "There are 20 repos.",
        0,
        "context",
        [],
      );
    });

    expect(mocks.requestMasterMessage).toHaveBeenCalledWith({
      eventId: "berd-master-1",
      message: "[bridge cursor 1] There are 20 repos.",
      mode: "context",
      resolvedHandoffIds: [],
    });
    expect(
      useChatStore.getState().messagesBySession["session-a"],
    ).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "text", text: "There are 20 repos." }],
        metadata: {
          personaName: "Expert → Spokesperson · Context · sent",
          voiceConversationDebugEvent: "masterToEmissaryContext",
        },
      },
    ]);

    await act(async () => owner.result.current.onToggle());
  });

  it("keeps a handoff open when its resolving delivery fails", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });
    await waitFor(() => expect(mocks.activeEmissary).not.toBeNull());
    const handoffId = acceptedHandoffId("call-1");

    mocks.sendRealtimeEvents.mockImplementationOnce(() => {
      throw new DOMException("channel closed", "InvalidStateError");
    });
    await expect(
      mocks.activeEmissary?.sendMasterMessage("First attempt", 1, "say", [
        handoffId,
      ]),
    ).rejects.toThrow("channel closed");

    await expect(
      mocks.activeEmissary?.sendMasterMessage("Retry", 1, "say", [handoffId]),
    ).resolves.toMatchObject({ accepted: true });

    await act(async () => owner.result.current.onToggle());
  });

  it("returns malformed tool arguments without ending the voice session", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    mocks.sendRealtimeEvents.mockClear();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.invalid_tool_call" }),
        }),
      );
    });

    await waitFor(() =>
      expect(mocks.createInvalidToolCallOutput).toHaveBeenCalledWith(
        "call-broken",
        "handoff",
        "JSON Parse error: Unterminated string",
      ),
    );
    expect(mocks.requestToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "conversation.item.create",
        item: expect.objectContaining({ type: "function_call_output" }),
      }),
    );
    expect(mocks.recordToolOutput).not.toHaveBeenCalled();
    expect(mocks.sendRealtimeEvents).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        type: "conversation.item.create",
        item: expect.objectContaining({ type: "function_call_output" }),
      }),
    ]);
    expect(owner.result.current.state).toBe("listening");

    await act(async () => owner.result.current.onToggle());
  });

  it("renders user speech normally and flushes it to the Expert on hang-up", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    await act(async () => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript" }),
        }),
      );
    });

    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().messagesBySession["session-a"]?.[0],
    ).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hello master" }],
      metadata: { origin: "voice_conversation" },
    });

    await act(async () => stopOpenAiRealtimeConversation());
    expect(onSend).toHaveBeenCalledWith(
      expect.stringContaining("User said: hello master"),
      undefined,
      undefined,
      expect.objectContaining({ displayText: "Final voice transcript" }),
    );
  });

  it("does not request a Spokesperson response when automatic responses are disabled", async () => {
    mocks.createResponse = false;
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript" }),
        }),
      );
    });

    await act(async () => owner.result.current.onToggle());
  });

  it("edits a provisional user transcript in place when the final correction arrives", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript_partial" }),
        }),
      );
    });
    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"]?.[0],
      ).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: { completionStatus: "inProgress" },
      }),
    );
    const provisional =
      useChatStore.getState().messagesBySession["session-a"]?.[0];
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript_corrected" }),
        }),
      );
    });
    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"]?.[0],
      ).toMatchObject({
        id: provisional?.id,
        content: [{ type: "text", text: "hello master" }],
        metadata: { completionStatus: "completed" },
      }),
    );
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => owner.result.current.onToggle());
  });

  it("waits for session hydration before dispatching a voice transcript", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    useChatStore.getState().setSessionLoading("session-a", true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });
    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();

    act(() => useChatStore.getState().setSessionLoading("session-a", false));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

    await act(async () => owner.result.current.onToggle());
  });

  it("cancels a queued delivery when its call stops and does not replay it after restart", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    useChatStore.getState().setSessionLoading("session-a", true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });
    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => owner.result.current.onToggle());
    act(() => useChatStore.getState().setSessionLoading("session-a", false));
    channel = new FakeDataChannel();
    peer = new FakePeer(channel);
    mocks.createPeer.mockReturnValue(peer);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });
    await waitFor(() => expect(mocks.reduceProtocol).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    await act(async () => owner.result.current.onToggle());
  });

  it("releases media while a blocked final transcript continues delivering", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    useChatStore.getState().setSessionLoading("session-a", true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript" }),
        }),
      );
    });

    await act(async () => owner.result.current.onToggle());

    expect(owner.result.current.state).toBe("off");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();

    act(() => useChatStore.getState().setSessionLoading("session-a", false));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  });

  it("forwards committed typed user text to the realtime emissary", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
      useChatStore.getState().setChatState("session-a", "thinking");
      useChatStore.getState().setActiveRunId("session-a", "run-typed");
    });

    act(() => {
      owner.result.current.onTypedUserMessageCommitted?.(
        "Please stop and check this.",
      );
    });

    await waitFor(() =>
      expect(mocks.requestTypedUserMessage).toHaveBeenCalledWith(
        "Please stop and check this.",
      ),
    );
    await waitFor(() =>
      expect(mocks.sendRealtimeEvents).toHaveBeenCalledWith(expect.anything(), [
        { type: "response.cancel" },
        { type: "conversation.item.create" },
      ]),
    );
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    expect(mocks.steerPrompt).toHaveBeenCalledWith(
      "session-a",
      "[Voice transcript; cursor 1] Spokesperson said: hello user",
      undefined,
      expect.objectContaining({
        userMessageMetadata: {
          origin: "voice_conversation",
          userVisible: false,
        },
      }),
      { throwOnError: true, reportErrorInTranscript: false },
    );

    await act(async () => owner.result.current.onToggle());
  });

  it("does not let a realtime transport failure abort the ordinary typed send", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    mocks.sendRealtimeEvents.mockImplementationOnce(() => {
      throw new DOMException(
        "The object is in an invalid state.",
        "InvalidStateError",
      );
    });

    expect(() => {
      owner.result.current.onTypedUserMessageCommitted?.("Still send this.");
    }).not.toThrow();
    await waitFor(() => expect(owner.result.current.state).toBe("error"));

    await act(async () => owner.result.current.onToggle());
  });

  it("renders emissary speech on the assistant side with spoken status", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    await act(async () => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });

    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"]?.[0],
      ).toBeDefined(),
    );
    expect(
      useChatStore.getState().messagesBySession["session-a"]?.[0],
    ).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "hello user",
          speech: { status: "spoken", spokenThrough: 10 },
        },
      ],
      metadata: {
        agentVisible: false,
        origin: "voice_conversation",
        voiceConversationDebugEvent: "emissarySpeech",
      },
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

    await act(async () => owner.result.current.onToggle());
  });

  it("updates a multi-item emissary response in one speaking bubble", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary_partial_first" }),
        }),
      );
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary_partial_second" }),
        }),
      );
    });

    await waitFor(() => {
      const messages = useChatStore.getState().messagesBySession["session-a"];
      expect(messages).toHaveLength(1);
      expect(messages?.[0]).toMatchObject({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Let me think about that. I received a compact transcript.",
            speech: { status: "speaking" },
          },
        ],
        metadata: {
          completionStatus: "inProgress",
          voiceConversationDebugEvent: "emissarySpeech",
        },
      });
    });

    await act(async () => owner.result.current.onToggle());
  });

  it("queues two user questions and wakes the Expert only after Spokesperson activity", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript_repository" }),
        }),
      );
    });
    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend.mock.calls[0]?.[0]).toBe(
      "[Voice transcript; cursor 1] User said: how many repos are in my development folder?\n" +
        "[Voice transcript; cursor 2] Spokesperson said: hello user",
    );
    act(() => useChatStore.getState().setChatState("session-a", "thinking"));
    act(() =>
      useChatStore.getState().setActiveRunId("session-a", "run-repository"),
    );

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledOnce();
    const handoffId = acceptedHandoffId("call-1");

    await act(async () => {
      await mocks.activeEmissary?.sendMasterMessage(
        "The answer is 21 repositories.",
        3,
        "say",
        [handoffId],
      );
    });
    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary_result" }),
        }),
      );
    });
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"],
      ).toHaveLength(5),
    );
    expect(onSend).toHaveBeenCalledOnce();

    act(() => {
      useChatStore.getState().setActiveRunId("session-a", null);
      useChatStore.getState().setChatState("session-a", "idle");
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript_followup" }),
        }),
      );
    });
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledOnce();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary_followup_ack" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1]?.[0]).toBe(
      "[Voice transcript; cursor 6] User said: are any of them symbolic links?\n" +
        "[Voice transcript; cursor 7] Spokesperson said: I'll verify that.",
    );
    act(() => useChatStore.getState().setChatState("session-a", "thinking"));
    act(() =>
      useChatStore.getState().setActiveRunId("session-a", "run-followup"),
    );

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff_followup" }),
        }),
      );
    });
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledTimes(3));
    expect(onSend).toHaveBeenCalledTimes(2);

    await act(async () => {
      await mocks.activeEmissary?.sendMasterMessage(
        "None of the repositories are symbolic links.",
        8,
        "say",
        ["handoff-8"],
      );
    });
    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary_symlink_result" }),
        }),
      );
    });
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(
        useChatStore
          .getState()
          .messagesBySession["session-a"]?.some(
            (message) =>
              message.content[0]?.type === "text" &&
              message.content[0].text ===
                "None of those repositories are symbolic links.",
          ),
      ).toBe(true),
    );
    expect(onSend).toHaveBeenCalledTimes(2);

    const messages =
      useChatStore.getState().messagesBySession["session-a"] ?? [];
    expect(
      messages.filter(
        (message) =>
          message.metadata?.voiceConversationDebugEvent === "emissaryToMaster",
      ),
    ).toHaveLength(2);
    expect(
      messages.filter(
        (message) =>
          message.content[0]?.type === "text" &&
          message.content[0].text === "You have 21 repositories.",
      ),
    ).toHaveLength(1);
    expect(
      messages.filter(
        (message) =>
          message.content[0]?.type === "text" &&
          message.content[0].text ===
            "None of those repositories are symbolic links.",
      ),
    ).toHaveLength(1);

    await act(async () => owner.result.current.onToggle());
  });

  it("wakes the Expert for Spokesperson speech but not subsequent user speech", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });

    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"]?.[0],
      ).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "hello user" }],
        metadata: { voiceConversationDebugEvent: "emissarySpeech" },
      }),
    );
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenLastCalledWith(
      "[Voice transcript; cursor 1] Spokesperson said: hello user",
      undefined,
      undefined,
      expect.objectContaining({
        displayText: "hello user",
        userMessageMetadata: expect.objectContaining({ userVisible: false }),
      }),
    );

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript" }),
        }),
      );
    });
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledOnce();

    await act(async () => owner.result.current.onToggle());
  });

  it("marks interrupted emissary speech without claiming a precise cutoff", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary_interrupted" }),
        }),
      );
    });

    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"]?.[0],
      ).toBeDefined(),
    );
    const content =
      useChatStore.getState().messagesBySession["session-a"]?.[0]?.content[0];
    if (content?.type !== "text")
      throw new Error("expected an emissary text message");
    const speech = content.speech;
    expect(speech).toEqual({ status: "interrupted", confidence: "low" });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

    await act(async () => owner.result.current.onToggle());
  });

  it("shows accepted emissary-to-master coordination in the transcript", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });

    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"]?.at(-1),
      ).toMatchObject({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Please inspect the disk.",
          },
        ],
        metadata: {
          agentVisible: false,
          personaName: expect.stringMatching(
            /^Spokesperson → Expert · Handoff handoff-.+-1$/,
          ),
          voiceConversationDebugEvent: "emissaryToMaster",
        },
      }),
    );
    expect(mocks.recordToolOutput).toHaveBeenCalledWith({
      type: "conversation.item.create",
      item: { type: "function_call_output" },
    });
    expect(mocks.requestToolOutput).not.toHaveBeenCalled();
    expect(mocks.sendRealtimeEvents).toHaveBeenCalledWith(expect.anything(), [
      {
        type: "conversation.item.create",
        item: { type: "function_call_output" },
      },
    ]);

    await act(async () => owner.result.current.onToggle());
  });

  it("steers emissary-to-master coordination into an active master turn", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    useChatStore.getState().setChatState("session-a", "thinking");
    useChatStore.getState().setActiveRunId("session-a", "run-1");

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });

    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    expect(onSend).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().messagesBySession["session-a"]?.at(-1),
    ).toMatchObject({
      role: "assistant",
      metadata: { voiceConversationDebugEvent: "emissaryToMaster" },
    });

    await act(async () => owner.result.current.onToggle());
  });

  it("delivers queued user speech and a handoff in one Expert wake", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript" }),
        }),
      );
    });
    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });
    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"]?.at(-1),
      ).toMatchObject({
        content: [
          expect.objectContaining({
            text: "Please inspect the disk.",
          }),
        ],
        metadata: {
          personaName: expect.stringMatching(
            /^Spokesperson → Expert · Handoff handoff-.+-2$/,
          ),
          voiceConversationDebugEvent: "emissaryToMaster",
        },
      }),
    );

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend.mock.calls[0]?.[0]).toBe(
      "[Voice transcript; cursor 1] User said: hello master\n" +
        `[Handoff ${acceptedHandoffId("call-1")} from spokesperson; cursor 2] Please inspect the disk.`,
    );
    expect(mocks.steerPrompt).not.toHaveBeenCalled();

    await act(async () => owner.result.current.onToggle());
  });

  it("accepts multiple handoffs without requiring new user input", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    mocks.createHandoffToolOutput.mockClear();
    mocks.sendRealtimeEvents.mockClear();

    await act(async () => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });

    await waitFor(() =>
      expect(mocks.createHandoffToolOutput).toHaveBeenCalledWith("call-1", {
        accepted: true,
        handoff_id: expect.stringMatching(/^handoff-.+-1$/),
      }),
    );
    expect(mocks.recordToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "conversation.item.create",
        item: expect.objectContaining({ type: "function_call_output" }),
      }),
    );
    expect(mocks.requestToolOutput).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledOnce();
    expect(mocks.sendRealtimeEvents).toHaveBeenCalledWith(expect.anything(), [
      {
        type: "conversation.item.create",
        item: { type: "function_call_output" },
      },
    ]);
    expect(useChatStore.getState().messagesBySession["session-a"]).toHaveLength(
      1,
    );

    await act(async () => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff_followup" }),
        }),
      );
    });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(mocks.createHandoffToolOutput).toHaveBeenLastCalledWith("call-2", {
      accepted: true,
      handoff_id: expect.stringMatching(/^handoff-.+-2$/),
    });
    await act(async () => owner.result.current.onToggle());
  });

  it("automatically orders a handoff after pending master context", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    await act(async () => {
      await mocks.activeEmissary?.sendMasterMessage(
        "Pending master context.",
        0,
        "context",
        [],
      );
    });
    mocks.requestToolOutput.mockClear();
    mocks.recordToolOutput.mockClear();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });

    await waitFor(() => expect(mocks.recordToolOutput).toHaveBeenCalledOnce());
    expect(mocks.requestToolOutput).not.toHaveBeenCalled();
    expect(mocks.createHandoffToolOutput).toHaveBeenCalledWith("call-1", {
      accepted: true,
      handoff_id: expect.stringMatching(/^handoff-.+-2$/),
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend.mock.calls[0]?.[0]).toContain(
      `[Handoff ${acceptedHandoffId("call-1")} from spokesperson; cursor 2]`,
    );

    await act(async () => owner.result.current.onToggle());
  });

  it("lets one say resolve several open handoffs", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff_followup" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    const handoffIds = [
      acceptedHandoffId("call-1"),
      acceptedHandoffId("call-2"),
    ];

    await expect(
      mocks.activeEmissary?.sendMasterMessage(
        "I handled both requests.",
        2,
        "say",
        handoffIds,
      ),
    ).resolves.toMatchObject({ accepted: true });

    act(() =>
      mocks.activeEmissary?.completeMasterTurn({ reminderHandoffIds: [] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSend).toHaveBeenCalledTimes(2);

    await act(async () => owner.result.current.onToggle());
  });

  it("rejects resolving a handoff through silent context", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

    await expect(
      mocks.activeEmissary?.sendMasterMessage("Silent context.", 0, "context", [
        "handoff-1",
      ]),
    ).resolves.toEqual({
      accepted: false,
      reason: "context_cannot_resolve",
      cursor: 0,
      handoffIds: ["handoff-1"],
    });
    expect(mocks.requestMasterMessage).not.toHaveBeenCalled();

    await act(async () => owner.result.current.onToggle());
  });

  it("delivers several dismissed handoffs as silent emissary context", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff_followup" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    mocks.requestMasterMessage.mockClear();
    const handoffIds = [
      acceptedHandoffId("call-1"),
      acceptedHandoffId("call-2"),
    ];

    await expect(
      mocks.activeEmissary?.dismissHandoffs(
        2,
        handoffIds,
        "The user withdrew both requests.",
      ),
    ).resolves.toEqual({
      accepted: true,
      cursor: 2,
      dismissedHandoffIds: handoffIds,
      deliveryStatus: "sent",
    });
    expect(mocks.requestMasterMessage).toHaveBeenCalledWith({
      eventId: "berd-master-dismissal-3",
      message: expect.stringContaining("The user withdrew both requests."),
      mode: "context",
    });
    expect(
      useChatStore
        .getState()
        .messagesBySession["session-a"]?.filter(
          (message) =>
            message.metadata?.voiceConversationDebugEvent === "masterDismissal",
        ),
    ).toMatchObject([
      {
        content: [
          {
            type: "text",
            text: `${handoffIds.join(", ")}: The user withdrew both requests.`,
          },
        ],
        metadata: {
          personaName: "Expert → Spokesperson · Dismissed · sent",
        },
      },
    ]);

    act(() =>
      mocks.activeEmissary?.completeMasterTurn({ reminderHandoffIds: [] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSend).toHaveBeenCalledTimes(2);

    await act(async () => owner.result.current.onToggle());
  });

  it("gives the master one private reminder for unresolved handoffs", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const handoffId = acceptedHandoffId("call-1");

    act(() =>
      mocks.activeEmissary?.completeMasterTurn({ reminderHandoffIds: [] }),
    );
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1]?.[0]).toContain(
      "[Private handoff reminder; cursor 2]",
    );
    expect(onSend.mock.calls[1]?.[0]).toContain(handoffId);
    expect(onSend.mock.calls[1]?.[3]).toMatchObject({
      displayText: "Handoff reminder",
      userMessageMetadata: { userVisible: false },
      acpGooseMetadata: {
        realtimeHandoffReminderIds: [handoffId],
        userVisible: false,
      },
    });
    expect(
      useChatStore
        .getState()
        .messagesBySession["session-a"]?.filter(
          (message) =>
            message.metadata?.voiceConversationDebugEvent === "handoffReminder",
        ),
    ).toMatchObject([
      {
        content: [
          {
            type: "text",
            text: `- ${handoffId}: Please inspect the disk.`,
          },
        ],
        metadata: {
          personaName: "Berd → Expert · Handoff reminder 1/3",
        },
      },
    ]);

    act(() =>
      mocks.activeEmissary?.completeMasterTurn({ reminderHandoffIds: [] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSend).toHaveBeenCalledTimes(2);

    await act(async () => owner.result.current.onToggle());
  });

  it("fails loudly after three reminder attempts leave a handoff unresolved", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.handoff" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const handoffId = acceptedHandoffId("call-1");

    act(() =>
      mocks.activeEmissary?.completeMasterTurn({ reminderHandoffIds: [] }),
    );
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    for (const expectedCalls of [3, 4]) {
      act(() =>
        mocks.activeEmissary?.completeMasterTurn({
          reminderHandoffIds: [handoffId],
        }),
      );
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(expectedCalls));
      expect(owner.result.current.state).not.toBe("error");
    }
    act(() =>
      mocks.activeEmissary?.completeMasterTurn({
        reminderHandoffIds: [handoffId],
      }),
    );
    await waitFor(() => expect(owner.result.current.state).toBe("error"));
    expect(owner.result.current.error).toContain(
      `left required ${handoffId} unresolved after 3 reminder attempts`,
    );
  });
});
