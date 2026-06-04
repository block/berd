import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { runChatRuntimeStartup } from "@/app/lib/chatRuntimeStartup";
import { SessionWindowTopBar } from "@/app/ui/SessionWindowTopBar";
import {
  listenSessionHandoffComplete,
  listenSessionHandoffFailed,
  listenSessionHandoffSnapshots,
  type SessionHandoffComplete,
  type SessionHandoffFailed,
  type SessionHandoffSnapshot,
} from "@/features/chat/lib/sessionHandoffEvents";
import {
  activateSession,
  loadSessionMessages,
} from "@/features/chat/lib/sessionActivation";
import { listSessionWindows } from "@/features/chat/lib/sessionWindowCommands";
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
  const runtime = payload.sessionState;
  useChatStore.setState((state) => ({
    messagesBySession: {
      ...state.messagesBySession,
      [payload.sessionId]: payload.messages,
    },
    ...(runtime
      ? {
          sessionStateById: {
            ...state.sessionStateById,
            [payload.sessionId]: runtime,
          },
        }
      : {}),
  }));
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
  const isContextPanelOpen = useChatSessionStore((s) => s.isContextPanelOpen);
  const setContextPanelOpen = useChatSessionStore((s) => s.setContextPanelOpen);
  const activeHandoff = useSessionWindowStore((state) => {
    const handoff = state.handoffs[sessionId];
    return handoff?.toLabel === currentWindowLabel ? handoff : null;
  });
  const openSessionWindowLabel = useSessionWindowStore(
    (state) => state.openSessions[sessionId],
  );

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
        setPhase("mirror");
        return;
      }

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
    let completed = false;
    const matchesThisHandoff = (
      payload:
        | SessionHandoffSnapshot
        | SessionHandoffComplete
        | SessionHandoffFailed,
    ) =>
      payload.sessionId === sessionId && payload.toLabel === currentWindowLabel;

    async function completeHandoff() {
      if (completed) {
        return;
      }
      completed = true;
      await loadOwnedSession({ force: true });
      if (cancelled) return;
      setPhase("ready");
    }

    async function setupHandoffListeners() {
      const [unlistenSnapshot, unlistenComplete, unlistenFailed] =
        await Promise.all([
          listenSessionHandoffSnapshots((payload) => {
            if (matchesThisHandoff(payload)) {
              applyHandoffSnapshot(payload);
            }
          }),
          listenSessionHandoffComplete((payload) => {
            if (matchesThisHandoff(payload)) {
              void completeHandoff();
            }
          }),
          listenSessionHandoffFailed((payload) => {
            if (matchesThisHandoff(payload) && !completed) {
              setPhase("recoverable");
            }
          }),
        ]);

      if (cancelled) {
        unlistenSnapshot();
        unlistenComplete();
        unlistenFailed();
      }

      return () => {
        unlistenSnapshot();
        unlistenComplete();
        unlistenFailed();
      };
    }

    let cleanup: (() => void) | undefined;
    void setupHandoffListeners().then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [currentWindowLabel, loadOwnedSession, phase, sessionId]);

  useEffect(() => {
    if (phase !== "mirror" || activeHandoff || !currentWindowLabel) {
      return;
    }

    if (openSessionWindowLabel === currentWindowLabel) {
      void loadOwnedSession({ force: true }).then(() => setPhase("ready"));
      return;
    }

    setPhase("recoverable");
  }, [
    activeHandoff,
    currentWindowLabel,
    loadOwnedSession,
    openSessionWindowLabel,
    phase,
  ]);

  const handleReloadSession = useCallback(() => {
    setPhase("loading");
    void loadOwnedSession({ force: true }).then(() => setPhase("ready"));
  }, [loadOwnedSession]);

  if (phase === "missing") {
    return (
      <div className="flex h-screen min-w-0 flex-col bg-background text-foreground">
        <SessionWindowTopBar title="Session unavailable" />
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          We can&apos;t find this session. It may have been deleted.
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
              Session handoff paused
            </h1>
            <p className="text-muted-foreground text-sm">
              The source window stopped sending live updates. Reload the session
              to recover the persisted conversation history.
            </p>
          </div>
          <Button type="button" onClick={handleReloadSession}>
            Reload session
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
              phase === "mirror" ? "Finishing current response..." : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}
