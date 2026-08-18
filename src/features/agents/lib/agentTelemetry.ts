/**
 * Thin, feature-scoped wrappers over the vendored `berd_agent` event factories.
 *
 * These build the vendored schema events and hand them to the shared telemetry
 * `track` chokepoint, inheriting its prod/staging gate, consent gating, and
 * startup buffering for free. Keeping the wrappers here (rather than in
 * `client.ts`) keeps `berd_agent` wiring additive and local to the agents
 * feature.
 */
import { track } from "@/shared/telemetry/client";
import {
  berdAgentCreateCompleted,
  berdAgentDeleteCompleted,
  berdAgentEditCompleted,
} from "@/shared/telemetry/events";

// Optional provider/model only carry signal when configured; drop blanks so we
// never emit an empty-string attribute standing in for "not set".
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

interface AgentCompletionParams {
  provider?: string | null;
  model?: string | null;
}

/** An agent/persona creation flow completed successfully. */
export function trackAgentCreateCompleted({
  provider,
  model,
}: AgentCompletionParams): void {
  track(
    berdAgentCreateCompleted({
      provider: nonEmpty(provider),
      model: nonEmpty(model),
    }),
  );
}

/** An agent/persona edit flow completed successfully. */
export function trackAgentEditCompleted({
  provider,
  model,
}: AgentCompletionParams): void {
  track(
    berdAgentEditCompleted({
      provider: nonEmpty(provider),
      model: nonEmpty(model),
    }),
  );
}

/** An agent/persona deletion completed successfully. */
export function trackAgentDeleteCompleted(): void {
  track(berdAgentDeleteCompleted());
}
