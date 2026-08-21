import { Mic, MicOff, PhoneOff } from "lucide-react";
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
import { useAvatarMediaState } from "@/shared/hooks/useAvatarSrc";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Button } from "@/shared/ui/button";

export function VoiceBuddyApp() {
  const { t } = useTranslation("chat");
  const [status, setStatus] = useState<VoiceConversationStatus | null>(null);
  const [busyAction, setBusyAction] = useState<"open" | "mute" | "stop" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const avatar = useAvatarMediaState("app-avatar:gloopies-22");

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
    <main className="flex h-screen min-w-0 flex-col overflow-hidden bg-transparent p-3 text-foreground">
      <div
        className="flex h-5 shrink-0 cursor-move items-center justify-center text-muted-foreground text-xs [text-shadow:0_1px_2px_var(--canvas-base)]"
        data-tauri-drag-region
      >
        {t("toolbar.voiceConversation.buddy.title")}
      </div>
      <button
        type="button"
        className="group relative flex min-h-0 flex-1 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("toolbar.voiceConversation.buddy.openSession")}
        title={t("toolbar.voiceConversation.buddy.openSession")}
        disabled={busyAction !== null}
        onClick={() => void run("open", openVoiceConversationSession)}
      >
        <div className="size-24">
          {avatar.media ? (
            <AvatarMedia
              media={avatar.media}
              alt={t("toolbar.voiceConversation.buddy.gloopieAlt")}
              className="rounded-md"
            />
          ) : (
            <div className="flex size-full items-center justify-center rounded-full bg-accent font-semibold text-2xl text-accent-foreground">
              B
            </div>
          )}
        </div>
      </button>
      <p
        className="mx-auto truncate rounded-full bg-card/90 px-2 py-0.5 text-center text-muted-foreground text-xs shadow-sm backdrop-blur-md"
        role="status"
        aria-live="polite"
      >
        {error ?? activityLabel}
      </p>
      <div className="mx-auto mt-2 flex items-center justify-center gap-1 rounded-full bg-card/90 p-1 shadow-sm backdrop-blur-md">
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
    </main>
  );
}
