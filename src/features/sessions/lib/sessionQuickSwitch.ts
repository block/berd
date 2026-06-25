import { Fzf, type FzfResultItem } from "fzf";
import { sessionActivityAt } from "@/features/chat/lib/sessionActivity";

export interface QuickSwitchSession {
  id: string;
  title: string;
  updatedAt: string;
  lastMessageAt?: string | null;
  isRunning: boolean;
}

export interface QuickSwitchResult {
  session: QuickSwitchSession;
  /** Matched character indexes in the title, for highlighting. Null when no query. */
  positions: ReadonlySet<number> | null;
}

export const QUICK_SWITCH_RESULT_LIMIT = 8;

// Roughly two matched characters' worth of fzf score, so a running session
// outranks a slightly better title match but not a clearly better one.
const ACTIVE_SESSION_SCORE_BONUS = 32;

function byRecency(a: QuickSwitchSession, b: QuickSwitchSession): number {
  return (
    Date.parse(sessionActivityAt(b)) - Date.parse(sessionActivityAt(a)) ||
    b.id.localeCompare(a.id)
  );
}

function effectiveScore(result: FzfResultItem<QuickSwitchSession>): number {
  return (
    result.score + (result.item.isRunning ? ACTIVE_SESSION_SCORE_BONUS : 0)
  );
}

/**
 * Rank sessions for the quick switcher.
 *
 * Empty query: most-recently-active order with running sessions first (MRU,
 * like Slack's Cmd+K with nothing typed). Activity uses the last chat message
 * timestamp when Goose provides it, with updatedAt as an older-backend fallback.
 *
 * With a query: fzf fuzzy match score, boosted for running sessions, with
 * recency as the tiebreaker.
 */
export function buildQuickSwitchResults(
  sessions: readonly QuickSwitchSession[],
  query: string,
  limit: number = QUICK_SWITCH_RESULT_LIMIT,
): QuickSwitchResult[] {
  const trimmed = query.trim();

  if (!trimmed) {
    const running = sessions.filter((s) => s.isRunning).sort(byRecency);
    const rest = sessions.filter((s) => !s.isRunning).sort(byRecency);
    return [...running, ...rest]
      .slice(0, limit)
      .map((session) => ({ session, positions: null }));
  }

  const fzf = new Fzf([...sessions], {
    selector: (session) => session.title,
    // We sort ourselves to blend in the active-session bonus.
    sort: false,
  });

  return fzf
    .find(trimmed)
    .sort(
      (a, b) =>
        effectiveScore(b) - effectiveScore(a) || byRecency(a.item, b.item),
    )
    .slice(0, limit)
    .map((result) => ({
      session: result.item,
      positions: result.positions,
    }));
}
