import type { ChatSession } from "@/features/chat/stores/chatSessionStore";

interface SessionMetaLineOptions {
  formatRelativeTimeToNow: (value: Date | string | number) => string;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function getSessionMetaLine(
  session: ChatSession,
  { formatRelativeTimeToNow, t }: SessionMetaLineOptions,
): string {
  const displayCount = session.messageCount;
  const messageCount = t("sessions:messageCount", {
    count: displayCount,
    displayCount,
  });

  return `${formatRelativeTimeToNow(session.updatedAt)} · ${messageCount}`;
}
