// Send-source priority, perch wire preamble, and the guidance ledger.
// Pure functions — no React, no invoke (the lib-layer rule).
//
// WIRE TEXT NOTICE: perchSendPreamble builds AGENT-FACING English that
// rides the ACP prompt — it is not UI copy and deliberately does NOT go
// through i18n (the transcript strips it for display via
// transcriptDisplay.stripWirePreamble, whose parser is coupled to this
// exact shape — change them together).

/** Where the perch lifecycle stands. Defined here (not in usePerch) so
 *  lib modules never import from hooks/. (No "waiting" phase: minimize
 *  auto-unperches — product rule against accidental screenshot sends.) */
export type PerchPhase = "unperched" | "targeting" | "perched";

export type ComposerSendSource = "perchedWindow" | "none";

/** Send-source priority: perched window > nothing. */
export function chooseComposerSendSource(args: {
  perchPhase: PerchPhase;
}): ComposerSendSource {
  if (args.perchPhase === "perched") {
    return "perchedWindow";
  }
  return "none";
}

/**
 * Identity preamble for perched sends. Prepended ON THE WIRE ONLY: the
 * local echo stays the user's bare words (house rule), and
 * stripWirePreamble removes it from replays.
 *
 * Guidance once per session: the panel renders wire truth, so guidance
 * repeated on every perched send gunks the transcript when the session
 * is opened in the main app. The FIRST perched send of a session carries
 * the full guidance; subsequent sends (fullGuidance: false) carry only
 * the bracket identity line — the per-message facts (app, title,
 * artifact URL, staleness warning) the agent needs each time.
 */
export function perchSendPreamble(args: {
  phase: PerchPhase;
  appName: string | null;
  title: string | null;
  artifactUrl?: string | null;
  fullGuidance?: boolean;
}): string | null {
  const { phase, appName, title } = args;
  if (appName === null || phase === "unperched" || phase === "targeting") {
    return null;
  }

  const bracketParts = [`Perched on: ${appName.trim()}`];
  const trimmedTitle = (title ?? "").trim();
  if (trimmedTitle.length > 0) bracketParts.push(`"${trimmedTitle}"`);
  const url = args.artifactUrl?.trim();
  if (url) bracketParts.push(url);
  const bracket = `[${bracketParts.join(" — ")}]`;

  if (args.fullGuidance === false) {
    return bracket;
  }

  const guidance =
    "If a skill of yours matches this window's content, prefer acting on the underlying artifact; any attached screenshot is visual context. Do not restate this notice.";
  return `${bracket}\n${guidance}`;
}

// Guidance ledger: which sessions have already received the full
// guidance. Module scope on purpose — the consuming components remount
// (ChatPopover unmounts per popover collapse), so local state would
// re-send the guidance per open. Resets per app launch (harmless: one
// repeat per session per launch). OWNERSHIP: SendController owns all
// reads/marks — it is the only place that knows which session a send
// actually targets (a deferred create's id exists only after commit).
// Marking happens AFTER delivery, never optimistically — a failed send
// leaves the ledger unburned so the retry carries full guidance again.
const guidanceSent = new Set<string>();

export function shouldSendFullGuidance(sessionKey: string): boolean {
  return !guidanceSent.has(sessionKey);
}

/**
 * Guidance decision for a send (pure — pins the armed-selection
 * semantics): a deferred create targets a NEW session whose agent has
 * never seen the guidance — always full, regardless of what the CURRENT
 * sessionId's ledger says (while armed, sessionId still holds the parked
 * session's id; keying off it was a review bug in the prototype).
 * Otherwise the live session's ledger decides; a null sessionId
 * (pre-attach edge) defaults to full — a repeat is harmless, a skip is
 * not.
 */
export function shouldSendFullGuidanceFor(
  pendingCreate: boolean,
  sessionId: string | null,
): boolean {
  if (pendingCreate) return true;
  if (sessionId === null) return true;
  return shouldSendFullGuidance(sessionId);
}

export function markGuidanceSent(sessionKey: string): void {
  guidanceSent.add(sessionKey);
}

/** Test seam. */
export function resetGuidanceLedger(): void {
  guidanceSent.clear();
}
