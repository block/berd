import { MessageSquare } from "lucide-react";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import type { MessageSearchResult } from "@/shared/api/messageSearch";
import { highlightKeywords } from "../lib/highlightKeywords";
import { ResultRow } from "./ResultRow";

export function MessageResultRow({
  id,
  result,
  defaultTitle,
  query,
  ariaLabel,
  archivedLabel,
  formatRelativeTimeToNow,
  isActive,
  onActive,
  onSelect,
}: {
  id: string;
  result: MessageSearchResult;
  defaultTitle: string;
  query: string;
  ariaLabel: string;
  archivedLabel: string;
  formatRelativeTimeToNow: (value: Date | string | number) => string;
  isActive: boolean;
  onActive: () => void;
  onSelect: () => void;
}) {
  return (
    <ResultRow
      id={id}
      title={getDisplaySessionTitle(result.title, defaultTitle)}
      excerpt={highlightKeywords(result.snippet, query)}
      meta={
        result.archivedAt
          ? archivedLabel
          : formatRelativeTimeToNow(result.messageCreatedAt)
      }
      icon={<MessageSquare aria-hidden="true" />}
      ariaLabel={ariaLabel}
      isActive={isActive}
      onActive={onActive}
      onClick={onSelect}
    />
  );
}
