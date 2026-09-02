import { useCallback, useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type {
  ChatInputSendHandler,
  ChatInputVoiceConversation,
} from "@/features/chat/types";
import { steerPromptInSession } from "@/features/chat/lib/steerCore";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { appendSessionSystemPrompt } from "@/shared/api/acpApi";
import {
  claimVoiceDictationMicrophone,
  createOpenAiRealtimeVoiceSession,
  releaseVoiceDictationMicrophone,
} from "@/shared/api/openaiRealtime";
import {
  createSystemNotificationMessage,
  type Message,
} from "@/shared/types/messages";
import {
  connectOpenAiRealtimePeerConnection,
  createOpenAiRealtimePeerConnection,
} from "@/features/chat/lib/openaiRealtimeAudio";
import {
  type HandoffDismissal,
  type MasterMessageDelivery,
  type RealtimeMasterTurnCompletion,
  registerRealtimeEmissary,
} from "../lib/realtimeEmissaryBridge";
import {
  createHandoffToolOutput,
  createInvalidToolCallOutput,
  DirectMessagePipe,
  type MasterMessageMode,
  REALTIME_MASTER_INSTRUCTIONS,
  RealtimeEmissaryProtocol,
  RealtimeResponseCoordinator,
  sendRealtimeEvents,
  configureRealtimeEmissarySession,
} from "../lib/realtimeEmissaryProtocol";
import {
  getRealtimeVoicePreference,
  parseRealtimeSessionOverrides,
} from "../lib/realtimeVoicePreference";

const MASTER_PROMPT_KEY = "berd-realtime-voice-master";
const MICROPHONE_OWNER_ID = "berd:realtime-voice-conversation";
const MAX_REALTIME_REPLAY_ITEMS = 12;
const HANDOFF_REMINDER_IDS_METADATA = "realtimeHandoffReminderIds";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnavailableDevMicrophoneClaim(error: unknown): boolean {
  return (
    import.meta.env.DEV &&
    errorText(error).includes("claim_voice_dictation_microphone not found")
  );
}

function isMissingActiveRun(error: unknown): boolean {
  return errorText(error).toLowerCase().includes("no active run to steer");
}

function waitForSessionHydration(sessionId: string): Promise<void> {
  if (!useChatStore.getState().loadingSessionIds.has(sessionId)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe((state) => {
      if (state.loadingSessionIds.has(sessionId)) return;
      unsubscribe();
      resolve();
    });
  });
}

function waitForMasterIdle(sessionId: string): Promise<void> {
  const isIdle = () => {
    const runtime = useChatStore.getState().getSessionRuntime(sessionId);
    return runtime.activeRunId === null && !isSessionRunning(runtime.chatState);
  };
  if (isIdle()) return Promise.resolve();

  return new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe(() => {
      if (!isIdle()) return;
      unsubscribe();
      resolve();
    });
  });
}

type MasterDeliveryOpportunity = "send" | "steer";

function masterDeliveryOpportunity(
  sessionId: string,
): MasterDeliveryOpportunity | null {
  const runtime = useChatStore.getState().getSessionRuntime(sessionId);
  if (runtime.isRunCancellationPending) return null;
  // A chat state can cross the run boundary before activeRunId catches up.
  // Only an actual run id is sufficient proof that ACP can accept a steer.
  if (runtime.activeRunId !== null) return "steer";
  if (!isSessionRunning(runtime.chatState)) return "send";
  return null;
}

function waitForMasterDeliveryOpportunity(
  sessionId: string,
): Promise<MasterDeliveryOpportunity> {
  const available = masterDeliveryOpportunity(sessionId);
  if (available) return Promise.resolve(available);

  return new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe(() => {
      const opportunity = masterDeliveryOpportunity(sessionId);
      if (!opportunity) return;
      unsubscribe();
      resolve(opportunity);
    });
  });
}

function waitForMasterRunBoundary(
  sessionId: string,
  rejectedRunId: string | null,
): Promise<void> {
  const crossedBoundary = () => {
    const runtime = useChatStore.getState().getSessionRuntime(sessionId);
    return (
      runtime.activeRunId !== rejectedRunId ||
      (runtime.activeRunId === null && !isSessionRunning(runtime.chatState))
    );
  };
  if (crossedBoundary()) return Promise.resolve();

  return new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe(() => {
      if (!crossedBoundary()) return;
      unsubscribe();
      resolve();
    });
  });
}

function createEmissaryTranscriptMessage(
  text: string,
  interrupted: boolean,
  id: string = crypto.randomUUID(),
  provisional = false,
): Message {
  return {
    id,
    role: "assistant",
    created: Date.now(),
    content: [
      {
        type: "text",
        text,
        speech: provisional
          ? { status: "speaking" }
          : interrupted
            ? {
                status: "interrupted",
                confidence: "low",
              }
            : { status: "spoken", spokenThrough: text.length },
      },
    ],
    metadata: {
      userVisible: true,
      agentVisible: false,
      origin: "voice_conversation",
      personaName: "Emissary",
      completionStatus: provisional ? "inProgress" : "completed",
    },
  };
}

function createUserTranscriptMessage(
  id: string,
  text: string,
  provisional: boolean,
): Message {
  return {
    id,
    role: "user",
    created: Date.now(),
    content: [{ type: "text", text }],
    metadata: {
      userVisible: true,
      agentVisible: false,
      origin: "voice_conversation",
      completionStatus: provisional ? "inProgress" : "completed",
    },
  };
}

function createHandoffDebugMessage(handoffId: string, text: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "user",
    created: Date.now(),
    content: [
      {
        type: "text",
        text: `Emissary handoff ${handoffId} → Master\n${text}`,
      },
    ],
    metadata: {
      userVisible: true,
      agentVisible: false,
      origin: "voice_conversation",
      personaName: "Routing",
      completionStatus: "completed",
    },
  };
}

function visibleMessageText(message: Message): string {
  return message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")
    .trim();
}

export function createRealtimeTranscriptReplayEvents(
  messages: readonly Message[],
  sessionId?: string,
): Record<string, unknown>[] {
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  let pendingAssistant: { role: "assistant"; text: string } | null = null;
  const flushAssistant = () => {
    if (!pendingAssistant) return;
    turns.push(pendingAssistant);
    pendingAssistant = null;
  };

  for (const message of messages) {
    if (message.metadata?.userVisible === false || message.role === "system")
      continue;
    const text = visibleMessageText(message);
    if (!text) continue;
    if (message.role === "user") {
      flushAssistant();
      turns.push({ role: "user", text });
      continue;
    }
    if (
      message.metadata?.personaName === "Routing" ||
      message.metadata?.personaName?.includes("→") ||
      (message.metadata?.completionStatus &&
        message.metadata.completionStatus !== "completed")
    )
      continue;
    // Only the final visible assistant block before the next user turn is
    // useful context. Progress narration and earlier replacements stay in the
    // durable Master transcript but do not bloat a resumed voice frontend.
    pendingAssistant = { role: "assistant", text };
  }
  flushAssistant();

  const tail = turns.slice(-MAX_REALTIME_REPLAY_ITEMS);
  const firstUserIndex = tail.findIndex((turn) => turn.role === "user");
  if (firstUserIndex < 0) return [];
  const replay = tail.slice(firstUserIndex).map((turn) => ({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: turn.role,
      content: [
        {
          type: turn.role === "assistant" ? "output_text" : "input_text",
          text: turn.text,
        },
      ],
    },
  }));
  if (!sessionId) return replay;
  return [
    {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `This voice conversation is being resumed from Berd session ${sessionId}. Durable session link: berd://session/${sessionId}. The following items are a compact recent transcript, not new turns. Ask the master to inspect the durable session when older context is needed.`,
          },
        ],
      },
    },
    ...replay,
  ];
}

function waitForDataChannelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("OpenAI Realtime data channel failed to open."));
    };
    channel.addEventListener("open", handleOpen);
    channel.addEventListener("error", handleError);
  });
}

function masterPrompt(sessionId: string): string {
  return `${REALTIME_MASTER_INSTRUCTIONS}

Your send_to_emissary tool is the Berd CLI command below. The initial bridge cursor is 0. Always use the newest cursor from any Master-bound transcript, handoff, reminder, or prior tool result. A stale cursor means a newer event is already queued; wait for its normal delivery rather than bypassing it. Choose --mode context to silently update the emissary's context for a future natural turn. Choose --mode say only when the emissary should speak your message to the user now. A say may resolve several open handoffs by repeating --resolves for each handoff id. Context cannot resolve a handoff. Finishing your turn does not notify or wake the emissary, so send explicitly when needed.

berdctl session send-to-emissary --session-id ${JSON.stringify(sessionId)} --cursor <cursor> --mode <context|say> [--resolves <handoff-id> ...] --message <message> --json

If a handoff is obsolete, superseded, or already handled, dismiss it explicitly:

berdctl session dismiss-handoffs --session-id ${JSON.stringify(sessionId)} --cursor <cursor> --handoff-id <handoff-id> [--handoff-id <handoff-id> ...] --reason <reason> --json`;
}

type RuntimeState = ChatInputVoiceConversation["state"];
interface Snapshot {
  state: RuntimeState;
  boundSessionId: string | null;
  requestedStartSessionId: string | null;
  microphoneMuted: boolean;
  error: string | null;
}
interface StartOptions {
  sessionId: string;
  onSend: ChatInputSendHandler;
}
const OFF_SNAPSHOT: Snapshot = {
  state: "off",
  boundSessionId: null,
  requestedStartSessionId: null,
  microphoneMuted: false,
  error: null,
};

class OpenAiRealtimeConversationRuntime {
  private snapshot: Snapshot = OFF_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private releaseBridge: (() => void) | null = null;
  private bridgeSender:
    | ((
        message: string,
        cursor: number,
        mode: MasterMessageMode,
        resolves: string[],
      ) => Promise<MasterMessageDelivery>)
    | null = null;
  private bridgeHandoffDismissal:
    | ((
        cursor: number,
        handoffIds: string[],
        reason: string,
      ) => Promise<HandoffDismissal>)
    | null = null;
  private bridgeMasterTurnCompletion:
    | ((completion: RealtimeMasterTurnCompletion) => void)
    | null = null;
  private readonly openHandoffs = new Map<
    string,
    { message: string; reminderSent: boolean }
  >();
  private activeRun = 0;
  private deliveryQueue = Promise.resolve();
  private boundOnSend: ChatInputSendHandler | null = null;
  private typedUserMessageSink: ((text: string) => void) | null = null;
  private pendingTypedUserMessages: string[] = [];
  private failureInProgress = false;
  private ownerMigration = Promise.resolve();
  private historyReplay = Promise.resolve();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): Snapshot => this.snapshot;

  bindOwner(sessionId: string, onSend: ChatInputSendHandler): void {
    if (this.snapshot.boundSessionId === sessionId) this.boundOnSend = onSend;
  }

  requestStart(sessionId: string): void {
    this.setSnapshot({ ...this.snapshot, requestedStartSessionId: sessionId });
  }

  rebindPromotedOwner(sessionId: string, onSend: ChatInputSendHandler): void {
    const previousSessionId = this.snapshot.boundSessionId;
    if (!previousSessionId || previousSessionId === sessionId) {
      this.bindOwner(sessionId, onSend);
      return;
    }

    this.boundOnSend = onSend;
    this.setSnapshot({ ...this.snapshot, boundSessionId: sessionId });
    this.registerBridge(sessionId);
    this.ownerMigration = this.ownerMigration
      .catch(() => undefined)
      .then(async () => {
        await appendSessionSystemPrompt(
          previousSessionId,
          MASTER_PROMPT_KEY,
          "",
        ).catch(() => undefined);
        await appendSessionSystemPrompt(
          sessionId,
          MASTER_PROMPT_KEY,
          masterPrompt(sessionId),
        );
      });
  }

  async start({ sessionId, onSend }: StartOptions): Promise<void> {
    if (
      (this.snapshot.boundSessionId &&
        this.snapshot.boundSessionId !== sessionId) ||
      (this.snapshot.boundSessionId === sessionId &&
        this.snapshot.state !== "off" &&
        this.snapshot.state !== "error")
    )
      return;

    const runId = ++this.activeRun;
    this.failureInProgress = false;
    this.openHandoffs.clear();
    this.boundOnSend = onSend;
    this.pendingTypedUserMessages = [];
    this.setSnapshot({
      state: "starting",
      boundSessionId: sessionId,
      requestedStartSessionId: null,
      microphoneMuted: false,
      error: null,
    });
    const isStale = () => this.activeRun !== runId;
    try {
      await claimVoiceDictationMicrophone(MICROPHONE_OWNER_ID).catch(
        (error) => {
          if (!isUnavailableDevMicrophoneClaim(error)) throw error;
        },
      );
      const preference = getRealtimeVoicePreference();
      const pendingDraft =
        useChatSessionStore.getState().getSession(sessionId)?.creationState ===
        "pending";
      const [stream, session] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
        }),
        createOpenAiRealtimeVoiceSession(preference.model),
        pendingDraft
          ? Promise.resolve()
          : appendSessionSystemPrompt(
              sessionId,
              MASTER_PROMPT_KEY,
              masterPrompt(sessionId),
            ),
      ]).then(([stream, session]) => [stream, session] as const);
      if (isStale()) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }

      const peer = createOpenAiRealtimePeerConnection();
      const channel = peer.createDataChannel("oai-events");
      const audio = new Audio();
      audio.autoplay = true;
      this.peer = peer;
      this.channel = channel;
      this.stream = stream;
      this.audio = audio;
      stream.getAudioTracks().forEach((track) => {
        peer.addTrack(track, stream);
      });
      peer.addEventListener("track", (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio
          .play()
          .catch((error) =>
            this.fail(this.snapshot.boundSessionId ?? sessionId, error),
          );
      });

      const transport = { send: (data: string) => channel.send(data) };
      const protocol = new RealtimeEmissaryProtocol();
      const responses = new RealtimeResponseCoordinator();
      const pipe = new DirectMessagePipe();
      const queueMasterBoundEvent = (message: string) => {
        const exchange = pipe.send({
          sender: "emissary",
          cursor: pipe.deliveryCursor("emissary"),
          message,
        });
        if (!exchange.accepted) {
          throw new Error(
            `The realtime event could not enter the master pipe (${exchange.reason}).`,
          );
        }
        return exchange.outbound;
      };
      const transcriptMessageIds = new Map<string, string>();
      const upsertTranscriptMessage = (
        ownerSessionId: string,
        transcript: {
          itemId: string;
          speaker: "user" | "emissary";
          text: string;
          interrupted?: true;
        },
        provisional: boolean,
      ): string => {
        const existingId = transcriptMessageIds.get(transcript.itemId);
        const messageId = existingId ?? crypto.randomUUID();
        transcriptMessageIds.set(transcript.itemId, messageId);
        const nextMessage =
          transcript.speaker === "user"
            ? createUserTranscriptMessage(
                messageId,
                transcript.text,
                provisional,
              )
            : createEmissaryTranscriptMessage(
                transcript.text,
                transcript.interrupted === true,
                messageId,
                provisional,
              );
        const store = useChatStore.getState();
        if (existingId) {
          store.updateMessage(ownerSessionId, messageId, (existing) => ({
            ...nextMessage,
            created: existing.created,
          }));
        } else {
          store.addMessage(ownerSessionId, nextMessage);
        }
        return messageId;
      };
      const forwardTypedUserMessage = (text: string) => {
        const request = responses.requestTypedUserMessage(text);
        sendRealtimeEvents(transport, request.events);
      };
      channel.addEventListener("message", (message) => {
        try {
          const ownerSessionId = this.snapshot.boundSessionId;
          if (!ownerSessionId || isStale()) return;
          const event: unknown = JSON.parse(String(message.data));
          sendRealtimeEvents(transport, responses.handle(event));
          for (const bridgeEvent of protocol.handle(event)) {
            if (bridgeEvent.type === "transcript.started") {
              upsertTranscriptMessage(
                ownerSessionId,
                { ...bridgeEvent, text: "" },
                true,
              );
            } else if (bridgeEvent.type === "transcript.updated") {
              upsertTranscriptMessage(ownerSessionId, bridgeEvent, true);
            } else if (bridgeEvent.type === "transcript.finalized") {
              const transcriptMessageId = upsertTranscriptMessage(
                ownerSessionId,
                bridgeEvent,
                false,
              );
              const interrupted = bridgeEvent.interrupted === true;
              const transcriptLabel =
                bridgeEvent.speaker === "user"
                  ? `User said: ${bridgeEvent.text}`
                  : `Emissary said${
                      interrupted
                        ? " (interrupted; best-effort transcript)"
                        : ""
                    }: ${bridgeEvent.text}`;
              const transcriptMessage = `[Voice transcript] ${transcriptLabel}`;
              const masterBound = queueMasterBoundEvent(transcriptMessage);
              const masterTranscript = `[Voice transcript; cursor ${masterBound.id}] ${transcriptLabel}`;
              if (bridgeEvent.speaker === "emissary") {
                this.deliverToMaster(
                  ownerSessionId,
                  masterTranscript,
                  bridgeEvent.text,
                  undefined,
                  true,
                );
                continue;
              }
              this.deliverToMaster(
                ownerSessionId,
                masterTranscript,
                bridgeEvent.text,
                undefined,
                false,
                transcriptMessageId,
              );
            } else if (bridgeEvent.type === "handoff") {
              const exchange = pipe.send({
                sender: "emissary",
                cursor: bridgeEvent.cursor,
                message: bridgeEvent.message,
              });
              const handoffId = exchange.accepted
                ? `handoff-${exchange.outbound.id}`
                : undefined;
              const toolOutput = createHandoffToolOutput(bridgeEvent.callId, {
                ...exchange,
                ...(handoffId ? { handoff_id: handoffId } : {}),
              });
              const toolFollowUp = exchange.accepted
                ? responses.recordToolOutput(toolOutput)
                : responses.requestToolOutput(toolOutput);
              sendRealtimeEvents(transport, toolFollowUp.events);
              if (exchange.accepted && handoffId) {
                this.openHandoffs.set(handoffId, {
                  message: exchange.outbound.message,
                  reminderSent: false,
                });
                useChatStore
                  .getState()
                  .addMessage(
                    ownerSessionId,
                    createHandoffDebugMessage(
                      handoffId,
                      exchange.outbound.message,
                    ),
                  );
                this.deliverToMaster(
                  ownerSessionId,
                  `[Handoff ${handoffId} from emissary; cursor ${exchange.outbound.id}] ${exchange.outbound.message}`,
                  exchange.outbound.message,
                  undefined,
                  true,
                  undefined,
                  false,
                );
              }
            } else if (bridgeEvent.type === "tool_call.invalid") {
              const toolFollowUp = responses.requestToolOutput(
                createInvalidToolCallOutput(
                  bridgeEvent.callId,
                  bridgeEvent.toolName,
                  bridgeEvent.error,
                ),
              );
              sendRealtimeEvents(transport, toolFollowUp.events);
            }
          }
        } catch (error) {
          void this.fail(this.snapshot.boundSessionId ?? sessionId, error);
        }
      });

      await connectOpenAiRealtimePeerConnection({
        peerConnection: peer,
        clientSecret: session.clientSecret,
      });
      await waitForDataChannelOpen(channel);
      if (isStale()) return;
      configureRealtimeEmissarySession(transport, {
        model: preference.model,
        transcriptionModel: preference.transcriptionModel,
        transcriptionLanguage: preference.transcriptionLanguage,
        transcriptionPrompt: preference.transcriptionPrompt,
        voice: preference.voice,
        speed: preference.speed,
        turnDetection: preference.turnDetection,
        eagerness: preference.eagerness,
        interruptResponse: preference.interruptResponse,
        createResponse: preference.createResponse,
        vadThreshold: preference.vadThreshold,
        prefixPaddingMs: preference.prefixPaddingMs,
        silenceDurationMs: preference.silenceDurationMs,
        idleTimeoutMs: preference.idleTimeoutMs,
        noiseReduction: preference.noiseReduction,
        reasoningEffort: preference.reasoningEffort,
        maxOutputTokens: preference.maxOutputTokens,
        sessionOverrides: parseRealtimeSessionOverrides(
          preference.sessionOverridesText,
        ),
      });
      this.typedUserMessageSink = forwardTypedUserMessage;
      for (const text of this.pendingTypedUserMessages.splice(0)) {
        forwardTypedUserMessage(text);
      }
      const replaySessionId = this.snapshot.boundSessionId ?? sessionId;
      this.historyReplay = waitForSessionHydration(replaySessionId).then(() => {
        if (isStale() || this.snapshot.boundSessionId !== replaySessionId)
          return;
        sendRealtimeEvents(
          transport,
          createRealtimeTranscriptReplayEvents(
            useChatStore.getState().messagesBySession[replaySessionId] ?? [],
            replaySessionId,
          ),
        );
      });
      this.bridgeSender = async (message, cursor, mode, resolves) => {
        const resolvedHandoffIds = [...new Set(resolves)];
        if (mode === "context" && resolvedHandoffIds.length > 0) {
          return {
            accepted: false,
            reason: "context_cannot_resolve",
            unreadPeerMessages: [],
            cursor: pipe.cursor("master"),
            handoffIds: resolvedHandoffIds,
          };
        }
        const unknownHandoffIds = resolvedHandoffIds.filter(
          (handoffId) => !this.openHandoffs.has(handoffId),
        );
        if (unknownHandoffIds.length > 0) {
          return {
            accepted: false,
            reason: "unknown_handoff",
            unreadPeerMessages: [],
            cursor: pipe.cursor("master"),
            handoffIds: unknownHandoffIds,
          };
        }
        const exchange = pipe.send({ sender: "master", cursor, message });
        if (!exchange.accepted) return exchange;
        for (const handoffId of resolvedHandoffIds) {
          this.openHandoffs.delete(handoffId);
        }
        const request = responses.requestMasterMessage({
          message: `[bridge cursor ${exchange.outbound.id}] ${message}`,
          mode,
          eventId: `berd-master-${exchange.outbound.id}`,
        });
        sendRealtimeEvents(transport, request.events);
        return { ...exchange, deliveryStatus: request.status };
      };
      this.bridgeHandoffDismissal = async (cursor, handoffIds, reason) => {
        const dismissedHandoffIds = [...new Set(handoffIds)];
        const unknownHandoffIds = dismissedHandoffIds.filter(
          (handoffId) => !this.openHandoffs.has(handoffId),
        );
        if (unknownHandoffIds.length > 0) {
          return {
            accepted: false,
            reason: "unknown_handoff",
            unreadPeerMessages: [],
            cursor: pipe.cursor("master"),
            handoffIds: unknownHandoffIds,
          };
        }
        if (!reason.trim()) {
          throw new Error("handoff dismissal reason cannot be empty");
        }
        const dismissalContext = `Handoffs ${dismissedHandoffIds.join(", ")} were dismissed without a spoken response. Reason: ${reason.trim()}`;
        const exchange = pipe.send({
          sender: "master",
          cursor,
          message: dismissalContext,
        });
        if (!exchange.accepted) return exchange;
        for (const handoffId of dismissedHandoffIds) {
          this.openHandoffs.delete(handoffId);
        }
        const request = responses.requestMasterMessage({
          message: `[bridge cursor ${exchange.outbound.id}] [Handoff dismissal] ${dismissalContext} This is silent context; do not speak merely to acknowledge it.`,
          mode: "context",
          eventId: `berd-master-dismissal-${exchange.outbound.id}`,
        });
        sendRealtimeEvents(transport, request.events);
        return {
          accepted: true,
          cursor: exchange.cursor,
          dismissedHandoffIds,
          deliveryStatus: request.status,
        };
      };
      this.bridgeMasterTurnCompletion = ({ reminderHandoffIds }) => {
        const ownerSessionId = this.snapshot.boundSessionId;
        if (!ownerSessionId) return;
        if (reminderHandoffIds.length > 0) {
          const unresolved = reminderHandoffIds.filter((handoffId) =>
            this.openHandoffs.has(handoffId),
          );
          if (unresolved.length > 0) {
            void this.fail(
              ownerSessionId,
              new Error(
                `The master left required ${unresolved.join(", ")} unresolved after its reminder turn.`,
              ),
            );
            return;
          }
        }

        const pending = [...this.openHandoffs.entries()].filter(
          ([, handoff]) => !handoff.reminderSent,
        );
        if (pending.length === 0) return;
        const pendingIds = pending.map(([handoffId]) => handoffId);
        for (const [, handoff] of pending) handoff.reminderSent = true;
        const requests = pending
          .map(([handoffId, handoff]) => `- ${handoffId}: ${handoff.message}`)
          .join("\n");
        const reminder = `[Private handoff reminder]\nYou ended your turn without resolving the required handoffs below. Resolve them now with one or more send-to-emissary --mode say calls that name every answered handoff in --resolves, or dismiss obsolete handoffs explicitly. Do not redo completed work.\n${requests}`;
        const masterBound = queueMasterBoundEvent(reminder);
        this.deliverToMaster(
          ownerSessionId,
          `[Private handoff reminder; cursor ${masterBound.id}]${reminder.slice("[Private handoff reminder]".length)}`,
          "Handoff reminder",
          undefined,
          true,
          undefined,
          true,
          pendingIds,
        );
      };
      this.registerBridge(this.snapshot.boundSessionId ?? sessionId);
      this.setSnapshot({ ...this.snapshot, state: "listening" });
    } catch (error) {
      if (!isStale()) await this.fail(sessionId, error);
    }
  }

  async stop(sessionId: string): Promise<void> {
    if (
      this.snapshot.boundSessionId !== sessionId ||
      this.snapshot.state === "off" ||
      this.snapshot.state === "stopping"
    )
      return;
    this.setSnapshot({ ...this.snapshot, state: "stopping" });
    await this.cleanupResources(sessionId);
    this.boundOnSend = null;
    this.failureInProgress = false;
    this.setSnapshot(OFF_SNAPSHOT);
  }

  toggleMute(sessionId: string): void {
    if (this.snapshot.boundSessionId !== sessionId) return;
    const microphoneMuted = !this.snapshot.microphoneMuted;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !microphoneMuted;
    });
    this.setSnapshot({ ...this.snapshot, microphoneMuted });
  }

  forwardTypedUserMessage(sessionId: string, text: string): void {
    if (this.snapshot.boundSessionId !== sessionId || !text.trim()) return;
    if (!this.typedUserMessageSink) {
      if (this.snapshot.state === "starting")
        this.pendingTypedUserMessages.push(text);
      return;
    }
    try {
      this.typedUserMessageSink(text);
    } catch (error) {
      // Mirroring into the voice frontend is secondary to the ordinary Berd
      // send that invoked this callback. Never let a synchronous WebRTC/data
      // channel failure abort the user's Master turn.
      void this.fail(sessionId, error);
    }
  }

  async dispose(): Promise<void> {
    const sessionId = this.snapshot.boundSessionId;
    if (sessionId) await this.cleanupResources(sessionId);
    this.boundOnSend = null;
    this.bridgeSender = null;
    this.bridgeHandoffDismissal = null;
    this.bridgeMasterTurnCompletion = null;
    this.openHandoffs.clear();
    this.typedUserMessageSink = null;
    this.pendingTypedUserMessages = [];
    this.failureInProgress = false;
    this.deliveryQueue = Promise.resolve();
    this.historyReplay = Promise.resolve();
    this.setSnapshot(OFF_SNAPSHOT);
  }

  private deliverToMaster(
    sessionId: string,
    text: string,
    displayText: string,
    onDelivered?: () => void,
    hidden = false,
    userMessageId?: string,
    queueUntilIdle = false,
    reminderHandoffIds: string[] = [],
  ): void {
    this.deliveryQueue = this.deliveryQueue
      .catch(() => undefined)
      .then(async () => {
        // History replay replaces the transcript wholesale. Dispatching a
        // realtime transcript while hydration is still active can therefore
        // route the master's live ACP stream into the replay buffer, or let a
        // subsequent replay replacement erase it. Preserve ordering in the
        // delivery queue and wait for hydration to publish before sending.
        await this.ownerMigration;
        await this.historyReplay;
        sessionId = this.snapshot.boundSessionId ?? sessionId;
        await waitForSessionHydration(sessionId);
        if (queueUntilIdle) await waitForMasterIdle(sessionId);
        if (this.snapshot.boundSessionId !== sessionId || !this.boundOnSend)
          throw new Error("The realtime voice owner is no longer available.");
        const sendOptions = {
          displayText,
          userMessageMetadata: {
            origin: "voice_conversation" as const,
            ...(hidden ? { userVisible: false } : {}),
          },
          acpGooseMetadata: {
            origin: "voice_conversation",
            userVisible: !hidden,
            agentVisible: false,
            ...(reminderHandoffIds.length > 0
              ? { [HANDOFF_REMINDER_IDS_METADATA]: reminderHandoffIds }
              : {}),
          },
          ...(userMessageId ? { userMessageId } : {}),
        };
        const sendAsPrompt = async () => {
          const accepted = await this.boundOnSend?.(
            text,
            undefined,
            undefined,
            sendOptions,
          );
          if (accepted === false)
            throw new Error(
              "The master session did not accept the voice transcript.",
            );
        };
        this.setSnapshot({ ...this.snapshot, state: "agent-working" });
        for (;;) {
          const opportunity = await waitForMasterDeliveryOpportunity(sessionId);
          if (opportunity === "send") {
            await sendAsPrompt();
            break;
          }
          const rejectedRunId = useChatStore
            .getState()
            .getSessionRuntime(sessionId).activeRunId;
          try {
            await steerPromptInSession(
              sessionId,
              text,
              undefined,
              sendOptions,
              {
                throwOnError: true,
                // A run can end after the opportunity check but before ACP
                // admits the steer. The bridge retries that boundary as a
                // fresh prompt, so the transient rejection is not a user
                // error and must not leak into the durable transcript.
                reportErrorInTranscript: false,
              },
            );
            break;
          } catch (error) {
            if (!isMissingActiveRun(error)) throw error;
            // Re-evaluate instead of assuming send: local run state may still
            // be publishing completion, or a newer run may already own the
            // session. Either transition yields the next safe opportunity.
            await waitForMasterRunBoundary(sessionId, rejectedRunId);
          }
        }
        onDelivered?.();
        if (this.snapshot.boundSessionId === sessionId)
          this.setSnapshot({ ...this.snapshot, state: "listening" });
      })
      .catch((error) => this.fail(sessionId, error));
  }

  private async fail(sessionId: string, error: unknown): Promise<void> {
    if (
      this.snapshot.boundSessionId !== sessionId ||
      this.failureInProgress ||
      this.snapshot.state === "error"
    )
      return;
    this.failureInProgress = true;
    const message = errorText(error);
    await this.cleanupResources(sessionId);
    this.boundOnSend = null;
    this.setSnapshot({
      state: "error",
      boundSessionId: sessionId,
      requestedStartSessionId: null,
      microphoneMuted: false,
      error: message,
    });
    useChatStore
      .getState()
      .addMessage(sessionId, createSystemNotificationMessage(message, "error"));
    toast.error("OpenAI Realtime voice failed", { description: message });
  }

  private async cleanupResources(sessionId: string): Promise<void> {
    this.activeRun += 1;
    this.releaseBridge?.();
    this.channel?.close();
    this.peer?.close();
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.audio?.pause();
    this.releaseBridge = null;
    this.bridgeSender = null;
    this.bridgeHandoffDismissal = null;
    this.bridgeMasterTurnCompletion = null;
    this.openHandoffs.clear();
    this.typedUserMessageSink = null;
    this.pendingTypedUserMessages = [];
    this.channel = null;
    this.peer = null;
    this.stream = null;
    this.audio = null;
    await releaseVoiceDictationMicrophone(MICROPHONE_OWNER_ID).catch(
      () => undefined,
    );
    await appendSessionSystemPrompt(sessionId, MASTER_PROMPT_KEY, "").catch(
      () => undefined,
    );
  }

  private setSnapshot(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private registerBridge(sessionId: string): void {
    if (
      !this.bridgeSender ||
      !this.bridgeHandoffDismissal ||
      !this.bridgeMasterTurnCompletion
    )
      return;
    this.releaseBridge?.();
    this.releaseBridge = registerRealtimeEmissary({
      sessionId,
      sendMasterMessage: this.bridgeSender,
      dismissHandoffs: this.bridgeHandoffDismissal,
      completeMasterTurn: this.bridgeMasterTurnCompletion,
    });
  }
}

const runtime = new OpenAiRealtimeConversationRuntime();

export function requestOpenAiRealtimeConversationStart(
  sessionId: string,
): void {
  runtime.requestStart(sessionId);
}

export async function stopOpenAiRealtimeConversation(): Promise<void> {
  const sessionId = runtime.getSnapshot().boundSessionId;
  if (sessionId) await runtime.stop(sessionId);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void runtime.dispose();
  });
}

export async function resetOpenAiRealtimeConversationRuntimeForTests(): Promise<void> {
  await runtime.dispose();
}

export function useOpenAiRealtimeConversation(options: {
  sessionId: string;
  onSend: ChatInputSendHandler;
  enabled: boolean;
  readOnly?: boolean;
  disabled?: boolean;
}): ChatInputVoiceConversation {
  const {
    sessionId,
    onSend,
    enabled,
    readOnly = false,
    disabled = false,
  } = options;
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const clientSessionId = useChatSessionStore(
    (state) =>
      state.sessions?.find((candidate) => candidate.id === sessionId)
        ?.clientSessionId,
  );
  const ownsPromotedConversation =
    snapshot.boundSessionId !== null &&
    snapshot.boundSessionId !== sessionId &&
    clientSessionId === snapshot.boundSessionId;
  const ownsActiveConversation = snapshot.boundSessionId === sessionId;
  const anotherSessionOwnsConversation =
    snapshot.boundSessionId !== null &&
    !ownsActiveConversation &&
    !ownsPromotedConversation;
  const requestedStartMatchesSession =
    snapshot.requestedStartSessionId === sessionId ||
    (clientSessionId !== undefined &&
      snapshot.requestedStartSessionId === clientSessionId);
  useEffect(() => {
    if (ownsPromotedConversation)
      runtime.rebindPromotedOwner(sessionId, onSend);
    else if (ownsActiveConversation) runtime.bindOwner(sessionId, onSend);
  }, [onSend, ownsActiveConversation, ownsPromotedConversation, sessionId]);
  useEffect(() => {
    if (
      !requestedStartMatchesSession ||
      !enabled ||
      disabled ||
      readOnly ||
      anotherSessionOwnsConversation
    )
      return;
    void runtime.start({ sessionId, onSend });
  }, [
    anotherSessionOwnsConversation,
    disabled,
    enabled,
    onSend,
    readOnly,
    requestedStartMatchesSession,
    sessionId,
  ]);
  const start = useCallback(async () => {
    if (!enabled || disabled || readOnly || anotherSessionOwnsConversation)
      return;
    await runtime.start({ sessionId, onSend });
  }, [
    anotherSessionOwnsConversation,
    disabled,
    enabled,
    onSend,
    readOnly,
    sessionId,
  ]);
  const stop = useCallback(async () => {
    await runtime.stop(sessionId);
  }, [sessionId]);
  const toggleMute = useCallback(
    () => runtime.toggleMute(sessionId),
    [sessionId],
  );
  const forwardTypedUserMessage = useCallback(
    (text: string) => runtime.forwardTypedUserMessage(sessionId, text),
    [sessionId],
  );
  const shouldStart =
    !ownsActiveConversation ||
    snapshot.state === "off" ||
    snapshot.state === "error";

  return {
    visible: enabled,
    state: snapshot.state,
    boundSessionId: snapshot.boundSessionId,
    active:
      snapshot.state !== "off" &&
      snapshot.state !== "error" &&
      snapshot.boundSessionId !== null,
    ownsActiveConversation,
    microphoneMuted: snapshot.microphoneMuted,
    error: snapshot.error,
    disabled: disabled || readOnly || anotherSessionOwnsConversation,
    onToggle: shouldStart ? start : stop,
    onMicrophoneMuteToggle: toggleMute,
    onTypedUserMessageCommitted: forwardTypedUserMessage,
  };
}
