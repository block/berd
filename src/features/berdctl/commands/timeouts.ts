import type { AppCommand } from "./types";

/**
 * Per-action bridge timeout (ms) shared by the set_timeouts push (lifecycle.ts
 * sends the broker each group's per-action maximum at start) and dispatch's
 * deadline fallback for direct callers. The values are the authoritative half
 * of the renderer/broker timeout contract:
 *
 * - sessions.create declares a 60s override for its backend session
 *   round-trip (the prompt itself is fire-and-forget and not awaited).
 * - Everything else is a fast local operation.
 *
 * The broker's MAX_COMMAND_TIMEOUT (150s) is above the largest value here, so
 * none of these is clamped; the berdctl CLI's HTTP timeout (160s) is above
 * the broker max, so the broker always gives up first with a clean error.
 */
export function commandBridgeTimeoutMs(
  command: Pick<AppCommand<unknown, unknown>, "bridgeTimeoutMs">,
): number {
  return command.bridgeTimeoutMs ?? 30_000;
}
