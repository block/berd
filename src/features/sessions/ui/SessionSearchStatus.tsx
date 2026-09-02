import { useTranslation } from "react-i18next";
import {
  SESSION_CONTENT_SEARCH_MIN_CHARS,
  type SessionSearchProgress,
} from "@/features/sessions/hooks/useSessionSearch";
import { cn } from "@/shared/lib/cn";

interface SessionSearchStatusProps {
  /** The submitted query, read only to tell whether a content sweep ran. */
  query: string;
  /**
   * True while the box holds an edit that has not been submitted yet. Takes
   * precedence over the completed counts, which describe the previous query.
   */
  isPending?: boolean;
  isSearching: boolean;
  progress: SessionSearchProgress | null;
  resultCount: number;
  /** Whether the submitted run actually included conversation content. */
  searchedContent?: boolean;
  /** Presence flags a failed sweep; the raw text is never shown to the user. */
  error?: string | null;
  /** The sweep hit its time budget; narrowing the query helps, so it gets its own copy. */
  timedOut?: boolean;
}

/**
 * One-line narration under the history search bar while a search is
 * submitted: sweep progress while searching, then an honest statement of what
 * was actually searched once done, or the error.
 *
 * The scope claim is conditional on purpose. Every submitted query matches
 * metadata (title, agent, project, date), but conversation text is only swept
 * once the query is long enough to be worth exporting corpora for, so a
 * one-character query that found nothing must not claim it read every message.
 *
 * Coverage can also be partial: the sweep resolves even when individual corpus
 * exports fail, so some conversations may never have been read. That is stated
 * rather than rounded up to a complete claim, because a false negative
 * presented as authoritative is worse than an admitted gap.
 *
 * This is also the only user-facing surface for a search failure: the message
 * is taken from locale resources rather than the backend's, which is English
 * technical prose that would otherwise land untranslated in a Spanish UI.
 */
export function SessionSearchStatus({
  query,
  isPending = false,
  isSearching,
  progress,
  resultCount,
  searchedContent: searchedContentProp,
  error,
  timedOut = false,
}: SessionSearchStatusProps) {
  const { t } = useTranslation(["sessions"]);
  const searchedContent =
    searchedContentProp ??
    query.trim().length >= SESSION_CONTENT_SEARCH_MIN_CHARS;
  const unreadable = progress?.unreadable ?? 0;

  let content: string;
  if (isPending) {
    // Every other state still describes the previous submitted query.
    content = t("history.searchStatus.pending");
  } else if (timedOut) {
    content = t("history.searchStatus.timedOut");
  } else if (error) {
    content = t("history.searchError");
  } else if (isSearching && progress) {
    content =
      progress.phase === "waiting"
        ? // No pages back yet, so the loaded-slice counts would read as stalled.
          t("history.searchStatus.waiting")
        : progress.phase === "reading"
          ? t("history.searchStatus.reading")
          : t("history.searchStatus.searching", {
              searched: progress.searched,
              total: progress.total,
            });
  } else if (searchedContent && unreadable > 0) {
    // Some conversations were never opened, so "no match" cannot be claimed for
    // them. Name the gap instead of implying the sweep was complete.
    //
    // Composed from two clauses rather than one string: the result count and
    // the unread count pluralize independently, and a single key can only
    // agree with one of them ("1 result … 3 conversation could not be read").
    content = t("history.searchStatus.donePartialContent", {
      done: t("history.searchStatus.doneWithContent", { count: resultCount }),
      note: t("history.searchStatus.unreadableNote", { count: unreadable }),
    });
  } else if (searchedContent) {
    content = t("history.searchStatus.doneWithContent", {
      count: resultCount,
    });
  } else {
    content = t("history.searchStatus.doneMetadataOnly", {
      count: resultCount,
    });
  }

  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "text-xs text-muted-foreground",
        !isPending && (error || timedOut) && "text-destructive",
      )}
    >
      {content}
    </p>
  );
}
