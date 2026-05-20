import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import type { SessionSearchDisplayResult } from "@/features/sessions/lib/buildSessionSearchResults";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { getSessionMetaLine } from "../lib/sessionMetaLine";
import { ResultRow } from "./ResultRow";

interface ChatResultRowProps {
  result: SessionSearchDisplayResult;
  defaultTitle: string;
  ariaLabel: string;
  formatRelativeTimeToNow: (value: Date | string | number) => string;
  t: (key: string, options?: Record<string, unknown>) => string;
  onSelect: (sessionId: string, messageId?: string) => void;
}

export function ChatResultRow({
  result,
  defaultTitle,
  ariaLabel,
  formatRelativeTimeToNow,
  t,
  onSelect,
}: ChatResultRowProps) {
  const session: ChatSession = result.session;
  const title = getDisplaySessionTitle(session.title, defaultTitle);

  return (
    <ResultRow
      title={title}
      meta={getSessionMetaLine(session, { formatRelativeTimeToNow, t })}
      ariaLabel={ariaLabel}
      onClick={() => onSelect(session.id, result.messageId)}
    />
  );
}
