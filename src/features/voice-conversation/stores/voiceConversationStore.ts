import { create } from "zustand";

import {
  applyVoiceConversationMicrophoneMuteEvent,
  acknowledgeVoiceConversationTranscript,
  drainVoiceConversationTranscripts,
  getVoiceConversationStatus,
  listenToVoiceConversation,
  reconcileVoiceConversationMicrophone,
  rejectVoiceConversationTranscript,
  setVoiceConversationMicrophoneMuted,
  startVoiceConversation,
  stopVoiceConversation,
  type PendingVoiceTranscript,
  type VoiceConversationEvent,
  type VoiceConversationStatus,
} from "../api/voiceConversation";

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
  init: () => Promise<void>;
  requestStart: (sessionId: string) => void;
  clearRequestedStart: (sessionId: string) => void;
  start: (sessionId: string) => Promise<VoiceConversationStatus>;
  stop: () => Promise<VoiceConversationStatus>;
  setMicrophoneMuted: (muted: boolean) => Promise<void>;
  setUiState: (state: VoiceConversationUiState, error?: string) => void;
  drainPendingTranscripts: (sessionId: string) => Promise<void>;
}

let initialized = false;
let stopInFlight: Promise<VoiceConversationStatus> | null = null;
const eventSubscribers = new Set<
  (event: VoiceConversationEvent) => void | Promise<void>
>();
const transcriptDeliveries = new Map<string, Promise<boolean>>();
const deliveredTranscripts = new Set<string>();
const deliveredTranscriptOrder: string[] = [];
const MAX_DELIVERED_TRANSCRIPT_KEYS = 256;

export function subscribeToVoiceConversationEvents(
  subscriber: (event: VoiceConversationEvent) => void | Promise<void>,
): () => void {
  eventSubscribers.add(subscriber);
  return () => eventSubscribers.delete(subscriber);
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
): Promise<boolean> {
  const key = transcriptKey(transcript);
  if (deliveredTranscripts.has(key)) {
    await acknowledgeVoiceConversationTranscript(transcript);
    return true;
  }

  const existing = transcriptDeliveries.get(key);
  if (existing) return existing;

  const event = { type: "user" as const, ...transcript };
  const subscribers = [...eventSubscribers];
  if (subscribers.length === 0) return false;
  const delivery = (async () => {
    const results = await Promise.allSettled(
      subscribers.map((subscriber) => subscriber(event)),
    );
    const accepted = results.some((result) => result.status === "fulfilled");
    if (accepted) {
      rememberDeliveredTranscript(key);
      await acknowledgeVoiceConversationTranscript(transcript);
    } else {
      await rejectVoiceConversationTranscript(transcript);
    }
    return accepted;
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
          const status = await getVoiceConversationStatus();
          await reconcileVoiceConversationMicrophone(status);
          set((state) => {
            if (
              shouldApplyResponseRevision(state.status, status.revision) ||
              (!state.hydrated &&
                state.status.revision === 0 &&
                state.uiState === "off")
            ) {
              return {
                status,
                uiState:
                  state.uiState === "error"
                    ? state.uiState
                    : uiStateForStatus(status),
                hydrated: true,
              };
            }
            if (status.revision === state.status.revision) {
              return {
                status: {
                  ...state.status,
                  available: status.available,
                  unavailableReason: status.unavailableReason,
                },
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

          if (event.type === "inputMute") {
            applyVoiceConversationMicrophoneMuteEvent(event.muted);
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
                    revision: event.revision,
                    nativeMicrophoneMuteControl:
                      event.nativeMicrophoneMuteControl,
                  },
                  uiState: "listening",
                  microphoneMuted: false,
                  error: null,
                };
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
              case "inputMute": {
                const nextState = {
                  ...state,
                  microphoneMuted: event.muted,
                  userSpeaking: event.muted ? false : state.userSpeaking,
                };
                return {
                  microphoneMuted: event.muted,
                  userSpeaking: nextState.userSpeaking,
                  uiState: activityUiState(nextState),
                };
              }
              case "cleanShutdown":
                return {
                  ...state,
                  status: {
                    ...state.status,
                    lifecycle: "stopped",
                    sessionId: null,
                    ownerWindowLabel: null,
                    revision: event.revision,
                    nativeMicrophoneMuteControl: false,
                  },
                  uiState: "off",
                  userSpeaking: false,
                  assistantSpeaking: false,
                  microphoneMuted: false,
                  activityFallbackState: "listening",
                  error: null,
                };
              case "error":
                return {
                  ...state,
                  status: event.terminal
                    ? {
                        ...state.status,
                        lifecycle: "stopped",
                        sessionId: null,
                        ownerWindowLabel: null,
                        revision: event.revision,
                        nativeMicrophoneMuteControl: false,
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
                  error: event.message,
                };
            }
          });

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
        await reconcileVoiceConversationMicrophone(status);
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
                hydrated: true,
              }
            : { hydrated: true },
        );
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          uiState: "error",
          hydrated: true,
        });
      }
    },

    start: async (sessionId) => {
      set({ uiState: "starting", microphoneMuted: false, error: null });
      try {
        const status = await startVoiceConversation(sessionId);
        set((state) =>
          shouldApplyResponseRevision(state.status, status.revision) ||
          (status.revision === state.status.revision &&
            status.lifecycle === "starting" &&
            state.status.lifecycle === "stopped")
            ? {
                status,
                uiState: uiStateForStatus(status),
                error: null,
              }
            : state,
        );
        return status;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const status = await getVoiceConversationStatus();
          set((state) =>
            status.revision >= state.status.revision
              ? { status, uiState: "error", error: message }
              : state,
          );
        } catch {
          set({ uiState: "error", error: message });
        }
        throw error;
      }
    },

    stop: () => {
      if (stopInFlight) return stopInFlight;
      set({
        uiState: "stopping",
        microphoneMuted: false,
        error: null,
        requestedStartSessionId: null,
      });
      const request = (async () => {
        try {
          const status = await stopVoiceConversation();
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
      try {
        await setVoiceConversationMicrophoneMuted(
          microphoneMuted,
          current.status,
        );
      } catch (error) {
        set({
          uiState: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      set((state) => {
        if (
          state.status.lifecycle !== "running" ||
          state.status.sessionId !== current.status.sessionId
        ) {
          return state;
        }
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
    },

    drainPendingTranscripts: async (sessionId) => {
      const pendingTranscripts =
        await drainVoiceConversationTranscripts(sessionId);
      if (pendingTranscripts.length > 0) {
        console.info("[native-voice] Recovering retained transcripts", {
          count: pendingTranscripts.length,
        });
      }
      for (const transcript of pendingTranscripts) {
        if (!(await deliverTranscriptOnce(transcript))) {
          throw new Error("Voice transcript delivery was rejected.");
        }
      }
    },
  }),
);
