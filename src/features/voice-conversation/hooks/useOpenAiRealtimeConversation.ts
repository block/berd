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
  createOpenAiRealtimeBackendInstructions,
  createOpenAiRealtimeTranscriptSeed,
  appendOpenAiRealtimeBackendResult,
  listenToOpenAiRealtimeVoiceControls,
  listenToOpenAiRealtimeGptLiveRuntime,
  publishOpenAiRealtimeVoiceActivity,
  publishOpenAiRealtimeVoiceMicrophoneMuted,
  rebindOpenAiRealtimeVoiceControls,
  reduceOpenAiRealtimeGptLiveEvent,
  requestOpenAiRealtimeTypedUserMessage,
  sendOpenAiRealtimeGptLiveRuntimeEvent,
  releaseVoiceDictationMicrophone,
  setOpenAiRealtimeVoiceControlsSuppressed,
  startOpenAiRealtimeVoiceControls,
  startOpenAiRealtimeGptLiveRuntime,
  stopOpenAiRealtimeVoiceControls,
  stopOpenAiRealtimeGptLiveRuntime,
  releaseOpenAiRealtimeGptLiveRuntime,
  updateOpenAiRealtimeGptLiveSettings,
  type OpenAiRealtimeTranscriptSeedTurn,
  type OpenAiRealtimeBackendDeliveryEvent,
} from "@/shared/api/openaiRealtime";
import {
  createSystemNotificationMessage,
  type Message,
  type VoiceConversationDebugEvent,
} from "@/shared/types/messages";
import {
  startNativeMicrophone,
  type NativeMicrophone,
} from "../lib/nativeMicrophone";
import {
  type ActiveGptLiveBridge,
  type GptLiveAppendChannel,
  type GptLiveAppendResult,
  registerGptLiveBridge,
  waitForGptLiveBridgeReady,
} from "../lib/gptLiveBridge";
import {
  requestVoiceConversationEnd,
  trackVoiceAssistantResponse,
  trackVoiceConversationEnded,
  trackVoiceConversationStarted,
  trackVoiceUserUtterance,
} from "../lib/voiceTelemetry";
import {
  getRealtimeVoicePreference,
  subscribeToRealtimeVoicePreference,
} from "../lib/realtimeVoicePreference";
import {
  beginVoiceControlsVisibilityLease,
  observeVoiceConversationControlVisibility,
} from "./useVoiceConversationController";

const BACKEND_PROMPT_KEY = "berd-gpt-live-backend";
const MICROPHONE_OWNER_ID = "berd:realtime-voice-conversation";
const MAX_REALTIME_REPLAY_ITEMS = 12;

function sendRealtimeEvents(
  transport: { send(data: string): void },
  events: readonly Record<string, unknown>[],
): void {
  for (const event of events) transport.send(JSON.stringify(event));
}

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

export function renderRealtimeBackendDeliveryEvent(
  event: OpenAiRealtimeBackendDeliveryEvent,
): string {
  const cursor = `cursor ${event.cursor}`;
  switch (event.role) {
    case "user":
      return `[Voice transcript; ${cursor}] User said: ${event.text}`;
    case "gpt_live":
      return `[Voice transcript; ${cursor}] GPT Live said: ${event.text}`;
    case "gpt_live_interrupted":
      return `[Voice transcript; ${cursor}] GPT Live said (interrupted; best effort): ${event.text}`;
    case "handoff":
      return `[Delegation ${event.handoffId ?? "unknown"} from GPT Live; ${cursor}] ${event.text}`;
  }
}

export function renderRealtimeBackendDelivery(
  events: OpenAiRealtimeBackendDeliveryEvent[],
): string {
  return events.map(renderRealtimeBackendDeliveryEvent).join("\n");
}

function waitForSessionHydration(
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!useChatStore.getState().loadingSessionIds.has(sessionId)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const cleanup = () => {
      unsubscribe();
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    unsubscribe = useChatStore.subscribe((state) => {
      if (state.loadingSessionIds.has(sessionId)) return;
      cleanup();
      resolve();
    });
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

function waitForBackendIdle(
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const isIdle = () => {
    const runtime = useChatStore.getState().getSessionRuntime(sessionId);
    return runtime.activeRunId === null && !isSessionRunning(runtime.chatState);
  };
  if (isIdle()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const cleanup = () => {
      unsubscribe();
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    unsubscribe = useChatStore.subscribe(() => {
      if (!isIdle()) return;
      cleanup();
      resolve();
    });
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

type BackendDeliveryOpportunity = "send" | "steer";

function backendDeliveryOpportunity(
  sessionId: string,
): BackendDeliveryOpportunity | null {
  const state = useChatStore.getState();
  if ((state.queuedMessageBySession[sessionId]?.length ?? 0) > 0) return null;
  const runtime = state.getSessionRuntime(sessionId);
  if (runtime.isRunCancellationPending) return null;
  // A chat state can cross the run boundary before activeRunId catches up.
  // Only an actual run id is sufficient proof that ACP can accept a steer.
  if (runtime.activeRunId !== null) return "steer";
  if (!isSessionRunning(runtime.chatState)) return "send";
  return null;
}

function waitForBackendDeliveryOpportunity(
  sessionId: string,
  signal?: AbortSignal,
): Promise<BackendDeliveryOpportunity> {
  signal?.throwIfAborted();
  const available = backendDeliveryOpportunity(sessionId);
  if (available) return Promise.resolve(available);

  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const cleanup = () => {
      unsubscribe();
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    unsubscribe = useChatStore.subscribe(() => {
      const opportunity = backendDeliveryOpportunity(sessionId);
      if (!opportunity) return;
      cleanup();
      resolve(opportunity);
    });
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

function waitForBackendRunBoundary(
  sessionId: string,
  rejectedRunId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const crossedBoundary = () => {
    const runtime = useChatStore.getState().getSessionRuntime(sessionId);
    return (
      runtime.activeRunId !== rejectedRunId ||
      (runtime.activeRunId === null && !isSessionRunning(runtime.chatState))
    );
  };
  if (crossedBoundary()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const cleanup = () => {
      unsubscribe();
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    unsubscribe = useChatStore.subscribe(() => {
      if (!crossedBoundary()) return;
      cleanup();
      resolve();
    });
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

const MAX_BRIDGE_CURSOR = 4_294_967_295;
const BRIDGE_CURSOR_RESERVE = 1_000_000;

function createBridgeCallScope(): { id: string; initialCursor: number } {
  const id = crypto.randomUUID();
  const prefix = Number.parseInt(id.replaceAll("-", "").slice(0, 8), 16);
  return {
    id,
    initialCursor: prefix % (MAX_BRIDGE_CURSOR - BRIDGE_CURSOR_RESERVE),
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException ||
      (typeof error === "object" && error !== null && "name" in error)) &&
    String(error.name) === "AbortError"
  );
}

function createGptLiveTranscriptMessage(
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
      personaName: "GPT Live",
      voiceConversationDebugEvent: "gptLiveSpeech",
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

function createCoordinationDebugMessage(
  kind: VoiceConversationDebugEvent,
  label: string,
  text: string,
): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    created: Date.now(),
    content: [{ type: "text", text }],
    metadata: {
      userVisible: true,
      agentVisible: false,
      origin: "voice_conversation",
      personaName: label,
      voiceConversationDebugEvent: kind,
      completionStatus: "completed",
    },
  };
}

function createHandoffDebugMessage(handoffId: string, text: string): Message {
  return createCoordinationDebugMessage(
    "gptLiveToBackend",
    `GPT Live → Backend · Delegation ${handoffId}`,
    text,
  );
}

function visibleMessageText(message: Message): string {
  return message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")
    .trim();
}

export function collectRealtimeTranscriptSeedTurns(
  messages: readonly Message[],
): OpenAiRealtimeTranscriptSeedTurn[] {
  const turns: OpenAiRealtimeTranscriptSeedTurn[] = [];
  let pendingAssistant: OpenAiRealtimeTranscriptSeedTurn | null = null;
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
      message.metadata?.voiceConversationDebugEvent ||
      message.metadata?.personaName === "Routing" ||
      message.metadata?.personaName?.includes("→") ||
      (message.metadata?.completionStatus &&
        message.metadata.completionStatus !== "completed")
    )
      continue;
    // Only the final visible assistant block before the next user turn is
    // useful context. Progress narration and earlier replacements stay in the
    // durable Backend transcript but do not bloat a resumed voice frontend.
    pendingAssistant = {
      role: "gpt_live",
      text,
      interrupted: false,
    };
  }
  flushAssistant();
  return turns;
}

type RuntimeState = ChatInputVoiceConversation["state"];
interface Snapshot {
  state: RuntimeState;
  boundSessionId: string | null;
  requestedStartSessionId: string | null;
  microphoneMuted: boolean;
  error: string | null;
  controlsRevision: number;
  ownerWindowLabel: string | null;
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
  controlsRevision: 0,
  ownerWindowLabel: null,
};

class OpenAiRealtimeConversationRuntime {
  private snapshot: Snapshot = OFF_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private nativeMicrophone: NativeMicrophone | null = null;
  private releaseRuntimeListener: (() => void) | null = null;
  private releaseVoicePreferenceListener: (() => void) | null = null;
  private realtimeSettingsRevision = 1;
  private realtimeSettingsQueue = Promise.resolve();
  private realtimeRuntimeSessionId: string | null = null;
  private realtimeProtocolQueue = Promise.resolve();
  private realtimeRuntimeSendQueue = Promise.resolve();
  private releaseControlsListener: (() => void) | null = null;
  private releaseBridge: (() => void) | null = null;
  private bridgeAppender:
    | ((
        message: string,
        cursor: number,
        channel: GptLiveAppendChannel,
        delegationId?: string,
      ) => Promise<GptLiveAppendResult>)
    | null = null;
  private activeRun = 0;
  private deliveryQueue = Promise.resolve();
  private deliveryAbortController = new AbortController();
  private boundOnSend: ChatInputSendHandler | null = null;
  private typedUserMessageSink: ((text: string) => void) | null = null;
  private pendingTypedUserMessages: string[] = [];
  private failureInProgress = false;
  private ownerMigration = Promise.resolve();
  private historyReplay = Promise.resolve();
  private bridgeCallScope = createBridgeCallScope();
  private bridgeReady: Promise<ActiveGptLiveBridge | null> =
    Promise.resolve(null);
  private resolveBridgeReady:
    | ((bridge: ActiveGptLiveBridge | null) => void)
    | null = null;

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
        if (this.snapshot.controlsRevision > 0) {
          const controlsStatus = await rebindOpenAiRealtimeVoiceControls(
            previousSessionId,
            sessionId,
            this.snapshot.controlsRevision,
          );
          if (this.snapshot.boundSessionId === sessionId) {
            this.setSnapshot({
              ...this.snapshot,
              controlsRevision: controlsStatus.revision,
              ownerWindowLabel: controlsStatus.ownerWindowLabel,
            });
          }
        }
        await appendSessionSystemPrompt(
          previousSessionId,
          BACKEND_PROMPT_KEY,
          "",
        ).catch(() => undefined);
        await appendSessionSystemPrompt(
          sessionId,
          BACKEND_PROMPT_KEY,
          await createOpenAiRealtimeBackendInstructions(
            sessionId,
            this.bridgeCallScope.initialCursor,
            this.bridgeCallScope.id,
          ),
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
    this.resetDeliveryQueue();
    this.bridgeReady = new Promise((resolve) => {
      this.resolveBridgeReady = resolve;
    });
    this.bridgeCallScope = createBridgeCallScope();
    this.failureInProgress = false;
    this.realtimeProtocolQueue = Promise.resolve();
    this.realtimeRuntimeSendQueue = Promise.resolve();
    this.realtimeSettingsRevision = 1;
    this.realtimeSettingsQueue = Promise.resolve();
    this.boundOnSend = onSend;
    this.pendingTypedUserMessages = [];
    this.setSnapshot({
      state: "starting",
      boundSessionId: sessionId,
      requestedStartSessionId: null,
      microphoneMuted: false,
      error: null,
      controlsRevision: 0,
      ownerWindowLabel: null,
    });
    const isStale = () => this.activeRun !== runId;
    try {
      this.releaseControlsListener = await listenToOpenAiRealtimeVoiceControls(
        (control) => {
          if (
            control.sessionId !== this.snapshot.boundSessionId ||
            control.revision !== this.snapshot.controlsRevision
          )
            return;
          if (control.action === "stop") {
            void this.stop(control.sessionId);
          } else if (control.action === "mute" && control.muted !== undefined) {
            this.setMicrophoneMuted(control.sessionId, control.muted);
          }
        },
      );
      if (isStale()) {
        this.releaseControlsListener();
        this.releaseControlsListener = null;
        return;
      }
      this.registerBridge(sessionId);
      await waitForGptLiveBridgeReady();
      if (isStale()) return;
      const preference = getRealtimeVoicePreference();
      const pendingDraft =
        useChatSessionStore.getState().getSession(sessionId)?.creationState ===
        "pending";
      if (!pendingDraft) {
        await createOpenAiRealtimeBackendInstructions(
          sessionId,
          this.bridgeCallScope.initialCursor,
          this.bridgeCallScope.id,
        ).then((instructions) =>
          appendSessionSystemPrompt(
            sessionId,
            BACKEND_PROMPT_KEY,
            instructions,
          ),
        );
      }
      if (isStale()) return;

      const transport = {
        send: (data: string) => {
          const event = JSON.parse(data) as Record<string, unknown>;
          const sent = this.realtimeRuntimeSendQueue.then(() =>
            sendOpenAiRealtimeGptLiveRuntimeEvent(sessionId, event),
          );
          this.realtimeRuntimeSendQueue = sent.catch(() => undefined);
          void sent.catch((error) =>
            this.fail(this.snapshot.boundSessionId ?? sessionId, error),
          );
        },
      };
      let markRuntimeReady: (() => void) | null = null;
      const runtimeReady = new Promise<void>((resolve) => {
        markRuntimeReady = resolve;
      });
      const enqueueProtocolOperation = <T>(
        operation: () => Promise<T>,
      ): Promise<T> => {
        const result = this.realtimeProtocolQueue.then(operation);
        this.realtimeProtocolQueue = result.then(
          () => undefined,
          async (error) => {
            await this.fail(this.snapshot.boundSessionId ?? sessionId, error);
          },
        );
        return result;
      };
      const deliverBackendEvents = (
        ownerSessionId: string,
        delivery: {
          events: OpenAiRealtimeBackendDeliveryEvent[];
          displayText: string;
          handoffIds: string[];
        },
        queueUntilIdle = false,
        continueAfterStop = false,
      ) => {
        this.deliverToBackend(
          ownerSessionId,
          renderRealtimeBackendDelivery(delivery.events),
          delivery.displayText,
          undefined,
          true,
          undefined,
          queueUntilIdle,
          continueAfterStop,
        );
      };
      const transcriptMessageIds = new Map<string, string>();
      const upsertTranscriptMessage = (
        ownerSessionId: string,
        transcript: {
          itemId: string;
          speaker: "user" | "gptLive";
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
            : createGptLiveTranscriptMessage(
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
        void enqueueProtocolOperation(async () => {
          const events = await requestOpenAiRealtimeTypedUserMessage(
            sessionId,
            text,
          );
          sendRealtimeEvents(transport, events);
        });
      };
      this.releaseRuntimeListener = await listenToOpenAiRealtimeGptLiveRuntime(
        (runtimeEvent) => {
          try {
            if (runtimeEvent.sessionId !== sessionId) return;
            if (!this.snapshot.boundSessionId || isStale()) return;
            const event: unknown = runtimeEvent.event;
            const eventType =
              event && typeof event === "object" && "type" in event
                ? String(event.type)
                : "";
            if (eventType === "berd.realtime.ready") {
              markRuntimeReady?.();
              return;
            }
            if (eventType === "berd.realtime.failed") {
              const message =
                event && typeof event === "object" && "message" in event
                  ? String(event.message)
                  : "OpenAI GPT Live runtime failed.";
              void this.fail(
                this.snapshot.boundSessionId ?? sessionId,
                message,
              );
              return;
            }
            if (
              eventType === "input_audio_buffer.speech_started" ||
              (eventType === "berd.realtime.user_speaking" &&
                "active" in (event as object) &&
                Boolean((event as { active?: unknown }).active))
            ) {
              this.publishActivity("user-speaking");
            } else if (
              eventType === "input_audio_buffer.speech_stopped" ||
              (eventType === "berd.realtime.user_speaking" &&
                "active" in (event as object) &&
                !(event as { active?: unknown }).active)
            ) {
              this.publishActivity("user-idle");
            } else if (eventType === "output_audio_buffer.started") {
              this.publishActivity("assistant-speaking");
            } else if (
              eventType === "output_audio_buffer.stopped" ||
              eventType === "output_audio_buffer.cleared"
            ) {
              this.publishActivity("assistant-idle");
            }
            void enqueueProtocolOperation(async () => {
              const reduction = await reduceOpenAiRealtimeGptLiveEvent(
                sessionId,
                event,
              );
              const ownerSessionId = this.snapshot.boundSessionId;
              if (!ownerSessionId || isStale()) return;
              sendRealtimeEvents(transport, reduction.clientEvents);
              for (const bridgeEvent of reduction.protocolEvents) {
                if (bridgeEvent.type === "transcript.started") {
                  upsertTranscriptMessage(
                    ownerSessionId,
                    {
                      itemId: bridgeEvent.itemId,
                      speaker:
                        bridgeEvent.speaker === "gpt_live" ? "gptLive" : "user",
                      text: "",
                    },
                    true,
                  );
                } else if (bridgeEvent.type === "transcript.updated") {
                  upsertTranscriptMessage(
                    ownerSessionId,
                    {
                      ...bridgeEvent,
                      speaker:
                        bridgeEvent.speaker === "gpt_live" ? "gptLive" : "user",
                    },
                    true,
                  );
                } else if (bridgeEvent.type === "transcript.settled") {
                  upsertTranscriptMessage(
                    ownerSessionId,
                    {
                      ...bridgeEvent,
                      speaker:
                        bridgeEvent.speaker === "gpt_live" ? "gptLive" : "user",
                    },
                    false,
                  );
                } else if (bridgeEvent.type === "transcript.finalized") {
                  if (bridgeEvent.speaker === "gpt_live") {
                    trackVoiceAssistantResponse();
                  } else {
                    trackVoiceUserUtterance();
                  }
                  upsertTranscriptMessage(
                    ownerSessionId,
                    {
                      ...bridgeEvent,
                      speaker:
                        bridgeEvent.speaker === "gpt_live" ? "gptLive" : "user",
                      interrupted: bridgeEvent.interrupted || undefined,
                    },
                    false,
                  );
                }
              }
              for (const handoff of reduction.acceptedHandoffs) {
                useChatStore
                  .getState()
                  .addMessage(
                    ownerSessionId,
                    createHandoffDebugMessage(
                      handoff.handoffId,
                      handoff.message,
                    ),
                  );
              }
              if (reduction.backendDelivery) {
                deliverBackendEvents(ownerSessionId, reduction.backendDelivery);
              }
            });
          } catch (error) {
            void this.fail(this.snapshot.boundSessionId ?? sessionId, error);
          }
        },
      );

      const runtimeOptions = {
        voice: preference.voice,
      };
      this.realtimeRuntimeSessionId = sessionId;
      try {
        await startOpenAiRealtimeGptLiveRuntime(
          sessionId,
          this.bridgeCallScope.initialCursor,
          this.bridgeCallScope.id,
          runtimeOptions,
        );
      } catch (error) {
        if (this.realtimeRuntimeSessionId === sessionId) {
          this.realtimeRuntimeSessionId = null;
        }
        throw error;
      }
      await Promise.race([
        runtimeReady,
        new Promise<never>((_, reject) => {
          window.setTimeout(
            () =>
              reject(
                new Error("OpenAI GPT Live runtime did not become ready."),
              ),
            35_000,
          );
        }),
      ]);
      if (isStale()) return;
      const controlsStatus = await startOpenAiRealtimeVoiceControls(sessionId);
      if (isStale()) {
        this.releaseControlsListener();
        this.releaseControlsListener = null;
        await stopOpenAiRealtimeVoiceControls(
          controlsStatus.sessionId ?? sessionId,
          controlsStatus.revision,
        ).catch(() => undefined);
        return;
      }
      this.setSnapshot({
        ...this.snapshot,
        controlsRevision: controlsStatus.revision,
        ownerWindowLabel: controlsStatus.ownerWindowLabel,
      });
      await claimVoiceDictationMicrophone(MICROPHONE_OWNER_ID).catch(
        (error) => {
          if (!isUnavailableDevMicrophoneClaim(error)) throw error;
        },
      );
      let appliedVoice = preference.voice;
      this.releaseVoicePreferenceListener = subscribeToRealtimeVoicePreference(
        (next) => {
          if (isStale() || next.voice === appliedVoice) return;
          const requestedVoice = next.voice;
          const update = this.realtimeSettingsQueue.then(async () => {
            if (isStale()) return;
            const snapshot = await updateOpenAiRealtimeGptLiveSettings(
              sessionId,
              this.realtimeSettingsRevision,
              requestedVoice,
              1,
            );
            if (isStale()) return;
            this.realtimeSettingsRevision = snapshot.revision;
            appliedVoice = snapshot.voice;
          });
          this.realtimeSettingsQueue = update.catch((error) => {
            if (!isStale()) {
              toast.error("Could not update GPT Live voice", {
                description: errorText(error),
              });
            }
          });
        },
      );
      const nativeMicrophone = await startNativeMicrophone(
        "push_openai_realtime_gpt_live_audio",
      );
      if (isStale()) {
        nativeMicrophone.stop();
        return;
      }
      this.nativeMicrophone = nativeMicrophone;
      this.nativeMicrophone.setMuted(this.snapshot.microphoneMuted);
      this.typedUserMessageSink = forwardTypedUserMessage;
      for (const text of this.pendingTypedUserMessages.splice(0)) {
        forwardTypedUserMessage(text);
      }
      const replaySessionId = this.snapshot.boundSessionId ?? sessionId;
      this.historyReplay = waitForSessionHydration(replaySessionId).then(
        async () => {
          if (isStale() || this.snapshot.boundSessionId !== replaySessionId)
            return;
          const events = await createOpenAiRealtimeTranscriptSeed(
            collectRealtimeTranscriptSeedTurns(
              useChatStore.getState().messagesBySession[replaySessionId] ?? [],
            ),
            MAX_REALTIME_REPLAY_ITEMS,
            replaySessionId,
          );
          sendRealtimeEvents(transport, events);
        },
      );
      this.bridgeAppender = async (message, cursor, channel, delegationId) => {
        const result = await enqueueProtocolOperation(() =>
          appendOpenAiRealtimeBackendResult(
            sessionId,
            cursor,
            message,
            channel,
            delegationId,
          ),
        );
        if (!result.accepted) return result;
        useChatStore
          .getState()
          .addMessage(
            this.snapshot.boundSessionId ?? sessionId,
            createCoordinationDebugMessage(
              channel === "commentary"
                ? "backendToGptLiveCommentary"
                : "backendToGptLiveThinking",
              `Backend → GPT Live · ${channel}`,
              message,
            ),
          );
        return result;
      };
      const bridgeSessionId = this.snapshot.boundSessionId ?? sessionId;
      if (!this.bridgeAppender) {
        throw new Error("The GPT Live bridge did not initialize.");
      }
      this.resolveBridgeReady?.({
        sessionId: bridgeSessionId,
        append: this.bridgeAppender,
      });
      this.resolveBridgeReady = null;
      trackVoiceConversationStarted({
        inputBackend: "openai",
        outputBackend: "openai",
        voiceMode: "openai-realtime",
        ttsRate: 1,
      });
      this.setSnapshot({
        ...this.snapshot,
        state: "listening",
      });
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
    // Invalidate an in-flight start before the first awaited shutdown step so
    // late microphone acquisition cannot install capture after stop begins.
    // A running session stays valid long enough to drain its final events.
    if (this.snapshot.state === "starting") this.activeRun += 1;
    requestVoiceConversationEnd("user");
    this.setSnapshot({ ...this.snapshot, state: "stopping" });
    this.nativeMicrophone?.stop();
    this.nativeMicrophone = null;
    const realtimeRuntimeSessionId = this.realtimeRuntimeSessionId;
    this.realtimeRuntimeSessionId = null;
    if (realtimeRuntimeSessionId) {
      await stopOpenAiRealtimeGptLiveRuntime(realtimeRuntimeSessionId).catch(
        () => undefined,
      );
    }
    await this.realtimeProtocolQueue.catch(() => undefined);
    await this.realtimeRuntimeSendQueue.catch(() => undefined);
    await releaseOpenAiRealtimeGptLiveRuntime(
      realtimeRuntimeSessionId ?? sessionId,
    ).catch(() => undefined);
    await this.cleanupResources(sessionId);
    this.boundOnSend = null;
    this.failureInProgress = false;
    trackVoiceConversationEnded("user");
    this.setSnapshot(OFF_SNAPSHOT);
  }

  toggleMute(sessionId: string): void {
    if (this.snapshot.boundSessionId !== sessionId) return;
    this.setMicrophoneMuted(sessionId, !this.snapshot.microphoneMuted);
  }

  private setMicrophoneMuted(
    sessionId: string,
    microphoneMuted: boolean,
  ): void {
    if (this.snapshot.boundSessionId !== sessionId) return;
    this.nativeMicrophone?.setMuted(microphoneMuted);
    this.setSnapshot({ ...this.snapshot, microphoneMuted });
    if (this.snapshot.controlsRevision > 0) {
      void publishOpenAiRealtimeVoiceMicrophoneMuted(
        sessionId,
        this.snapshot.controlsRevision,
        microphoneMuted,
      ).catch(() => undefined);
    }
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
      // channel failure abort the user's Backend turn.
      void this.fail(sessionId, error);
    }
  }

  async dispose(): Promise<void> {
    const sessionId = this.snapshot.boundSessionId;
    await this.realtimeProtocolQueue.catch(() => undefined);
    if (sessionId) await this.cleanupResources(sessionId);
    this.boundOnSend = null;
    this.bridgeAppender = null;
    this.typedUserMessageSink = null;
    this.pendingTypedUserMessages = [];
    this.failureInProgress = false;
    this.resetDeliveryQueue();
    this.historyReplay = Promise.resolve();
    trackVoiceConversationEnded("clean-shutdown");
    this.setSnapshot(OFF_SNAPSHOT);
  }

  private deliverToBackend(
    sessionId: string,
    text: string,
    displayText: string,
    onDelivered?: () => void,
    hidden = false,
    userMessageId?: string,
    queueUntilIdle = false,
    continueAfterStop = false,
  ): void {
    const signal = continueAfterStop
      ? undefined
      : this.deliveryAbortController.signal;
    const onSend = this.boundOnSend;
    this.deliveryQueue = this.deliveryQueue
      .catch(() => undefined)
      .then(async () => {
        signal?.throwIfAborted();
        // History replay replaces the transcript wholesale. Dispatching a
        // realtime transcript while hydration is still active can therefore
        // route the Backend's live ACP stream into the replay buffer, or let a
        // subsequent replay replacement erase it. Preserve ordering in the
        // delivery queue and wait for hydration to publish before sending.
        await this.ownerMigration;
        await this.historyReplay;
        signal?.throwIfAborted();
        if (!continueAfterStop) {
          sessionId = this.snapshot.boundSessionId ?? sessionId;
        }
        await waitForSessionHydration(sessionId, signal);
        if (queueUntilIdle) await waitForBackendIdle(sessionId, signal);
        if (
          !onSend ||
          (!continueAfterStop && this.snapshot.boundSessionId !== sessionId)
        )
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
          },
          ...(userMessageId ? { userMessageId } : {}),
        };
        const sendAsPrompt = async () => {
          const accepted = await onSend(
            text,
            undefined,
            undefined,
            sendOptions,
          );
          if (accepted === false)
            throw new Error(
              "The Backend session did not accept the voice transcript.",
            );
        };
        if (!continueAfterStop) {
          this.setSnapshot({ ...this.snapshot, state: "agent-working" });
        }
        for (;;) {
          const opportunity = await waitForBackendDeliveryOpportunity(
            sessionId,
            signal,
          );
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
            await waitForBackendRunBoundary(sessionId, rejectedRunId, signal);
          }
        }
        onDelivered?.();
        if (this.snapshot.boundSessionId === sessionId)
          this.setSnapshot({ ...this.snapshot, state: "listening" });
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        if (continueAfterStop) {
          console.warn(
            "Could not deliver the final GPT Live transcript",
            error,
          );
          return;
        }
        return this.fail(sessionId, error);
      });
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
    trackVoiceConversationEnded("error");
    this.setSnapshot({
      state: "error",
      boundSessionId: sessionId,
      requestedStartSessionId: null,
      microphoneMuted: false,
      error: message,
      controlsRevision: 0,
      ownerWindowLabel: null,
    });
    useChatStore
      .getState()
      .addMessage(sessionId, createSystemNotificationMessage(message, "error"));
    toast.error("OpenAI GPT Live voice failed", { description: message });
  }

  private async cleanupResources(sessionId: string): Promise<void> {
    this.activeRun += 1;
    this.resetDeliveryQueue();
    this.resolveBridgeReady?.(null);
    this.resolveBridgeReady = null;
    await this.ownerMigration.catch(() => undefined);
    const activeSessionId = this.snapshot.boundSessionId ?? sessionId;
    const controlsRevision = this.snapshot.controlsRevision;
    this.releaseBridge?.();
    this.nativeMicrophone?.stop();
    this.releaseRuntimeListener?.();
    this.releaseVoicePreferenceListener?.();
    const realtimeRuntimeSessionId = this.realtimeRuntimeSessionId;
    this.realtimeRuntimeSessionId = null;
    this.releaseControlsListener?.();
    this.releaseControlsListener = null;
    this.releaseBridge = null;
    this.bridgeAppender = null;
    this.typedUserMessageSink = null;
    this.pendingTypedUserMessages = [];
    this.nativeMicrophone = null;
    this.releaseRuntimeListener = null;
    this.releaseVoicePreferenceListener = null;
    this.realtimeSettingsQueue = Promise.resolve();
    if (controlsRevision > 0) {
      await stopOpenAiRealtimeVoiceControls(
        activeSessionId,
        controlsRevision,
      ).catch(() => undefined);
    }
    if (realtimeRuntimeSessionId) {
      await stopOpenAiRealtimeGptLiveRuntime(realtimeRuntimeSessionId).catch(
        () => undefined,
      );
    }
    await releaseOpenAiRealtimeGptLiveRuntime(
      realtimeRuntimeSessionId ?? sessionId,
    ).catch(() => undefined);
    await releaseVoiceDictationMicrophone(MICROPHONE_OWNER_ID).catch(
      () => undefined,
    );
    await appendSessionSystemPrompt(
      activeSessionId,
      BACKEND_PROMPT_KEY,
      "",
    ).catch(() => undefined);
  }

  private resetDeliveryQueue(): void {
    this.deliveryAbortController.abort();
    this.deliveryAbortController = new AbortController();
    this.deliveryQueue = Promise.resolve();
  }

  private setSnapshot(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private publishActivity(
    activity:
      | "user-speaking"
      | "user-idle"
      | "assistant-speaking"
      | "assistant-idle",
  ): void {
    const { boundSessionId, controlsRevision } = this.snapshot;
    if (!boundSessionId || controlsRevision === 0) return;
    void publishOpenAiRealtimeVoiceActivity(
      boundSessionId,
      controlsRevision,
      activity,
    ).catch(() => undefined);
  }

  private registerBridge(sessionId: string): void {
    const bridgeReady = this.bridgeReady;
    this.releaseBridge?.();
    this.releaseBridge = registerGptLiveBridge({
      sessionId,
      async append(message, cursor, channel, delegationId) {
        const bridge = await bridgeReady;
        if (!bridge) throw new Error("The GPT Live conversation stopped.");
        return bridge.append(message, cursor, channel, delegationId);
      },
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

export async function stopOpenAiRealtimeConversationForSession(
  sessionId: string,
): Promise<void> {
  if (runtime.getSnapshot().boundSessionId === sessionId) {
    await runtime.stop(sessionId);
  }
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
    if (!enabled && ownsActiveConversation) void runtime.stop(sessionId);
  }, [enabled, ownsActiveConversation, sessionId]);
  useEffect(() => {
    if (
      !window.__TAURI_INTERNALS__ ||
      !snapshot.boundSessionId ||
      !snapshot.ownerWindowLabel ||
      snapshot.controlsRevision === 0
    )
      return;
    let disposed = false;
    let stopObserver: (() => void) | undefined;
    const lease = beginVoiceControlsVisibilityLease();
    const activeSessionId = snapshot.boundSessionId;
    const ownerWindowLabel = snapshot.ownerWindowLabel;
    const revision = snapshot.controlsRevision;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const stop = await observeVoiceConversationControlVisibility({
          activeSessionId,
          currentSessionId: sessionId,
          ownerWindowLabel,
          currentWindow: getCurrentWindow(),
          report: (suppressed) =>
            lease.run(() =>
              setOpenAiRealtimeVoiceControlsSuppressed(
                activeSessionId,
                revision,
                suppressed,
              ),
            ),
          onError: (error) =>
            console.warn(
              "Could not synchronize GPT Live floating voice controls",
              error,
            ),
        });
        if (disposed) stop();
        else stopObserver = stop;
      })
      .catch((error) => {
        void lease
          .run(() =>
            setOpenAiRealtimeVoiceControlsSuppressed(
              activeSessionId,
              revision,
              false,
            ),
          )
          .catch(() => undefined);
        console.warn(
          "Could not observe the GPT Live voice owner window focus",
          error,
        );
      });
    return () => {
      disposed = true;
      if (stopObserver) {
        stopObserver();
        lease.invalidate();
      } else {
        void lease
          .release(() =>
            setOpenAiRealtimeVoiceControlsSuppressed(
              activeSessionId,
              revision,
              false,
            ),
          )
          .catch(() => undefined);
      }
    };
  }, [
    sessionId,
    snapshot.boundSessionId,
    snapshot.controlsRevision,
    snapshot.ownerWindowLabel,
  ]);
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
    disabled:
      !ownsActiveConversation &&
      (disabled || readOnly || anotherSessionOwnsConversation),
    onToggle: shouldStart ? start : stop,
    onMicrophoneMuteToggle: toggleMute,
    onTypedUserMessageCommitted: forwardTypedUserMessage,
  };
}
