import { CircleAlert, GripVertical, Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  getVoiceConversationStatus,
  listenToVoiceConversation,
  openVoiceConversationSession,
  setVoiceConversationMicrophoneMuted,
  stopVoiceConversationFromBuddy,
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

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getVoiceConversationStatus()
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    void listenToVoiceConversation((event) => {
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
    }).then((nextUnlisten) => {
      if (cancelled) nextUnlisten();
      else unlisten = nextUnlisten;
    });
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
      await setVoiceConversationMicrophoneMuted(!microphoneMuted, status);
      setStatus((current) =>
        current ? { ...current, microphoneMuted: !microphoneMuted } : current,
      );
    });
  };

  return (
    <main
      className="flex h-screen min-w-0 select-none items-center justify-center overflow-hidden bg-transparent p-2 text-foreground"
      data-tauri-drag-region="deep"
    >
      <div className="flex items-center justify-center gap-1">
        <Button
          type="button"
          variant="subtle"
          size="icon"
          aria-label={t("toolbar.voiceConversation.buddy.openSession")}
          title={t("toolbar.voiceConversation.buddy.openSession")}
          disabled={busyAction !== null}
          onClick={() => void run("open", openVoiceConversationSession)}
        >
          <BerdIcon aria-hidden="true" />
        </Button>
        <div className="flex items-center justify-center gap-1 rounded-full bg-card/90 p-1 shadow-sm backdrop-blur-md">
          <div
            className="flex h-8 cursor-move items-center justify-center px-1 text-muted-foreground"
            data-tauri-drag-region="deep"
            title={error ?? t("toolbar.voiceConversation.buddy.title")}
          >
            {error ? (
              <CircleAlert
                aria-hidden="true"
                className="size-3.5 text-destructive"
              />
            ) : (
              <GripVertical aria-hidden="true" className="size-3.5" />
            )}
          </div>
          <Button
            type="button"
            variant="subtle"
            size="icon-sm"
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
            disabled={busyAction !== null}
            onClick={() => void run("stop", stopVoiceConversationFromBuddy)}
          >
            <PhoneOff />
          </Button>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {error ?? activityLabel}
      </p>
    </main>
  );
}
