import { GripVertical, Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  getVoiceConversationStatus,
  listenToVoiceConversation,
  openVoiceConversationSession,
  setVoiceConversationMicrophoneMuted,
  showVoiceConversationControls,
  stopVoiceConversationFromBuddy,
  type VoiceConversationEvent,
  type VoiceConversationStatus,
} from "@/features/voice-conversation/api/voiceConversation";
import {
  getOpenAiRealtimeVoiceControlsStatus,
  requestOpenAiRealtimeVoiceControl,
  showOpenAiRealtimeVoiceControls,
} from "@/shared/api/openaiRealtime";
import { Button } from "@/shared/ui/button";
import { VoiceConversationButton } from "@/shared/ui/voice-conversation-button";
import { BerdIcon } from "@/shared/ui/icons/BerdIcon";

type VoiceControlsError =
  | "conversation"
  | "initialize"
  | "mute"
  | "open"
  | "show"
  | "stop";

export function VoiceBuddyApp() {
  const realtime =
    new URLSearchParams(window.location.search).get("voiceMode") === "realtime";
  const { t } = useTranslation("chat");
  const [status, setStatus] = useState<VoiceConversationStatus | null>(null);
  const [busyAction, setBusyAction] = useState<"open" | "mute" | "stop" | null>(
    null,
  );
  const [error, setError] = useState<VoiceControlsError | null>(null);
  const [activity, setActivity] = useState({
    userSpeaking: false,
    assistantSpeaking: false,
    sessionId: null as string | null,
    revision: 0,
  });
  const [initialized, setInitialized] = useState(false);
  const microphoneMuteGeneration = useRef(0);
  const statusRef = useRef<VoiceConversationStatus | null>(null);
  const latestMuteObservation = useRef<{
    sessionId: string;
    revision: number;
    muted: boolean;
  } | null>(null);
  const latestLifecycleObservation = useRef<Extract<
    VoiceConversationEvent,
    { type: "startup" | "cleanShutdown" | "controlsDismissed" }
  > | null>(null);

  useLayoutEffect(() => {
    if (!initialized || !status?.sessionId) return;
    const showControls = realtime
      ? showOpenAiRealtimeVoiceControls
      : showVoiceConversationControls;
    void showControls(status.sessionId, status.revision).catch((cause) => {
      console.error("Failed to show floating voice controls", cause);
      setError("show");
    });
  }, [initialized, realtime, status?.revision, status?.sessionId]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const onEvent = (event: VoiceConversationEvent) => {
      const observedStatus = statusRef.current;
      if (observedStatus && event.revision < observedStatus.revision) return;
      if (
        observedStatus?.sessionId &&
        event.type !== "startup" &&
        "sessionId" in event &&
        event.sessionId &&
        event.sessionId !== observedStatus.sessionId
      ) {
        return;
      }
      if (
        event.type === "microphoneMute" ||
        event.type === "startup" ||
        event.type === "cleanShutdown" ||
        event.type === "controlsDismissed" ||
        (event.type === "error" && event.terminal)
      ) {
        microphoneMuteGeneration.current += 1;
      }
      if (event.type === "microphoneMute") {
        latestMuteObservation.current = {
          sessionId: event.sessionId,
          revision: event.revision,
          muted: event.muted,
        };
      }
      if (
        event.type === "startup" ||
        event.type === "cleanShutdown" ||
        event.type === "controlsDismissed"
      ) {
        const observation = latestLifecycleObservation.current;
        if (!observation || event.revision >= observation.revision) {
          latestLifecycleObservation.current = event;
        }
      }
      setActivity((current) => {
        if (event.revision < current.revision) return current;
        if (
          event.type === "activity" &&
          current.sessionId !== null &&
          event.sessionId !== current.sessionId
        ) {
          return current;
        }
        if (
          event.type === "startup" ||
          event.type === "cleanShutdown" ||
          event.type === "controlsDismissed"
        ) {
          return {
            userSpeaking: false,
            assistantSpeaking: false,
            sessionId: event.type === "startup" ? event.sessionId : null,
            revision: event.revision,
          };
        }
        if (event.type === "microphoneMute" && event.muted) {
          return {
            ...current,
            userSpeaking: false,
            revision: event.revision,
          };
        }
        if (event.type !== "activity") {
          return { ...current, revision: event.revision };
        }
        return {
          sessionId: current.sessionId ?? event.sessionId,
          userSpeaking:
            event.activity === "user-speaking"
              ? true
              : event.activity === "assistant-speaking"
                ? false
                : event.activity === "user-idle"
                  ? false
                  : current.userSpeaking,
          assistantSpeaking:
            event.activity === "assistant-speaking"
              ? true
              : event.activity === "user-speaking"
                ? false
                : event.activity === "assistant-idle"
                  ? false
                  : current.assistantSpeaking,
          revision: event.revision,
        };
      });
      setStatus((current) => {
        if (!current || event.revision < current.revision) return current;
        const nextStatus = ((): VoiceConversationStatus => {
          switch (event.type) {
            case "startup":
              return {
                ...current,
                lifecycle: "running",
                sessionId: event.sessionId,
                ownerWindowLabel: event.ownerWindowLabel,
                microphoneMuted: false,
                revision: event.revision,
              };
            case "microphoneMute":
              return {
                ...current,
                microphoneMuted: event.muted,
                revision: event.revision,
              };
            case "activity":
              return { ...current, revision: event.revision };
            case "cleanShutdown":
            case "controlsDismissed":
              return {
                ...current,
                lifecycle: "stopped",
                sessionId: null,
                ownerWindowLabel: null,
                microphoneMuted: false,
                revision: event.revision,
              };
            case "error":
              if (event.terminal) {
                console.error("Voice conversation failed", event.message);
                setError("conversation");
              }
              return { ...current, revision: event.revision };
            default:
              return { ...current, revision: event.revision };
          }
        })();
        statusRef.current = nextStatus;
        return nextStatus;
      });
    };

    void (async () => {
      try {
        const nextUnlisten = await listenToVoiceConversation(onEvent);
        if (cancelled) nextUnlisten();
        else unlisten = nextUnlisten;
      } catch (cause) {
        if (!cancelled) {
          console.error("Failed to listen for voice conversation state", cause);
          setError("initialize");
        }
      }

      try {
        const muteGeneration = microphoneMuteGeneration.current;
        const nextStatus = await (realtime
          ? getOpenAiRealtimeVoiceControlsStatus()
          : getVoiceConversationStatus());
        if (!cancelled) {
          setStatus((current) => {
            if (current && current.revision > nextStatus.revision) {
              statusRef.current = current;
              return current;
            }
            const lifecycleObservation = latestLifecycleObservation.current;
            let hydratedStatus = nextStatus;
            if (
              lifecycleObservation &&
              lifecycleObservation.revision >= nextStatus.revision
            ) {
              hydratedStatus =
                lifecycleObservation.type === "startup"
                  ? {
                      ...nextStatus,
                      lifecycle: "running",
                      sessionId: lifecycleObservation.sessionId,
                      ownerWindowLabel: lifecycleObservation.ownerWindowLabel,
                      microphoneMuted: false,
                      revision: lifecycleObservation.revision,
                    }
                  : {
                      ...nextStatus,
                      lifecycle: "stopped",
                      sessionId: null,
                      ownerWindowLabel: null,
                      microphoneMuted: false,
                      revision: lifecycleObservation.revision,
                    };
            }
            const observation = latestMuteObservation.current;
            const shouldPreserveObservedMute =
              hydratedStatus.lifecycle === "running" &&
              microphoneMuteGeneration.current !== muteGeneration &&
              observation?.sessionId === hydratedStatus.sessionId &&
              observation.revision >= hydratedStatus.revision;
            hydratedStatus = shouldPreserveObservedMute
              ? {
                  ...hydratedStatus,
                  microphoneMuted: observation.muted,
                  revision: Math.max(
                    hydratedStatus.revision,
                    observation.revision,
                  ),
                }
              : hydratedStatus;
            statusRef.current = hydratedStatus;
            return hydratedStatus;
          });
          setActivity((current) =>
            current.revision >= nextStatus.revision
              ? current
              : {
                  userSpeaking: false,
                  assistantSpeaking: false,
                  sessionId: nextStatus.sessionId,
                  revision: nextStatus.revision,
                },
          );
        }
      } catch (cause) {
        if (!cancelled) {
          console.error("Failed to load voice conversation state", cause);
          setError("initialize");
        }
      } finally {
        if (!cancelled) setInitialized(true);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [realtime]);

  const microphoneMuted = status?.microphoneMuted ?? false;
  const controlsActive =
    status?.lifecycle === "running" && status.sessionId !== null;
  const errorLabel = error
    ? t(`toolbar.voiceConversation.buddy.errors.${error}`)
    : null;
  const activityLabel = !controlsActive
    ? t("toolbar.voiceConversation.buddy.stopped")
    : microphoneMuted
      ? t("toolbar.voiceConversation.buddy.muted")
      : t("toolbar.voiceConversation.buddy.listening");

  const run = async (
    action: "open" | "mute" | "stop",
    errorType: VoiceControlsError,
    operation: () => Promise<void>,
  ) => {
    setBusyAction(action);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      console.error(`Voice control action failed: ${action}`, cause);
      setError(errorType);
    } finally {
      setBusyAction(null);
    }
  };

  const toggleMute = () => {
    if (!status) return;
    if (realtime) {
      const muted = !microphoneMuted;
      setStatus((current) =>
        current ? { ...current, microphoneMuted: muted } : current,
      );
      void run("mute", "mute", async () => {
        try {
          await requestOpenAiRealtimeVoiceControl(
            status.sessionId ?? "",
            status.revision,
            "mute",
            muted,
          );
        } catch (cause) {
          setStatus((current) =>
            current ? { ...current, microphoneMuted: !muted } : current,
          );
          throw cause;
        }
      });
      return;
    }
    const generation = microphoneMuteGeneration.current;
    void run("mute", "mute", async () => {
      const nextStatus = await setVoiceConversationMicrophoneMuted(
        !microphoneMuted,
        status,
      );
      if (generation !== microphoneMuteGeneration.current) return;
      setStatus((current) => {
        const acceptedStatus =
          current && current.revision > nextStatus.revision
            ? current
            : nextStatus;
        statusRef.current = acceptedStatus;
        return acceptedStatus;
      });
    });
  };

  return (
    <main
      className="flex h-screen min-w-0 select-none items-center justify-center overflow-hidden bg-transparent p-2 text-foreground"
      data-tauri-drag-region="deep"
    >
      <div
        className={`flex items-center justify-center gap-1 rounded-full bg-card/90 p-1 shadow-sm backdrop-blur-md ${error ? "ring-2 ring-destructive" : ""}`}
        data-tauri-drag-region="deep"
        title={errorLabel ?? t("toolbar.voiceConversation.buddy.title")}
      >
        <div
          className="flex h-8 cursor-move items-center justify-center px-1 text-muted-foreground"
          data-tauri-drag-region="deep"
          aria-hidden="true"
        >
          <GripVertical className="size-3.5" />
        </div>
        <VoiceConversationButton
          type="button"
          size="icon-sm"
          speaking={activity.assistantSpeaking}
          aria-label={t("toolbar.voiceConversation.buddy.openSession")}
          aria-describedby={
            activity.assistantSpeaking
              ? "voice-buddy-assistant-speaking"
              : undefined
          }
          title={t("toolbar.voiceConversation.buddy.openSession")}
          disabled={!controlsActive || busyAction !== null}
          onClick={() => void run("open", "open", openVoiceConversationSession)}
        >
          <BerdIcon aria-hidden="true" />
        </VoiceConversationButton>
        <VoiceConversationButton
          type="button"
          size="icon-sm"
          speaking={activity.userSpeaking && !microphoneMuted}
          aria-label={
            microphoneMuted
              ? t("toolbar.voiceConversation.unmuteMicrophone")
              : t("toolbar.voiceConversation.muteMicrophone")
          }
          aria-describedby={
            activity.userSpeaking && !microphoneMuted
              ? "voice-buddy-user-speaking"
              : undefined
          }
          title={
            microphoneMuted
              ? t("toolbar.voiceConversation.unmuteMicrophone")
              : t("toolbar.voiceConversation.muteMicrophone")
          }
          disabled={!controlsActive || busyAction !== null}
          onClick={toggleMute}
        >
          {microphoneMuted ? <MicOff /> : <Mic />}
        </VoiceConversationButton>
        <Button
          type="button"
          variant="subtle"
          size="icon-sm"
          destructive
          aria-label={t("toolbar.voiceConversation.buddy.hangUp")}
          title={t("toolbar.voiceConversation.buddy.hangUp")}
          disabled={!controlsActive || busyAction !== null}
          onClick={() => {
            if (status) {
              void run("stop", "stop", () =>
                realtime
                  ? requestOpenAiRealtimeVoiceControl(
                      status.sessionId ?? "",
                      status.revision,
                      "stop",
                    )
                  : stopVoiceConversationFromBuddy(status),
              );
            }
          }}
        >
          <PhoneOff />
        </Button>
      </div>
      {activity.assistantSpeaking ? (
        <span id="voice-buddy-assistant-speaking" className="sr-only">
          {t("toolbar.voiceConversation.buddy.assistantSpeaking")}
        </span>
      ) : null}
      {activity.userSpeaking && !microphoneMuted ? (
        <span id="voice-buddy-user-speaking" className="sr-only">
          {t("toolbar.voiceConversation.buddy.userSpeaking")}
        </span>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {errorLabel ?? activityLabel}
      </p>
    </main>
  );
}
