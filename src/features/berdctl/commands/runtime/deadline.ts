import { MUTATION_DEADLINE_MARGIN_MS } from "../../bridge/appNavigationController";
import { CommandError, type CommandContext } from "../types";

/** Margin covering the mutation dispatch after validation, mirroring
 *  createSession's CREATE_DEADLINE_MARGIN_MS: past the broker deadline the
 *  caller has already been told the command failed, so a slow validation
 *  read must not mutate state afterwards. */
/** Throw `timed_out` when the broker deadline is too close to safely
 *  mutate. Call immediately before the first mutation; `notChanged` states
 *  what was left untouched (e.g. "the session's worktree was not changed"). */
export function refusePastDeadline(
  ctx: CommandContext,
  notChanged: string,
): void {
  if (
    ctx.deadlineMs != null &&
    Date.now() > ctx.deadlineMs - MUTATION_DEADLINE_MARGIN_MS
  ) {
    throw new CommandError(
      "timed_out",
      `Validation took too long; ${notChanged}. Retry once.`,
    );
  }
}
