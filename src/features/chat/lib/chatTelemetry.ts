/**
 * Thin, feature-scoped wrappers over the vendored `berd_chat` event factories,
 * mirroring `src/features/agents/lib/agentTelemetry.ts`.
 *
 * Each wrapper builds the vendored schema event and hands it to the shared
 * telemetry `track` chokepoint, inheriting its prod/staging gate, consent
 * gating, and startup buffering/backdating for free. Keeping the wrappers
 * here (rather than in `client.ts`) keeps `berd_chat` wiring additive and local
 * to the chat feature.
 */
import { track } from "@/shared/telemetry/client";
import {
  type BerdChatChatSourceSurface,
  berdChatMessageSent,
  berdChatSessionStarted,
} from "@/shared/telemetry/events";

/**
 * The `source_surface` values this feature emits. These are the exact schema
 * values reachable from the chat controller flows wired here. Detached
 * `session:*` windows run the same controller flows and report MAIN_CHAT;
 * there is no separate session-window surface on the wire.
 */
export const CHAT_SOURCE_SURFACE = {
  MAIN_CHAT: "CHAT_SOURCE_SURFACE_MAIN_CHAT",
  GLOBAL_COMPOSER: "CHAT_SOURCE_SURFACE_GLOBAL_COMPOSER",
  AGENT_BUILDER: "CHAT_SOURCE_SURFACE_AGENT_BUILDER",
} as const satisfies Record<string, BerdChatChatSourceSurface>;

// Optional provider/model only carry signal when configured; drop blanks so we
// never emit an empty-string attribute standing in for "not set".
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A chat session begins, fired when the session's first user message is
 * committed to the transcript (a session id already exists at this point).
 * "First" is decided by `chatFirstMessage`, which withholds the event while a
 * session's history has yet to replay rather than call a resumed session new.
 */
export function trackChatSessionStarted({
  sessionId,
  sourceSurface,
  hasProject,
  hasPersona,
  provider,
  model,
}: {
  sessionId: string;
  sourceSurface: BerdChatChatSourceSurface;
  hasProject: boolean;
  hasPersona: boolean;
  provider?: string | null;
  model?: string | null;
}): void {
  track(
    berdChatSessionStarted({
      session_id: sessionId,
      source_surface: sourceSurface,
      has_project: hasProject,
      has_persona: hasPersona,
      provider: nonEmpty(provider),
      model: nonEmpty(model),
    }),
  );
}

/** The user sends a chat message. */
export function trackChatMessageSent({
  sessionId,
  isFirstMessage,
  hasAttachments,
  hasPersona,
  provider,
  model,
}: {
  sessionId: string;
  isFirstMessage: boolean;
  hasAttachments: boolean;
  hasPersona: boolean;
  provider?: string | null;
  model?: string | null;
}): void {
  track(
    berdChatMessageSent({
      session_id: sessionId,
      is_first_message: isFirstMessage,
      has_attachments: hasAttachments,
      has_persona: hasPersona,
      provider: nonEmpty(provider),
      model: nonEmpty(model),
    }),
  );
}
