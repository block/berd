import { useEffect } from "react";
import {
  hasSessionStarted,
  type ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import { persistHomeSessionId } from "../lib/homeSessionStorage";

interface UseHomeSessionStateSyncOptions {
  homeSessionId: string | null;
  homeSession?: ChatSession;
  homeSessionMessages?: ArrayLike<unknown>;
  hasHydratedSessions: boolean;
  isLoading: boolean;
  setHomeSessionId: (sessionId: string | null) => void;
}

export function useHomeSessionStateSync({
  homeSessionId,
  homeSession,
  homeSessionMessages,
  hasHydratedSessions,
  isLoading,
  setHomeSessionId,
}: UseHomeSessionStateSyncOptions): void {
  useEffect(() => {
    if (!homeSessionId || !hasHydratedSessions || isLoading) {
      return;
    }

    if (
      !homeSession ||
      homeSession.archivedAt ||
      hasSessionStarted(homeSession, homeSessionMessages)
    ) {
      setHomeSessionId(null);
    }
  }, [
    hasHydratedSessions,
    homeSession,
    homeSession?.archivedAt,
    homeSession?.messageCount,
    homeSessionId,
    homeSessionMessages,
    isLoading,
    setHomeSessionId,
  ]);

  useEffect(() => {
    persistHomeSessionId(homeSessionId);
  }, [homeSessionId]);
}
