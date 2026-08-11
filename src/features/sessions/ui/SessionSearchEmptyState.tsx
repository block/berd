import { SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SESSION_CONTENT_SEARCH_MIN_CHARS } from "@/features/sessions/hooks/useSessionSearch";
import { Button } from "@/shared/ui/button";

interface SessionSearchEmptyStateProps {
  query: string;
  /** Shown only when provided — i.e. filters are active and clearable. */
  onClearFilters?: () => void;
  /** Shown only when provided — i.e. archived sessions are hidden. */
  onShowArchived?: () => void;
  /** When true, hints that archived sessions may hold matches. */
  hasArchivedMatchesHint?: boolean;
}

/**
 * Quiet centered block for a submitted search with zero results. States the
 * searched scope honestly and offers real outs (clear filters, search
 * archived) as buttons instead of a dead end.
 *
 * The scope line names every field a query is matched against, and only claims
 * conversation text when the query was long enough for a content sweep to run
 * — otherwise a one-character miss would blame the archive for a search that
 * never read a message.
 */
export function SessionSearchEmptyState({
  query,
  onClearFilters,
  onShowArchived,
  hasArchivedMatchesHint,
}: SessionSearchEmptyStateProps) {
  const { t } = useTranslation(["sessions"]);
  const hasActions = Boolean(onClearFilters || onShowArchived);
  const searchedContent =
    query.trim().length >= SESSION_CONTENT_SEARCH_MIN_CHARS;
  const scopeKey = searchedContent
    ? hasArchivedMatchesHint
      ? "history.searchEmpty.scopeWithContentAndArchivedHint"
      : "history.searchEmpty.scopeWithContent"
    : hasArchivedMatchesHint
      ? "history.searchEmpty.scopeMetadataOnlyWithArchivedHint"
      : "history.searchEmpty.scopeMetadataOnly";

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <SearchX aria-hidden="true" className="size-8 opacity-30" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">
          {t("history.searchEmpty.title", {
            defaultValue: 'No sessions match "{{query}}"',
            query,
          })}
        </p>
        <p className="text-xs text-muted-foreground">{t(scopeKey)}</p>
      </div>
      {hasActions && (
        <div className="flex items-center gap-4">
          {onClearFilters && (
            <Button
              type="button"
              variant="ghost"
              flush
              onClick={onClearFilters}
            >
              {t("history.searchEmpty.clearFilters", {
                defaultValue: "Clear filters",
              })}
            </Button>
          )}
          {onShowArchived && (
            <Button
              type="button"
              variant="ghost"
              flush
              onClick={onShowArchived}
            >
              {t("history.searchEmpty.searchArchived", {
                defaultValue: "Search archived",
              })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
