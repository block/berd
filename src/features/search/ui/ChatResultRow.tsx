import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import type { SessionSearchDisplayResult } from "@/features/sessions/lib/buildSessionSearchResults";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { getSessionMetaLine } from "../lib/sessionMetaLine";
import { ResultRow } from "./ResultRow";

interface ChatResultRowProps {
  id?: string;
  result: SessionSearchDisplayResult;
  defaultTitle: string;
  ariaLabel: string;
  formatRelativeTimeToNow: (value: Date | string | number) => string;
  t: (key: string, options?: Record<string, unknown>) => string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (sessionId: string, messageId?: string) => void;
}

export function ChatResultRow({
  id,
  result,
  defaultTitle,
  ariaLabel,
  formatRelativeTimeToNow,
  t,
  isActive,
  onActive,
  onSelect,
}: ChatResultRowProps) {
  const session: ChatSession = result.session;
  const title = getDisplaySessionTitle(session.title, defaultTitle);

  return (
    <ResultRow
      id={id}
      title={title}
      meta={getSessionMetaLine(session, { formatRelativeTimeToNow, t })}
      ariaLabel={ariaLabel}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(session.id, result.messageId)}
    />
  );
}
