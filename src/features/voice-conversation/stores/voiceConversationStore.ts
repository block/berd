import { create } from "zustand";

import {
  acknowledgeVoiceConversationTranscript,
  blockNativeVoiceConversationStarts,
  drainVoiceConversationTranscripts,
  getVoiceConversationStatus,
  listenToVoiceConversation,
  reconcileVoiceConversationMicrophone,
  rejectVoiceConversationTranscript,
  releaseNativeVoiceConversationStartBlock,
  setVoiceConversationMicrophoneMuted,
  startVoiceConversation,
  stopVoiceConversation,
  stopVoiceConversationForReplacement,
  type PendingVoiceTranscript,
  type VoiceConversationEvent,
  type VoiceConversationStatus,
} from "../api/voiceConversation";
import type { VoiceInputBackend } from "../lib/voiceInputPreference";
import { trackVoiceConversationStarted } from "../lib/voiceTelemetry";

export type VoiceConversationUiState =
  | "off"
  | "starting"
  | "stopping"
  | "listening"
  | "user-speaking"
  | "agent-working"
  | "agent-speaking"
  | "error";

export const VOICE_CONVERSATION_OFF_STATUS: VoiceConversationStatus = {
  available: false,
  unavailableReason: null,
  lifecycle: "stopped",
  sessionId: null,
  ownerWindowLabel: null,
  microphoneMuted: false,
  revision: 0,
};

interface VoiceConversationStore {
  status: VoiceConversationStatus;
  uiState: VoiceConversationUiState;
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  microphoneMuted: boolean;
  activityFallbackState: VoiceConversationUiState;
  error: string | null;
  hydrated: boolean;
  requestedStartSessionId: string | null;
  latestFinalizedTranscriptKey: string | null;
  init: () => Promise<void>;
  refreshStatus: () => Promise<VoiceConversationStatus>;
  requestStart: (sessionId: string) => void;
  clearRequestedStart: (sessionId: string) => void;
  start: (
    sessionId: string,
    inputBackend?: VoiceInputBackend,
    foregroundGeneration?: number,
  ) => Promise<VoiceConversationStatus>;
  stop: () => Promise<VoiceConversationStatus>;
  stopForReplacement: (
    status: VoiceConversationStatus,
    targetSessionId: string,
  ) => Promise<VoiceConversationStatus>;
  setMicrophoneMuted: (muted: boolean) => Promise<void>;
  setUiState: (state: VoiceConversationUiState, error?: string) => void;
  drainPendingTranscripts: (
    sessionId: string,
    transcriptAlreadyInChat?: (transcript: PendingVoiceTranscript) => boolean,
  ) => Promise<void>;
}

function finalizedTranscriptKey(event: PendingVoiceTranscript): string {
  return `${event.sessionId}\0${event.lifecycleId}\0${event.revision}\0${event.id}`;
}

let initialized = false;
let stopInFlight: Promise<VoiceConversationStatus> | null = null;
let microphoneMuteIntent = 0;
let microphoneMuteStateVersion = 0;
let pendingMicrophoneMuteRequests = 0;
const voiceStartBlocks = new Map<string, number>();
const voiceStartsInFlight = new Map<string, Promise<VoiceConversationStatus>>();
const eventSubscribers = new Set<
  (event: VoiceConversationEvent) => void | Promise<void>
>();
type TranscriptDeliveryOutcome = "accepted" | "deferred" | "rejected";
const transcriptDeliveries = new Map<
  string,
  Promise<TranscriptDeliveryOutcome>
>();
const deliveredTranscripts = new Set<string>();
const deliveredTranscriptOrder: string[] = [];
const MAX_DELIVERED_TRANSCRIPT_KEYS = 256;
const priorFinalizedTranscriptKeys = new Map<string, string | null>();

function observeFinalizedTranscript(transcript: PendingVoiceTranscript): void {
  const deliveryKey = transcriptKey(transcript);
  const key = finalizedTranscriptKey(transcript);
  if (!priorFinalizedTranscriptKeys.has(deliveryKey)) {
    priorFinalizedTranscriptKeys.set(
      deliveryKey,
      useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    );
  }
  useVoiceConversationStore.setState({ latestFinalizedTranscriptKey: key });
}

export function subscribeToVoiceConversationEvents(
  subscriber: (event: VoiceConversationEvent) => void | Promise<void>,
): () => void {
  eventSubscribers.add(subscriber);
  return () => eventSubscribers.delete(subscriber);
}

export class VoiceTranscriptDeferredError extends Error {}

export async function blockVoiceConversationStarts(
  sessionId: string,
): Promise<() => Promise<void>> {
  const nativeToken = await blockNativeVoiceConversationStarts(sessionId);
  voiceStartBlocks.set(sessionId, (voiceStartBlocks.get(sessionId) ?? 0) + 1);
  await voiceStartsInFlight.get(sessionId)?.catch(() => undefined);
  let released = false;
  let releaseStarted = false;
  const finishRelease = () => {
    released = true;
    const remaining = (voiceStartBlocks.get(sessionId) ?? 1) - 1;
    if (remaining === 0) voiceStartBlocks.delete(sessionId);
    else voiceStartBlocks.set(sessionId, remaining);
  };
  const retryRelease = () => {
    window.setTimeout(() => {
      void releaseNativeVoiceConversationStartBlock(sessionId, nativeToken)
        .then(finishRelease)
        .catch(retryRelease);
    }, 1_000);
  };
  return async () => {
    if (released || releaseStarted) return;
    releaseStarted = true;
    try {
      await releaseNativeVoiceConversationStartBlock(sessionId, nativeToken);
      finishRelease();
    } catch {
      retryRelease();
    }
  };
}

function transcriptKey(transcript: PendingVoiceTranscript): string {
  return `${transcript.lifecycleId}\u0000${transcript.revision}\u0000${transcript.sessionId}\u0000${transcript.id}`;
}

function rememberDeliveredTranscript(key: string) {
  if (deliveredTranscripts.has(key)) return;
  deliveredTranscripts.add(key);
  deliveredTranscriptOrder.push(key);
  if (deliveredTranscriptOrder.length > MAX_DELIVERED_TRANSCRIPT_KEYS) {
    const expired = deliveredTranscriptOrder.shift();
    if (expired) deliveredTranscripts.delete(expired);
  }
}

async function deliverTranscriptOnce(
  transcript: PendingVoiceTranscript,
): Promise<TranscriptDeliveryOutcome> {
  const key = transcriptKey(transcript);
  if (deliveredTranscripts.has(key)) {
    await acknowledgeVoiceConversationTranscript(transcript);
    priorFinalizedTranscriptKeys.delete(key);
    return "accepted";
  }

  const existing = transcriptDeliveries.get(key);
  if (existing) return existing;

  const event = { type: "user" as const, ...transcript };
  const finalizedKey = finalizedTranscriptKey(transcript);
  const subscribers = [...eventSubscribers];
  if (subscribers.length === 0) return "rejected";
  const delivery = (async () => {
    const results = await Promise.allSettled(
      subscribers.map((subscriber) => subscriber(event)),
    );
    const accepted = results.some((result) => result.status === "fulfilled");
    const deferred = results.some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof VoiceTranscriptDeferredError,
    );
    if (accepted) {
      rememberDeliveredTranscript(key);
      await acknowledgeVoiceConversationTranscript(transcript);
      priorFinalizedTranscriptKeys.delete(key);
    } else if (!deferred) {
      const rejection = await rejectVoiceConversationTranscript(transcript);
      if (rejection.terminal) {
        const priorKey = priorFinalizedTranscriptKeys.get(key) ?? null;
        priorFinalizedTranscriptKeys.delete(key);
        for (const [
          pendingKey,
          pendingPriorKey,
        ] of priorFinalizedTranscriptKeys) {
          if (pendingPriorKey === finalizedKey) {
            priorFinalizedTranscriptKeys.set(pendingKey, priorKey);
          }
        }
        useVoiceConversationStore.setState((state) =>
          state.latestFinalizedTranscriptKey === finalizedKey
            ? { latestFinalizedTranscriptKey: priorKey }
            : state,
        );
      }
    }
    return accepted ? "accepted" : deferred ? "deferred" : "rejected";
  })().finally(() => transcriptDeliveries.delete(key));

  transcriptDeliveries.set(key, delivery);
  return delivery;
}

function uiStateForStatus(
  status: VoiceConversationStatus,
): VoiceConversationUiState {
  switch (status.lifecycle) {
    case "starting":
      return "starting";
    case "stopping":
      return "stopping";
    case "running":
      return "listening";
    case "stopped":
    case "unavailable":
      return "off";
  }
}

function activityUiState(state: {
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  activityFallbackState: VoiceConversationUiState;
}): VoiceConversationUiState {
  if (state.userSpeaking) return "user-speaking";
  if (state.assistantSpeaking) return "agent-speaking";
  return state.activityFallbackState;
}

function shouldApplyEventRevision(
  current: VoiceConversationStatus,
  revision: number,
) {
  return revision >= current.revision;
}

function shouldApplyResponseRevision(
  current: VoiceConversationStatus,
  revision: number,
) {
  return revision > current.revision;
}

function isSameRunningLifecycle(
  current: VoiceConversationStatus,
  next: VoiceConversationStatus,
) {
  return (
    current.lifecycle === "running" &&
    next.lifecycle === "running" &&
    current.sessionId === next.sessionId &&
    current.revision === next.revision
  );
}

export const useVoiceConversationStore = create<VoiceConversationStore>(
  (set, get) => ({
    status: VOICE_CONVERSATION_OFF_STATUS,
    uiState: "off",
    userSpeaking: false,
    assistantSpeaking: false,
    microphoneMuted: false,
    activityFallbackState: "listening",
    error: null,
    hydrated: false,
    requestedStartSessionId: null,
    latestFinalizedTranscriptKey: null,

    requestStart: (sessionId) => set({ requestedStartSessionId: sessionId }),
    clearRequestedStart: (sessionId) =>
      set((state) =>
        state.requestedStartSessionId === sessionId
          ? { requestedStartSessionId: null }
          : state,
      ),

    init: async () => {
      if (initialized) {
        try {
          const muteStateVersion = microphoneMuteStateVersion;
          const muteRequestWasPending = pendingMicrophoneMuteRequests > 0;
          const status = await getVoiceConversationStatus();
          const currentStatus = get().status;
          const shouldPreserveCurrentMute = (
            observedStatus: VoiceConversationStatus,
          ) =>
            isSameRunningLifecycle(observedStatus, status) &&
            (muteRequestWasPending ||
              pendingMicrophoneMuteRequests > 0 ||
              muteStateVersion !== microphoneMuteStateVersion);
          const preserveCurrentMute = shouldPreserveCurrentMute(currentStatus);
          await reconcileVoiceConversationMicrophone(
            preserveCurrentMute
              ? { ...status, microphoneMuted: get().microphoneMuted }
              : status,
          );
          set((state) => {
            const microphoneMuted = shouldPreserveCurrentMute(state.status)
              ? state.microphoneMuted
              : status.microphoneMuted;
            if (
              shouldApplyResponseRevision(state.status, status.revision) ||
              (!state.hydrated &&
                state.status.revision === 0 &&
                state.uiState === "off")
            ) {
              return {
                status: { ...status, microphoneMuted },
                uiState:
                  state.uiState === "error"
                    ? state.uiState
                    : uiStateForStatus(status),
                microphoneMuted,
                hydrated: true,
              };
            }
            if (status.revision === state.status.revision) {
              return {
                status: {
                  ...state.status,
                  available: status.available,
                  unavailableReason: status.unavailableReason,
                  microphoneMuted,
                },
                microphoneMuted,
                hydrated: true,
              };
            }
            return { hydrated: true };
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : String(error),
            uiState: "error",
            hydrated: true,
          });
        }
        return;
      }

      // Reserve listener initialization before awaiting the native boundary so
      // concurrent controller mounts cannot register duplicate listeners.
      initialized = true;

      try {
        await listenToVoiceConversation((event) => {
          if (!shouldApplyEventRevision(get().status, event.revision)) return;

          if (event.type === "user") observeFinalizedTranscript(event);

          if (event.type === "microphoneMute") {
            microphoneMuteIntent += 1;
            microphoneMuteStateVersion += 1;
          } else if (event.type === "startup") {
            microphoneMuteIntent += 1;
          } else if (
            event.type === "cleanShutdown" ||
            event.type === "controlsDismissed" ||
            (event.type === "error" && event.terminal)
          ) {
            microphoneMuteIntent += 1;
            microphoneMuteStateVersion += 1;
          }

          if (
            event.type === "startup" ||
            event.type === "cleanShutdown" ||
            event.type === "controlsDismissed" ||
            (event.type === "error" && event.terminal)
          ) {
            priorFinalizedTranscriptKeys.clear();
          }

          set((state) => {
            switch (event.type) {
              case "startup":
                return {
                  ...state,
                  status: {
                    ...state.status,
                    lifecycle: "running",
                    sessionId: event.sessionId,
                    ownerWindowLabel: event.ownerWindowLabel,
                    microphoneMuted: false,
                    revision: event.revision,
                  },
                  uiState: "listening",
                  microphoneMuted: false,
                  latestFinalizedTranscriptKey: null,
                  error: null,
                };
              case "microphoneMute": {
                const nextState = {
                  ...state,
                  microphoneMuted: event.muted,
                  userSpeaking: event.muted ? false : state.userSpeaking,
                  status: {
                    ...state.status,
                    lifecycle: "running" as const,
                    sessionId: event.sessionId,
                    microphoneMuted: event.muted,
                    revision: event.revision,
                  },
                };
                return {
                  ...nextState,
                  uiState: activityUiState(nextState),
                };
              }
              case "user":
                return {
                  ...state,
                  status: {
                    ...state.status,
                    lifecycle: "running",
                    sessionId: event.sessionId,
                    revision: event.revision,
                  },
                  error: null,
                };
              case "activity": {
                const userSpeaking = state.microphoneMuted
                  ? false
                  : event.activity === "user-speaking"
                    ? true
                    : event.activity === "user-idle"
                      ? false
                      : state.userSpeaking;
                const assistantSpeaking =
                  event.activity === "assistant-speaking"
                    ? true
                    : event.activity === "assistant-idle"
                      ? false
                      : state.assistantSpeaking;
                const nextState = {
                  ...state,
                  userSpeaking,
                  assistantSpeaking,
                  status: {
                    ...state.status,
                    lifecycle: "running" as const,
                    sessionId: event.sessionId,
                    revision: event.revision,
                  },
                  error: null,
                };
                return {
                  ...nextState,
                  uiState: activityUiState(nextState),
                };
              }
              case "cleanShutdown":
              case "controlsDismissed": {
                const preservesTerminalError =
                  state.uiState === "error" &&
                  state.status.lifecycle === "stopped" &&
                  state.status.revision === event.revision &&
                  state.error !== null;
                return {
                  ...state,
                  status: {
                    ...state.status,
                    lifecycle: "stopped",
                    sessionId: null,
                    ownerWindowLabel: null,
                    microphoneMuted: false,
                    revision: event.revision,
                  },
                  uiState: preservesTerminalError ? "error" : "off",
                  userSpeaking: false,
                  assistantSpeaking: false,
                  microphoneMuted: false,
                  activityFallbackState: "listening",
                  latestFinalizedTranscriptKey: null,
                  error: preservesTerminalError ? state.error : null,
                };
              }
              case "error":
                return {
                  ...state,
                  status: event.terminal
                    ? {
                        ...state.status,
                        lifecycle: "stopped",
                        sessionId: null,
                        ownerWindowLabel: null,
                        microphoneMuted: false,
                        revision: event.revision,
                      }
                    : {
                        ...state.status,
                        sessionId: event.sessionId ?? state.status.sessionId,
                        revision: event.revision,
                      },
                  uiState: "error",
                  microphoneMuted: event.terminal
                    ? false
                    : state.microphoneMuted,
                  latestFinalizedTranscriptKey: event.terminal
                    ? null
                    : state.latestFinalizedTranscriptKey,
                  error: event.message,
                };
            }
          });

          if (
            event.type === "startup" ||
            event.type === "microphoneMute" ||
            event.type === "cleanShutdown" ||
            event.type === "controlsDismissed" ||
            (event.type === "error" && event.terminal)
          ) {
            void reconcileVoiceConversationMicrophone(get().status).catch(
              (error) => {
                const current = get();
                if (current.status.revision === event.revision) {
                  set({
                    uiState: "error",
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              },
            );
          }

          if (event.type === "user") {
            void deliverTranscriptOnce(event).catch((error) => {
              const current = get();
              if (
                current.status.lifecycle === "running" &&
                current.status.sessionId === event.sessionId &&
                current.status.revision === event.revision
              ) {
                set({
                  uiState: "error",
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            });
          } else {
            for (const subscriber of [...eventSubscribers])
              void subscriber(event);
          }
        });
      } catch (error) {
        initialized = false;
        set({
          error: error instanceof Error ? error.message : String(error),
          uiState: "error",
        });
      }

      try {
        const status = await getVoiceConversationStatus();
        set((state) =>
          shouldApplyResponseRevision(state.status, status.revision) ||
          (!state.hydrated &&
            state.status.revision === 0 &&
            state.uiState === "off")
            ? {
                status,
                uiState:
                  state.uiState === "error"
                    ? state.uiState
                    : uiStateForStatus(status),
                microphoneMuted: status.microphoneMuted,
                hydrated: true,
              }
            : { hydrated: true },
        );
        await reconcileVoiceConversationMicrophone(get().status);
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          uiState: "error",
          hydrated: true,
        });
      }
    },

    refreshStatus: async () => {
      const muteStateVersion = microphoneMuteStateVersion;
      const muteRequestWasPending = pendingMicrophoneMuteRequests > 0;
      const status = await getVoiceConversationStatus();
      const shouldPreserveCurrentMute = (
        observedStatus: VoiceConversationStatus,
      ) =>
        isSameRunningLifecycle(observedStatus, status) &&
        (muteRequestWasPending ||
          pendingMicrophoneMuteRequests > 0 ||
          muteStateVersion !== microphoneMuteStateVersion);
      const preserveCurrentMute = shouldPreserveCurrentMute(get().status);
      await reconcileVoiceConversationMicrophone(
        preserveCurrentMute
          ? { ...status, microphoneMuted: get().microphoneMuted }
          : status,
      );
      set((state) => {
        if (
          !shouldApplyResponseRevision(state.status, status.revision) &&
          status.revision !== state.status.revision
        ) {
          return state;
        }
        const microphoneMuted = shouldPreserveCurrentMute(state.status)
          ? state.microphoneMuted
          : status.microphoneMuted;
        return {
          status: { ...status, microphoneMuted },
          uiState: uiStateForStatus(status),
          microphoneMuted,
          hydrated: true,
          error: null,
        };
      });
      return status;
    },

    start: (sessionId, inputBackend = "parakeet", foregroundGeneration) => {
      if (voiceStartBlocks.has(sessionId)) {
        return Promise.reject(
          new Error("Voice cannot start while this chat is being archived."),
        );
      }
      microphoneMuteIntent += 1;
      microphoneMuteStateVersion += 1;
      set({ uiState: "starting", microphoneMuted: false, error: null });
      const request = (async () => {
        try {
          const status = await startVoiceConversation(
            sessionId,
            inputBackend,
            foregroundGeneration,
          );
          trackVoiceConversationStarted();
          set((state) =>
            shouldApplyResponseRevision(state.status, status.revision) ||
            (status.revision === state.status.revision &&
              status.lifecycle === "starting" &&
              state.status.lifecycle === "stopped")
              ? {
                  status,
                  uiState: uiStateForStatus(status),
                  microphoneMuted: status.microphoneMuted,
                  error: null,
                }
              : state,
          );
          await reconcileVoiceConversationMicrophone(get().status);
          return status;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          try {
            const muteStateVersion = microphoneMuteStateVersion;
            const muteRequestWasPending = pendingMicrophoneMuteRequests > 0;
            const status = await getVoiceConversationStatus();
            set((state) => {
              if (status.revision < state.status.revision) return state;
              if (status.sessionId !== null && status.sessionId !== sessionId) {
                if (
                  state.status.sessionId === status.sessionId &&
                  state.status.revision === status.revision &&
                  state.status.lifecycle === status.lifecycle
                ) {
                  const preserveCurrentMute =
                    isSameRunningLifecycle(state.status, status) &&
                    (muteRequestWasPending ||
                      pendingMicrophoneMuteRequests > 0 ||
                      muteStateVersion !== microphoneMuteStateVersion);
                  const microphoneMuted = preserveCurrentMute
                    ? state.microphoneMuted
                    : status.microphoneMuted;
                  const userSpeaking = microphoneMuted
                    ? false
                    : state.userSpeaking;
                  return {
                    status: { ...state.status, microphoneMuted },
                    microphoneMuted,
                    userSpeaking,
                    uiState:
                      microphoneMuted && state.uiState === "user-speaking"
                        ? activityUiState({ ...state, userSpeaking })
                        : state.uiState,
                  };
                }
                return {
                  status,
                  uiState: uiStateForStatus(status),
                  microphoneMuted: status.microphoneMuted,
                  error: null,
                };
              }
              return { status, uiState: "error", error: message };
            });
            await reconcileVoiceConversationMicrophone(get().status);
          } catch {
            set((state) =>
              state.status.sessionId !== null &&
              state.status.sessionId !== sessionId
                ? state
                : { uiState: "error", error: message },
            );
          }
          throw error;
        }
      })();
      voiceStartsInFlight.set(sessionId, request);
      void request.then(
        () => {
          if (voiceStartsInFlight.get(sessionId) === request)
            voiceStartsInFlight.delete(sessionId);
        },
        () => {
          if (voiceStartsInFlight.get(sessionId) === request)
            voiceStartsInFlight.delete(sessionId);
        },
      );
      return request;
    },

    stop: () => {
      if (stopInFlight) return stopInFlight;
      microphoneMuteIntent += 1;
      microphoneMuteStateVersion += 1;
      const activeStatus = get().status;
      set({
        uiState: "stopping",
        microphoneMuted: false,
        error: null,
        requestedStartSessionId: null,
      });
      const request = (async () => {
        try {
          const status = await stopVoiceConversation(activeStatus);
          set((state) =>
            shouldApplyResponseRevision(state.status, status.revision) ||
            (status.revision === state.status.revision &&
              (status.lifecycle === "stopped" ||
                status.lifecycle === "unavailable"))
              ? {
                  status,
                  uiState: uiStateForStatus(status),
                  error: null,
                }
              : state,
          );
          await reconcileVoiceConversationMicrophone(get().status);
          return status;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          try {
            const status = await getVoiceConversationStatus();
            set((state) =>
              status.revision >= state.status.revision
                ? { status, uiState: "error", error: message }
                : state,
            );
            await reconcileVoiceConversationMicrophone(get().status);
          } catch {
            set({ uiState: "error", error: message });
          }
          throw error;
        }
      })();
      stopInFlight = request;
      const clearStopRequest = () => {
        if (stopInFlight === request) stopInFlight = null;
      };
      void request.then(clearStopRequest, clearStopRequest);
      return request;
    },

    stopForReplacement: async (activeStatus, targetSessionId) => {
      microphoneMuteIntent += 1;
      microphoneMuteStateVersion += 1;
      set({
        uiState: "stopping",
        microphoneMuted: false,
        error: null,
        requestedStartSessionId: null,
      });
      try {
        const status = await stopVoiceConversationForReplacement(
          activeStatus,
          targetSessionId,
        );
        set((state) =>
          shouldApplyResponseRevision(state.status, status.revision) ||
          (status.revision === state.status.revision &&
            (status.lifecycle === "stopped" ||
              status.lifecycle === "unavailable"))
            ? {
                status,
                uiState: uiStateForStatus(status),
                microphoneMuted: status.microphoneMuted,
                error: null,
              }
            : state,
        );
        await reconcileVoiceConversationMicrophone(get().status);
        return status;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const muteStateVersion = microphoneMuteStateVersion;
          const muteRequestWasPending = pendingMicrophoneMuteRequests > 0;
          const status = await getVoiceConversationStatus();
          set((state) => {
            if (status.revision < state.status.revision) return state;
            const foreignWinner =
              status.sessionId !== null &&
              status.sessionId !== activeStatus.sessionId &&
              status.sessionId !== targetSessionId;
            if (foreignWinner) {
              if (
                state.status.sessionId === status.sessionId &&
                state.status.revision === status.revision &&
                state.status.lifecycle === status.lifecycle
              ) {
                const preserveCurrentMute =
                  isSameRunningLifecycle(state.status, status) &&
                  (muteRequestWasPending ||
                    pendingMicrophoneMuteRequests > 0 ||
                    muteStateVersion !== microphoneMuteStateVersion);
                const microphoneMuted = preserveCurrentMute
                  ? state.microphoneMuted
                  : status.microphoneMuted;
                const userSpeaking = microphoneMuted
                  ? false
                  : state.userSpeaking;
                return {
                  status: { ...state.status, microphoneMuted },
                  microphoneMuted,
                  userSpeaking,
                  uiState:
                    microphoneMuted && state.uiState === "user-speaking"
                      ? activityUiState({ ...state, userSpeaking })
                      : state.uiState,
                };
              }
              return {
                status,
                uiState: uiStateForStatus(status),
                microphoneMuted: status.microphoneMuted,
                error: null,
              };
            }
            return status.revision >= state.status.revision
              ? { status, uiState: "error", error: message }
              : state;
          });
          await reconcileVoiceConversationMicrophone(get().status);
        } catch {
          set((state) =>
            state.status.sessionId !== null &&
            state.status.sessionId !== activeStatus.sessionId &&
            state.status.sessionId !== targetSessionId
              ? state
              : { uiState: "error", error: message },
          );
        }
        throw error;
      }
    },

    setUiState: (uiState, error) =>
      set((state) => {
        const activityFallbackState = [
          "listening",
          "agent-working",
          "error",
        ].includes(uiState)
          ? uiState
          : state.activityFallbackState;
        const nextState = {
          ...state,
          activityFallbackState,
        };
        return {
          activityFallbackState,
          uiState:
            uiState === "user-speaking" || uiState === "agent-speaking"
              ? uiState
              : activityUiState(nextState),
          error:
            uiState === "error"
              ? error?.trim() || state.error || "Voice conversation failed."
              : state.error,
        };
      }),

    setMicrophoneMuted: async (microphoneMuted) => {
      const current = get();
      if (current.status.lifecycle !== "running") return;
      const intent = ++microphoneMuteIntent;
      microphoneMuteStateVersion += 1;
      pendingMicrophoneMuteRequests += 1;
      set((state) => {
        const nextState = {
          ...state,
          microphoneMuted,
          userSpeaking: microphoneMuted ? false : state.userSpeaking,
        };
        return {
          microphoneMuted,
          userSpeaking: nextState.userSpeaking,
          uiState: activityUiState(nextState),
        };
      });
      let status: VoiceConversationStatus;
      try {
        status = await setVoiceConversationMicrophoneMuted(
          microphoneMuted,
          current.status,
        );
      } catch (error) {
        if (intent === microphoneMuteIntent) {
          set({
            microphoneMuted: current.microphoneMuted,
            uiState: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      } finally {
        pendingMicrophoneMuteRequests -= 1;
      }
      if (intent !== microphoneMuteIntent) return;
      set((state) => {
        if (status.revision < state.status.revision) {
          return state;
        }
        const nextState = {
          ...state,
          status,
          microphoneMuted: status.microphoneMuted,
          userSpeaking: status.microphoneMuted ? false : state.userSpeaking,
        };
        return {
          status,
          microphoneMuted: status.microphoneMuted,
          userSpeaking: nextState.userSpeaking,
          uiState: activityUiState(nextState),
        };
      });
    },

    drainPendingTranscripts: async (sessionId, transcriptAlreadyInChat) => {
      const pendingTranscripts =
        await drainVoiceConversationTranscripts(sessionId);
      if (pendingTranscripts.length > 0) {
        console.info("[native-voice] Recovering retained transcripts", {
          count: pendingTranscripts.length,
        });
      }
      for (const transcript of pendingTranscripts) {
        const key = finalizedTranscriptKey(transcript);
        const current =
          useVoiceConversationStore.getState().latestFinalizedTranscriptKey;
        const alreadyDelivered =
          deliveredTranscripts.has(transcriptKey(transcript)) ||
          transcriptAlreadyInChat?.(transcript) === true;
        if (!alreadyDelivered || current === null || current === key) {
          observeFinalizedTranscript(transcript);
        }
        const outcome = await deliverTranscriptOnce(transcript);
        if (outcome === "deferred") return;
        if (outcome === "rejected") {
          throw new Error("Voice transcript delivery was rejected.");
        }
      }
    },
  }),
);
