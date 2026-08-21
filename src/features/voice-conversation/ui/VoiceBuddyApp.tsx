import { GripVertical, Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
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
import { Button } from "@/shared/ui/button";
import { BerdIcon } from "@/shared/ui/icons/BerdIcon";

export function VoiceBuddyApp() {
  const { t } = useTranslation("chat");
  const [status, setStatus] = useState<VoiceConversationStatus | null>(null);
  const [busyAction, setBusyAction] = useState<"open" | "mute" | "stop" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState({
    userSpeaking: false,
    assistantSpeaking: false,
    sessionId: null as string | null,
    revision: 0,
  });
  const [initialized, setInitialized] = useState(false);

  useLayoutEffect(() => {
    if (!initialized || !status?.sessionId) return;
    void showVoiceConversationControls(status.sessionId, status.revision).catch(
      (cause) => {
        console.error("Failed to show floating voice controls", cause);
        setError(String(cause));
      },
    );
  }, [initialized, status?.revision, status?.sessionId]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const onEvent = (event: VoiceConversationEvent) => {
      setActivity((current) => {
        if (event.revision < current.revision) return current;
        if (
          event.type === "activity" &&
          current.sessionId !== null &&
          event.sessionId !== current.sessionId
        ) {
          return current;
        }
        if (event.type === "startup" || event.type === "cleanShutdown") {
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
            return {
              ...current,
              lifecycle: "stopped",
              sessionId: null,
              ownerWindowLabel: null,
              microphoneMuted: false,
              revision: event.revision,
            };
          case "error":
            if (event.terminal) setError(event.message);
            return { ...current, revision: event.revision };
          default:
            return { ...current, revision: event.revision };
        }
      });
    };

    void (async () => {
      try {
        const nextUnlisten = await listenToVoiceConversation(onEvent);
        if (cancelled) nextUnlisten();
        else unlisten = nextUnlisten;
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }

      try {
        const nextStatus = await getVoiceConversationStatus();
        if (!cancelled) {
          setStatus((current) =>
            current && current.revision > nextStatus.revision
              ? current
              : nextStatus,
          );
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
        if (!cancelled) setError(String(cause));
      } finally {
        if (!cancelled) setInitialized(true);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const microphoneMuted = status?.microphoneMuted ?? false;
  const activityLabel = microphoneMuted
    ? t("toolbar.voiceConversation.buddy.muted")
    : t("toolbar.voiceConversation.buddy.listening");

  const run = async (
    action: "open" | "mute" | "stop",
    operation: () => Promise<void>,
  ) => {
    setBusyAction(action);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const toggleMute = () => {
    if (!status) return;
    void run("mute", async () => {
      const nextStatus = await setVoiceConversationMicrophoneMuted(
        !microphoneMuted,
        status,
      );
      setStatus((current) =>
        current && current.revision > nextStatus.revision
          ? current
          : nextStatus,
      );
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
        title={error ?? t("toolbar.voiceConversation.buddy.title")}
      >
        <div
          className="flex h-8 cursor-move items-center justify-center px-1 text-muted-foreground"
          data-tauri-drag-region="deep"
          aria-hidden="true"
        >
          <GripVertical className="size-3.5" />
        </div>
        <Button
          type="button"
          variant="subtle"
          size="icon-sm"
          activity={activity.assistantSpeaking}
          aria-label={t("toolbar.voiceConversation.buddy.openSession")}
          title={t("toolbar.voiceConversation.buddy.openSession")}
          disabled={!status || busyAction !== null}
          onClick={() => void run("open", openVoiceConversationSession)}
        >
          <BerdIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="subtle"
          size="icon-sm"
          activity={activity.userSpeaking && !microphoneMuted}
          aria-label={
            microphoneMuted
              ? t("toolbar.voiceConversation.unmuteMicrophone")
              : t("toolbar.voiceConversation.muteMicrophone")
          }
          title={
            microphoneMuted
              ? t("toolbar.voiceConversation.unmuteMicrophone")
              : t("toolbar.voiceConversation.muteMicrophone")
          }
          disabled={!status || busyAction !== null}
          onClick={toggleMute}
        >
          {microphoneMuted ? <MicOff /> : <Mic />}
        </Button>
        <Button
          type="button"
          variant="subtle"
          size="icon-sm"
          destructive
          aria-label={t("toolbar.voiceConversation.buddy.hangUp")}
          title={t("toolbar.voiceConversation.buddy.hangUp")}
          disabled={!status || busyAction !== null}
          onClick={() => {
            if (status) {
              void run("stop", () => stopVoiceConversationFromBuddy(status));
            }
          }}
        >
          <PhoneOff />
        </Button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {error ?? activityLabel}
      </p>
    </main>
  );
}
