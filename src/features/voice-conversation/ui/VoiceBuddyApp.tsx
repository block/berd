import { Menu, Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  getVoiceConversationStatus,
  listenToVoiceConversation,
  openVoiceConversationSession,
  sendVoiceConversationToMenuBar,
  setVoiceConversationMicrophoneMuted,
  stopVoiceConversationFromBuddy,
  type VoiceConversationEvent,
  type VoiceConversationStatus,
} from "@/features/voice-conversation/api/voiceConversation";
import { useAvatarMediaState } from "@/shared/hooks/useAvatarSrc";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Button } from "@/shared/ui/button";

type Activity = "listening" | "user-speaking" | "agent-speaking";

function activityFromEvent(
  event: VoiceConversationEvent,
  current: Activity,
): Activity {
  if (event.type !== "activity") return current;
  if (event.activity === "user-speaking") return "user-speaking";
  if (event.activity === "assistant-speaking") return "agent-speaking";
  return "listening";
}

export function VoiceBuddyApp() {
  const { t } = useTranslation("chat");
  const [status, setStatus] = useState<VoiceConversationStatus | null>(null);
  const [activity, setActivity] = useState<Activity>("listening");
  const [busyAction, setBusyAction] = useState<"mute" | "stop" | "menu" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const avatar = useAvatarMediaState("app-avatar:gloopies-22");
  const menuBarAvailable = useMemo(
    () => new URLSearchParams(window.location.search).has("menuBar"),
    [],
  );

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
      setActivity((current) => activityFromEvent(event, current));
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
    ? t("composer.voiceConversation.buddy.muted")
    : t(`composer.voiceConversation.buddy.${activity}`);

  const run = async (
    action: "mute" | "stop" | "menu",
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
    <main className="flex h-screen min-w-0 flex-col overflow-hidden rounded-3xl border border-border bg-card p-3 text-foreground smooth-shadow-sm">
      <div
        className="flex h-5 shrink-0 cursor-move items-center justify-center text-muted-foreground text-xs"
        data-tauri-drag-region
      >
        {t("composer.voiceConversation.buddy.title")}
      </div>
      <button
        type="button"
        className="group relative flex min-h-0 flex-1 items-center justify-center rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("composer.voiceConversation.buddy.openSession")}
        title={t("composer.voiceConversation.buddy.openSession")}
        onClick={() => void openVoiceConversationSession()}
      >
        <div
          className={`size-24 transition-transform duration-200 ${
            activity === "user-speaking" || activity === "agent-speaking"
              ? "scale-110"
              : "scale-100"
          }`}
        >
          {avatar.media ? (
            <AvatarMedia
              media={avatar.media}
              alt={t("composer.voiceConversation.buddy.gloopieAlt")}
              className="rounded-2xl"
            />
          ) : (
            <div className="flex size-full items-center justify-center rounded-full bg-accent font-semibold text-2xl text-accent-foreground">
              B
            </div>
          )}
        </div>
      </button>
      <p className="truncate px-1 text-center text-muted-foreground text-xs">
        {error ?? activityLabel}
      </p>
      <div className="mt-2 flex items-center justify-center gap-1">
        <Button
          type="button"
          variant="subtle"
          size="icon-sm"
          aria-label={
            microphoneMuted
              ? t("composer.voiceConversation.unmuteMicrophone")
              : t("composer.voiceConversation.muteMicrophone")
          }
          title={
            microphoneMuted
              ? t("composer.voiceConversation.unmuteMicrophone")
              : t("composer.voiceConversation.muteMicrophone")
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
          aria-label={t("composer.voiceConversation.buddy.hangUp")}
          title={t("composer.voiceConversation.buddy.hangUp")}
          disabled={busyAction !== null}
          onClick={() => void run("stop", stopVoiceConversationFromBuddy)}
        >
          <PhoneOff />
        </Button>
        {menuBarAvailable ? (
          <Button
            type="button"
            variant="subtle"
            size="icon-sm"
            aria-label={t("composer.voiceConversation.buddy.sendToMenuBar")}
            title={t("composer.voiceConversation.buddy.sendToMenuBar")}
            disabled={busyAction !== null}
            onClick={() => void run("menu", sendVoiceConversationToMenuBar)}
          >
            <Menu />
          </Button>
        ) : null}
      </div>
    </main>
  );
}
