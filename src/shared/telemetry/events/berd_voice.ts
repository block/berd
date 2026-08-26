// Vendored-style typed telemetry event factory. Berd's event modules are
// maintained locally; keep this event name and parameter shape aligned with
// the versioned allowlist in squareup/berd-monitoring.

import type { Event } from "./event";

/**
 * Berd Voice · Conversation · Started
 *
 * Counts a voice conversation only after native voice startup succeeds. The
 * event intentionally has no attributes: the anonymous installation resource
 * identity is enough to measure adoption without collecting session or voice
 * configuration details.
 */
export function berdVoiceConversationStarted(): Event {
  return {
    name: "berd_voice_conversation_started",
    parameters: {},
  };
}
