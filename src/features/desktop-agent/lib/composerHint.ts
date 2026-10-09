// Composer hint derivation: the priority chain was once a ~12-branch
// nested ternary inline in ChatPopover — pure derivation logic trapped in
// the component, unscannable and untested. Extracted here with a
// table-driven test pinning the priority order.
//
// Returns an i18n DESCRIPTOR ({ key, params }) rather than English text:
// the component translates via the `desktop-agent` namespace. Keys live in
// src/shared/i18n/locales/{en,es}/desktop-agent.json.
//
// Priority (first match wins):
//   1. send error        — actionable failure, beats everything
//   2. perch error       — AX/capture problems from the perch layer
//   3. disconnected      — exhausted > reconnecting > connecting
//   4. stalled           — thinking with zero traffic for 25s
//   5. capture pending   — perched-window snapshot before dispatch
//   6. agent starting    — deferred create in flight
//   7. perch hint        — ambient perched-on identity
//   8. thinking          — plain activity indicator
//   9. null              — no hint row
//
// (The prototype's "notice" rung — delivered-but-status for the
// out-of-process dispatch path — was dead plumbing in the in-process
// rewrite and was removed in PR3; see git history if a status channel
// is ever needed again.)

import type { PerchPhase } from "./sendSource";

export interface ComposerHintInputs {
  lastSendError: string | null;
  /** Raw perch-layer error (usePerch.lastError): AX resolve failures,
   *  capture failures, the accessibility_denied gate. Mapped to a
   *  friendly key when recognized, passthrough otherwise. */
  perchError: string | null;
  perchPhase: PerchPhase;
  perchApp: string | null;
  perchTitle: string | null;
  attached: boolean;
  connectionError: string | null;
  /** Reconnect gave up: the copy must stop claiming "reconnecting" when
   *  nothing is reconnecting. */
  reconnectExhausted: boolean;
  sendStalled: boolean;
  agentSendInFlight: boolean;
  capturePending: boolean;
  pendingName: string | null;
  thinking: boolean;
}

export interface ComposerHint {
  key: string;
  params?: Record<string, string>;
}

const truncate = (value: string, maxCharacters: number): string =>
  value.length <= maxCharacters
    ? value
    : `${value.slice(0, maxCharacters - 1)}…`;

/** The perch_on gate rejects with this token when Accessibility is not
 *  granted (perch.rs) — mapped to friendly copy instead of passthrough. */
const ACCESSIBILITY_DENIED_TOKEN = "accessibility_denied";

/** Ambient perched-on identity (priority 7). Identity params are
 *  pre-truncated here (app 28, title 72) — the hint row is one line. */
function perchIdentityHint(inputs: ComposerHintInputs): ComposerHint | null {
  if (inputs.perchApp === null) return null;
  const app = truncate(inputs.perchApp, 28);
  if (inputs.perchPhase !== "perched") return null;
  const title = (inputs.perchTitle ?? "").trim();
  return title.length > 0
    ? {
        key: "hint.perched",
        params: { app, title: truncate(title, 72) },
      }
    : { key: "hint.perchedApp", params: { app } };
}

export function deriveComposerHint(
  inputs: ComposerHintInputs,
): ComposerHint | null {
  if (inputs.lastSendError) {
    return {
      key: "hint.sendFailed",
      params: { message: inputs.lastSendError },
    };
  }
  if (inputs.perchError) {
    // The one recognizable token gets real copy (grant instructions);
    // everything else is a native-layer message rendered verbatim, like
    // sendFailed.
    return inputs.perchError.includes(ACCESSIBILITY_DENIED_TOKEN)
      ? { key: "hint.perchAccessibility" }
      : { key: "hint.perchError", params: { message: inputs.perchError } };
  }
  if (!inputs.attached) {
    if (inputs.reconnectExhausted) return { key: "hint.reconnectExhausted" };
    if (inputs.connectionError) return { key: "hint.reconnecting" };
    return { key: "hint.connecting" };
  }
  if (inputs.sendStalled) return { key: "hint.stalled" };
  if (inputs.capturePending) return { key: "hint.capturing" };
  if (inputs.agentSendInFlight) {
    return inputs.pendingName !== null
      ? { key: "hint.agentStarting", params: { name: inputs.pendingName } }
      : { key: "hint.agentStartingGeneric" };
  }
  const perched = perchIdentityHint(inputs);
  if (perched) return perched;
  if (inputs.thinking) return { key: "hint.thinking" };
  return null;
}
