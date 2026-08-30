import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  createRealtimeTranscriptReplayEvents,
  requestOpenAiRealtimeConversationStart,
  resetOpenAiRealtimeConversationRuntimeForTests,
  useOpenAiRealtimeConversation,
} from "./useOpenAiRealtimeConversation";

const mocks = vi.hoisted(() => ({
  appendSessionSystemPrompt: vi.fn(),
  claimMicrophone: vi.fn(),
  connectPeer: vi.fn(),
  createSendToMasterToolOutput: vi.fn(),
  createEndTurnToolOutput: vi.fn(),
  createPeer: vi.fn(),
  createSession: vi.fn(),
  registerEmissary: vi.fn(),
  activeEmissary: null as null | {
    sessionId: string;
    beginMasterTurn(turnId: string): void;
    endMasterTurn(completion: {
      turnId: string;
      status: "completed" | "cancelled" | "failed";
      finalText?: string;
    }): void;
    sendMasterMessage(message: string, cursor: number): Promise<unknown>;
  },
  releaseBridge: vi.fn(),
  releaseMicrophone: vi.fn(),
  sendRealtimeEvents: vi.fn(),
  steerPrompt: vi.fn(),
  requestToolOutput: vi.fn(),
  requestMasterMessage: vi.fn(),
  requestTypedUserMessage: vi.fn(),
}));

vi.mock("@/shared/api/acpApi", () => ({
  appendSessionSystemPrompt: mocks.appendSessionSystemPrompt,
}));

vi.mock("@/shared/api/openaiRealtime", () => ({
  claimVoiceDictationMicrophone: mocks.claimMicrophone,
  createOpenAiRealtimeVoiceSession: mocks.createSession,
  releaseVoiceDictationMicrophone: mocks.releaseMicrophone,
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
}));

vi.mock("../lib/realtimeVoicePreference", () => ({
  getRealtimeVoicePreference: () => ({
    model: "gpt-realtime",
    sessionOverridesText: "{}",
    speed: 1,
    transcriptionModel: "gpt-4o-mini-transcribe",
    voice: "marin",
  }),
  parseRealtimeSessionOverrides: () => ({}),
}));

vi.mock("../lib/realtimeEmissaryProtocol", () => ({
  configureRealtimeEmissarySession: vi.fn(),
  createEndTurnToolOutput: mocks.createEndTurnToolOutput,
  createSendToMasterToolOutput: mocks.createSendToMasterToolOutput,
  DirectMessagePipe: class {
    cursor() {
      return 0;
    }
    send(options: { sender: "master" | "emissary"; message: string }) {
      return {
        accepted: true,
        cursor: 0,
        unreadPeerMessages: [],
        outbound: {
          id: 1,
          sender: options.sender,
          recipient: options.sender === "master" ? "emissary" : "master",
          senderCursor: 0,
          message: options.message,
        },
      };
    }
  },
  REALTIME_MASTER_INSTRUCTIONS: "Master instructions",
  RealtimeEmissaryProtocol: class {
    handle(event: { type?: string }) {
      if (event.type === "test.transcript")
        return [
          {
            interrupted: false,
            itemId: "user-item-1",
            speaker: "user",
            text: "hello master",
            type: "transcript.finalized",
          },
        ];
      if (event.type === "test.transcript_repository")
        return [
          {
            interrupted: false,
            itemId: "user-item-repository",
            speaker: "user",
            text: "how many repos are in my development folder?",
            type: "transcript.finalized",
          },
        ];
      if (event.type === "test.transcript_followup")
        return [
          {
            interrupted: false,
            itemId: "user-item-2",
            speaker: "user",
            text: "are any of them symbolic links?",
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
      if (event.type === "test.transcript_corrected")
        return [
          {
            itemId: "user-item-1",
            speaker: "user",
            text: "hello master",
            type: "transcript.finalized",
          },
        ];
      if (event.type === "test.emissary")
        return [
          {
            interrupted: false,
            itemId: "emissary-item-1",
            speaker: "emissary",
            text: "hello user",
            type: "transcript.finalized",
          },
        ];
      if (event.type === "test.emissary_result")
        return [
          {
            interrupted: false,
            itemId: "emissary-item-2",
            speaker: "emissary",
            text: "You have 21 repositories.",
            type: "transcript.finalized",
          },
        ];
      if (event.type === "test.emissary_followup_ack")
        return [
          {
            interrupted: false,
            itemId: "emissary-item-3",
            speaker: "emissary",
            text: "I'll verify that.",
            type: "transcript.finalized",
          },
        ];
      if (event.type === "test.emissary_symlink_result")
        return [
          {
            interrupted: false,
            itemId: "emissary-item-4",
            speaker: "emissary",
            text: "None of those repositories are symbolic links.",
            type: "transcript.finalized",
          },
        ];
      if (event.type === "test.emissary_interrupted")
        return [
          {
            interrupted: true,
            speaker: "emissary",
            text: "partially heard",
            type: "transcript.finalized",
          },
        ];
      if (event.type === "test.send_to_master")
        return [
          {
            callId: "call-1",
            cursor: 0,
            message: "Please inspect the disk.",
            type: "send_to_master",
          },
        ];
      if (event.type === "test.send_to_master_followup")
        return [
          {
            callId: "call-2",
            cursor: 0,
            message: "Please verify whether those repositories are symlinks.",
            type: "send_to_master",
          },
        ];
      if (event.type === "test.end_turn")
        return [{ callId: "call-end", type: "end_turn" }];
      return [];
    }
  },
  RealtimeResponseCoordinator: class {
    handle() {
      return [];
    }
    requestMasterMessage(message: unknown) {
      return mocks.requestMasterMessage(message);
    }
    requestToolOutput(event: unknown) {
      return mocks.requestToolOutput(event);
    }
    requestTypedUserMessage(text: string) {
      return mocks.requestTypedUserMessage(text);
    }
  },
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

  constructor(channel: FakeDataChannel) {
    super();
    this.createDataChannel.mockReturnValue(channel);
  }
}

class FakeAudio {
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

function renderConversation(sessionId: string, onSend = vi.fn()) {
  return renderHook(() =>
    useOpenAiRealtimeConversation({ enabled: true, onSend, sessionId }),
  );
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
            personaName: "Master → Emissary",
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
  useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
  useChatSessionStore.setState({ sessions: [] });
  channel = new FakeDataChannel();
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
  mocks.createSendToMasterToolOutput.mockReturnValue({
    type: "conversation.item.create",
    item: { type: "function_call_output" },
  });
  mocks.createEndTurnToolOutput.mockReturnValue({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call-end",
      output: '{"status":"ended"}',
    },
  });
  mocks.createPeer.mockReturnValue(peer);
  mocks.createSession.mockResolvedValue({ clientSecret: "test-secret" });
  mocks.registerEmissary.mockReturnValue(mocks.releaseBridge);
  mocks.releaseMicrophone.mockResolvedValue(undefined);
  mocks.requestToolOutput.mockImplementation((event) => ({
    status: "queued",
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
          'send-to-emissary --session-id "backend-session"',
        ),
      ),
    );
    expect(owner.result.current.state).toBe("listening");
    expect(owner.result.current.boundSessionId).toBe("backend-session");

    await act(async () => owner.result.current.onToggle());
  });

  it("keeps the process-wide conversation alive across owner unmount and remount", async () => {
    const originalOnSend = vi.fn().mockResolvedValue(true);
    const remountedOnSend = vi.fn().mockResolvedValue(true);
    const first = renderConversation("session-a", originalOnSend);

    await act(async () => first.result.current.onToggle());
    await waitFor(() => expect(first.result.current.state).toBe("listening"));
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
          data: JSON.stringify({ type: "test.transcript" }),
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
    await waitFor(() =>
      expect(mocks.appendSessionSystemPrompt).toHaveBeenCalledWith(
        "backend-session",
        expect.any(String),
        expect.stringContaining(
          'send-to-emissary --session-id "backend-session"',
        ),
      ),
    );

    await act(async () => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().messagesBySession["backend-session"]?.[0],
    ).toMatchObject({ metadata: { personaName: "Emissary" } });
    expect(useChatStore.getState().messagesBySession["draft-session"]).toBe(
      undefined,
    );

    await act(async () => owner.result.current.onToggle());
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
          data: JSON.stringify({ type: "test.transcript" }),
        }),
      );
    });

    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    expect(onSend).not.toHaveBeenCalled();

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
          data: JSON.stringify({ type: "test.transcript" }),
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
      "[Voice transcript] User said: hello master",
      undefined,
      undefined,
      expect.objectContaining({ displayText: "hello master" }),
    );
    expect(mocks.steerPrompt).toHaveBeenCalledWith(
      "session-a",
      "[Voice transcript] User said: hello master",
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
          data: JSON.stringify({ type: "test.transcript" }),
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

  it("shows accepted master-to-emissary coordination in the transcript", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    await act(async () => {
      await mocks.activeEmissary?.sendMasterMessage("There are 20 repos.", 0);
    });

    expect(
      useChatStore.getState().messagesBySession["session-a"]?.at(-1),
    ).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "There are 20 repos." }],
      metadata: {
        agentVisible: false,
        personaName: "Master → Emissary",
      },
    });

    await act(async () => owner.result.current.onToggle());
  });

  it("delivers every terminal master turn to the emissary for evaluation", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    act(() => {
      mocks.activeEmissary?.beginMasterTurn("turn-1");
      mocks.activeEmissary?.endMasterTurn({
        turnId: "turn-1",
        status: "completed",
        finalText: "There are 20 repositories.",
      });
    });

    expect(mocks.requestMasterMessage).toHaveBeenCalledWith({
      eventId: "berd-master-turn-ended-turn-1",
      message: expect.stringContaining(
        "Final response:\nThere are 20 repositories.",
      ),
    });
    expect(
      useChatStore.getState().messagesBySession["session-a"]?.at(-1),
    ).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "There are 20 repositories." }],
      metadata: {
        agentVisible: false,
        personaName: "Master ended turn",
      },
    });

    await act(async () => owner.result.current.onToggle());
  });

  it("ends an emissary evaluation silently without scheduling a continuation", async () => {
    const owner = renderConversation("session-a");
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));
    mocks.sendRealtimeEvents.mockClear();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.end_turn" }),
        }),
      );
    });

    expect(mocks.createEndTurnToolOutput).toHaveBeenCalledWith("call-end");
    expect(mocks.sendRealtimeEvents).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        type: "conversation.item.create",
        item: expect.objectContaining({ type: "function_call_output" }),
      }),
    ]);
    expect(mocks.requestToolOutput).not.toHaveBeenCalled();
    expect(mocks.requestMasterMessage).not.toHaveBeenCalled();

    await act(async () => owner.result.current.onToggle());
  });

  it("renders user speech as a normal user send", async () => {
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

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith(
      "[Voice transcript] User said: hello master",
      undefined,
      undefined,
      expect.objectContaining({
        displayText: "hello master",
        userMessageMetadata: { origin: "voice_conversation" },
      }),
    );

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
    const provisional =
      useChatStore.getState().messagesBySession["session-a"]?.[0];
    expect(provisional).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      metadata: { completionStatus: "inProgress" },
    });
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript_corrected" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith(
      expect.stringContaining("hello master"),
      undefined,
      undefined,
      expect.objectContaining({ userMessageId: provisional?.id }),
    );
    expect(
      useChatStore.getState().messagesBySession["session-a"]?.[0],
    ).toMatchObject({
      id: provisional?.id,
      content: [{ type: "text", text: "hello master" }],
      metadata: { completionStatus: "completed" },
    });

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
          data: JSON.stringify({ type: "test.transcript" }),
        }),
      );
    });
    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();

    act(() => useChatStore.getState().setSessionLoading("session-a", false));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

    await act(async () => owner.result.current.onToggle());
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

    expect(mocks.requestTypedUserMessage).toHaveBeenCalledWith(
      "Please stop and check this.",
    );
    expect(mocks.sendRealtimeEvents).toHaveBeenCalledWith(expect.anything(), [
      { type: "response.cancel" },
      { type: "conversation.item.create" },
    ]);
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    expect(mocks.steerPrompt).toHaveBeenCalledWith(
      "session-a",
      "[Voice transcript] Emissary said: hello user",
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
        personaName: "Emissary",
      },
    });
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => owner.result.current.onToggle());
  });

  it("handles a repository question and symlink follow-up without emissary-triggered master wakes", async () => {
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
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend.mock.calls[0]?.[0]).toBe(
      "[Voice transcript] User said: how many repos are in my development folder?",
    );
    act(() => useChatStore.getState().setChatState("session-a", "thinking"));
    act(() =>
      useChatStore.getState().setActiveRunId("session-a", "run-repository"),
    );

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary" }),
        }),
      );
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.send_to_master" }),
        }),
      );
    });
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledOnce();

    await act(async () => {
      await mocks.activeEmissary?.sendMasterMessage(
        "The answer is 21 repositories.",
        0,
      );
    });
    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary_result" }),
        }),
      );
    });
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
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1]?.[0]).toBe(
      "[Voice transcript] Emissary said: hello user\n" +
        "[Voice transcript] Emissary said: You have 21 repositories.\n" +
        "[Voice transcript] User said: are any of them symbolic links?",
    );
    act(() => useChatStore.getState().setChatState("session-a", "thinking"));
    act(() =>
      useChatStore.getState().setActiveRunId("session-a", "run-followup"),
    );

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary_followup_ack" }),
        }),
      );
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.send_to_master_followup" }),
        }),
      );
    });
    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenCalledTimes(2);

    await act(async () => {
      await mocks.activeEmissary?.sendMasterMessage(
        "None of the repositories are symbolic links.",
        0,
      );
    });
    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.emissary_symlink_result" }),
        }),
      );
    });
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
        (message) => message.metadata?.personaName === "Master → Emissary",
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

  it("buffers emissary speech until the next user-triggered master turn", async () => {
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

    expect(
      useChatStore.getState().messagesBySession["session-a"]?.[0],
    ).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello user" }],
      metadata: { personaName: "Emissary" },
    });
    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.transcript" }),
        }),
      );
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith(
      "[Voice transcript] Emissary said: hello user\n[Voice transcript] User said: hello master",
      undefined,
      undefined,
      expect.objectContaining({ displayText: "hello master" }),
    );

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
    expect(onSend).not.toHaveBeenCalled();

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
          data: JSON.stringify({ type: "test.send_to_master" }),
        }),
      );
    });

    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"]?.at(-1),
      ).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Please inspect the disk." }],
        metadata: {
          agentVisible: false,
          personaName: "Emissary → Master",
        },
      }),
    );
    expect(mocks.requestToolOutput).toHaveBeenCalledWith({
      type: "conversation.item.create",
      item: { type: "function_call_output" },
    });
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
          data: JSON.stringify({ type: "test.send_to_master" }),
        }),
      );
    });

    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    expect(onSend).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().messagesBySession["session-a"]?.at(-1),
    ).toMatchObject({ metadata: { personaName: "Emissary → Master" } });

    await act(async () => owner.result.current.onToggle());
  });

  it("uses one active-turn delivery for transcript coordination", async () => {
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
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    act(() => useChatStore.getState().setChatState("session-a", "thinking"));
    act(() => useChatStore.getState().setActiveRunId("session-a", "run-1"));

    act(() => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.send_to_master" }),
        }),
      );
    });
    await waitFor(() =>
      expect(
        useChatStore.getState().messagesBySession["session-a"]?.at(-1),
      ).toMatchObject({ metadata: { personaName: "Emissary → Master" } }),
    );

    await waitFor(() => expect(mocks.steerPrompt).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledOnce();

    await act(async () => owner.result.current.onToggle());
  });

  it("blocks acknowledgement loops until the user speaks again", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const owner = renderConversation("session-a", onSend);
    await act(async () => owner.result.current.onToggle());
    await waitFor(() => expect(owner.result.current.state).toBe("listening"));

    await act(async () => {
      await mocks.activeEmissary?.sendMasterMessage("The result.", 0);
    });
    mocks.createSendToMasterToolOutput.mockClear();
    mocks.sendRealtimeEvents.mockClear();

    await act(async () => {
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.send_to_master" }),
        }),
      );
    });

    await waitFor(() =>
      expect(mocks.createSendToMasterToolOutput).toHaveBeenCalledWith(
        "call-1",
        {
          accepted: false,
          reason: "awaiting_new_user_input",
          unreadPeerMessages: [],
          cursor: 0,
        },
      ),
    );
    expect(onSend).not.toHaveBeenCalled();
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
          data: JSON.stringify({ type: "test.transcript" }),
        }),
      );
      channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "test.send_to_master" }),
        }),
      );
    });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    await act(async () => owner.result.current.onToggle());
  });
});
