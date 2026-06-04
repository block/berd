import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { runChatRuntimeStartup } from "@/app/lib/chatRuntimeStartup";
import { SessionWindowTopBar } from "@/app/ui/SessionWindowTopBar";
import {
  listenSessionHandoffSnapshotAvailable,
  type SessionHandoffSnapshotAvailable,
} from "@/features/chat/lib/sessionHandoffEvents";
import {
  activateSession,
  loadSessionMessages,
} from "@/features/chat/lib/sessionActivation";
import {
  joinSessionHandoff,
  listSessionWindows,
  readSessionHandoffSnapshot,
  recoverSessionHandoff,
  type SessionHandoffPayload,
  type SessionHandoffSnapshot,
} from "@/features/chat/lib/sessionWindowCommands";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  useChatSessionStore,
  type ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import {
  useSessionWindowStore,
  type SessionWindowEntry,
  type SessionWindowHandoff,
} from "@/features/chat/stores/sessionWindowStore";
import { ChatView } from "@/features/chat/ui/ChatView";
import { Button } from "@/shared/ui/button";

type Phase = "loading" | "mirror" | "recoverable" | "ready" | "missing";

interface SessionWindowAppProps {
  sessionId: string;
  currentWindowLabel?: string;
}

function getEntryHandoff(
  entry: SessionWindowEntry | undefined,
): SessionWindowHandoff | null {
  if (
    entry?.mode &&
    typeof entry.mode === "object" &&
    "handoff" in entry.mode
  ) {
    return entry.mode.handoff;
  }

  return null;
}

function getDestinationHandoff(
  entries: SessionWindowEntry[],
  sessionId: string,
  currentWindowLabel: string,
): SessionWindowHandoff | null {
  const entry = entries.find((candidate) => candidate.sessionId === sessionId);
  const handoff = getEntryHandoff(entry);
  return handoff?.toLabel === currentWindowLabel ? handoff : null;
}

async function resolveCurrentWindowLabel(fallback: string): Promise<string> {
  if (!window.__TAURI_INTERNALS__) {
    return fallback;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().label;
}

function applyHandoffSnapshot(payload: SessionHandoffSnapshot) {
  const handoffPayload = payload.payload;
  const runtime = handoffPayload.sessionState;
  useChatStore.setState((state) => ({
    messagesBySession: {
      ...state.messagesBySession,
      [handoffPayload.sessionId]: handoffPayload.messages,
    },
    ...(runtime
      ? {
          sessionStateById: {
            ...state.sessionStateById,
            [handoffPayload.sessionId]: runtime,
          },
        }
      : {}),
  }));
}

function isSnapshotForWindow(
  payload: SessionHandoffPayload,
  sessionId: string,
  currentWindowLabel: string,
) {
  return (
    payload.sessionId === sessionId && payload.toLabel === currentWindowLabel
  );
}

function applySnapshotForWindow(
  snapshot: SessionHandoffSnapshot | undefined | null,
  sessionId: string,
  currentWindowLabel: string,
) {
  if (!snapshot) {
    return false;
  }
  if (!isSnapshotForWindow(snapshot.payload, sessionId, currentWindowLabel)) {
    return false;
  }

  applyHandoffSnapshot(snapshot);
  return true;
}

export function SessionWindowApp({
  sessionId,
  currentWindowLabel: currentWindowLabelOverride,
}: SessionWindowAppProps) {
  const { t } = useTranslation("chat");
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<ChatSession | null>(null);
  const [currentWindowLabel, setCurrentWindowLabel] = useState<string | null>(
    currentWindowLabelOverride ?? null,
  );
  const [initialMirrorVersion, setInitialMirrorVersion] = useState(0);
  const isContextPanelOpen = useChatSessionStore((s) => s.isContextPanelOpen);
  const setContextPanelOpen = useChatSessionStore((s) => s.setContextPanelOpen);

  const loadOwnedSession = useCallback(
    async (options: { force?: boolean } = {}) => {
      activateSession(sessionId);
      await loadSessionMessages(sessionId, { force: options.force });
    },
    [sessionId],
  );
  const contextPanelLabel = isContextPanelOpen
    ? t("context.closePanel")
    : t("context.openPanel");
  const handleToggleContextPanel = useCallback(() => {
    setContextPanelOpen(sessionId, !isContextPanelOpen);
  }, [isContextPanelOpen, sessionId, setContextPanelOpen]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrapSessionWindow() {
      await runChatRuntimeStartup();
      if (cancelled) return;

      const loadedSession = useChatSessionStore
        .getState()
        .getSession(sessionId);
      if (!loadedSession || loadedSession.archivedAt) {
        setPhase("missing");
        return;
      }

      // TODO(perf): render from open-command metadata before loadSessions resolves.
      setSession(loadedSession);
      const label =
        currentWindowLabelOverride ??
        (await resolveCurrentWindowLabel(`session:${sessionId}`));
      if (cancelled) return;

      setCurrentWindowLabel(label);
      const entries = await listSessionWindows().catch(() => []);
      if (cancelled) return;

      useSessionWindowStore.getState().setSnapshot(entries);
      const handoff = getDestinationHandoff(entries, sessionId, label);
      if (handoff) {
        activateSession(sessionId);
        const joined = await joinSessionHandoff(sessionId);
        if (cancelled) return;
        const joinedSnapshot = joined.snapshot;
        let startingVersion = 0;
        if (applySnapshotForWindow(joinedSnapshot, sessionId, label)) {
          startingVersion = joinedSnapshot?.version ?? 0;
          if (joinedSnapshot?.isFinal) {
            setPhase("ready");
            return;
          }
        }
        useSessionWindowStore
          .getState()
          .setSnapshot(await listSessionWindows());
        setInitialMirrorVersion(startingVersion);
        setPhase("mirror");
        return;
      }

      setInitialMirrorVersion(0);
      await loadOwnedSession();
      if (!cancelled) setPhase("ready");
    }

    void bootstrapSessionWindow();

    return () => {
      cancelled = true;
    };
  }, [currentWindowLabelOverride, loadOwnedSession, sessionId]);

  useEffect(() => {
    if (phase !== "mirror" || !currentWindowLabel) {
      return;
    }

    let cancelled = false;
    let lastVersion = initialMirrorVersion;
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRecoveryTimer = () => {
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }
    };

    const resetRecoveryTimer = () => {
      clearRecoveryTimer();
      recoveryTimer = setTimeout(() => {
        if (!cancelled) {
          setPhase("recoverable");
        }
      }, 5000);
    };

    const readLatestSnapshot = async (afterVersion = lastVersion) => {
      const snapshot = await readSessionHandoffSnapshot(
        sessionId,
        afterVersion,
      );
      if (cancelled || !snapshot) {
        return;
      }
      if (!applySnapshotForWindow(snapshot, sessionId, currentWindowLabel)) {
        return;
      }

      lastVersion = snapshot.version;
      if (snapshot.isFinal) {
        clearRecoveryTimer();
        setPhase("ready");
      } else {
        resetRecoveryTimer();
      }
    };

    resetRecoveryTimer();

    void readLatestSnapshot().catch((error) => {
      console.error("Failed to read session handoff snapshot:", error);
    });

    const pollTimer = window.setInterval(() => {
      void readLatestSnapshot().catch((error) => {
        console.error("Failed to poll session handoff snapshot:", error);
      });
    }, 500);

    let cleanup: (() => void) | undefined;
    void listenSessionHandoffSnapshotAvailable(
      (payload: SessionHandoffSnapshotAvailable) => {
        if (
          payload.sessionId === sessionId &&
          payload.toLabel === currentWindowLabel
        ) {
          void readLatestSnapshot(lastVersion).catch((error) => {
            console.error(
              "Failed to read hinted session handoff snapshot:",
              error,
            );
          });
        }
      },
    ).then((unlisten) => {
      cleanup = unlisten;
      if (cancelled) {
        unlisten();
      }
    });

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
      clearRecoveryTimer();
      cleanup?.();
    };
  }, [currentWindowLabel, initialMirrorVersion, phase, sessionId]);

  const handleReloadSession = useCallback(() => {
    setPhase("loading");
    void recoverSessionHandoff(sessionId)
      .catch((error) => {
        console.error("Failed to recover session handoff:", error);
      })
      .then(() => loadOwnedSession({ force: true }))
      .then(() => setPhase("ready"));
  }, [loadOwnedSession, sessionId]);

  if (phase === "missing") {
    return (
      <div className="flex h-screen min-w-0 flex-col bg-background text-foreground">
        <SessionWindowTopBar title={t("sessionWindow.missingTitle")} />
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t("sessionWindow.missingDescription")}
        </div>
      </div>
    );
  }

  if (phase === "recoverable" && session) {
    return (
      <div className="flex h-screen min-w-0 flex-col bg-background text-foreground">
        <SessionWindowTopBar title={session.title} />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="max-w-md space-y-2">
            <h1 className="font-medium text-foreground text-lg">
              {t("sessionWindow.handoffPausedTitle")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("sessionWindow.handoffPausedDescription")}
            </p>
          </div>
          <Button type="button" onClick={handleReloadSession}>
            {t("sessionWindow.reload")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen min-w-0 flex-col bg-background text-foreground">
      <SessionWindowTopBar
        title={session?.title ?? "Goose"}
        contextPanelLabel={contextPanelLabel}
        contextPanelOpen={isContextPanelOpen}
        showContextPanelToggle={Boolean(session)}
        onToggleContextPanel={handleToggleContextPanel}
      />
      {(phase === "ready" || phase === "mirror") && session ? (
        <div className="min-h-0 flex-1">
          <ChatView
            sessionId={sessionId}
            activeSession={session}
            readOnlyStatus={
              phase === "mirror" ? t("sessionWindow.readOnlyStatus") : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}
